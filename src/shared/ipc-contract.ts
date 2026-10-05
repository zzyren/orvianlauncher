import type { LauncherState } from './launcher-state'

/** Shape of `window.orvian`: the only bridge between the windows and the main process. */

export type FolderKind = 'mods' | 'shaders' | 'resourcepacks' | 'logs' | 'game' | 'crash-reports'
export type ModPlatform = 'modrinth' | 'curseforge'

export interface InstalledMod {
  filename: string
  isOfficial: boolean
  size: number
  dependencies: string[]
  requiredBy: string[]
  projectId?: string
  platform?: ModPlatform
}

export interface ModSearchHit {
  project_id: string
  title: string
  description: string
  icon_url: string
  author: string
  downloads?: number
}

export interface ModInstallResult {
  ok: boolean
  filename: string
  dependencies?: string[]
  failedDependencies?: string[]
}

export interface OrvianApi {
  // Launcher state, pushed by the main process
  getState(): Promise<LauncherState>
  onState(callback: (state: LauncherState) => void): () => void
  dismissError(): Promise<void>
  refreshServer(): Promise<void>
  /** Copies a redacted support report to the clipboard. */
  copyDiagnostics(): Promise<{ ok: boolean; lines: number }>

  // Game and modpack
  checkForUpdates(): Promise<{
    configured: boolean
    hasUpdate: boolean
    installedVersion?: string | null
    latestVersion?: string | null
    message: string
    offline?: boolean
    /** Estimated download size of the update, when there is one. */
    downloadBytes?: number
  }>
  repair(): Promise<{ ok: boolean; message: string }>
  play(options?: { quickPlay?: boolean; playInstalled?: boolean }): Promise<{ ok: boolean; message: string }>
  /** Ends the game process only; the launcher stays open. */
  killGame(): Promise<void>
  /** Pack defaults that were not applied because the player had edited those config files. */
  pendingConfigs(): Promise<{ files: string[] }>
  restorePendingConfigs(): Promise<{ restored: number }>
  discardPendingConfigs(): Promise<void>

  // Account and settings
  login(): Promise<{ ok: boolean; message: string; cancelled?: boolean }>
  /** Closes the Microsoft sign-in window if one is open. */
  cancelLogin(): Promise<{ ok: boolean }>
  logout(): Promise<{ ok: boolean }>
  setRam(gb: number): Promise<{ ok: boolean }>
  openFolder(kind: FolderKind): Promise<{ ok: boolean; error: string }>
  /** Wipes launcher data. Worlds, screenshots, packs and options are kept unless `deleteWorlds` is true. */
  resetInstallation(options?: { deleteWorlds: boolean }): Promise<{ ok: boolean; message: string; preserved: string[] }>
  openExternal(url: string): Promise<void>

  // Admin
  pickMrpack(): Promise<{ canceled: boolean; selectionId: string | null; fileName: string | null; size: number }>
  /** `minimumLauncher` is carried over from the published manifest unless given; raise it only when the pack needs a newer launcher. */
  publishUpdate(params: { selectionId: string; version: string; changelog: string; overwrite?: boolean; minimumLauncher?: string }): Promise<{ ok: boolean; releaseUrl: string; message: string }>
  onPublishProgress(callback: (event: { state: string; progress: number; detail: string }) => void): () => void
  /** The publishing token lives only in the main process; the renderer can never read it back. */
  adminTokenStatus(): Promise<{ hasToken: boolean; canEncrypt: boolean }>
  adminSetToken(token: string): Promise<{ ok: boolean; verified: boolean }>
  adminClearToken(): Promise<{ ok: boolean }>

  // Mods
  listMods(): Promise<InstalledMod[]>
  deleteMod(filename: string): Promise<{ ok: boolean }>
  searchModrinth(query: string): Promise<{ hits: ModSearchHit[] }>
  installModrinth(projectId: string): Promise<ModInstallResult>
  searchCurseForge(query: string): Promise<{ hits: ModSearchHit[] }>
  installCurseForge(modId: string | number): Promise<ModInstallResult>

  // Windows and application
  appReady(): Promise<void>
  minimizeWindow(): Promise<void>
  toggleMaximizeWindow(): Promise<boolean>
  isWindowMaximized(): Promise<boolean>
  closeWindow(): Promise<void>
  showMainWindow(): Promise<void>
  hideTrayWindow(): Promise<void>
  quitApp(): Promise<void>
  isMinecraftRunning(): Promise<boolean>
  forceQuit(): Promise<void>
  onPromptMcQuit(callback: () => void): () => void
  onWindowState(callback: (isMaximized: boolean) => void): () => void

  // Launcher self-update
  updaterCheck(): Promise<{ ok: boolean; message?: string }>
  updaterDownload(): Promise<{ ok: boolean; message?: string }>
  updaterInstall(): Promise<void>
}
