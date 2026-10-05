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
        /** The pack information is the last saved copy because GitHub could not be reached. */
        offline?: boolean
      }>
      /** Fuerza una comprobación de actualización del modpack contra GitHub. */
      checkForUpdates(): Promise<{
        configured: boolean
        hasUpdate: boolean
        installedVersion: string | null
        latestVersion: string | null
        message: string
        offline?: boolean
        /** Estimated download size of the update, when there is one. */
        downloadBytes?: number
      }>
      repair(): Promise<{ ok: boolean; message: string }>
      play(options?: { quickPlay?: boolean; playInstalled?: boolean }): Promise<{ ok: boolean; message: string }>
      login(): Promise<{ ok: boolean; message: string }>
      /** Closes the Microsoft sign-in window if one is open. */
      cancelLogin(): Promise<{ ok: boolean }>
      logout(): Promise<{ ok: boolean }>
      setRam(gb: number): Promise<{ ok: boolean }>
      openFolder(kind: 'mods' | 'shaders' | 'resourcepacks' | 'logs'): Promise<{ ok: boolean; error: string }>
      /** Wipes launcher data. Worlds, screenshots, packs and options are kept unless `deleteWorlds` is true. */
      resetInstallation(options?: { deleteWorlds: boolean }): Promise<{ ok: boolean; message: string; preserved: string[] }>
      pickMrpack(): Promise<{ canceled: boolean; selectionId: string | null; fileName: string | null; size: number }>
      /** `minimumLauncher` is carried over from the published manifest unless given; raise it only when the pack needs a newer launcher. */
      publishUpdate(params: { selectionId: string; version: string; changelog: string; overwrite?: boolean; minimumLauncher?: string }): Promise<{ ok: boolean; releaseUrl: string; message: string }>
      /** The publishing token lives only in the main process; the renderer can never read it back. */
      adminTokenStatus(): Promise<{ hasToken: boolean; canEncrypt: boolean }>
      adminSetToken(token: string): Promise<{ ok: boolean; verified: boolean }>
      adminClearToken(): Promise<{ ok: boolean }>
      openExternal(url: string): Promise<void>
      listMods(): Promise<Array<{ filename: string; isOfficial: boolean; size: number; dependencies: string[]; requiredBy: string[]; projectId?: string; platform?: 'modrinth' | 'curseforge' }>>
      deleteMod(filename: string): Promise<{ ok: boolean }>
      searchModrinth(query: string): Promise<{ hits: Array<{ project_id: string; title: string; description: string; icon_url: string; author: string }> }>
      installModrinth(projectId: string): Promise<{ ok: boolean; filename: string; dependencies?: string[]; failedDependencies?: string[] }>
      searchCurseForge(query: string): Promise<{ hits: Array<{ project_id: string; title: string; description: string; icon_url: string; author: string; downloads?: number }> }>
      installCurseForge(modId: string | number): Promise<{ ok: boolean; filename: string; dependencies?: string[]; failedDependencies?: string[] }>
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
