import type { LauncherProgress, UpdaterEvent, PackStatus } from '../../electron/preload'

declare global {
  interface Window {
    orvian: {
      /** Obtiene el estado actual del launcher. Pasar fresh:true para forzar un fetch de red del manifest. */
      getStatus(opts?: { fresh?: boolean }): Promise<{
        appVersion: string
        packVersion: string | null
        installedVersion: string | null
        hasUpdate: boolean
        ready: boolean
        authenticated: boolean
        playerName: string | null
        playerUuid: string | null
        isAdmin: boolean
        ramGb: number
        configured: boolean
        isPlaying?: boolean
      }>
      /** Fuerza una comprobación de actualización del modpack contra GitHub. */
      checkForUpdates(): Promise<{
        configured: boolean
        hasUpdate: boolean
        installedVersion: string | null
        latestVersion: string | null
        message: string
      }>
      repair(): Promise<{ ok: boolean; message: string }>
      play(): Promise<{ ok: boolean; message: string }>
      login(): Promise<{ ok: boolean; message: string }>
      logout(): Promise<{ ok: boolean }>
      setRam(gb: number): Promise<{ ok: boolean }>
      openFolder(kind: 'mods' | 'shaders' | 'resourcepacks' | 'logs'): Promise<{ ok: boolean; error: string }>
      resetInstallation(): Promise<{ ok: boolean; message: string }>
      pickMrpack(): Promise<{ canceled: boolean; filePath: string | null; fileName: string | null }>
      publishUpdate(params: { mrpackPath: string; version: string; changelog: string; githubToken: string }): Promise<{ ok: boolean; releaseUrl: string; message: string }>
      openExternal(url: string): Promise<void>
      listMods(): Promise<Array<{ filename: string; isOfficial: boolean; size: number; dependencies: string[]; requiredBy: string[] }>>
      deleteMod(filename: string): Promise<{ ok: boolean }>
      searchModrinth(query: string): Promise<{ hits: Array<{ project_id: string; title: string; description: string; icon_url: string; author: string }> }>
      installModrinth(projectId: string): Promise<{ ok: boolean; filename: string; dependencies?: string[] }>
      searchCurseForge(query: string): Promise<{ hits: Array<{ project_id: string; title: string; description: string; icon_url: string; author: string; downloads?: number }> }>
      installCurseForge(modId: string | number): Promise<{ ok: boolean; filename: string; dependencies?: string[] }>
      minimizeWindow(): Promise<void>
      toggleMaximizeWindow(): Promise<boolean>
      closeWindow(): Promise<void>
      showMainWindow(): Promise<void>
      hideTrayWindow(): Promise<void>
      quitApp(): Promise<void>
      isMinecraftRunning(): Promise<boolean>
      forceQuit(): Promise<void>
      appReady?(): Promise<void>
      onPromptMcQuit?(callback: () => void): () => void
      onStatusUpdate?(callback: (status: any) => void): () => void
      /** 
       * Suscribirse a notificaciones proactivas de estado del modpack.
       * El main process emite este evento cuando detecta un cambio de versión
       * sin necesidad de que el renderer haga polling.
       */
      onPackStatus(callback: (status: PackStatus) => void): () => void
      onWindowState?(callback: (isMaximized: boolean) => void): () => void
      onProgress(callback: (event: LauncherProgress) => void): () => void
      // Auto-updater del launcher
      updaterCheck(): Promise<{ ok: boolean; message?: string }>
      updaterDownload(): Promise<{ ok: boolean; message?: string }>
      updaterInstall(): void
      updaterGetVersion(): Promise<string>
      onUpdaterEvent(callback: (event: UpdaterEvent) => void): () => void
    }
  }
}
export {}
