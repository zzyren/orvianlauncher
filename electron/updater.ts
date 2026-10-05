import { autoUpdater } from 'electron-updater'
import { app } from 'electron'
import type { UpdaterState } from '../src/shared/launcher-state'
import { getConfig } from './config'
import type { Ipc } from './ipc'
import { log } from './logger'

/**
 * Self-update of the launcher through electron-updater. The windows never talk to it directly:
 * its state is reported to the launcher store (`bindUpdater`) and shown in the status bar.
 */

export interface UpdaterHooks {
  /** Receives every change of the launcher-update state. */
  onState: (state: UpdaterState) => void
  isGameRunning: () => boolean
}

let hooks: UpdaterHooks | null = null
let current: UpdaterState = { status: 'idle', currentVersion: '' }
/** Version already downloaded; avoids announcing it again. */
let downloadedVersion: string | null = null
let isChecking = false

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

/** Messages that only mean "there is no real updater here" (development builds, missing feed). */
const ENVIRONMENT_ERRORS = ['net::ERR_', 'dev mode', 'ENOENT', 'Cannot find module']

export function configureAutoUpdater(): void {
  // The launcher draws its own UI: no native dialogs and no download without the player's consent
  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = false
  // Stable channel only, never a pre-release by accident
  autoUpdater.channel = 'latest'
  autoUpdater.allowDowngrade = false
  autoUpdater.allowPrerelease = false

  autoUpdater.on('checking-for-update', () => {
    log.info('[Updater] Comprobando actualizaciones del launcher...')
    // A background check must not flicker the UI of a state that is already past it
    if (current.status === 'idle' || current.status === 'error') setState({ status: 'checking' })
  })

  autoUpdater.on('update-available', (info) => {
    log.info('[Updater] Actualización del launcher disponible: v%s', info.version)
    if (downloadedVersion === info.version) {
      log.info('[Updater] Esa versión ya está descargada; se ignora el aviso duplicado.')
      return
    }
    setState({ status: 'available', newVersion: info.version })
  })

  autoUpdater.on('update-not-available', () => {
    log.info('[Updater] El launcher ya está en la última versión.')
    if (current.status === 'checking') setState({ status: 'idle' })
    isChecking = false
  })

  autoUpdater.on('download-progress', (progress) => {
    setState({ status: 'downloading', newVersion: current.newVersion, percent: Math.round(progress.percent), bytesPerSecond: Math.round(progress.bytesPerSecond) })
  })

  autoUpdater.on('update-downloaded', (info) => {
    log.info('[Updater] Actualización del launcher descargada: v%s', info.version)
    downloadedVersion = info.version
    isChecking = false
    // Once downloaded it installs when the launcher is closed normally, even if restart is never pressed
    autoUpdater.autoInstallOnAppQuit = true
    setState({ status: 'downloaded', newVersion: info.version })
  })

  autoUpdater.on('error', (err) => {
    const message = err?.message ?? String(err)
    log.warn('[Updater] Error (no crítico): %s', message)
    isChecking = false
    if (current.status === 'downloaded') return
    if (ENVIRONMENT_ERRORS.some((fragment) => message.includes(fragment))) {
      if (current.status !== 'idle') setState({ status: 'idle' })
      return
    }
    setState({ status: 'error', newVersion: current.newVersion, message })
  })
}

export function registerUpdaterIpc(ipc: Ipc): void {
  ipc.handle('updater:check', [], async () => {
    if (isChecking) {
      log.info('[Updater] Comprobación ya en curso; se ignora la petición duplicada.')
      return { ok: true }
    }
    isChecking = true
    try {
      await autoUpdater.checkForUpdates()
      return { ok: true }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      log.warn('[Updater] checkForUpdates falló: %s', message)
      isChecking = false
      return { ok: false, message }
    }
  })

  ipc.handle('updater:download', [], async () => {
    try {
      await autoUpdater.downloadUpdate()
      return { ok: true }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      log.warn('[Updater] downloadUpdate falló: %s', message)
      return { ok: false, message }
    }
  })

  ipc.handle('updater:install', [], () => {
    // quitAndInstall quits the launcher, which would kill a running game without warning
    if (hooks?.isGameRunning()) {
      throw new Error('Minecraft está abierto. La actualización se instalará cuando cierres el launcher.')
    }
    try {
      // Visible installer (isSilent=false) and relaunch afterwards (isForceRunAfter=true)
      autoUpdater.quitAndInstall(false, true)
    } catch (err) {
      log.error('[Updater] quitAndInstall falló: %s', String(err))
    }
  })
}

/** Background check shortly after start; skipped in development, where there is no real feed. */
export function scheduleUpdateCheck(delay = 8000): void {
  if (getConfig().devServerUrl) {
    log.info('[Updater] Modo desarrollo: comprobación de actualizaciones desactivada.')
    return
  }
  if (isChecking) return

  setTimeout(() => {
    if (isChecking) return
    isChecking = true
    autoUpdater.checkForUpdates().catch((err: unknown) => {
      log.warn('[Updater] Comprobación automática fallida (no crítico): %s', String(err))
      isChecking = false
    })
  }, delay)
}
