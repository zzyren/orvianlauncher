import { autoUpdater } from 'electron-updater'
import type { BrowserWindow } from 'electron'
import { app } from 'electron'
import type { UpdaterState } from '../src/shared/launcher-state'
import { getConfig } from './config'
import type { Ipc } from './ipc'
import { log } from './logger'

// ─── Tipos de eventos que se envian al renderer ───────────────────────────────

export type UpdaterEvent =
  | { type: 'checking' }
  | { type: 'not-available'; currentVersion: string }
  | { type: 'available'; currentVersion: string; newVersion: string; releaseNotes?: string }
  | { type: 'downloading'; percent: number; bytesPerSecond: number; transferred: number; total: number }
  | { type: 'downloaded'; newVersion: string }
  | { type: 'error'; message: string }

// ─── Canal IPC publico ────────────────────────────────────────────────────────

export const IPC_UPDATER_EVENT = 'updater:event'

// ─── Estado interno ───────────────────────────────────────────────────────────

export interface UpdaterHooks {
  /** Receives every change of the launcher-update state (the main process store shows it). */
  onState: (state: UpdaterState) => void
  isGameRunning: () => boolean
}

let hooks: UpdaterHooks | null = null
let current: UpdaterState = { status: 'idle', currentVersion: '' }

/** Connects the updater to the rest of the launcher; call once before the first update check. */
export function bindUpdater(value: UpdaterHooks): void {
  hooks = value
  current = { ...current, currentVersion: app.getVersion() }
  value.onState(current)
}

export function getUpdaterState(): UpdaterState {
  return current
}

function setState(next: Omit<UpdaterState, 'currentVersion'>): void {
  current = { ...next, currentVersion: app.getVersion() }
  hooks?.onState(current)
}

let activeWindow: BrowserWindow | null = null
/** Versión que ya fue descargada. Evita bucles de re-descarga. */
let downloadedVersion: string | null = null
/** Flag para evitar múltiples comprobaciones en paralelo */
let isChecking = false

function send(event: UpdaterEvent) {
  if (activeWindow && !activeWindow.isDestroyed()) {
    activeWindow.webContents.send(IPC_UPDATER_EVENT, event)
  }
}

// ─── Configuracion de electron-updater ───────────────────────────────────────

export function configureAutoUpdater() {
  // No mostrar dialogos nativos — nosotros controlamos la UI
  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = false

  // Forzar canal stable para no coger pre-releases accidentalmente
  autoUpdater.channel = 'latest'
  autoUpdater.allowDowngrade = false
  autoUpdater.allowPrerelease = false

  // ─── Eventos de electron-updater ─────────────────────────────────────────

  autoUpdater.on('checking-for-update', () => {
    log.info('[Updater] Comprobando actualizaciones del launcher...')
    send({ type: 'checking' })
    // A background check must not flicker the UI of a state that is already past it
    if (current.status === 'idle' || current.status === 'error') setState({ status: 'checking' })
  })

  autoUpdater.on('update-available', (info) => {
    log.info(`[Updater] Actualizacion del launcher disponible: v${info.version}`)
    // Anti-bucle: si ya descargamos esta versión, no volver a anunciarla
    if (downloadedVersion === info.version) {
      log.info('[Updater] Esta version ya fue descargada. Ignorando evento duplicado.')
      return
    }
    setState({ status: 'available', newVersion: info.version })
    const releaseNotes = typeof info.releaseNotes === 'string'
      ? info.releaseNotes
      : Array.isArray(info.releaseNotes)
        ? (info.releaseNotes as Array<{ note?: string; version?: string }>)
            .map((n) => n.note ?? '')
            .filter(Boolean)
            .join('\n')
        : undefined
    send({
      type: 'available',
      currentVersion: app.getVersion(),
      newVersion: info.version,
      releaseNotes
    })
  })

  autoUpdater.on('update-not-available', (_info) => {
    log.info('[Updater] El launcher ya esta en la ultima version.')
    send({ type: 'not-available', currentVersion: app.getVersion() })
    if (current.status === 'checking') setState({ status: 'idle' })
    isChecking = false
  })

  autoUpdater.on('download-progress', (progress) => {
    setState({ status: 'downloading', newVersion: current.newVersion, percent: Math.round(progress.percent), bytesPerSecond: Math.round(progress.bytesPerSecond) })
    send({
      type: 'downloading',
      percent: Math.round(progress.percent),
      bytesPerSecond: Math.round(progress.bytesPerSecond),
      transferred: progress.transferred,
      total: progress.total
    })
  })

  autoUpdater.on('update-downloaded', (info) => {
    log.info(`[Updater] Actualizacion del launcher descargada: v${info.version}`)
    downloadedVersion = info.version
    isChecking = false
    // Once downloaded, install when the launcher is closed normally, even if the player never presses restart
    autoUpdater.autoInstallOnAppQuit = true
    setState({ status: 'downloaded', newVersion: info.version })
    send({ type: 'downloaded', newVersion: info.version })
  })

  autoUpdater.on('error', (err) => {
    const msg = err?.message ?? String(err)
    log.warn('[Updater] Error (no critico):', msg)
    isChecking = false
    if (current.status !== 'downloaded') setState({ status: 'error', newVersion: current.newVersion, message: msg })
    // Solo enviar si no es un error de entorno de desarrollo o de configuración missing
    const ignoredMessages = [
      'net::ERR_',
      'dev mode',
      'ENOENT',
      'Cannot find module'
    ]
    if (!ignoredMessages.some(s => msg.includes(s))) {
      send({ type: 'error', message: msg })
    }
  })
}

// ─── Registro de handlers IPC ─────────────────────────────────────────────────

export function registerUpdaterIpc(ipc: Ipc, getMainWindow: () => BrowserWindow | null) {
  function refreshWindow() {
    const win = getMainWindow()
    if (win && !win.isDestroyed()) {
      activeWindow = win
    }
  }

  // Comprobar actualizaciones del launcher bajo demanda
  ipc.handle('updater:check', [], async () => {
    refreshWindow()
    if (isChecking) {
      log.info('[Updater] Comprobacion ya en curso, ignorando peticion duplicada.')
      return { ok: true }
    }
    isChecking = true
    try {
      await autoUpdater.checkForUpdates()
      return { ok: true }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      log.warn('[Updater] checkForUpdates fallo:', msg)
      isChecking = false
      return { ok: false, message: msg }
    }
  })

  // Iniciar descarga del launcher
  ipc.handle('updater:download', [], async () => {
    refreshWindow()
    try {
      await autoUpdater.downloadUpdate()
      return { ok: true }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      log.warn('[Updater] downloadUpdate fallo:', msg)
      return { ok: false, message: msg }
    }
  })

  // Instalar y reiniciar
  ipc.handle('updater:install', [], () => {
    // quitAndInstall quits the launcher, which would kill a running game without warning
    if (hooks?.isGameRunning()) {
      throw new Error('Minecraft está abierto. La actualización se instalará cuando cierres el launcher.')
    }
    try {
      // isSilent=false para mostrar el instalador NSIS visualmente,
      // isForceRunAfter=true para que el launcher se abra después de instalar
      autoUpdater.quitAndInstall(false, true)
    } catch (err) {
      log.error('[Updater] quitAndInstall fallo:', err)
    }
  })

  // Obtener version actual del ejecutable
  ipc.handle('updater:get-version', [], () => {
    return app.getVersion()
  })
}

// ─── Comprobacion automatica al iniciar ──────────────────────────────────────

export function scheduleUpdateCheck(delay = 8000) {
  // Solo en produccion — en dev no hay actualizador real
  if (getConfig().devServerUrl) {
    log.info('[Updater] Modo desarrollo — comprobacion de actualizaciones desactivada.')
    return
  }
  if (isChecking) return

  setTimeout(async () => {
    if (isChecking) return
    isChecking = true
    try {
      await autoUpdater.checkForUpdates()
    } catch (err) {
      log.warn('[Updater] Comprobacion automatica fallida (no critico):', err)
      isChecking = false
    }
  }, delay)
}

// ─── Exponer setActiveWindow para que main.ts pueda actualizar cuando la ventana esté lista ──
export function setUpdaterWindow(win: BrowserWindow | null) {
  if (win && !win.isDestroyed()) {
    activeWindow = win
  }
}
