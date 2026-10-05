import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { app, BrowserWindow, nativeImage, screen, session, shell, type NativeImage, type Tray, type WebContents } from 'electron'
import { getConfig } from './config'
import { isAppUrl, type AppUrlContext } from './ipc'
import { log } from './logger'

/** Windows, icons and the rules that keep every window locked to the launcher's own page. */

/** Directory holding public assets: `public/` in development, the built `dist/` otherwise. */
function assetDir(): string {
  return join(app.getAppPath(), getConfig().devServerUrl ? 'public' : 'dist')
}

function appUrlContext(): AppUrlContext {
  return {
    indexFileUrl: pathToFileURL(join(app.getAppPath(), 'dist', 'index.html')).href,
    devServerUrl: getConfig().devServerUrl
  }
}

export function isTrustedAppUrl(url: string): boolean {
  return isAppUrl(url, appUrlContext())
}

function loadImage(name: string): NativeImage | undefined {
  const path = join(assetDir(), name)
  if (!existsSync(path)) return undefined
  const image = nativeImage.createFromPath(path)
  return image.isEmpty() ? undefined : image
}

export function getAppIcon(): NativeImage | undefined {
  return loadImage('logo.png') ?? loadImage('logo.ico')
}

export function getTrayIcon(): NativeImage {
  const image = loadImage('tray-icon.png') ?? getAppIcon()
  return image ? image.resize({ width: 16, height: 16 }) : nativeImage.createEmpty()
}

/** Opens `url` in the system browser, but only for https links. */
export function openExternalHttps(url: string): void {
  try {
    if (new URL(url).protocol === 'https:') void shell.openExternal(url)
  } catch {
    log.warn('[windows] URL externa rechazada')
  }
}

/** Blocks navigation away from the app page, popups into new windows, and webviews. */
function hardenAppContents(contents: WebContents): void {
  const guard = (event: Electron.Event, url: string): void => {
    if (!isTrustedAppUrl(url)) {
      event.preventDefault()
      log.warn('[windows] Navegación bloqueada hacia %s', url.split(/[?#]/)[0])
    }
  }
  contents.on('will-navigate', guard)
  contents.on('will-redirect', guard)
  contents.on('will-attach-webview', (event) => event.preventDefault())
  contents.setWindowOpenHandler(({ url }) => {
    openExternalHttps(url)
    return { action: 'deny' }
  })
}

/** The renderer never needs device permissions (camera, location, notifications, ...). */
export function lockDownSession(): void {
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
  session.defaultSession.setPermissionCheckHandler(() => false)
}

function appWebPreferences(): Electron.WebPreferences {
  return { preload: join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true }
}

function loadRenderer(win: BrowserWindow, hash?: string): void {
  const devServerUrl = getConfig().devServerUrl
  const loading = devServerUrl
    ? win.loadURL(hash ? `${devServerUrl}#${hash}` : devServerUrl)
    : win.loadFile(join(app.getAppPath(), 'dist', 'index.html'), hash ? { hash } : undefined)
  loading.catch((err: unknown) => log.error('[windows] No se pudo cargar la interfaz: %s', String(err)))
}

export function showWindow(win: BrowserWindow): void {
  if (win.isMinimized()) win.restore()
  if (!win.isVisible()) win.show()
  win.focus()
}

export function createMainWindow(options: { shouldHideOnClose: () => boolean }): BrowserWindow {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1120,
    minHeight: 720,
    backgroundColor: '#0a0e13',
    title: 'Orvian Launcher',
    frame: false,
    show: false,
    autoHideMenuBar: true,
    icon: getAppIcon(),
    webPreferences: appWebPreferences()
  })

  // Closing the window sends the launcher to the tray unless the app is really quitting.
  win.on('close', (event) => {
    if (options.shouldHideOnClose()) {
      event.preventDefault()
      win.hide()
    }
  })
  win.on('maximize', () => win.webContents.send('window:state-changed', { isMaximized: true }))
  win.on('unmaximize', () => win.webContents.send('window:state-changed', { isMaximized: false }))

  hardenAppContents(win.webContents)
  loadRenderer(win)
  return win
}

export function createTrayWindow(): BrowserWindow {
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
    webPreferences: appWebPreferences()
  })
  win.on('blur', () => {
    if (!win.webContents.isDevToolsOpened()) win.hide()
  })
  hardenAppContents(win.webContents)
  loadRenderer(win, 'tray')
  return win
}

/** Places the quick menu next to the tray icon, kept inside the visible work area. */
export function positionTrayWindow(trayWindow: BrowserWindow, tray: Tray): void {
  const trayBounds = tray.getBounds()
  const winBounds = trayWindow.getBounds()
  const { workArea } = screen.getDisplayNearestPoint({ x: trayBounds.x, y: trayBounds.y })

  let x = Math.round(trayBounds.x + trayBounds.width / 2 - winBounds.width / 2)
  let y = Math.round(trayBounds.y - winBounds.height - 12)
  if (x + winBounds.width > workArea.x + workArea.width) x = workArea.x + workArea.width - winBounds.width - 12
  if (x < workArea.x) x = workArea.x + 12
  if (y < workArea.y) {
    y = Math.min(workArea.y + workArea.height - winBounds.height - 12, trayBounds.y + trayBounds.height + 10)
  }
  trayWindow.setPosition(x, y, false)
}

/** Shows what the launcher is really doing on the splash screen. Never throws: the splash is cosmetic. */
export function setSplashStatus(splash: BrowserWindow | null, label: string, fraction: number): void {
  if (!splash || splash.isDestroyed()) return
  splash.webContents
    .executeJavaScript(`window.setSplash && window.setSplash(${JSON.stringify(label)}, ${Number(fraction)})`)
    .catch((err: unknown) => log.debug('[windows] No se pudo actualizar la splash: %s', String(err)))
}

export function createSplashWindow(): BrowserWindow | null {
  const splashPath = join(assetDir(), 'splash.html')
  if (!existsSync(splashPath)) {
    log.warn('[windows] splash.html no encontrado en %s', assetDir())
    return null
  }
  const splash = new BrowserWindow({
    width: 380,
    height: 480,
    backgroundColor: '#0a0e13',
    frame: false,
    alwaysOnTop: true,
    resizable: false,
    center: true,
    show: true,
    skipTaskbar: true,
    icon: getAppIcon(),
    webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true }
  })
  splash.webContents.on('will-navigate', (event) => event.preventDefault())
  splash.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  splash.loadFile(splashPath).catch((err: unknown) => log.error('[windows] Error cargando la splash: %s', String(err)))
  splash.focus()
  return splash
}
