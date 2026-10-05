import { app, shell, BrowserWindow, Notification, session } from 'electron'
import os from 'node:os'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'
import { z } from 'zod'
import { planUpdate } from '../src/shared/integrity'
import { userMessage } from '../src/shared/errors'
import { isAdminUuid } from './config'
import type { Ipc } from './ipc'
import { log } from './logger'
import { AuthService } from './auth'
import { isGameBusy, isMinecraftRunning, killMinecraftProcess, playGame, repairGame, type GameDeps } from './game/launch'
import { registerAdminIpc } from './admin'
import { ManifestPoller, ManifestProvider, hasUpdate, readInstalledVersion, type PollResult } from './modpack/manifest'
import { resetLauncherData } from './reset'

export { isMinecraftRunning, killMinecraftProcess }

function broadcast(channel: string, payload: unknown): void {
  BrowserWindow.getAllWindows().forEach((win) => {
    if (!win.isDestroyed()) win.webContents.send(channel, payload)
  })
}

/** Tells every window about the pack's state (installed vs latest). */
function broadcastModpackStatus(installed: string | null, latest: string | null): void {
  broadcast('pack:status', { installedVersion: installed, latestVersion: latest, hasUpdate: hasUpdate(installed, latest) })
}

export function registerLauncherIpc(ipc: Ipc, dataRoot: string) {
  const instance = join(dataRoot, 'instances', 'orvian')
  const authService = new AuthService(dataRoot)
  const provider = new ManifestProvider({ dataRoot })
  const readSettings = () => readJson(join(dataRoot, 'launcher', 'config.json'), { ramGb: 6 })

  // ─── Background check for a newer modpack ───────────────────────────────────
  // Every 5 minutes while reachable, backing off while offline, and silent while the game runs.
  const poller = new ManifestPoller({
    provider,
    readInstalled: () => readInstalledVersion(instance),
    isPaused: isMinecraftRunning,
    onResult: (result: PollResult, changed: boolean) => {
      if (!changed) return
      broadcastModpackStatus(result.installed, result.latest)
      if (result.hasUpdate && result.source === 'network') {
        log.info('[Modpack] Nueva versión disponible: %s (instalada: %s)', result.latest, result.installed)
        notifyUpdate(result.latest as string)
      }
    }
  })
  void poller.checkNow(false)
  poller.start()

  /** Resolves what the launcher knows without waiting on the network when it already has an answer. */
  const knownManifest = async () => provider.peek() ?? (await provider.get())

  // ─── Handler: launcher:status ─────────────────────────────────────────────
  ipc.handle('launcher:status', [z.object({ fresh: z.boolean().optional() }).optional()], async (_event, opts) => {
    const settings = await readSettings()
    const account = await authService.loadAccount()
    const found = opts?.fresh ? await provider.get({ force: true }) : await knownManifest()
    const installedVersion = await readInstalledVersion(instance)
    const latestVersion = found?.manifest.pack.version ?? null

    return {
      appVersion: app.getVersion(),
      packVersion: latestVersion,
      installedVersion,
      hasUpdate: hasUpdate(installedVersion, latestVersion),
      ready: found !== null && account !== null,
      authenticated: account !== null,
      playerName: account?.name ?? null,
      playerUuid: account?.uuid ?? null,
      isAdmin: account !== null && isAdminUuid(account.uuid),
      ramGb: settings.ramGb,
      configured: found !== null,
      isPlaying: isMinecraftRunning(),
      /** True when the pack information comes from the last saved copy because GitHub could not be reached. */
      offline: found?.source === 'cache'
    }
  })

  // ─── Handler: pack:check — fresh check, with the size of the update ──────
  ipc.handle('pack:check', [], async () => {
    try {
      const result = await poller.checkNow(true)
      const found = provider.peek()
      let downloadBytes: number | undefined
      if (result.hasUpdate && found) downloadBytes = (await planUpdate(instance, found.manifest.files)).bytesToDownload
      return {
        configured: found !== null,
        hasUpdate: result.hasUpdate,
        installedVersion: result.installed,
        latestVersion: result.latest,
        offline: result.source === 'cache',
        downloadBytes,
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

  const gameDeps: GameDeps = {
    dataRoot,
    appVersion: app.getVersion(),
    hasAccount: async () => (await authService.loadAccount()) !== null,
    getSession: () => authService.getValidSession(),
    getManifest: async () => (await provider.get())?.manifest ?? null,
    getRamGb: async () => (await readSettings()).ramGb,
    emit: (event) => broadcast('launcher:progress', event),
    onPackSynced: (version) => {
      poller.note(version, version)
      broadcastModpackStatus(version, version)
    },
    // Re-check for a newer pack after a session: updates may have been published while playing
    onGameExit: () => void poller.checkNow(true)
  }

  ipc.handle('pack:repair', [], () => repairGame(gameDeps))

  ipc.handle(
    'game:play',
    [z.object({ quickPlay: z.boolean().optional(), playInstalled: z.boolean().optional() }).optional()],
    (_event, options) => playGame(gameDeps, options ?? {})
  )

  ipc.handle('account:login', [], async (event) => {
    try {
      const window = BrowserWindow.fromWebContents(event.sender) ?? undefined
      await authService.loginWithMicrosoft(window)
      return { ok: true, message: 'Sesión iniciada con éxito.' }
    } catch (error) {
      return { ok: false, message: userMessage(error) }
    }
  })

  ipc.handle('account:cancel-login', [], () => {
    authService.cancelLogin()
    return { ok: true }
  })

  ipc.handle('account:logout', [], async () => {
    await authService.logout()
    return { ok: true }
  })

  ipc.handle('settings:ram', [z.number()], async (_event, value) => {
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 2 || value > 16) throw new Error('RAM fuera de rango')
    const physical = Math.floor(os.totalmem() / 1024 ** 3)
    if (value > Math.max(2, physical - 3)) throw new Error('La configuración dejaría muy poca memoria para Windows')
    const file = join(dataRoot, 'launcher', 'config.json')
    const settings = await readJson(file, {})
    await writeFile(file, JSON.stringify({ ...settings, ramGb: value }, null, 2), 'utf8')
    return { ok: true }
  })

  ipc.handle('folder:open', [z.enum(['mods', 'shaders', 'resourcepacks', 'logs'])], async (_event, kind) => {
    // 'logs' → carpeta de logs del launcher
    // Resto → carpeta directa dentro de la instancia (mods/, shaderpacks/, resourcepacks/)
    // NOTA: abrimos la carpeta real donde están los archivos, no una subcarpeta 'user'
    const kindMap: Record<string, string> = {
      logs: join(dataRoot, 'launcher', 'logs'),
      mods: join(instance, 'mods'),
      shaders: join(instance, 'shaderpacks'),
      resourcepacks: join(instance, 'resourcepacks')
    }
    const folder = kindMap[String(kind)] ?? join(instance, String(kind))
    const normalized = resolve(folder)
    if (!normalized.startsWith(resolve(dataRoot) + sep)) throw new Error('Ruta no válida')
    
    // Crear la carpeta si no existe antes de abrirla
    await mkdir(normalized, { recursive: true }).catch(() => {})
    
    const error = await shell.openPath(normalized)
    return { ok: !error, error }
  })

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

    // Forget everything known about the pack
    provider.forget()
    poller.note(null, null)

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
    emitProgress: (state, progress, detail) => broadcast('launcher:progress', { state, progress, detail }),
    getLatestVersion: () => provider.peek()?.manifest.pack.version ?? null,
    getMinimumLauncher: () => provider.peek()?.manifest.minimumLauncher,
    onPublished: (manifest, version) => {
      // The admin already runs the new version: remember it and tell every window.
      void provider.remember(manifest)
      void readInstalledVersion(instance).then((installed) => {
        poller.note(installed, version)
        broadcastModpackStatus(installed, version)
      })
    }
  })

  ipc.handle('url:open', [z.string().max(2048)], async (_event, url) => {
    if (isHttpsUrl(url)) await shell.openExternal(url)
  })
}

function isHttpsUrl(value: string): boolean {
  try {
    return new URL(value).protocol === 'https:'
  } catch {
    return false
  }
}

async function readJson<T>(path: string, fallback: T): Promise<T> {
  try { return JSON.parse(await readFile(path, 'utf8')) as T } catch { return fallback }
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
