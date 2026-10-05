import { app, shell, BrowserWindow, Notification, session } from 'electron'
import { z } from 'zod'
import { join, resolve, sep } from 'node:path'
import { readFile, writeFile } from 'node:fs/promises'
import { safePackPath, OrvianManifest, ManifestSchema } from '../src/shared/manifest'
import { userMessage } from '../src/shared/errors'
import { getConfig, isAdminUuid } from './config'
import type { Ipc } from './ipc'
import { log } from './logger'
import { fetchWithTimeout } from './net'
import { AuthService } from './auth'
import { isGameBusy, isMinecraftRunning, killMinecraftProcess, playGame, repairGame, type GameDeps } from './game/launch'
import { registerAdminIpc } from './admin'
import { resetLauncherData } from './reset'
import os from 'node:os'

export { isMinecraftRunning, killMinecraftProcess }

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
      getConfig().manifestUrl ?? `https://github.com/${getConfig().packRepo}/releases/latest/download/orvian-manifest.json?t=${Date.now()}`,
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
        log.warn('[Manifest] Manifiesto remoto inválido (Zod):', parsed.error.issues.slice(0, 3))
      }
    }
  } catch (err) {
    if ((err as Error).name === 'AbortError') {
      log.warn('[Manifest] Timeout al descargar manifest desde GitHub releases/latest')
    }
  }

  // 2. Fallback a la API de GitHub para consultar la última release
  try {
    const res = await fetchWithTimeout(
      `https://api.github.com/repos/${getConfig().packRepo}/releases/latest?t=${Date.now()}`,
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
            log.warn('[Manifest] Manifiesto remoto inválido (API fallback, Zod):', parsed.error.issues.slice(0, 3))
          }
        }
      }
    }
  } catch (err) {
    if ((err as Error).name === 'AbortError') {
      log.warn('[Manifest] Timeout al consultar GitHub API releases/latest')
    }
  }

  // 3. Si falló la red, usar la caché descargada previamente
  try {
    const cached = await readJson<OrvianManifest | null>(cachedManifestPath, null)
    if (cached) {
      const norm = normalizeManifest(JSON.parse(JSON.stringify(cached)))
      // Caché del disco: timestamp = 0 para que expire pronto y se reintente en el siguiente ciclo
      inMemoryManifest = { manifest: norm, timestamp: 0 }
      log.info('[Manifest] Usando manifest en caché local (sin conexión a Internet)')
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

export function registerLauncherIpc(ipc: Ipc, dataRoot: string) {
  const instance = join(dataRoot, 'instances', 'orvian')
  const common = join(dataRoot, 'common')
  const authService = new AuthService(dataRoot)

  const emitProgress = (_event: unknown, state: string, progress: number, detail: string) => {
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
    if (isMinecraftRunning()) return // Don't notify while the user is playing
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
          log.info(`[Modpack] Nueva version disponible: ${latest} (instalada: ${installed})`)
          try {
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
            log.error('[Modpack] Fallo al mostrar notificacion del sistema:', err)
          }
        }
      }
    } catch (err) {
      log.warn('[Modpack] Fallo en comprobacion de actualizacion:', err)
    }
  }

  // Comprobación inicial al arrancar (sin force, usa caché si existe)
  void checkModpackUpdate(false)

  // Polling periódico: cada 5 minutos con forceRefresh
  setInterval(() => void checkModpackUpdate(true), 5 * 60 * 1000)

  // ─── Handler: launcher:status ─────────────────────────────────────────────
  // useCache=true por defecto para respuesta rápida; pack:check fuerza refresh
  ipc.handle('launcher:status', [z.object({ fresh: z.boolean().optional() }).optional()], async (_event, opts) => {
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
      isAdmin: account !== null && isAdminUuid(account.uuid),
      ramGb: settings.ramGb, 
      configured: manifest !== null,
      isPlaying: isMinecraftRunning()
    }
  })

  // ─── Handler: pack:check — forzar comprobación fresca ────────────────────
  ipc.handle('pack:check', [], async () => {
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
  
  const gameDeps: GameDeps = {
    dataRoot,
    appVersion: app.getVersion(),
    hasAccount: async () => (await authService.loadAccount()) !== null,
    getSession: () => authService.getValidSession(),
    getManifest: () => getOrvianManifest(dataRoot),
    getRamGb: async () => (await readJson(join(dataRoot, 'launcher', 'config.json'), { ramGb: 6 })).ramGb,
    emit: (event) => {
      BrowserWindow.getAllWindows().forEach((win) => {
        if (!win.isDestroyed()) win.webContents.send('launcher:progress', event)
      })
    },
    onPackSynced: (version) => {
      lastKnownInstalled = version
      lastKnownLatest = version
      broadcastModpackStatus(version, version)
    },
    // Re-check for a newer pack after a session: updates may have been published while playing
    onGameExit: () => void checkModpackUpdate(true)
  }

  ipc.handle('pack:repair', [], () => repairGame(gameDeps))

  ipc.handle(
    'game:play',
    [z.object({ quickPlay: z.boolean().optional(), playInstalled: z.boolean().optional() }).optional()],
    (_event, options) => playGame(gameDeps, options ?? {})
  )

  ipc.handle('account:login', [], async (event) => {
    try {
      const window = BrowserWindow.fromWebContents(event.sender) ?? undefined
      await authService.loginWithMicrosoft(window)
      return { ok: true, message: 'Sesión iniciada con éxito.' }
    } catch (error) {
      return { ok: false, message: userMessage(error) }
    }
  })

  ipc.handle('account:cancel-login', [], () => {
    authService.cancelLogin()
    return { ok: true }
  })

  ipc.handle('account:logout', [], async () => {
    await authService.logout()
    return { ok: true }
  })

  ipc.handle('settings:ram', [z.number()], async (_event, value) => {
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 2 || value > 16) throw new Error('RAM fuera de rango')
    const physical = Math.floor(os.totalmem() / 1024 ** 3)
    if (value > Math.max(2, physical - 3)) throw new Error('La configuración dejaría muy poca memoria para Windows')
    const file = join(dataRoot, 'launcher', 'config.json')
    const settings = await readJson(file, {})
    await writeFile(file, JSON.stringify({ ...settings, ramGb: value }, null, 2), 'utf8')
    return { ok: true }
  })

  ipc.handle('folder:open', [z.enum(['mods', 'shaders', 'resourcepacks', 'logs'])], async (_event, kind) => {
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

  ipc.handle('launcher:reset', [z.object({ deleteWorlds: z.boolean() })], async (_event, options) => {
    if (isMinecraftRunning() || isGameBusy()) {
      throw new Error('No puedes restablecer el launcher mientras haya una partida o una instalación en curso.')
    }

    const { preserved } = await resetLauncherData(dataRoot, options)

    // Clear persistent Electron sessions (Microsoft account cookies and web storage)
    for (const clear of [
      () => session.fromPartition('persist:microsoft-auth').clearStorageData(),
      () => session.defaultSession.clearStorageData()
    ]) {
      await clear().catch((err: unknown) => log.warn('[Reset] No se pudo limpiar una sesión: %s', String(err)))
    }

    // Reset in-memory tracking
    inMemoryManifest = null
    lastKnownLatest = null
    lastKnownInstalled = null

    log.info('[Reset] Launcher restablecido (mundos %s)', options.deleteWorlds ? 'eliminados' : 'conservados')
    return {
      ok: true,
      preserved,
      message: options.deleteWorlds
        ? 'Launcher restablecido de fábrica. Todo ha quedado como nuevo.'
        : 'Launcher restablecido. Se conservaron tus mundos, capturas, resourcepacks, shaders y opciones.'
    }
  })

  registerAdminIpc(ipc, {
    dataRoot,
    getAccount: () => authService.loadAccount(),
    emitProgress: (state, progress, detail) => emitProgress(null, state, progress, detail),
    getLatestVersion: () => lastKnownLatest,
    onPublished: (manifest, version) => {
      // The admin already runs the new version: refresh the local cache and tell every window.
      void writeFile(join(dataRoot, 'launcher', 'orvian-manifest.json'), JSON.stringify(manifest, null, 2), 'utf8').catch(() => undefined)
      inMemoryManifest = { manifest, timestamp: Date.now() }
      lastKnownLatest = version
      broadcastModpackStatus(lastKnownInstalled, version)
    }
  })

  ipc.handle('url:open', [z.string().max(2048)], async (_event, url) => {
    if (isHttpsUrl(url)) await shell.openExternal(url)
  })
}

function isHttpsUrl(value: string): boolean {
  try {
    return new URL(value).protocol === 'https:'
  } catch {
    return false
  }
}

async function readJson<T>(path: string, fallback: T): Promise<T> {
  try { return JSON.parse(await readFile(path, 'utf8')) as T } catch { return fallback }
}

export { safePackPath }
