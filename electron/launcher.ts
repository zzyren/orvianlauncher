import { app, BrowserWindow, clipboard, Notification, session, shell } from 'electron'
import os from 'node:os'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'
import { z } from 'zod'
import { planUpdate } from '../src/shared/integrity'
import { OrvianError, toPayload, userMessage } from '../src/shared/errors'
import type { LauncherState } from '../src/shared/launcher-state'
import { getConfig, isAdminUuid } from './config'
import { buildDiagnostics, readLogTail } from './diagnostics'
import type { Ipc } from './ipc'
import { log } from './logger'
import { AuthService } from './auth'
import { isGameBusy, isMinecraftRunning, killMinecraftProcess, playGame, repairGame, type GameDeps, type PipelineResult } from './game/launch'
import { registerAdminIpc } from './admin'
import { ManifestPoller, ManifestProvider, readInstalledVersion, type PollResult } from './modpack/manifest'
import { discardPendingConfigs, listPendingConfigs, restorePendingConfigs } from './modpack/pending'
import { NewsService } from './news'
import { resetLauncherData } from './reset'
import { ServerMonitor } from './serverStatus'
import { LauncherStore } from './state'
import { bindUpdater } from './updater'

export { isMinecraftRunning, killMinecraftProcess }

export interface LauncherHooks {
  /** True while any launcher window is on screen; background work that only feeds the UI sleeps otherwise. */
  isUiVisible: () => boolean
}

export interface Launcher {
  store: LauncherStore
  /** Loads the account and the first pack information; the splash waits for it. */
  init: () => Promise<void>
}

const MIN_RAM_GB = 2
const MAX_RAM_GB = 16
const DEFAULT_RAM_GB = 6
const WINDOWS_RESERVE_GB = 3

function broadcast(channel: string, payload: unknown): void {
  BrowserWindow.getAllWindows().forEach((win) => {
    if (!win.isDestroyed()) win.webContents.send(channel, payload)
  })
}

/** The most RAM the player may give the game: leaves room for Windows and the launcher. */
export function ramLimits(physicalBytes: number = os.totalmem()): { ramMin: number; ramMax: number } {
  const physicalGb = Math.floor(physicalBytes / 1024 ** 3)
  return { ramMin: MIN_RAM_GB, ramMax: Math.min(MAX_RAM_GB, Math.max(MIN_RAM_GB, physicalGb - WINDOWS_RESERVE_GB)) }
}

async function readJson<T>(path: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as T
  } catch {
    return fallback
  }
}

function isHttpsUrl(value: string): boolean {
  try {
    return new URL(value).protocol === 'https:'
  } catch {
    return false
  }
}

export function registerLauncher(ipc: Ipc, dataRoot: string, hooks: LauncherHooks): Launcher {
  const instance = join(dataRoot, 'instances', 'orvian')
  const settingsFile = join(dataRoot, 'launcher', 'config.json')
  const authService = new AuthService(dataRoot)
  const provider = new ManifestProvider({ dataRoot })
  const news = new NewsService({ dataRoot, repo: getConfig().packRepo })

  const store = new LauncherStore({
    appVersion: app.getVersion(),
    broadcast: (state: LauncherState) => broadcast('launcher:state', state)
  })

  // ─── Facts the store needs ────────────────────────────────────────────────

  const loadSettings = async (): Promise<void> => {
    const stored = await readJson<{ ramGb?: number }>(settingsFile, {})
    const limits = ramLimits()
    const ramGb = Number.isInteger(stored.ramGb) ? Math.min(limits.ramMax, Math.max(limits.ramMin, stored.ramGb as number)) : Math.min(DEFAULT_RAM_GB, limits.ramMax)
    store.setSettings({ ramGb, ...limits })
  }

  const loadAccount = async (): Promise<void> => {
    const account = await authService.loadAccount()
    store.setAccount(account ? { name: account.name, uuid: account.uuid } : null, account !== null && isAdminUuid(account.uuid))
  }

  /** Re-reads the manifest and the installed version and tells the store, including how big the update is. */
  const refreshPack = async (force: boolean): Promise<PollResult> => {
    store.setChecking(true)
    try {
      const result = await poller.checkNow(force)
      await publishPack(result.installed)
      return result
    } finally {
      store.setChecking(false)
    }
  }

  const publishPack = async (installed: string | null): Promise<void> => {
    const found = provider.peek()
    if (!found) {
      store.setPack(null, installed)
      return
    }
    let downloadBytes: number | undefined
    if (installed === null || installed !== found.manifest.pack.version) {
      downloadBytes = await planUpdate(instance, found.manifest.files).then((plan) => plan.bytesToDownload, () => undefined)
    }
    store.setPack(
      { version: found.manifest.pack.version, minimumLauncher: found.manifest.minimumLauncher, source: found.source, changelog: found.manifest.changelog },
      installed,
      downloadBytes
    )
    void news.get({ manifest: found.manifest }).then((items) => store.setNews(items))
  }

  // ─── Background check for a newer modpack ─────────────────────────────────
  // Every 5 minutes while reachable, backing off while offline, and silent while the game runs.
  const poller: ManifestPoller = new ManifestPoller({
    provider,
    readInstalled: () => readInstalledVersion(instance),
    isPaused: isMinecraftRunning,
    onResult: (result: PollResult, changed: boolean) => {
      if (!changed) return
      void publishPack(result.installed)
      if (result.hasUpdate && result.source === 'network') {
        log.info('[Modpack] Nueva versión disponible: %s (instalada: %s)', result.latest, result.installed)
        if (!hooks.isUiVisible()) notifyUpdate(result.latest as string)
      }
    }
  })
  poller.start()

  // ─── Server status ────────────────────────────────────────────────────────
  const serverMonitor = new ServerMonitor({
    getTarget: () => {
      const fromManifest = provider.peek()?.manifest.server
      const target = fromManifest ?? getConfig().server
      return { host: target.address, port: target.port ?? 25565 }
    },
    isActive: () => hooks.isUiVisible() && !isMinecraftRunning(),
    onStatus: (status) => store.setServer(status)
  })
  serverMonitor.start()

  // ─── Launcher self-update ─────────────────────────────────────────────────
  bindUpdater({ onState: (state) => store.setLauncherUpdate(state), isGameRunning: isMinecraftRunning })

  // ─── Game pipeline ────────────────────────────────────────────────────────
  const gameDeps: GameDeps = {
    dataRoot,
    appVersion: app.getVersion(),
    hasAccount: async () => (await authService.loadAccount()) !== null,
    getSession: () => authService.getValidSession(),
    getManifest: async () => (await provider.get())?.manifest ?? null,
    getRamGb: async () => store.getState().settings.ramGb,
    emit: (event) => {
      if (event.state === 'playing') store.markRunning()
      else store.applyProgress(event)
    },
    onPackSynced: (version) => {
      poller.note(version, version)
      store.setInstalledVersion(version)
    },
    onGameExit: (result) => {
      store.endActivity()
      if (result.kind === 'crash') store.setCrash({ exitCode: result.exitCode, summary: result.summary, reportPath: result.reportPath })
      // Updates may have been published while playing
      void refreshPack(true)
    }
  }

  /** Runs a pipeline and reflects its start, its failure or its end in the store. */
  const runPipeline = async (mode: 'installing' | 'repairing', run: () => Promise<PipelineResult>): Promise<PipelineResult> => {
    const phase = store.getState().phase.kind
    if (!isIdle(phase)) {
      const busy = new OrvianError(isMinecraftRunning() ? 'GAME_ALREADY_RUNNING' : 'BUSY')
      return { ok: false, message: userMessage(busy), error: toPayload(busy) }
    }
    store.beginActivity(mode)
    const result = await run()
    if (!result.ok) {
      store.endActivity()
      if (result.error?.code === 'AUTH_EXPIRED') store.expireSession()
      else if (result.error) store.setError(result.error, mode === 'repairing' ? 'repair' : 'play')
    } else if (mode === 'repairing') {
      store.endActivity()
      void refreshPack(false)
    } else if (!isMinecraftRunning()) {
      // The game already exited before the pipeline reported back
      store.endActivity()
    }
    return result
  }

  ipc.handle('launcher:get-state', [], () => store.getState())

  ipc.handle(
    'game:play',
    [z.object({ quickPlay: z.boolean().optional(), playInstalled: z.boolean().optional() }).optional()],
    (_event, options) => runPipeline('installing', () => playGame(gameDeps, options ?? {}))
  )
  ipc.handle('pack:repair', [], () => runPipeline('repairing', () => repairGame(gameDeps)))
  ipc.handle('game:kill', [], () => {
    // The exit watcher reports the end of the process, which clears the "running" state
    killMinecraftProcess()
  })
  ipc.handle('launcher:dismiss-error', [], () => store.dismissError())

  // ─── Manual check ─────────────────────────────────────────────────────────
  ipc.handle('pack:check', [], async () => {
    try {
      const result = await refreshPack(true)
      const state = store.getState()
      return {
        configured: provider.peek() !== null,
        hasUpdate: result.hasUpdate,
        installedVersion: result.installed,
        latestVersion: result.latest,
        offline: result.source === 'cache',
        downloadBytes: state.pack.downloadBytes,
        message: result.source === 'cache'
          ? 'No se pudo comprobar GitHub; se muestra la última versión conocida.'
          : result.hasUpdate
            ? `Nueva versión disponible: v${result.latest} (instalada: v${result.installed})`
            : result.latest
              ? `Estás en la última versión: v${result.latest}`
              : 'No se pudo obtener información de la versión.'
      }
    } catch (err) {
      log.warn('[Modpack] Comprobación manual fallida: %s', String(err))
      return { configured: false, hasUpdate: false, message: 'Error comprobando actualizaciones.' }
    }
  })

  // ─── Config files the pack wanted to change but the player had edited ───────
  const guardIdle = (): void => {
    if (isMinecraftRunning() || isGameBusy()) throw new Error('Espera a que termine la partida o la instalación en curso.')
  }
  ipc.handle('pack:pending-configs', [], () => listPendingConfigs(instance))
  ipc.handle('pack:restore-configs', [], async () => {
    guardIdle()
    return restorePendingConfigs(instance)
  })
  ipc.handle('pack:discard-configs', [], async () => {
    guardIdle()
    await discardPendingConfigs(instance)
  })

  // ─── Account ──────────────────────────────────────────────────────────────
  ipc.handle('account:login', [], async (event) => {
    store.setSigningIn(true)
    try {
      const window = BrowserWindow.fromWebContents(event.sender) ?? undefined
      const account = await authService.loginWithMicrosoft(window)
      store.setAccount({ name: account.name, uuid: account.uuid }, isAdminUuid(account.uuid))
      return { ok: true, message: 'Sesión iniciada con éxito.' }
    } catch (error) {
      return { ok: false, message: userMessage(error), cancelled: toPayload(error).code === 'AUTH_CANCELLED' }
    } finally {
      store.setSigningIn(false)
    }
  })

  ipc.handle('account:cancel-login', [], () => {
    authService.cancelLogin()
    return { ok: true }
  })

  ipc.handle('account:logout', [], async () => {
    await authService.logout()
    store.setAccount(null)
    return { ok: true }
  })

  // ─── Settings and folders ─────────────────────────────────────────────────
  ipc.handle('settings:ram', [z.number()], async (_event, value) => {
    const { ramMin, ramMax } = store.getState().settings
    if (!Number.isInteger(value) || value < ramMin || value > ramMax) throw new Error('RAM fuera de rango')
    const settings = await readJson<Record<string, unknown>>(settingsFile, {})
    await mkdir(join(dataRoot, 'launcher'), { recursive: true })
    await writeFile(settingsFile, JSON.stringify({ ...settings, ramGb: value }, null, 2), 'utf8')
    store.setSettings({ ramGb: value, ramMin, ramMax })
    return { ok: true }
  })

  ipc.handle('folder:open', [z.enum(['mods', 'shaders', 'resourcepacks', 'logs', 'game', 'crash-reports'])], async (_event, kind) => {
    const folders: Record<typeof kind, string> = {
      logs: join(dataRoot, 'launcher', 'logs'),
      game: instance,
      'crash-reports': join(instance, 'crash-reports'),
      mods: join(instance, 'mods'),
      shaders: join(instance, 'shaderpacks'),
      resourcepacks: join(instance, 'resourcepacks')
    }
    const normalized = resolve(folders[kind])
    if (!normalized.startsWith(resolve(dataRoot) + sep)) throw new Error('Ruta no válida')
    await mkdir(normalized, { recursive: true }).catch(() => undefined)
    const error = await shell.openPath(normalized)
    return { ok: !error, error }
  })

  ipc.handle('url:open', [z.string().max(2048)], async (_event, url) => {
    if (isHttpsUrl(url)) await shell.openExternal(url)
  })

  // ─── Server and diagnostics ───────────────────────────────────────────────
  ipc.handle('server:refresh', [], () => serverMonitor.refresh())

  ipc.handle('diagnostics:copy', [], async () => {
    const state = store.getState()
    const phase = state.phase
    const text = buildDiagnostics({
      appVersion: state.appVersion,
      phase: phase.kind,
      packInstalled: state.pack.installed,
      packLatest: state.pack.latest,
      platform: process.platform,
      arch: process.arch,
      electron: process.versions.electron,
      error: phase.kind === 'error' ? { code: phase.error.code, title: phase.error.title, technical: phase.error.technical } : undefined,
      logLines: await readLogTail(join(dataRoot, 'launcher', 'logs', 'launcher.log'), 50)
    })
    clipboard.writeText(text)
    return { ok: true, lines: text.split('\n').length }
  })

  // ─── Reset ────────────────────────────────────────────────────────────────
  ipc.handle('launcher:reset', [z.object({ deleteWorlds: z.boolean() })], async (_event, options) => {
    if (isMinecraftRunning() || isGameBusy()) {
      throw new Error('No puedes restablecer el launcher mientras haya una partida o una instalación en curso.')
    }

    const { preserved } = await resetLauncherData(dataRoot, options)

    // Clear persistent Electron sessions (Microsoft account cookies and web storage)
    for (const clear of [
      () => session.fromPartition('persist:microsoft-auth').clearStorageData(),
      () => session.defaultSession.clearStorageData()
    ]) {
      await clear().catch((err: unknown) => log.warn('[Reset] No se pudo limpiar una sesión: %s', String(err)))
    }

    // Forget everything known about the pack and the account
    provider.forget()
    poller.note(null, null)
    store.setAccount(null)
    store.dismissError()
    await loadSettings()
    await publishPack(null)

    log.info('[Reset] Launcher restablecido (mundos %s)', options.deleteWorlds ? 'eliminados' : 'conservados')
    return {
      ok: true,
      preserved,
      message: options.deleteWorlds
        ? 'Launcher restablecido de fábrica. Todo ha quedado como nuevo.'
        : 'Launcher restablecido. Se conservaron tus mundos, capturas, resourcepacks, shaders y opciones.'
    }
  })

  registerAdminIpc(ipc, {
    dataRoot,
    getAccount: () => authService.loadAccount(),
    emitProgress: (state, progress, detail) => broadcast('admin:progress', { state, progress, detail }),
    getLatestVersion: () => provider.peek()?.manifest.pack.version ?? null,
    getMinimumLauncher: () => provider.peek()?.manifest.minimumLauncher,
    onPublished: (manifest, version) => {
      // The admin already runs the new version: remember it and tell every window.
      void provider.remember(manifest)
      void readInstalledVersion(instance).then((installed) => {
        poller.note(installed, version)
        void publishPack(installed)
      })
    }
  })

  // ─── Start-up ─────────────────────────────────────────────────────────────
  const init = async (): Promise<void> => {
    await Promise.all([loadSettings(), loadAccount()])
    store.markBooted()
    // The pack information and the server do not block the window: the store shows "checking" meanwhile.
    void refreshPack(false).then(() => serverMonitor.refresh())
  }

  return { store, init }
}

function isIdle(kind: string): boolean {
  return !['booting', 'installing', 'repairing', 'launching', 'running', 'signing-in'].includes(kind)
}

function notifyUpdate(version: string): void {
  try {
    if (!Notification.isSupported()) return
    const notification = new Notification({ title: 'Orvian: modpack actualizado', body: `Hay una nueva versión (v${version}). Abre el launcher para jugarla.` })
    notification.on('click', () => {
      BrowserWindow.getAllWindows().forEach((win) => {
        if (win.isDestroyed()) return
        if (win.isVisible()) win.focus()
        else win.show()
      })
    })
    notification.show()
  } catch (err) {
    log.error('[Modpack] Fallo al mostrar la notificación del sistema: %s', String(err))
  }
}

