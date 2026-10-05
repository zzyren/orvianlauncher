import { execSync, type ChildProcess } from 'node:child_process'
import { join } from 'node:path'
import { createMinecraftProcessWatcher, createQuickPlayMultiplayer, launch, Version } from '@xmcl/core'
import { OrvianError, toPayload, userMessage, type OrvianErrorPayload } from '../../src/shared/errors'
import { hasInterruptedSync } from '../../src/shared/integrity'
import { compareVersions, type OrvianManifest } from '../../src/shared/manifest'
import { redactSecrets } from '../../src/shared/redact'
import type { AccountInfo } from '../auth'
import { getConfig } from '../config'
import { ensureJava17 } from '../java'
import { log, RotatingFile } from '../logger'
import { readInstalledVersion } from '../modpack/manifest'
import { syncModpack } from '../modpack/sync'
import { analyzeExit, findNewCrashReport, type ExitResult } from './crash'
import { ensureDependencies, ensureForge, ensureVanilla, forgeIds } from './install'
import { ProgressTracker, type ProgressEvent } from './progress'

export interface PlayOptions {
  /** Open the game directly on the Orvian server. */
  quickPlay?: boolean
  /** Skip the modpack update check and run the files already installed (offline play). */
  playInstalled?: boolean
}

export interface PipelineResult {
  ok: boolean
  message: string
  error?: OrvianErrorPayload
}

export interface GameDeps {
  dataRoot: string
  appVersion: string
  hasAccount(): Promise<boolean>
  getSession(): Promise<{ account: AccountInfo; stale: boolean }>
  getManifest(): Promise<OrvianManifest | null>
  getRamGb(): Promise<number>
  emit(event: ProgressEvent): void
  onPackSynced(version: string): void
  onGameExit(result: ExitResult): void
}

/** Process-level state: at most one game and one install pipeline at a time. */
const runtime = {
  playing: false,
  busy: false,
  process: null as ChildProcess | null,
  killedByLauncher: false
}

export function isMinecraftRunning(): boolean {
  return runtime.playing || runtime.process !== null
}

export function isGameBusy(): boolean {
  return runtime.busy
}

export function killMinecraftProcess(): void {
  const proc = runtime.process
  if (proc) {
    runtime.killedByLauncher = true
    if (proc.pid && process.platform === 'win32') {
      try {
        execSync(`taskkill /pid ${proc.pid} /T /F`, { stdio: 'ignore' })
      } catch {
        // taskkill fails when the process already exited
      }
    }
    try {
      proc.kill('SIGKILL')
    } catch {
      // Already gone.
    }
    runtime.process = null
  }
  runtime.playing = false
}

function failure(err: unknown): PipelineResult {
  return { ok: false, message: userMessage(err), error: toPayload(err) }
}

async function runPipeline(deps: GameDeps, mode: 'play' | 'repair', options: PlayOptions): Promise<PipelineResult> {
  if (runtime.playing) return failure(new OrvianError('GAME_ALREADY_RUNNING'))
  if (runtime.busy) return failure(new OrvianError('BUSY'))
  runtime.busy = true

  const tracker = new ProgressTracker(deps.emit)
  const config = getConfig()
  const common = join(deps.dataRoot, 'common')
  const instance = join(deps.dataRoot, 'instances', 'orvian')
  const fullVerify = mode === 'repair'

  try {
    if (mode === 'play' && !(await deps.hasAccount())) {
      throw new Error('Inicia sesión en tu cuenta de Microsoft antes de jugar.')
    }

    const installedVersion = await readInstalledVersion(instance)
    // A sync that never finished may have left a mix of old and new files: never run that unchecked.
    if (options.playInstalled && (await hasInterruptedSync(instance))) throw new OrvianError('UPDATE_INTERRUPTED')
    const manifest = options.playInstalled ? null : await deps.getManifest()
    if (!manifest && !installedVersion) throw new OrvianError('OFFLINE_NOT_INSTALLED')
    if (manifest && compareVersions(deps.appVersion, manifest.minimumLauncher) < 0) {
      throw new OrvianError('LAUNCHER_TOO_OLD', { required: manifest.minimumLauncher })
    }
    const forge = manifest?.pack.forge ?? config.forgeVersion
    const ids = forgeIds(config.mcVersion, forge)

    // Renews the Minecraft token silently when it is about to expire; offline it falls back to the stored one.
    let session: { account: AccountInfo; stale: boolean } | null = null
    if (mode === 'play') {
      session = await deps.getSession()
      if (session.stale) log.warn('[Launcher] Se usará la sesión guardada sin renovar: el multijugador puede fallar.')
    }

    tracker.begin('java', 'Preparando Java 17...')
    const javaPath = await ensureJava17(deps.dataRoot, (detail) => tracker.update({ detail }), { force: fullVerify })
    tracker.done('java')

    await ensureVanilla(common, config.mcVersion, tracker, { fullVerify })
    await ensureForge(common, javaPath, { mc: config.mcVersion, forge }, tracker)
    await ensureDependencies(common, ids.id, tracker, { fullVerify })

    if (manifest) {
      const required = manifest.pack.version
      const detail = fullVerify
        ? `Reparando modpack v${required}...`
        : !installedVersion
          ? 'Instalando el modpack de Orvian por primera vez...'
          : installedVersion !== required
            ? `Actualizando modpack: v${installedVersion} → v${required}...`
            : `Verificando modpack v${required}...`
      tracker.begin('modpack', detail)
      log.info('[Launcher] Modpack instalado: %s, requerido: %s, reparación: %s', installedVersion ?? 'ninguno', required, fullVerify)
      const result = await syncModpack({ instanceDir: instance, manifest, fullVerify, onProgress: (update) => tracker.update(update) })
      log.info('[Launcher] Sync: %d instalados, %d reemplazados, %d sin cambios, %d de confianza', result.installed, result.replaced, result.unchanged, result.trustedFromState)
      deps.onPackSynced(required)
      tracker.done('modpack')
    } else {
      tracker.begin('modpack', `Usando el modpack instalado (v${installedVersion}).`)
      tracker.done('modpack')
    }

    if (mode === 'repair') {
      tracker.begin('finalizing', 'Instalación verificada.')
      tracker.done('finalizing')
      return { ok: true, message: 'Instalación verificada y reparada.' }
    }

    tracker.begin('finalizing', 'Iniciando juego...')
    await startGame(deps, { account: (session as NonNullable<typeof session>).account, javaPath, common, instance, versionId: ids.id, options })
    return { ok: true, message: 'Minecraft ha iniciado correctamente.' }
  } catch (err) {
    log.error('[Launcher] %s falló: %s', mode === 'play' ? 'Iniciar Minecraft' : 'Reparar', err instanceof Error ? (err.stack ?? err.message) : String(err))
    return failure(err)
  } finally {
    runtime.busy = false
  }
}

interface StartArgs {
  account: AccountInfo
  javaPath: string
  common: string
  instance: string
  versionId: string
  options: PlayOptions
}

async function startGame(deps: GameDeps, args: StartArgs): Promise<void> {
  const config = getConfig()
  const startedAt = Date.now()
  const version = await Version.parse(args.common, args.versionId)

  const gameLog = new RotatingFile(join(deps.dataRoot, 'launcher', 'logs'), 'minecraft-latest', 20 * 1024 * 1024, 3)
  gameLog.startFresh()

  runtime.playing = true
  runtime.killedByLauncher = false
  let proc: ChildProcess
  try {
    proc = await launch({
      gamePath: args.instance,
      resourcePath: args.common,
      javaPath: args.javaPath,
      version,
      minMemory: 1024,
      maxMemory: (await deps.getRamGb()) * 1024,
      gameProfile: { id: args.account.uuid, name: args.account.name },
      accessToken: args.account.accessToken,
      // userType is left unset on purpose: @xmcl/core then sends `msa`, which is what Microsoft accounts use.
      launcherName: 'Orvian',
      launcherBrand: deps.appVersion,
      quickPlayMultiplayer: args.options.quickPlay ? createQuickPlayMultiplayer(config.server.address, config.server.port) : undefined
    })
  } catch (err) {
    runtime.playing = false
    gameLog.close()
    throw err
  }
  runtime.process = proc

  // Both streams must be consumed: an unread pipe fills up and eventually freezes the game.
  const toLog = (chunk: Buffer): void => gameLog.write(redactSecrets(chunk.toString()))
  proc.stdout?.on('data', toLog)
  proc.stderr?.on('data', toLog)
  proc.on('error', (err) => {
    log.error('[Launcher] Error del proceso de Minecraft: %s', err.message)
    runtime.process = null
    runtime.playing = false
    gameLog.close()
  })

  const watcher = createMinecraftProcessWatcher(proc)
  watcher.on('minecraft-window-ready', () => deps.emit({ state: 'playing', progress: 1, detail: 'Minecraft se está ejecutando.' }))
  watcher.on('minecraft-exit', (exit) => {
    runtime.process = null
    runtime.playing = false
    gameLog.close()
    void (async () => {
      const newReport = await findNewCrashReport(args.instance, startedAt).catch(() => undefined)
      const result = analyzeExit({ code: exit.code, signal: exit.signal, crashReport: exit.crashReport, crashReportLocation: exit.crashReportLocation, killedByLauncher: runtime.killedByLauncher }, newReport)
      if (result.kind === 'crash') {
        log.error('[Launcher] Minecraft terminó con un fallo (código %s): %s', exit.code, result.summary)
        deps.emit({ state: 'error', progress: 0, detail: result.summary })
      } else {
        log.info('[Launcher] Minecraft se cerró (código %s).', exit.code)
        deps.emit({ state: 'idle', progress: 0, detail: 'Minecraft se ha cerrado.' })
      }
      deps.onGameExit(result)
    })()
  })
}

export function playGame(deps: GameDeps, options: PlayOptions = {}): Promise<PipelineResult> {
  return runPipeline(deps, 'play', options)
}

export function repairGame(deps: GameDeps): Promise<PipelineResult> {
  return runPipeline(deps, 'repair', {})
}
