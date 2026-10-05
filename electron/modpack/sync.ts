import { join } from 'node:path'
import type { PackFile } from '../../src/shared/manifest'
import { synchronizeOfficialFiles, type SyncResult, type SyncOptions } from '../../src/shared/integrity'
import { getConfig } from '../config'
import { log } from '../logger'

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
