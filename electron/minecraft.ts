import { join } from 'node:path'
import { mkdir, stat } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import type { PackFile } from '../src/shared/manifest'
import { synchronizeOfficialFiles, type SyncResult, type SyncOptions } from '../src/shared/integrity'
import { forgeVersionId, getConfig } from './config'
import { log } from './logger'
import { download, fetchJson } from './net'

export async function ensureMinecraftVanilla(commonDir: string, onProgress: (detail: string) => void): Promise<void> {
  onProgress('Obteniendo manifiesto de versiones de Minecraft...')
  const mc = getConfig().mcVersion
  const meta = await fetchJson<any>('https://piston-meta.mojang.com/mc/game/version_manifest_v2.json')
  const vMeta = meta.versions.find((v: any) => v.id === mc)
  if (!vMeta) throw new Error(`No se encontró la versión ${mc}`)

  const vJson = await fetchJson<any>(vMeta.url)
  const vDir = join(commonDir, 'versions', mc)
  await mkdir(vDir, { recursive: true })
  
  const { writeFile } = await import('node:fs/promises')
  await writeFile(join(vDir, `${mc}.json`), JSON.stringify(vJson, null, 2))

  onProgress(`Descargando cliente de Minecraft ${mc}...`)
  const clientUrl = vJson.downloads.client.url
  await download(clientUrl, join(vDir, `${mc}.jar`), { size: vJson.downloads.client.size, sha1: vJson.downloads.client.sha1 })

  onProgress('Descargando índice de recursos de Minecraft...')
  const assetIndex = vJson.assetIndex
  const indexesDir = join(commonDir, 'assets', 'indexes')
  await mkdir(indexesDir, { recursive: true })
  await download(assetIndex.url, join(indexesDir, `${assetIndex.id}.json`), { size: assetIndex.size, sha1: assetIndex.sha1 })

  // El instalador oficial de Forge requiere que exista launcher_profiles.json
  const profilesPath = join(commonDir, 'launcher_profiles.json')
  try {
    await stat(profilesPath)
  } catch {
    const dummyProfiles = {
      profiles: {
        '(Default)': {
          name: '(Default)'
        }
      },
      selectedProfile: '(Default)'
    }
    await writeFile(profilesPath, JSON.stringify(dummyProfiles, null, 2))
  }
}

export async function ensureForge(commonDir: string, javaPath: string, onProgress: (detail: string) => void): Promise<void> {
  const config = getConfig()
  const forgeVersion = forgeVersionId(config)
  const forgeJson = join(commonDir, 'versions', forgeVersion, `${forgeVersion}.json`)
  
  try {
    const info = await stat(forgeJson)
    if (info.isFile()) {
      onProgress(`Forge ${config.forgeVersion} verificado.`)
      return
    }
  } catch {}

  onProgress(`Descargando instalador de Forge ${config.forgeVersion}...`)
  const build = `${config.mcVersion}-${config.forgeVersion}`
  const installerUrl = `https://maven.minecraftforge.net/net/minecraftforge/forge/${build}/forge-${build}-installer.jar`
  const installerJar = join(commonDir, 'forge-installer.jar')
  await download(installerUrl, installerJar)

  onProgress('Ejecutando instalador de Forge (puede tardar un minuto)...')
  return new Promise((resolve, reject) => {
    const proc = spawn(javaPath, ['-jar', installerJar, '--installClient', commonDir], { cwd: commonDir })
    
    let errorLog = ''
    proc.stderr.on('data', (d) => { errorLog += d.toString() })
    proc.stdout.on('data', (d) => { 
      const txt = d.toString()
      errorLog += txt
      if (txt.includes('Downloading')) onProgress('Descargando dependencias de Forge...')
      else if (txt.includes('Processing')) onProgress('Procesando dependencias de Forge...')
    })

    proc.on('close', async (code) => {
      const { rm, readFile } = await import('node:fs/promises')
      let logDetail = errorLog.trim()
      
      const installerLogFile = join(commonDir, 'forge-installer.jar.log')
      try {
        const logContent = await readFile(installerLogFile, 'utf8')
        const lines = logContent.split('\n').filter(Boolean)
        const lastFew = lines.slice(-5).join('; ')
        if (lastFew) logDetail = (logDetail ? logDetail + ' | ' : '') + lastFew
      } catch {}

      await rm(installerJar, { force: true }).catch(() => {})
      
      if (code === 0) {
        onProgress('Forge instalado correctamente.')
        resolve()
      } else {
        reject(new Error(`Fallo al instalar Forge (código ${code}): ${logDetail || 'Error desconocido'}`))
      }
    })
    proc.on('error', (err) => reject(new Error('Error al ejecutar Java para instalar Forge: ' + err.message)))
  })
}

export async function ensureDependencies(commonDir: string, onProgress: (detail: string) => void): Promise<void> {
  const { Version, MinecraftFolder } = await import('@xmcl/core')
  const { diagnoseLibraries, diagnoseVersionAssets } = await import('@xmcl/installer')
  
  onProgress('Verificando dependencias de Minecraft...')
  const folder = MinecraftFolder.from(commonDir)
  const v = await Version.parse(folder, forgeVersionId())
  
  const missingLibs = await diagnoseLibraries(v.libraries, folder, {})
  const missingAssetsRes = await diagnoseVersionAssets(v, {})
  const missingAssets = missingAssetsRes?.assets || []
  
  const toDownload: { url: string, dest: string, size?: number, sha1?: string }[] = []
  
  for (const lib of missingLibs) {
    if (lib.download && lib.download.url) {
      toDownload.push({
        url: lib.download.url,
        dest: join(commonDir, 'libraries', lib.download.path),
        size: lib.download.size,
        sha1: lib.download.sha1
      })
    }
  }
  
  for (const asset of missingAssets) {
    const hash = asset.hash
    const two = hash.slice(0, 2)
    toDownload.push({
      url: `https://resources.download.minecraft.net/${two}/${hash}`,
      dest: join(commonDir, 'assets', 'objects', two, hash),
      size: asset.size,
      sha1: asset.hash
    })
  }

  if (toDownload.length === 0) return

  onProgress(`Descargando ${toDownload.length} dependencias (puede tardar)...`)
  let done = 0
  
  const chunk = 15
  for (let i = 0; i < toDownload.length; i += chunk) {
    const batch = toDownload.slice(i, i + chunk)
    await Promise.all(batch.map(async (item) => {
      try {
        await download(item.url, item.dest, { size: item.size, sha1: item.sha1 })
      } catch (e) {
        log.error('No se pudo descargar %s: %s', item.url, e instanceof Error ? e.message : String(e))
      }
      done++
      if (done % 50 === 0 || done === toDownload.length) {
        onProgress(`Descargando dependencias (${done}/${toDownload.length})...`)
      }
    }))
  }
}

export async function syncModpack(
  instanceDir: string, 
  manifestFiles: PackFile[], 
  version: string,
  onProgress: (detail: string) => void,
  opts?: SyncOptions
): Promise<SyncResult> {
  onProgress('Verificando archivos del modpack...')
  let processed = 0

  // Limpiar archivos temporales huérfanos de sincronizaciones anteriores interrumpidas
  try {
    const { readdir, rm: rmFile } = await import('node:fs/promises')
    const { glob } = await import('node:fs/promises').catch(() => ({ glob: null }))
    // Buscar archivos .orvian-tmp en mods/ y config/ recursivamente
    for (const dir of ['mods', 'config', 'defaultconfigs', 'shaderpacks', 'resourcepacks']) {
      const dirPath = join(instanceDir, dir)
      const files = await readdir(dirPath, { withFileTypes: true, recursive: true }).catch(() => [])
      for (const f of files) {
        if (!f.isDirectory() && f.name.endsWith('.orvian-tmp')) {
          const fullPath = join('parentPath' in f ? (f as any).parentPath : dirPath, f.name)
          await rmFile(fullPath, { force: true }).catch(() => {})
        }
      }
    }
  } catch {}


  let zipBuffer: Buffer | null = null
  let entryMap: Map<string, any> | null = null
  let zipFile: any = null

  const fetchBytes = async (file: PackFile) => {
    if (!zipBuffer || !entryMap) {
      const tag = version.startsWith('v') ? version : `v${version}`
      onProgress(`Descargando modpack.zip (${tag})...`)
      let zipUrl = `https://github.com/${getConfig().packRepo}/releases/download/${tag}/modpack.zip`
      let res = await fetch(zipUrl)
      if (!res.ok) {
        const altTag = version.startsWith('v') ? version.slice(1) : version
        const altUrl = `https://github.com/${getConfig().packRepo}/releases/download/${altTag}/modpack.zip`
        const altRes = await fetch(altUrl)
        if (altRes.ok) {
          res = altRes
          zipUrl = altUrl
        } else {
          const latestUrl = `https://github.com/${getConfig().packRepo}/releases/latest/download/modpack.zip`
          const latestRes = await fetch(latestUrl)
          if (latestRes.ok) {
            res = latestRes
            zipUrl = latestUrl
          } else {
            throw new Error(`Fallo al descargar modpack.zip desde ${zipUrl} (HTTP ${res.status})`)
          }
        }
      }
      zipBuffer = Buffer.from(await res.arrayBuffer())
      
      onProgress('Abriendo y leyendo modpack.zip...')
      const { open, readAllEntries } = await import('@xmcl/unzip')
      zipFile = await open(zipBuffer)
      const entries = await readAllEntries(zipFile)
      
      entryMap = new Map()
      const hasDotMinecraft = entries.some((e: any) => e.fileName.startsWith('.minecraft/') || e.fileName.includes('/.minecraft/'))
      const hasOverrides = entries.some((e: any) => e.fileName.startsWith('overrides/'))
      
      let prefix = ''
      if (hasDotMinecraft) {
        const dotMcEntry = entries.find((e: any) => e.fileName.endsWith('.minecraft/') || e.fileName.includes('/.minecraft/'))
        if (dotMcEntry) {
          const idx = dotMcEntry.fileName.indexOf('.minecraft/')
          prefix = dotMcEntry.fileName.slice(0, idx + '.minecraft/'.length)
        } else {
          prefix = '.minecraft/'
        }
      } else if (hasOverrides) {
        prefix = 'overrides/'
      }
      
      for (const entry of entries) {
        if (entry.fileName.endsWith('/')) continue
        const norm = entry.fileName.replace(/\\/g, '/')
        let rel = norm
        if (rel.includes('.minecraft/')) {
          rel = rel.slice(rel.indexOf('.minecraft/') + '.minecraft/'.length)
        } else if (rel.startsWith('minecraft/')) {
          rel = rel.slice('minecraft/'.length)
        } else if (prefix && rel.startsWith(prefix)) {
          rel = rel.slice(prefix.length)
        }
        rel = rel.replace(/^\/+/, '')
        if (rel) {
          entryMap.set(rel, entry)
          entryMap.set(rel.toLowerCase(), entry)
          entryMap.set(norm, entry)
          entryMap.set(norm.toLowerCase(), entry)
        }
      }
    }
    
    const entry = entryMap.get(file.path) ?? entryMap.get(file.path.toLowerCase())
    if (!entry) {
      throw new Error(`El archivo ${file.path} no se encuentra en el ZIP del modpack.`)
    }
    
    const { readEntry } = await import('@xmcl/unzip')
    const buf = await readEntry(zipFile, entry)
    
    processed++
    if (processed % 10 === 0) {
      onProgress(`Sincronizando archivos del modpack... (${processed})`)
    }
    return new Uint8Array(buf)
  }
  
  const result = await synchronizeOfficialFiles(instanceDir, version, manifestFiles, fetchBytes, opts)
  if (zipFile && zipFile.close) {
    try { zipFile.close() } catch {}
  }

  // ── Resumen de diagnóstico ───────────────────────────────────────────────
  const wasAlreadyCurrent = result.trustedFromState > 0 && result.installed === 0 && result.replaced === 0
  if (wasAlreadyCurrent) {
    log.info(`[Launcher] Modpack v${version} ya estaba instalado correctamente.`)
    log.info(`[Launcher]   → ${result.trustedFromState} archivos validados desde estado (sin descarga)`)
    log.info(`[Launcher]   → ${result.unchanged} archivos verificados con SHA-256 (sin cambios)`)
  } else {
    log.info(`[Launcher] Sync del modpack v${version} completado:`)
    log.info(`[Launcher]   → Instalados: ${result.installed}`)
    log.info(`[Launcher]   → Reemplazados: ${result.replaced}`)
    log.info(`[Launcher]   → Sin cambios (SHA-256): ${result.unchanged}`)
    log.info(`[Launcher]   → Fast-path (confiados desde estado): ${result.trustedFromState}`)
    log.info(`[Launcher]   → Configs preservadas: ${result.preservedConfigs}`)
    log.info(`[Launcher]   → Defaults nuevos staged: ${result.stagedDefaults}`)
  }

  return result
}
