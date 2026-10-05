import { app, type IpcMain, shell, BrowserWindow, dialog, session } from 'electron'
import { join, resolve, sep } from 'node:path'
import { readFile, writeFile } from 'node:fs/promises'
import type { ChildProcess } from 'node:child_process'
import { execSync } from 'node:child_process'
import { safePackPath, OrvianManifest, ManifestSchema } from '../src/shared/manifest'
import { AuthService } from './auth'
import { ensureJava17 } from './java'
import { ensureMinecraftVanilla, ensureForge, ensureDependencies, syncModpack } from './minecraft'
import { Version, launch, createMinecraftProcessWatcher } from '@xmcl/core'
import { buildManifestFromPrismZip, publishReleaseToGitHub } from './publisher'
import os from 'node:os'

let isPlaying = false
let activeMinecraftProcess: ChildProcess | null = null
/** Mutex: previene que game:play se ejecute en paralelo si el usuario pulsa múltiples veces */
let isBusy = false
/** Flag de reparación: fuerza full-verify en el próximo sync */
let forceRepairNextPlay = false

export function isMinecraftRunning(): boolean {
  return isPlaying || activeMinecraftProcess !== null
}

export function killMinecraftProcess(): void {
  if (activeMinecraftProcess) {
    const pid = activeMinecraftProcess.pid
    if (pid) {
      if (process.platform === 'win32') {
        try {
          execSync(`taskkill /pid ${pid} /T /F`, { stdio: 'ignore' })
        } catch {
          // Taskkill might throw if process already exited
        }
      }
    }
    try {
      activeMinecraftProcess.kill('SIGKILL')
    } catch {
      // Ignore
    }
    activeMinecraftProcess = null
  }
  isPlaying = false
  isBusy = false
}

const GITHUB_REPO = 'zzyren/orvianmodpack'

/**
 * fetch() con timeout explícito. Evita que una petición de red se quede
 * colgada indefinidamente cuando GitHub / CDN no responde.
 */
async function fetchWithTimeout(url: string, init: RequestInit = {}, timeoutMs = 15_000): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetch(url, { ...init, signal: controller.signal })
  } finally {
    clearTimeout(timer)
  }
}

let inMemoryManifest: { manifest: OrvianManifest; timestamp: number } | null = null
// 1 minuto de caché en memoria para el manifest
const MANIFEST_CACHE_TTL = 1 * 60 * 1000

async function getOrvianManifest(dataRoot: string, forceRefresh = false): Promise<OrvianManifest | null> {
  const cachedManifestPath = join(dataRoot, 'launcher', 'orvian-manifest.json')
  
  // Usar caché en memoria si es válida y no se fuerza refresh
  if (!forceRefresh && inMemoryManifest && (Date.now() - inMemoryManifest.timestamp < MANIFEST_CACHE_TTL)) {
    return inMemoryManifest.manifest
  }

  const noCacheHeaders: Record<string, string> = {
    'User-Agent': 'OrvianLauncher',
    'Cache-Control': 'no-cache, no-store, must-revalidate',
    'Pragma': 'no-cache',
    'Expires': '0'
  }

  // 1. Descarga directa desde la última release (no consume cuota de la API de GitHub)
  // Timeout de 10s: si GitHub no responde, pasar al siguiente fallback
  try {
    const directRes = await fetchWithTimeout(
      `https://github.com/${GITHUB_REPO}/releases/latest/download/orvian-manifest.json?t=${Date.now()}`,
      { headers: noCacheHeaders },
      10_000
    )
    if (directRes.ok) {
      const raw = await directRes.json()
      const parsed = ManifestSchema.safeParse(raw)
      if (parsed.success) {
        // Clonamos para evitar mutar el objeto al normalizar
        const normalized = normalizeManifest(JSON.parse(JSON.stringify(parsed.data)))
        await writeFile(cachedManifestPath, JSON.stringify(normalized, null, 2), 'utf8').catch(() => {})
        inMemoryManifest = { manifest: normalized, timestamp: Date.now() }
        return normalized
      } else {
        console.warn('[Manifest] Manifiesto remoto inválido (Zod):', parsed.error.issues.slice(0, 3))
      }
    }
  } catch (err) {
    if ((err as Error).name === 'AbortError') {
      console.warn('[Manifest] Timeout al descargar manifest desde GitHub releases/latest')
    }
  }

  // 2. Fallback a la API de GitHub para consultar la última release
  try {
    const res = await fetchWithTimeout(
      `https://api.github.com/repos/${GITHUB_REPO}/releases/latest?t=${Date.now()}`,
      { headers: noCacheHeaders },
      10_000
    )
    if (res.ok) {
      const release = (await res.json()) as { tag_name: string; assets: Array<{ name: string; browser_download_url: string }> }
      const manifestAsset = release.assets?.find(a => a.name === 'orvian-manifest.json')
      if (manifestAsset) {
        const manifestRes = await fetchWithTimeout(
          `${manifestAsset.browser_download_url}?t=${Date.now()}`,
          { headers: noCacheHeaders },
          10_000
        )
        if (manifestRes.ok) {
          const raw = await manifestRes.json()
          const parsed = ManifestSchema.safeParse(raw)
          if (parsed.success) {
            const normalized = normalizeManifest(JSON.parse(JSON.stringify(parsed.data)))
            await writeFile(cachedManifestPath, JSON.stringify(normalized, null, 2), 'utf8').catch(() => {})
            inMemoryManifest = { manifest: normalized, timestamp: Date.now() }
            return normalized
          } else {
            console.warn('[Manifest] Manifiesto remoto inválido (API fallback, Zod):', parsed.error.issues.slice(0, 3))
          }
        }
      }
    }
  } catch (err) {
    if ((err as Error).name === 'AbortError') {
      console.warn('[Manifest] Timeout al consultar GitHub API releases/latest')
    }
  }

  // 3. Si falló la red, usar la caché descargada previamente
  try {
    const cached = await readJson<OrvianManifest | null>(cachedManifestPath, null)
    if (cached) {
      const norm = normalizeManifest(JSON.parse(JSON.stringify(cached)))
      // Caché del disco: timestamp = 0 para que expire pronto y se reintente en el siguiente ciclo
      inMemoryManifest = { manifest: norm, timestamp: 0 }
      console.log('[Manifest] Usando manifest en caché local (sin conexión a Internet)')
      return norm
    }
  } catch {}

  // 4. Fallback al manifest empaquetado con la app
  const bundled = await readJson<OrvianManifest | null>(join(app.getAppPath(), 'pack', 'orvian-manifest.json'), null)
  if (bundled) {
    const norm = normalizeManifest(JSON.parse(JSON.stringify(bundled)))
    inMemoryManifest = { manifest: norm, timestamp: 0 }
    return norm
  }
  return null
}

function normalizeManifest(manifest: OrvianManifest): OrvianManifest {
  // IMPORTANTE: esta función muta el objeto que recibe.
  // Los llamadores DEBEN pasar una copia (JSON.parse(JSON.stringify(...)))
  // para no corromper el objeto cacheado en memoria.
  manifest.files = manifest.files.filter(f => !f.path.includes('.bobby/'))
  for (const f of manifest.files) {
    if (f.path.includes('.minecraft/')) f.path = f.path.slice(f.path.indexOf('.minecraft/') + '.minecraft/'.length)
    else if (f.path.startsWith('minecraft/')) f.path = f.path.slice('minecraft/'.length)
    else if (f.path.startsWith('overrides/')) f.path = f.path.slice('overrides/'.length)
    f.path = f.path.replace(/^\/+/, '')
  }
  return manifest
}

/** Emite el estado de modpack a todas las ventanas activas */
function broadcastModpackStatus(installed: string | null, latest: string | null) {
  const hasUpdate = Boolean(installed && latest && installed !== latest)
  BrowserWindow.getAllWindows().forEach(win => {
    if (!win.isDestroyed()) {
      win.webContents.send('pack:status', {
        installedVersion: installed,
        latestVersion: latest,
        hasUpdate
      })
    }
  })
}

export function registerLauncherIpc(ipc: IpcMain, dataRoot: string) {
  const instance = join(dataRoot, 'instances', 'orvian')
  const common = join(dataRoot, 'common')
  const authService = new AuthService(dataRoot)

  const ADMIN_UUIDS = ['a8603c06e7474c44b0bde33067ab6627', 'a8603c06-e747-4c44-b0bd-e33067ab6627']

  const emitProgress = (event: Electron.IpcMainInvokeEvent | Electron.IpcMainEvent, state: string, progress: number, detail: string) => {
    BrowserWindow.getAllWindows().forEach(win => {
      if (!win.isDestroyed()) {
        win.webContents.send('launcher:progress', { state, progress, detail })
      }
    })
  }

  // ─── Polling en background: detección de nueva versión del modpack ──────────
  // Comprobación cada 5 minutos. Usa forceRefresh para bypassear caché siempre.
  // Evita notificar si el usuario está jugando.
  let lastKnownLatest: string | null = null
  let lastKnownInstalled: string | null = null

  const checkModpackUpdate = async (force = false) => {
    if (isPlaying) return // No notificar si el usuario está jugando
    try {
      const manifest = await getOrvianManifest(dataRoot, force)
      if (!manifest) return
      
      const statePath = join(instance, '.orvian', 'official-state.json')
      const localState = await readJson<{ version: string }>(statePath, { version: '' })
      
      const installed = localState.version || null
      const latest = manifest.pack.version
      
      // Solo emitir si cambió algo respecto a lo último conocido
      if (latest !== lastKnownLatest || installed !== lastKnownInstalled) {
        lastKnownLatest = latest
        lastKnownInstalled = installed

        // Broadcast inmediato a todas las ventanas
        broadcastModpackStatus(installed, latest)

        // Si hay una versión nueva disponible, notificación del sistema + log
        if (installed && latest && installed !== latest) {
          console.log(`[Modpack] Nueva version disponible: ${latest} (instalada: ${installed})`)
          try {
            const { Notification } = require('electron')
            if (Notification.isSupported()) {
              const notif = new Notification({
                title: 'Orvian Modpack Actualizado',
                body: `¡Nueva versión disponible! (v${latest})\nAbre el launcher para jugar la nueva versión.`
              })
              notif.on('click', () => {
                BrowserWindow.getAllWindows().forEach(win => {
                  if (!win.isDestroyed()) {
                    if (win.isVisible()) win.focus()
                    else win.show()
                  }
                })
              })
              notif.show()
            }
          } catch (err) {
            console.error('[Modpack] Fallo al mostrar notificacion del sistema:', err)
          }
        }
      }
    } catch (err) {
      console.warn('[Modpack] Fallo en comprobacion de actualizacion:', err)
    }
  }

  // Comprobación inicial al arrancar (sin force, usa caché si existe)
  void checkModpackUpdate(false)

  // Polling periódico: cada 5 minutos con forceRefresh
  setInterval(() => void checkModpackUpdate(true), 5 * 60 * 1000)

  // ─── Handler: launcher:status ─────────────────────────────────────────────
  // useCache=true por defecto para respuesta rápida; pack:check fuerza refresh
  ipc.handle('launcher:status', async (_event, opts?: { fresh?: boolean }) => {
    const fresh = opts?.fresh ?? false
    const settings = await readJson(join(dataRoot, 'launcher', 'config.json'), { ramGb: 6 })
    const account = await authService.loadAccount()
    const manifest = await getOrvianManifest(dataRoot, fresh)
    
    // Comprobar la versión instalada en la instancia local
    const statePath = join(instance, '.orvian', 'official-state.json')
    const localState = await readJson<{ version: string }>(statePath, { version: '' })
    
    const installedVersion = localState.version || null
    const latestVersion = manifest?.pack?.version ?? null
    const hasUpdate = Boolean(installedVersion && latestVersion && installedVersion !== latestVersion)

    // Actualizar lastKnownLatest para que el polling no notifique duplicados
    if (latestVersion) lastKnownLatest = latestVersion
    if (installedVersion !== undefined) lastKnownInstalled = installedVersion

    return { 
      appVersion: app.getVersion(), 
      packVersion: latestVersion, 
      installedVersion,
      hasUpdate,
      ready: manifest !== null && account !== null, 
      authenticated: account !== null, 
      playerName: account?.name ?? null,
      playerUuid: account?.uuid ?? null,
      isAdmin: account !== null && ADMIN_UUIDS.includes(account.uuid),
      ramGb: settings.ramGb, 
      configured: manifest !== null,
      isPlaying: isMinecraftRunning()
    }
  })

  // ─── Handler: pack:check — forzar comprobación fresca ────────────────────
  ipc.handle('pack:check', async () => {
    try {
      const manifest = await getOrvianManifest(dataRoot, true) // siempre forceRefresh
      const statePath = join(instance, '.orvian', 'official-state.json')
      const localState = await readJson<{ version: string }>(statePath, { version: '' })
      
      const installed = localState.version || null
      const latest = manifest?.pack?.version ?? null
      const hasUpdate = Boolean(installed && latest && installed !== latest)

      // Actualizar tracking y broadcast
      lastKnownLatest = latest
      lastKnownInstalled = installed
      broadcastModpackStatus(installed, latest)

      return { 
        configured: manifest !== null,
        hasUpdate,
        installedVersion: installed,
        latestVersion: latest,
        message: hasUpdate 
          ? `Nueva versión disponible: v${latest} (instalada: v${installed})`
          : (latest ? `Estás en la última versión: v${latest}` : 'No se pudo obtener información de la versión.')
      }
    } catch (e) {
      return { configured: false, hasUpdate: false, message: 'Error comprobando actualizaciones.' }
    }
  })
  
  ipc.handle('pack:repair', async () => {
    forceRepairNextPlay = true
    return { ok: true, message: 'La reparación profunda se ejecutará ahora al iniciar el juego.' }
  })

  ipc.handle('game:play', async (event) => {
    // ── Mutex: previene ejecuciones paralelas ───────────────────────────────────
    if (isPlaying) return { ok: false, message: 'Minecraft ya está en ejecución.' }
    if (isBusy) return { ok: false, message: 'El launcher ya está realizando una operación. Espera a que termine.' }
    isBusy = true
    
    try {
      const account = await authService.loadAccount()
      if (!account) throw new Error('Inicia sesión en tu cuenta de Microsoft antes de jugar.')

      // Detectar estado local primero por si estamos offline
      const statePath = join(instance, '.orvian', 'official-state.json')
      const localState = await readJson<{ version: string; files?: Record<string, string> }>(statePath, { version: '' })
      const installedVersion = localState.version || null

      const manifest = await getOrvianManifest(dataRoot)
      
      // Comportamiento Offline
      if (!manifest) {
        if (!installedVersion) {
          throw new Error('No hay conexión a Internet y el modpack no está instalado en este equipo. Conéctate para instalarlo por primera vez.')
        }
        console.warn(`[Launcher] Modo Offline activo. Usando la versión instalada localmente (v${installedVersion}).`)
        // Emular un manifest básico para poder arrancar
        // getOrvianManifest ya devuelve null si TODO falla, por lo que aquí forzamos el juego
      }

      // Si no hay manifest y sí hay instalación, procedemos asumiendo que está OK.
      // Si hay manifest, verificamos todo normal.
      const requiredVersion = manifest ? manifest.pack.version : installedVersion!
      const manifestFiles = manifest ? manifest.files : []

      const settings = await readJson(join(dataRoot, 'launcher', 'config.json'), { ramGb: 6 })

      emitProgress(event, 'java', 0.1, 'Preparando Java 17...')
      const javaPath = await ensureJava17(dataRoot, (detail) => emitProgress(event, 'java', 0.2, detail))

      emitProgress(event, 'minecraft', 0.3, 'Verificando Minecraft 1.20.1...')
      await ensureMinecraftVanilla(common, (detail) => emitProgress(event, 'minecraft', 0.4, detail))

      emitProgress(event, 'forge', 0.5, 'Verificando Forge 47.4.23...')
      await ensureForge(common, javaPath, (detail) => emitProgress(event, 'forge', 0.6, detail))

      emitProgress(event, 'deps', 0.65, 'Verificando dependencias...')
      await ensureDependencies(common, (detail) => emitProgress(event, 'deps', 0.68, detail))

      // ── Determinar estado del modpack ANTES de sincronizar ────────────────────
      console.log(`[Launcher] Versión del modpack instalada: ${installedVersion ?? 'no instalado'}`)
      console.log(`[Launcher] Versión del modpack requerida: ${requiredVersion}`)

      const isFirstInstall = !installedVersion
      const needsUpdate = installedVersion !== null && installedVersion !== requiredVersion
      const alreadyCurrent = installedVersion === requiredVersion && installedVersion !== null

      console.log(`[Launcher] Primera instalación: ${isFirstInstall}`)
      console.log(`[Launcher] Actualización requerida: ${needsUpdate}`)
      console.log(`[Launcher] Ya actualizado: ${alreadyCurrent}`)

      const isRepair = forceRepairNextPlay
      forceRepairNextPlay = false

      if (isRepair) {
        emitProgress(event, 'pack', 0.7, `Reparando modpack v${requiredVersion}... (Verificación profunda)`)
        console.log(`[Launcher] Ejecutando REPARACIÓN PROFUNDA (SHA-256 forzado)...`)
      } else if (isFirstInstall) {
        emitProgress(event, 'pack', 0.7, 'Instalando modpack Orvian por primera vez...')
      } else if (needsUpdate) {
        emitProgress(event, 'pack', 0.7, `Actualizando modpack: v${installedVersion} → v${requiredVersion}...`)
        console.log(`[Launcher] Actualizando modpack: v${installedVersion} → v${requiredVersion}`)
      } else {
        emitProgress(event, 'pack', 0.7, `Verificando modpack v${requiredVersion}...`)
        console.log(`[Launcher] Verificando integridad del modpack v${requiredVersion}...`)
      }

      // Sincronizar (si estamos offline y ya estaba instalado, no habrá manifestFiles y pasará rápido,
      // a menos que algo se haya corrompido, en cuyo caso intentará descargar y fallará).
      const syncResult = await syncModpack(
        instance,
        manifestFiles,
        requiredVersion,
        (detail) => emitProgress(event, 'pack', 0.8, detail),
        { forceVerify: isRepair }
      )

      // Mensaje post-sync para el usuario
      const noDownload = syncResult.installed === 0 && syncResult.replaced === 0
      if (noDownload) {
        console.log(`[Launcher] No se descargó nada — modpack v${requiredVersion} listo para jugar.`)
      }

      // Actualizar tracking de versiones tras la sincronización
      lastKnownInstalled = requiredVersion
      lastKnownLatest = requiredVersion
      broadcastModpackStatus(requiredVersion, requiredVersion)

      emitProgress(event, 'launching', 0.9, 'Resolviendo entorno de ejecución...')
      const resolvedVersion = await Version.parse(common, '1.20.1-forge-47.4.23')

      emitProgress(event, 'launching', 0.95, 'Iniciando juego...')
      isPlaying = true
      
      const proc = await launch({
        gamePath: instance,
        resourcePath: common,
        javaPath,
        version: resolvedVersion,
        minMemory: 1024,
        maxMemory: settings.ramGb * 1024,
        gameProfile: {
          id: account.uuid,
          name: account.name
        },
        accessToken: account.accessToken,
        userType: 'mojang'
      })

      activeMinecraftProcess = proc

      proc.on('exit', () => {
        activeMinecraftProcess = null
        isPlaying = false
      })

      proc.on('error', () => {
        activeMinecraftProcess = null
        isPlaying = false
      })

      const watcher = createMinecraftProcessWatcher(proc)
      watcher.on('minecraft-window-ready', () => {
        emitProgress(event, 'playing', 1, '¡Jugando!')
      })
      
      watcher.on('minecraft-exit', ({ code }) => {
        activeMinecraftProcess = null
        isPlaying = false
        emitProgress(event, 'idle', 0, `Minecraft se ha cerrado.`)
        // Forzar refresh de estado tras cerrar Minecraft por si hay nuevas versiones
        void checkModpackUpdate(true)
      })
      
      return { ok: true, message: 'Minecraft ha iniciado correctamente.' }
    } catch (error) {
      activeMinecraftProcess = null
      isPlaying = false
      isBusy = false
      const msg = error instanceof Error ? error.message : String(error)
      console.error('[Launcher] Error al iniciar Minecraft:', msg)
      return { ok: false, message: msg }
    } finally {
      // El mutex se libera cuando termina de arrancar Minecraft (o si hay error).
      // Una vez que el proceso Minecraft está corriendo, isBusy se vuelve false
      // para que el usuario pueda pulsar "Reparar" etc. sin reiniciar.
      isBusy = false
    }
  })

  ipc.handle('account:login', async (event) => {
    try {
      const window = BrowserWindow.fromWebContents(event.sender) ?? undefined
      await authService.loginWithMicrosoft(window)
      return { ok: true, message: 'Sesión iniciada con éxito.' }
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) }
    }
  })

  ipc.handle('account:logout', async () => {
    await authService.saveAccount(null)
    return { ok: true }
  })

  ipc.handle('settings:ram', async (_event, value: unknown) => {
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 2 || value > 16) throw new Error('RAM fuera de rango')
    const physical = Math.floor(os.totalmem() / 1024 ** 3)
    if (value > Math.max(2, physical - 3)) throw new Error('La configuración dejaría muy poca memoria para Windows')
    const file = join(dataRoot, 'launcher', 'config.json')
    const settings = await readJson(file, {})
    await writeFile(file, JSON.stringify({ ...settings, ramGb: value }, null, 2), 'utf8')
    return { ok: true }
  })

  ipc.handle('folder:open', async (_event, kind: unknown) => {
    if (!['mods', 'shaders', 'resourcepacks', 'logs'].includes(String(kind))) throw new Error('Carpeta no permitida')
    // 'logs' → carpeta de logs del launcher
    // Resto → carpeta directa dentro de la instancia (mods/, shaderpacks/, resourcepacks/)
    // NOTA: abrimos la carpeta real donde están los archivos, no una subcarpeta 'user'
    const kindMap: Record<string, string> = {
      logs: join(dataRoot, 'launcher', 'logs'),
      mods: join(instance, 'mods'),
      shaders: join(instance, 'shaderpacks'),
      resourcepacks: join(instance, 'resourcepacks')
    }
    const folder = kindMap[String(kind)] ?? join(instance, String(kind))
    const normalized = resolve(folder)
    if (!normalized.startsWith(resolve(dataRoot) + sep)) throw new Error('Ruta no válida')
    
    // Crear la carpeta si no existe antes de abrirla
    const { mkdir } = await import('node:fs/promises')
    await mkdir(normalized, { recursive: true }).catch(() => {})
    
    const error = await shell.openPath(normalized)
    return { ok: !error, error }
  })

  ipc.handle('admin:reset', async () => {
    if (isPlaying) {
      throw new Error('No puedes restablecer el launcher mientras Minecraft se esté ejecutando.')
    }

    const { readdir, rm, mkdir } = await import('node:fs/promises')
    
    // 1. Borrar absolutamente todos los archivos y carpetas dentro de dataRoot
    try {
      const entries = await readdir(dataRoot).catch(() => [] as string[])
      for (const entry of entries) {
        await rm(join(dataRoot, entry), { recursive: true, force: true }).catch(() => {})
      }
    } catch {}

    // 2. Limpiar completamente las sesiones persistentes de Electron (cuentas Microsoft y almacenamiento web)
    try {
      const msSession = session.fromPartition('persist:microsoft-auth')
      await msSession.clearStorageData()
    } catch {}
    try {
      await session.defaultSession.clearStorageData()
    } catch {}

    // 3. Recrear la estructura inicial mínima para que el launcher funcione como recién instalado
    await mkdir(join(dataRoot, 'launcher', 'logs'), { recursive: true }).catch(() => {})
    await mkdir(join(dataRoot, 'instances', 'orvian'), { recursive: true }).catch(() => {})

    // 4. Resetear estado de tracking en memoria
    inMemoryManifest = null
    lastKnownLatest = null
    lastKnownInstalled = null

    return { ok: true, message: 'Launcher restablecido de fábrica. Todo ha quedado como nuevo.' }
  })

  ipc.handle('admin:pick-mrpack', async (event) => {
    const account = await authService.loadAccount()
    if (!account || !ADMIN_UUIDS.includes(account.uuid)) {
      throw new Error('No tienes permisos de administrador para realizar esta acción.')
    }
    const win = BrowserWindow.fromWebContents(event.sender)
    const result = await dialog.showOpenDialog(win ?? BrowserWindow.getFocusedWindow()!, {
      title: 'Seleccionar modpack exportado de Prism Launcher (.zip)',
      filters: [
        { name: 'Prism Launcher / Minecraft ZIP', extensions: ['zip', 'mrpack'] },
        { name: 'Todos los archivos', extensions: ['*'] }
      ],
      properties: ['openFile']
    })
    if (result.canceled || result.filePaths.length === 0) {
      return { canceled: true, filePath: null, fileName: null }
    }
    const path = result.filePaths[0]
    return { canceled: false, filePath: path, fileName: require('node:path').basename(path) }
  })

  ipc.handle('admin:publish-update', async (event, params: {
    mrpackPath: string
    version: string
    changelog: string
    githubToken: string
  }) => {
    const account = await authService.loadAccount()
    if (!account || !ADMIN_UUIDS.includes(account.uuid)) {
      throw new Error('No tienes permisos de administrador para publicar actualizaciones.')
    }

    const { mrpackPath, version, changelog, githubToken } = params
    if (!mrpackPath || !version || !githubToken) {
      throw new Error('Faltan campos requeridos (archivo ZIP, versión o token de GitHub).')
    }

    emitProgress(event, 'publishing', 0.1, 'Leyendo archivo ZIP de Prism Launcher...')
    const zipBuffer = await readFile(mrpackPath)

    const changelogLines = changelog.split('\n').map(l => l.trim()).filter(Boolean)

    emitProgress(event, 'publishing', 0.3, 'Generando manifiesto de Orvian...')
    const { manifest } = await buildManifestFromPrismZip(
      zipBuffer,
      version,
      changelogLines,
      GITHUB_REPO,
      (detail, p) => emitProgress(event, 'publishing', p ?? 0.4, detail)
    )

    emitProgress(event, 'publishing', 0.6, 'Publicando release en GitHub...')
    const result = await publishReleaseToGitHub({
      token: githubToken,
      repo: GITHUB_REPO,
      version,
      changelog,
      manifest,
      zipBuffer,
      onProgress: (detail, p) => emitProgress(event, 'publishing', p ?? 0.8, detail)
    })

    // Actualizar la caché local para que el admin ya tenga la versión activa
    const cachedManifestPath = join(dataRoot, 'launcher', 'orvian-manifest.json')
    await writeFile(cachedManifestPath, JSON.stringify(manifest, null, 2), 'utf8').catch(() => {})
    inMemoryManifest = { manifest, timestamp: Date.now() }

    // Notificar a todas las ventanas que hay una nueva versión publicada
    lastKnownLatest = version
    broadcastModpackStatus(lastKnownInstalled, version)

    return { ok: true, releaseUrl: result.releaseUrl, message: `¡Versión ${version} publicada correctamente en GitHub!` }
  })

  ipc.handle('url:open', async (_event, url: string) => {
    if (typeof url === 'string' && (url.startsWith('https://') || url.startsWith('http://'))) {
      await shell.openExternal(url)
    }
  })
}

async function readJson<T>(path: string, fallback: T): Promise<T> {
  try { return JSON.parse(await readFile(path, 'utf8')) as T } catch { return fallback }
}

export { safePackPath }
