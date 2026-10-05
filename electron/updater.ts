import { autoUpdater } from 'electron-updater'
import type { IpcMain, BrowserWindow } from 'electron'
import { app } from 'electron'

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
    console.log('[Updater] Comprobando actualizaciones del launcher...')
    send({ type: 'checking' })
  })

  autoUpdater.on('update-available', (info) => {
    console.log(`[Updater] Actualizacion del launcher disponible: v${info.version}`)
    // Anti-bucle: si ya descargamos esta versión, no volver a anunciarla
    if (downloadedVersion === info.version) {
      console.log('[Updater] Esta version ya fue descargada. Ignorando evento duplicado.')
      return
    }
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
    console.log('[Updater] El launcher ya esta en la ultima version.')
    send({ type: 'not-available', currentVersion: app.getVersion() })
    isChecking = false
  })

  autoUpdater.on('download-progress', (progress) => {
    send({
      type: 'downloading',
      percent: Math.round(progress.percent),
      bytesPerSecond: Math.round(progress.bytesPerSecond),
      transferred: progress.transferred,
      total: progress.total
    })
  })

  autoUpdater.on('update-downloaded', (info) => {
    console.log(`[Updater] Actualizacion del launcher descargada: v${info.version}`)
    downloadedVersion = info.version
    isChecking = false
    send({ type: 'downloaded', newVersion: info.version })
  })

  autoUpdater.on('error', (err) => {
    const msg = err?.message ?? String(err)
    console.warn('[Updater] Error (no critico):', msg)
    isChecking = false
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

export function registerUpdaterIpc(ipcMain: IpcMain, getMainWindow: () => BrowserWindow | null) {
  function refreshWindow() {
    const win = getMainWindow()
    if (win && !win.isDestroyed()) {
      activeWindow = win
    }
  }

  // Comprobar actualizaciones del launcher bajo demanda
  ipcMain.handle('updater:check', async () => {
    refreshWindow()
    if (isChecking) {
      console.log('[Updater] Comprobacion ya en curso, ignorando peticion duplicada.')
      return { ok: true }
    }
    isChecking = true
    try {
      await autoUpdater.checkForUpdates()
      return { ok: true }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.warn('[Updater] checkForUpdates fallo:', msg)
      isChecking = false
      return { ok: false, message: msg }
    }
  })

  // Iniciar descarga del launcher
  ipcMain.handle('updater:download', async () => {
    refreshWindow()
    try {
      await autoUpdater.downloadUpdate()
      return { ok: true }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.warn('[Updater] downloadUpdate fallo:', msg)
      return { ok: false, message: msg }
    }
  })

  // Instalar y reiniciar
  ipcMain.handle('updater:install', () => {
    try {
      // isSilent=false para mostrar el instalador NSIS visualmente,
      // isForceRunAfter=true para que el launcher se abra después de instalar
      autoUpdater.quitAndInstall(false, true)
    } catch (err) {
      console.error('[Updater] quitAndInstall fallo:', err)
    }
  })

  // Obtener version actual del ejecutable
  ipcMain.handle('updater:get-version', () => {
    return app.getVersion()
  })
}

// ─── Comprobacion automatica al iniciar ──────────────────────────────────────

export function scheduleUpdateCheck(delay = 8000) {
  // Solo en produccion — en dev no hay actualizador real
  if (process.env.VITE_DEV_SERVER_URL) {
    console.log('[Updater] Modo desarrollo — comprobacion de actualizaciones desactivada.')
    return
  }
  if (isChecking) return

  setTimeout(async () => {
    if (isChecking) return
    isChecking = true
    try {
      await autoUpdater.checkForUpdates()
    } catch (err) {
      console.warn('[Updater] Comprobacion automatica fallida (no critico):', err)
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
