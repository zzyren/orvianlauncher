import { contextBridge, ipcRenderer } from 'electron'
// Only `import type` is allowed here: the sandboxed preload cannot require local modules.
import type { LauncherState } from '../src/shared/launcher-state'

/** Subscribes to a push channel and returns the function that unsubscribes. */
function subscribe<T>(channel: string, callback: (payload: T) => void): () => void {
  const listener = (_: Electron.IpcRendererEvent, payload: T): void => callback(payload)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

const api = {
  // ─── Launcher state (pushed by the main process) ──────────────────────────
  getState: (): Promise<LauncherState> => ipcRenderer.invoke('launcher:get-state'),
  onState: (callback: (state: LauncherState) => void) => subscribe('launcher:state', callback),
  dismissError: () => ipcRenderer.invoke('launcher:dismiss-error'),
  refreshServer: () => ipcRenderer.invoke('server:refresh'),
  copyDiagnostics: () => ipcRenderer.invoke('diagnostics:copy'),

  // ─── Game and modpack ─────────────────────────────────────────────────────
  checkForUpdates: () => ipcRenderer.invoke('pack:check'),
  repair: () => ipcRenderer.invoke('pack:repair'),
  play: (options?: { quickPlay?: boolean; playInstalled?: boolean }) => ipcRenderer.invoke('game:play', options),
  killGame: () => ipcRenderer.invoke('game:kill'),
  pendingConfigs: () => ipcRenderer.invoke('pack:pending-configs'),
  restorePendingConfigs: () => ipcRenderer.invoke('pack:restore-configs'),
  discardPendingConfigs: () => ipcRenderer.invoke('pack:discard-configs'),

  // ─── Account and settings ─────────────────────────────────────────────────
  login: () => ipcRenderer.invoke('account:login'),
  cancelLogin: () => ipcRenderer.invoke('account:cancel-login'),
  logout: () => ipcRenderer.invoke('account:logout'),
  setRam: (gb: number) => ipcRenderer.invoke('settings:ram', gb),
  openFolder: (kind: 'mods' | 'shaders' | 'resourcepacks' | 'logs' | 'game' | 'crash-reports') => ipcRenderer.invoke('folder:open', kind),
  resetInstallation: (options: { deleteWorlds: boolean } = { deleteWorlds: false }) => ipcRenderer.invoke('launcher:reset', options),
  openExternal: (url: string) => ipcRenderer.invoke('url:open', url),

  // ─── Admin ────────────────────────────────────────────────────────────────
  pickMrpack: () => ipcRenderer.invoke('admin:pick-archive'),
  publishUpdate: (params: { selectionId: string; version: string; changelog: string; overwrite?: boolean; minimumLauncher?: string }) =>
    ipcRenderer.invoke('admin:publish', params),
  onPublishProgress: (callback: (event: { state: string; progress: number; detail: string }) => void) => subscribe('admin:progress', callback),
  adminTokenStatus: () => ipcRenderer.invoke('admin:token-status'),
  adminSetToken: (token: string) => ipcRenderer.invoke('admin:token-set', token),
  adminClearToken: () => ipcRenderer.invoke('admin:token-clear'),

  // ─── Mods ─────────────────────────────────────────────────────────────────
  listMods: () => ipcRenderer.invoke('mods:list'),
  deleteMod: (filename: string) => ipcRenderer.invoke('mods:delete', filename),
  searchModrinth: (query: string) => ipcRenderer.invoke('mods:search-modrinth', query),
  installModrinth: (projectId: string) => ipcRenderer.invoke('mods:install-modrinth', projectId),
  searchCurseForge: (query: string) => ipcRenderer.invoke('mods:search-curseforge', query),
  installCurseForge: (modId: string | number) => ipcRenderer.invoke('mods:install-curseforge', modId),

  // ─── Windows and application ──────────────────────────────────────────────
  appReady: () => ipcRenderer.invoke('app:ready'),
  minimizeWindow: () => ipcRenderer.invoke('window:minimize'),
  toggleMaximizeWindow: () => ipcRenderer.invoke('window:toggle-maximize'),
  isWindowMaximized: () => ipcRenderer.invoke('window:is-maximized'),
  closeWindow: () => ipcRenderer.invoke('window:close'),
  showMainWindow: () => ipcRenderer.invoke('window:show-main'),
  hideTrayWindow: () => ipcRenderer.invoke('window:hide-tray'),
  quitApp: () => ipcRenderer.invoke('app:quit'),
  isMinecraftRunning: () => ipcRenderer.invoke('app:is-mc-running'),
  forceQuit: () => ipcRenderer.invoke('app:force-quit'),
  onPromptMcQuit: (callback: () => void) => subscribe('dialog:prompt-mc-quit', callback),
  onWindowState: (callback: (isMaximized: boolean) => void) =>
    subscribe<{ isMaximized: boolean }>('window:state-changed', (data) => callback(data.isMaximized)),

  // ─── Launcher self-update ─────────────────────────────────────────────────
  updaterCheck: () => ipcRenderer.invoke('updater:check'),
  updaterDownload: () => ipcRenderer.invoke('updater:download'),
  updaterInstall: () => ipcRenderer.invoke('updater:install')
}

contextBridge.exposeInMainWorld('orvian', api)
