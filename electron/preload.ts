import { contextBridge, ipcRenderer } from 'electron'
import type { UpdaterEvent } from './updater'

const api = {
  getStatus: (opts?: { fresh?: boolean }) => ipcRenderer.invoke('launcher:status', opts),
  checkForUpdates: () => ipcRenderer.invoke('pack:check'),
  repair: () => ipcRenderer.invoke('pack:repair'),
  play: (options?: { quickPlay?: boolean; playInstalled?: boolean }) => ipcRenderer.invoke('game:play', options),
  login: () => ipcRenderer.invoke('account:login'),
  cancelLogin: () => ipcRenderer.invoke('account:cancel-login'),
  logout: () => ipcRenderer.invoke('account:logout'),
  setRam: (gb: number) => ipcRenderer.invoke('settings:ram', gb),
  openFolder: (kind: 'mods' | 'shaders' | 'resourcepacks' | 'logs') => ipcRenderer.invoke('folder:open', kind),
  resetInstallation: (options: { deleteWorlds: boolean } = { deleteWorlds: false }) => ipcRenderer.invoke('launcher:reset', options),
  pickMrpack: () => ipcRenderer.invoke('admin:pick-archive'),
  publishUpdate: (params: { selectionId: string; version: string; changelog: string; overwrite?: boolean; minimumLauncher?: string }) =>
    ipcRenderer.invoke('admin:publish', params),
  adminTokenStatus: () => ipcRenderer.invoke('admin:token-status'),
  adminSetToken: (token: string) => ipcRenderer.invoke('admin:token-set', token),
  adminClearToken: () => ipcRenderer.invoke('admin:token-clear'),
  openExternal: (url: string) => ipcRenderer.invoke('url:open', url),
  listMods: () => ipcRenderer.invoke('mods:list'),
  deleteMod: (filename: string) => ipcRenderer.invoke('mods:delete', filename),
  searchModrinth: (query: string) => ipcRenderer.invoke('mods:search-modrinth', query),
  installModrinth: (projectId: string) => ipcRenderer.invoke('mods:install-modrinth', projectId),
  searchCurseForge: (query: string) => ipcRenderer.invoke('mods:search-curseforge', query),
  installCurseForge: (modId: string | number) => ipcRenderer.invoke('mods:install-curseforge', modId),
  appReady: () => ipcRenderer.invoke('app:ready'),
  minimizeWindow: () => ipcRenderer.invoke('window:minimize'),
  toggleMaximizeWindow: () => ipcRenderer.invoke('window:toggle-maximize'),
  closeWindow: () => ipcRenderer.invoke('window:close'),
  showMainWindow: () => ipcRenderer.invoke('window:show-main'),
  hideTrayWindow: () => ipcRenderer.invoke('window:hide-tray'),
  quitApp: () => ipcRenderer.invoke('app:quit'),
  isMinecraftRunning: () => ipcRenderer.invoke('app:is-mc-running'),
  forceQuit: () => ipcRenderer.invoke('app:force-quit'),
  onPromptMcQuit: (callback: () => void) => {
    const listener = () => callback()
    ipcRenderer.on('dialog:prompt-mc-quit', listener)
    return () => ipcRenderer.removeListener('dialog:prompt-mc-quit', listener)
  },
  onStatusUpdate: (callback: (status: any) => void) => {
    const listener = (_: Electron.IpcRendererEvent, data: any) => callback(data)
    ipcRenderer.on('launcher:status-update', listener)
    return () => ipcRenderer.removeListener('launcher:status-update', listener)
  },
  /** 
   * Escucha actualizaciones de estado del modpack enviadas proactivamente por el main process.
   * Emitido cuando el background polling detecta un cambio de versión o cuando pack:check se ejecuta.
   */
  onPackStatus: (callback: (status: PackStatus) => void) => {
    const listener = (_: Electron.IpcRendererEvent, data: PackStatus) => callback(data)
    ipcRenderer.on('pack:status', listener)
    return () => ipcRenderer.removeListener('pack:status', listener)
  },
  onWindowState: (callback: (isMaximized: boolean) => void) => {
    const listener = (_: Electron.IpcRendererEvent, data: { isMaximized: boolean }) => callback(data.isMaximized)
    ipcRenderer.on('window:state-changed', listener)
    return () => ipcRenderer.removeListener('window:state-changed', listener)
  },
  onProgress: (callback: (event: LauncherProgress) => void) => {
    const listener = (_: Electron.IpcRendererEvent, event: LauncherProgress) => callback(event)
    ipcRenderer.on('launcher:progress', listener)
    return () => ipcRenderer.removeListener('launcher:progress', listener)
  },
  // ─── Auto-updater del launcher ────────────────────────────────────────────
  updaterCheck: () => ipcRenderer.invoke('updater:check'),
  updaterDownload: () => ipcRenderer.invoke('updater:download'),
  updaterInstall: () => ipcRenderer.invoke('updater:install'),
  updaterGetVersion: () => ipcRenderer.invoke('updater:get-version'),
  onUpdaterEvent: (callback: (event: UpdaterEvent) => void) => {
    const listener = (_: Electron.IpcRendererEvent, event: UpdaterEvent) => callback(event)
    ipcRenderer.on('updater:event', listener)
    return () => ipcRenderer.removeListener('updater:event', listener)
  }
}

contextBridge.exposeInMainWorld('orvian', api)
export type LauncherProgress = {
  state: string
  /** Overall progress from 0 to 1. */
  progress: number
  detail: string
  step?: 'java' | 'minecraft' | 'forge' | 'libraries' | 'modpack' | 'finalizing'
  current?: number
  total?: number
  bytesDone?: number
  bytesTotal?: number
  bytesPerSecond?: number
}
export type PackStatus = { installedVersion: string | null; latestVersion: string | null; hasUpdate: boolean }
export type { UpdaterEvent }
