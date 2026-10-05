import { join } from 'node:path'
import { mkdir } from 'node:fs/promises'
import { app, BrowserWindow, ipcMain, Menu, Tray } from 'electron'
import { getConfig, initConfig } from './config'
import { createIpc } from './ipc'
import { initLogger, log } from './logger'
import { registerModsIpc } from './modManager'
import { setUserAgent } from './net'
import { isMinecraftRunning, killMinecraftProcess, registerLauncherIpc } from './services'
import { configureAutoUpdater, registerUpdaterIpc, scheduleUpdateCheck, setUpdaterWindow } from './updater'
import {
  createMainWindow,
  createSplashWindow,
  createTrayWindow,
  getTrayIcon,
  isTrustedAppUrl,
  lockDownSession,
  positionTrayWindow,
  showWindow
} from './windows'

// Application name shown in the Windows task manager and notifications
app.setName('Orvian')
if (process.platform === 'win32') {
  app.setAppUserModelId('com.orvian.launcher')
}
Menu.setApplicationMenu(null)
initConfig(app.isPackaged)

let mainWindow: BrowserWindow | null = null
let trayWindow: BrowserWindow | null = null
let tray: Tray | null = null
let isQuitting = false

function safeQuit(): void {
  if (isMinecraftRunning()) {
    if (mainWindow && !mainWindow.isDestroyed()) {
      showWindow(mainWindow)
      mainWindow.webContents.send('dialog:prompt-mc-quit')
      return
    }
    if (trayWindow && !trayWindow.isDestroyed() && trayWindow.isVisible()) {
      trayWindow.webContents.send('dialog:prompt-mc-quit')
      return
    }
  }
  isQuitting = true
  app.quit()
}

function toggleTrayWindow(): void {
  if (!tray) return
  if (!trayWindow || trayWindow.isDestroyed()) trayWindow = createTrayWindow()
  if (trayWindow.isVisible()) {
    trayWindow.hide()
    return
  }
  positionTrayWindow(trayWindow, tray)
  trayWindow.show()
  trayWindow.focus()
}

function createTray(): void {
  tray = new Tray(getTrayIcon())
  tray.setToolTip('Orvian Launcher')
  tray.on('click', toggleTrayWindow)
  tray.on('right-click', toggleTrayWindow)
  tray.on('double-click', () => {
    if (mainWindow && !mainWindow.isDestroyed()) showWindow(mainWindow)
    if (trayWindow?.isVisible()) trayWindow.hide()
  })
}

function createWindow(): void {
  mainWindow = createMainWindow({ shouldHideOnClose: () => !isQuitting })
  createTray()
}

function start(): void {
  const dataRoot = getConfig().dataDir ?? join(app.getPath('appData'), 'Orvian')
  initLogger({
    dir: join(dataRoot, 'launcher', 'logs'),
    level: app.isPackaged ? 'info' : 'debug',
    mirrorConsole: !app.isPackaged
  })
  setUserAgent(`OrvianLauncher/${app.getVersion()}`)
  log.info('Orvian Launcher %s arrancando (empaquetado: %s)', app.getVersion(), app.isPackaged)

  process.on('unhandledRejection', (reason) => log.error('unhandledRejection: %s', reason instanceof Error ? (reason.stack ?? reason.message) : String(reason)))
  process.on('uncaughtException', (err) => log.error('uncaughtException: %s', err.stack ?? err.message))

  app.on('second-instance', () => {
    if (mainWindow && !mainWindow.isDestroyed()) showWindow(mainWindow)
  })

  // Configure electron-updater before the app is ready
  configureAutoUpdater()

  app.whenReady().then(async () => {
    lockDownSession()

    // Splash first, before any work
    let splash = createSplashWindow()
    const splashStartTime = Date.now()

    await mkdir(join(dataRoot, 'launcher', 'logs'), { recursive: true })
    await mkdir(join(dataRoot, 'instances', 'orvian'), { recursive: true })

    const ipc = createIpc(ipcMain, { isTrustedUrl: isTrustedAppUrl })
    registerLauncherIpc(ipc, dataRoot)
    registerModsIpc(ipc, dataRoot)
    registerUpdaterIpc(ipc, () => mainWindow)

    ipc.handle('window:minimize', [], () => {
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.minimize()
    })
    ipc.handle('window:toggle-maximize', [], () => {
      if (!mainWindow || mainWindow.isDestroyed()) return false
      if (mainWindow.isMaximized()) mainWindow.unmaximize()
      else mainWindow.maximize()
      return mainWindow.isMaximized()
    })
    ipc.handle('window:is-maximized', [], () => (mainWindow && !mainWindow.isDestroyed() ? mainWindow.isMaximized() : false))
    ipc.handle('window:close', [], () => {
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.close()
    })
    ipc.handle('window:show-main', [], () => {
      if (mainWindow && !mainWindow.isDestroyed()) showWindow(mainWindow)
      if (trayWindow && !trayWindow.isDestroyed()) trayWindow.hide()
    })
    ipc.handle('window:hide-tray', [], () => {
      if (trayWindow && !trayWindow.isDestroyed()) trayWindow.hide()
    })
    ipc.handle('app:quit', [], () => {
      if (mainWindow) {
        safeQuit()
      } else {
        isQuitting = true
        app.quit()
      }
    })
    ipc.handle('app:is-mc-running', [], () => isMinecraftRunning())
    ipc.handle('app:force-quit', [], () => {
      killMinecraftProcess()
      isQuitting = true
      app.quit()
    })

    // The renderer reports once mounted; keep the splash up for at least minSplashMs
    let splashClosed = false
    const finishLoading = (): void => {
      if (splashClosed) return
      splashClosed = true
      if (mainWindow && !mainWindow.isDestroyed()) {
        // Connect the updater to the window before showing it so events arrive from the start
        setUpdaterWindow(mainWindow)
        mainWindow.show()
        mainWindow.focus()
      }
      if (splash && !splash.isDestroyed()) {
        splash.destroy()
        splash = null
      }
    }
    ipc.handle('app:ready', [], () => {
      const delay = Math.max(0, getConfig().minSplashMs - (Date.now() - splashStartTime))
      setTimeout(finishLoading, delay)
    })
    // Safety net: if the renderer never reports, still open the launcher
    setTimeout(finishLoading, getConfig().minSplashMs + 2500)

    createWindow()

    // Check for launcher updates in the background, delayed so the UI is not blocked
    scheduleUpdateCheck(8000)

    app.on('activate', () => {
      if (mainWindow && !mainWindow.isDestroyed()) showWindow(mainWindow)
      else if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })

  app.on('window-all-closed', () => {
    // On Windows/Linux closing every window quits, unless Minecraft is running in the tray
    if (process.platform !== 'darwin' && !isMinecraftRunning()) app.quit()
  })

  // Minecraft must never outlive the launcher
  app.on('before-quit', () => {
    isQuitting = true
    if (isMinecraftRunning()) killMinecraftProcess()
  })
  app.on('will-quit', () => killMinecraftProcess())
  process.on('exit', () => killMinecraftProcess())
  process.on('SIGINT', () => {
    killMinecraftProcess()
    process.exit(0)
  })
  process.on('SIGTERM', () => {
    killMinecraftProcess()
    process.exit(0)
  })
}

// Single-instance lock: a second launch only focuses the existing window
if (app.requestSingleInstanceLock()) {
  start()
} else {
  app.quit()
}
