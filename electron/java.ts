import { mkdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { open, readAllEntries, readEntry } from '@xmcl/unzip'
import { OrvianError } from '../src/shared/errors'
import { assertInside } from '../src/shared/paths'
import { log } from './logger'
import { download, fetchJson } from './net'

const ASSETS_URL = 'https://api.adoptium.net/v3/assets/latest/17/hotspot?os=windows&architecture=x64&image_type=jre'
const ALLOWED_LINK_HOSTS = new Set(['github.com', 'api.adoptium.net'])

export interface JreAsset {
  link: string
  sha256: string
  size: number
  name: string
}

function badMetadata(reason: string): OrvianError {
  return new OrvianError('JAVA_INSTALL_FAILED', { reason }, { message: `Metadatos de Java no válidos: ${reason}` })
}

/** Picks the Windows x64 JRE from the Adoptium assets response and validates what we rely on. */
export function selectJreAsset(assets: unknown): JreAsset {
  if (!Array.isArray(assets)) throw badMetadata('respuesta inesperada')
  for (const asset of assets) {
    const binary = (asset as { binary?: Record<string, unknown> })?.binary
    const pkg = binary?.package as Record<string, unknown> | undefined
    if (!binary || !pkg) continue
    if (binary.image_type !== 'jre' || binary.os !== 'windows' || binary.architecture !== 'x64') continue

    const { link, checksum, size, name } = pkg
    if (typeof link !== 'string' || typeof checksum !== 'string' || typeof size !== 'number' || typeof name !== 'string') {
      throw badMetadata('faltan campos del paquete')
    }
    if (!/^[a-f0-9]{64}$/i.test(checksum)) throw badMetadata('checksum no es SHA-256')
    if (!(size > 1_000_000 && size < 500_000_000)) throw badMetadata('tamaño fuera de rango')
    let host = ''
    try {
      const url = new URL(link)
      if (url.protocol !== 'https:') throw new Error('not https')
      host = url.hostname
    } catch {
      throw badMetadata('enlace no válido')
    }
    if (!ALLOWED_LINK_HOSTS.has(host)) throw badMetadata(`host no permitido (${host})`)
    return { link, sha256: checksum.toLowerCase(), size, name }
  }
  throw badMetadata('no hay un JRE para Windows x64')
}

/**
 * Maps a zip entry to a path inside `destDir`, dropping the archive's single top-level folder.
 * Returns null for directories and the folder itself; throws for entries escaping `destDir`.
 */
export function resolveEntryTarget(destDir: string, rootFolder: string, fileName: string): string | null {
  if (fileName.endsWith('/')) return null
  const relPath = fileName.substring(rootFolder.length + 1)
  if (!relPath) return null
  return assertInside(destDir, join(destDir, ...relPath.split('/')))
}

export async function extractJreZip(zipPath: string, destDir: string, onProgress: (detail: string) => void): Promise<void> {
  const zip = await open(zipPath)
  const entries = await readAllEntries(zip)
  const rootFolder = entries.map((e) => e.fileName.split('/')[0]).find(Boolean)
  if (!rootFolder) throw badMetadata('el ZIP tiene un formato inesperado')

  let extracted = 0
  for (const entry of entries) {
    const target = resolveEntryTarget(destDir, rootFolder, entry.fileName)
    if (!target) continue
    await mkdir(join(target, '..'), { recursive: true })
    await writeFile(target, await readEntry(zip, entry))
    extracted++
    if (extracted % 100 === 0) onProgress(`Extrayendo Java 17... (${extracted} archivos)`)
  }
}

export async function ensureJava17(dataRoot: string, onProgress: (detail: string) => void): Promise<string> {
  const runtimeDir = join(dataRoot, 'runtime')
  const javaHome = join(runtimeDir, 'java-17')
  const javaw = join(javaHome, 'bin', 'javaw.exe')

  if (await testJava(javaw)) {
    onProgress('Java 17 encontrado y verificado.')
    return javaw
  }

  onProgress('Descargando Java 17 (Eclipse Temurin JRE)...')
  await mkdir(runtimeDir, { recursive: true })
  const asset = selectJreAsset(await fetchJson<unknown>(ASSETS_URL))
  const zipPath = join(runtimeDir, 'java-17.zip')
  // The checksum comes from Adoptium's API and the file from GitHub: both must agree.
  await download(asset.link, zipPath, { sha256: asset.sha256, size: asset.size, idleTimeoutMs: 60_000 })

  onProgress('Extrayendo Java 17...')
  const staging = join(runtimeDir, 'java-17.staging')
  await rm(staging, { recursive: true, force: true })
  try {
    await extractJreZip(zipPath, staging, onProgress)
    if (!(await testJava(join(staging, 'bin', 'javaw.exe')))) {
      throw new OrvianError('JAVA_INSTALL_FAILED', { reason: 'verification' }, { message: 'La instalación de Java 17 falló la verificación final.' })
    }
    // Swap only after the new runtime is proven good, so a failed update never removes a working one.
    await rm(javaHome, { recursive: true, force: true })
    await rename(staging, javaHome)
  } catch (err) {
    await rm(staging, { recursive: true, force: true }).catch(() => undefined)
    log.error('[Java] Instalación fallida: %s', err instanceof Error ? err.message : String(err))
    throw err
  } finally {
    await rm(zipPath, { force: true }).catch(() => undefined)
  }

  onProgress('Java 17 instalado correctamente.')
  return javaw
}

async function testJava(javawPath: string): Promise<boolean> {
  try {
    const info = await stat(javawPath)
    if (!info.isFile()) return false
  } catch {
    return false
  }

  // 10 s timeout so a hung javaw.exe cannot block the launcher
  return new Promise((resolve) => {
    let settled = false
    const finish = (value: boolean): void => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      resolve(value)
    }
    const proc = spawn(javawPath, ['-version'])
    const timeout = setTimeout(() => {
      try {
        proc.kill()
      } catch {
        // Process already gone.
      }
      finish(false)
    }, 10_000)
    let output = ''
    proc.stderr?.on('data', (data) => { output += data.toString() })
    proc.stdout?.on('data', (data) => { output += data.toString() })
    proc.on('close', (code) => finish(code === 0 && /version "17/.test(output)))
    proc.on('error', () => finish(false))
  })
}

