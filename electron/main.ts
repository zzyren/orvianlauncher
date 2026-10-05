import { app, BrowserWindow, Menu, Tray, nativeImage, ipcMain, shell, screen } from 'electron'
import { join } from 'node:path'
import { existsSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { registerLauncherIpc, isMinecraftRunning, killMinecraftProcess } from './services'
import { registerModsIpc } from './modManager'
import { configureAutoUpdater, registerUpdaterIpc, scheduleUpdateCheck, setUpdaterWindow } from './updater'

// Configuración del nombre de la aplicación para el Administrador de tareas y Windows
app.setName('Orvian')
if (process.platform === 'win32') {
  app.setAppUserModelId('com.orvian.launcher')
}

// Eliminar el menú por defecto de Electron ("File Edit View Window Help")
Menu.setApplicationMenu(null)

const isDev = Boolean(process.env.VITE_DEV_SERVER_URL)
let mainWindow: BrowserWindow | null = null
let tray: Tray | null = null
let isQuitting = false

function getAppIcon() {
  const candidates = [
    join(app.getAppPath(), 'public', 'logo.png'),
    join(app.getAppPath(), 'public', 'logo.ico'),
    join(app.getAppPath(), 'dist', 'logo.png'),
    join(app.getAppPath(), 'dist', 'logo.ico'),
    join(app.getAppPath(), 'build', 'icon.ico'),
    join(__dirname, '..', '..', 'public', 'logo.png'),
    join(__dirname, '..', 'public', 'logo.png')
  ]
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      const img = nativeImage.createFromPath(candidate)
      if (!img.isEmpty()) {
        return img
      }
    }
  }
  return undefined
}

function getTrayIcon() {
  const candidates = [
    join(app.getAppPath(), 'public', 'tray-icon.png'),
    join(app.getAppPath(), 'public', 'logo.png'),
    join(app.getAppPath(), 'dist', 'tray-icon.png'),
    join(app.getAppPath(), 'dist', 'logo.png'),
    join(__dirname, '..', '..', 'public', 'tray-icon.png'),
    join(__dirname, '..', 'public', 'tray-icon.png'),
    join(__dirname, '..', '..', 'public', 'logo.png')
  ]
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      const img = nativeImage.createFromPath(candidate)
      if (!img.isEmpty()) {
        return img.resize({ width: 16, height: 16 })
      }
    }
  }
  const fallback = getAppIcon()
  if (fallback && !fallback.isEmpty()) {
    return fallback.resize({ width: 16, height: 16 })
  }
  return nativeImage.createEmpty()
}

function showWindow(win: BrowserWindow) {
  if (win.isMinimized()) win.restore()
  if (!win.isVisible()) win.show()
  win.focus()
}

function safeQuit() {
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

let trayWindow: BrowserWindow | null = null

function createTrayWindow() {
  const win = new BrowserWindow({
    width: 370,
    height: 490,
    show: false,
    frame: false,
    fullscreenable: false,
    resizable: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    skipTaskbar: true,
    icon: getAppIcon(),
    webPreferences: {
      preload: join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })

  // Cargar frontend con el hash #tray
  if (isDev) {
    void win.loadURL(`${process.env.VITE_DEV_SERVER_URL!}#tray`)
  } else {
    void win.loadURL(`file://${join(app.getAppPath(), 'dist/index.html')}#tray`)
  }

  win.on('blur', () => {
    if (!win.webContents.isDevToolsOpened()) {
      win.hide()
    }
  })

  return win
}

function toggleTrayWindow() {
  if (!trayWindow) trayWindow = createTrayWindow()
  
  if (trayWindow.isVisible()) {
    trayWindow.hide()
  } else {
    const trayBounds = tray!.getBounds()
    const winBounds = trayWindow.getBounds()
    const display = screen.getDisplayNearestPoint({ x: trayBounds.x, y: trayBounds.y })
    const workArea = display.workArea
    
    // Posicionar la ventana encima del tray (Windows 11 / 10)
    let x = Math.round(trayBounds.x + (trayBounds.width / 2) - (winBounds.width / 2))
    let y = Math.round(trayBounds.y - winBounds.height - 12)
    
    // Asegurar que no se salga de la pantalla visible
    if (x + winBounds.width > workArea.x + workArea.width) {
      x = workArea.x + workArea.width - winBounds.width - 12
    }
    if (x < workArea.x) {
      x = workArea.x + 12
    }
    if (y < workArea.y) {
      y = Math.min(workArea.y + workArea.height - winBounds.height - 12, trayBounds.y + trayBounds.height + 10)
    }

    trayWindow.setPosition(x, y, false)
    trayWindow.show()
    trayWindow.focus()
  }
}

function createTray() {
  const icon = getTrayIcon()
  tray = new Tray(icon)
  tray.setToolTip('Orvian Launcher')

  tray.on('click', toggleTrayWindow)
  tray.on('right-click', toggleTrayWindow)
  tray.on('double-click', () => {
    showWindow(mainWindow!)
    if (trayWindow?.isVisible()) trayWindow.hide()
  })
}

// Bloqueo de instancia única: si ya está abierto, enfocar la ventana existente
const gotTheLock = app.requestSingleInstanceLock()
if (!gotTheLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      showWindow(mainWindow)
    }
  })
}

async function createWindow() {
  const appIcon = getAppIcon()

  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1120,
    minHeight: 720,
    backgroundColor: '#090b0c',
    title: 'Orvian Launcher',
    frame: false,
    show: false,
    autoHideMenuBar: true,
    icon: appIcon,
    webPreferences: {
      preload: join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })

  mainWindow = win

  // Interceptar el cierre: minimizar a la bandeja en lugar de cerrar
  win.on('close', (event) => {
    if (!isQuitting) {
      event.preventDefault()
      win.hide()
    }
  })

  win.on('maximize', () => {
    win.webContents.send('window:state-changed', { isMaximized: true })
  })

  win.on('unmaximize', () => {
    win.webContents.send('window:state-changed', { isMaximized: false })
  })

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) void shell.openExternal(url)
    return { action: 'deny' }
  })

  if (isDev) {
    void win.loadURL(process.env.VITE_DEV_SERVER_URL!)
  } else {
    void win.loadFile(join(app.getAppPath(), 'dist/index.html'))
  }

  createTray()
}

// Configurar electron-updater antes de que la app esté lista
configureAutoUpdater()

app.whenReady().then(async () => {
  const appIcon = getAppIcon()

  // ─── SPLASH SCREEN: mostrar inmediatamente antes de cualquier trabajo ───
  function findSplashPath(): string | null {
    const candidates = [
      join(app.getAppPath(), 'public', 'splash.html'),
      join(app.getAppPath(), 'dist', 'splash.html'),
      join(__dirname, '..', '..', 'public', 'splash.html'),
      join(__dirname, '..', 'public', 'splash.html'),
      join(__dirname, '..', 'dist', 'splash.html'),
      join(process.cwd(), 'public', 'splash.html'),
      join(process.cwd(), 'dist', 'splash.html')
    ]
    for (const p of candidates) {
      if (existsSync(p)) return p
    }
    return null
  }

  const splashPath = findSplashPath()
  let splash: BrowserWindow | null = null
  const splashStartTime = Date.now()
  const MIN_SPLASH_TIME = 5000 // Garantizar al menos 5 segundos de pantalla de carga como pidió el usuario

  if (splashPath) {
    splash = new BrowserWindow({
      width: 380,
      height: 480,
      backgroundColor: '#07090b',
      frame: false,
      alwaysOnTop: true,
      resizable: false,
      center: true,
      show: true,
      skipTaskbar: true,
      icon: appIcon,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true
      }
    })
    splash.loadFile(splashPath).catch((err) => {
      console.error('[Splash] Error cargando splash:', err)
    })
    splash.show()
    splash.focus()
  }

  // ─── SETUP EN SEGUNDO PLANO (mientras se ve la pantalla de carga) ───
  const root = join(app.getPath('appData'), 'Orvian')
  await mkdir(join(root, 'launcher', 'logs'), { recursive: true })
  await mkdir(join(root, 'instances', 'orvian'), { recursive: true })
  registerLauncherIpc(ipcMain, root)
  registerModsIpc(ipcMain, root)
  registerUpdaterIpc(ipcMain, () => mainWindow)

  ipcMain.handle('window:minimize', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.minimize()
    }
  })

  ipcMain.handle('window:toggle-maximize', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (mainWindow.isMaximized()) {
        mainWindow.unmaximize()
      } else {
        mainWindow.maximize()
      }
      return mainWindow.isMaximized()
    }
    return false
  })

  ipcMain.handle('window:is-maximized', () => {
    return mainWindow && !mainWindow.isDestroyed() ? mainWindow.isMaximized() : false
  })

  ipcMain.handle('window:close', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.close()
    }
  })

  ipcMain.handle('window:show-main', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      showWindow(mainWindow)
    }
    if (trayWindow && !trayWindow.isDestroyed()) {
      trayWindow.hide()
    }
  })

  ipcMain.handle('window:hide-tray', () => {
    if (trayWindow && !trayWindow.isDestroyed()) {
      trayWindow.hide()
    }
  })

  ipcMain.handle('app:quit', () => {
    if (mainWindow) {
      safeQuit()
    } else {
      isQuitting = true
      app.quit()
    }
  })

  ipcMain.handle('app:is-mc-running', () => {
    return isMinecraftRunning()
  })

  ipcMain.handle('app:force-quit', () => {
    killMinecraftProcess()
    isQuitting = true
    app.quit()
  })

  // app:ready: React avisa cuando está montado → esperar al menos MIN_SPLASH_TIME antes de cambiar a la ventana principal
  let splashClosed = false
  const finishLoading = () => {
    if (splashClosed) return
    splashClosed = true

    if (mainWindow && !mainWindow.isDestroyed()) {
      // Conectar el updater con la ventana antes de mostrarla
      // para que los eventos de electron-updater lleguen desde el primer momento
      setUpdaterWindow(mainWindow)
      mainWindow.show()
      mainWindow.focus()
    }
    if (splash && !splash.isDestroyed()) {
      splash.destroy()
      splash = null
    }
  }

  ipcMain.handle('app:ready', () => {
    const elapsed = Date.now() - splashStartTime
    const delay = Math.max(0, MIN_SPLASH_TIME - elapsed)
    setTimeout(() => {
      finishLoading()
    }, delay)
  })

  // Fallback de seguridad: si React tarda o falla, garantizar que el launcher se abra
  setTimeout(() => {
    finishLoading()
  }, 7500)

  await createWindow()

  // Comprobar actualizaciones en segundo plano, con retardo para no bloquear la UI
  scheduleUpdateCheck(8000)

  app.on('activate', () => {
    if (mainWindow) {
      showWindow(mainWindow)
    } else if (BrowserWindow.getAllWindows().length === 0) {
      void createWindow()
    }
  })
})

app.on('window-all-closed', () => {
  // En Windows/Linux, cerrar todas las ventanas debería matar la app,
  // A MENOS que estemos jugando a Minecraft, en cuyo caso la app sigue viva en tray/segundo plano.
  if (process.platform !== 'darwin' && !isMinecraftRunning()) {
    app.quit()
  }
})

// Garantía de que Minecraft se termine bajo cualquier circunstancia antes de que el launcher muera
app.on('before-quit', () => {
  isQuitting = true
  if (isMinecraftRunning()) {
    killMinecraftProcess()
  }
})

app.on('will-quit', () => {
  killMinecraftProcess()
})

process.on('exit', () => {
  killMinecraftProcess()
})

process.on('SIGINT', () => {
  killMinecraftProcess()
  process.exit(0)
})

process.on('SIGTERM', () => {
  killMinecraftProcess()
  process.exit(0)
})
