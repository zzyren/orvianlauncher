import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { MinecraftFolder, Version } from '@xmcl/core'
import { OrvianError } from '../../src/shared/errors'
import { log } from '../logger'
import { download, fetchJson, fetchWithTimeout, hashFile } from '../net'
import type { InstallReporter } from './progress'

/**
 * Installing and verifying Minecraft, Forge and their libraries.
 * Everything here is idempotent and avoids the network when the files are already in place,
 * so a launcher that is offline can still start an installation that is complete.
 */

const VERSION_MANIFEST_URL = 'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json'
const ASSET_HOST = 'https://resources.download.minecraft.net'

interface VersionJson {
  downloads?: { client?: { url: string; size: number; sha1: string } }
  assetIndex?: { id: string; url: string; size: number; sha1: string }
}

const orvianDir = (commonDir: string): string => join(commonDir, '.orvian')

async function sizeIs(path: string, size: number): Promise<boolean> {
  return stat(path).then((info) => info.isFile() && info.size === size, () => false)
}

async function readVersionJson(path: string): Promise<VersionJson | null> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as VersionJson
  } catch {
    return null
  }
}

// ─── Vanilla ──────────────────────────────────────────────────────────────────

function vanillaPaths(commonDir: string, mc: string) {
  return { json: join(commonDir, 'versions', mc, `${mc}.json`), jar: join(commonDir, 'versions', mc, `${mc}.jar`), profiles: join(commonDir, 'launcher_profiles.json') }
}

/** Cheap local check (existence and size); `fullVerify` also re-hashes the client jar and asset index. */
export async function isVanillaInstalled(commonDir: string, mc: string, fullVerify = false): Promise<boolean> {
  const paths = vanillaPaths(commonDir, mc)
  const json = await readVersionJson(paths.json)
  const client = json?.downloads?.client
  const index = json?.assetIndex
  if (!client || !index || !existsSync(paths.profiles)) return false
  const indexPath = join(commonDir, 'assets', 'indexes', `${index.id}.json`)
  if (!(await sizeIs(paths.jar, client.size)) || !(await sizeIs(indexPath, index.size))) return false
  if (fullVerify) {
    return (await hashFile(paths.jar, 'sha1')) === client.sha1.toLowerCase() && (await hashFile(indexPath, 'sha1')) === index.sha1.toLowerCase()
  }
  return true
}

export async function ensureVanilla(commonDir: string, mc: string, reporter: InstallReporter, options: { fullVerify?: boolean } = {}): Promise<void> {
  reporter.begin('minecraft', `Verificando Minecraft ${mc}...`)
  if (await isVanillaInstalled(commonDir, mc, options.fullVerify)) {
    reporter.done('minecraft')
    return
  }

  reporter.update({ detail: 'Obteniendo manifiesto de versiones de Minecraft...' })
  const manifest = await fetchJson<{ versions: Array<{ id: string; url: string; sha1: string }> }>(VERSION_MANIFEST_URL)
  const entry = manifest.versions.find((v) => v.id === mc)
  if (!entry) throw new OrvianError('UNKNOWN', {}, { message: `No se encontró la versión ${mc} en el manifiesto de Mojang.` })

  const paths = vanillaPaths(commonDir, mc)
  await download(entry.url, paths.json, { sha1: entry.sha1 })
  const json = await readVersionJson(paths.json)
  const client = json?.downloads?.client
  const index = json?.assetIndex
  if (!client || !index) throw new OrvianError('UNKNOWN', {}, { message: `El descriptor de Minecraft ${mc} no es válido.` })

  reporter.update({ detail: `Descargando cliente de Minecraft ${mc}...` })
  await download(client.url, paths.jar, { size: client.size, sha1: client.sha1 })
  reporter.update({ detail: 'Descargando índice de recursos de Minecraft...' })
  await download(index.url, join(commonDir, 'assets', 'indexes', `${index.id}.json`), { size: index.size, sha1: index.sha1 })

  // The official Forge installer insists on a launcher_profiles.json existing
  if (!existsSync(paths.profiles)) {
    await writeFile(paths.profiles, JSON.stringify({ profiles: { '(Default)': { name: '(Default)' } }, selectedProfile: '(Default)' }, null, 2))
  }
  reporter.done('minecraft')
}

// ─── Forge ────────────────────────────────────────────────────────────────────

export function forgeIds(mc: string, forge: string): { id: string; build: string } {
  return { id: `${mc}-forge-${forge}`, build: `${mc}-${forge}` }
}

const forgeMarker = (commonDir: string, id: string): string => join(orvianDir(commonDir), `forge-${id}.ok`)

/**
 * Forge installs written before the completion marker existed: accept them when the version
 * descriptor parses and every library it lists is on disk.
 */
async function forgeLooksComplete(commonDir: string, id: string): Promise<boolean> {
  try {
    const folder = MinecraftFolder.from(commonDir)
    const version = await Version.parse(folder, id)
    return version.libraries.every((lib) => !lib.download.path || existsSync(folder.getLibraryByPath(lib.download.path)))
  } catch {
    return false
  }
}

function runInstaller(javaPath: string, installerJar: string, commonDir: string, onLine: (line: string) => void): Promise<{ code: number | null; output: string }> {
  return new Promise((resolve, reject) => {
    const proc = spawn(javaPath, ['-jar', installerJar, '--installClient', commonDir], { cwd: commonDir, windowsHide: true })
    let output = ''
    const collect = (chunk: Buffer): void => {
      const text = chunk.toString()
      output += text
      for (const line of text.split(/\r?\n/)) if (line.trim()) onLine(line)
    }
    proc.stdout?.on('data', collect)
    proc.stderr?.on('data', collect)
    proc.on('close', (code) => resolve({ code, output }))
    proc.on('error', reject)
  })
}

/** Forge's Maven publishes a `.sha1` beside each file; use it when available. */
async function fetchPublishedSha1(url: string): Promise<string | undefined> {
  try {
    const res = await fetchWithTimeout(`${url}.sha1`, {}, 10_000)
    if (!res.ok) return undefined
    const match = /^[a-f0-9]{40}/i.exec((await res.text()).trim())
    return match?.[0].toLowerCase()
  } catch {
    return undefined
  }
}

export async function ensureForge(commonDir: string, javaPath: string, ids: { mc: string; forge: string }, reporter: InstallReporter): Promise<void> {
  const { id, build } = forgeIds(ids.mc, ids.forge)
  const json = join(commonDir, 'versions', id, `${id}.json`)
  const marker = forgeMarker(commonDir, id)
  reporter.begin('forge', `Verificando Forge ${ids.forge}...`)

  if (existsSync(json)) {
    if (existsSync(marker)) {
      reporter.done('forge')
      return
    }
    if (await forgeLooksComplete(commonDir, id)) {
      await mkdir(orvianDir(commonDir), { recursive: true })
      await writeFile(marker, new Date().toISOString())
      reporter.done('forge')
      return
    }
    log.warn('[Forge] La instalación de %s está incompleta; se reinstalará.', id)
  }

  // Clear any half-finished install so the installer starts from a known state
  await rm(join(commonDir, 'versions', id), { recursive: true, force: true })
  await rm(marker, { force: true })

  reporter.update({ detail: `Descargando instalador de Forge ${ids.forge}...` })
  const installerUrl = `https://maven.minecraftforge.net/net/minecraftforge/forge/${build}/forge-${build}-installer.jar`
  const installerJar = join(commonDir, 'forge-installer.jar')
  const sha1 = await fetchPublishedSha1(installerUrl)
  if (!sha1) log.warn('[Forge] No se pudo obtener el SHA-1 publicado del instalador; se instala sin esa comprobación.')
  await download(installerUrl, installerJar, { sha1 })

  reporter.update({ detail: 'Ejecutando instalador de Forge (puede tardar un minuto)...' })
  try {
    const { code, output } = await runInstaller(javaPath, installerJar, commonDir, (line) => {
      if (line.includes('Downloading')) reporter.update({ detail: 'Descargando dependencias de Forge...' })
      else if (line.includes('Processing')) reporter.update({ detail: 'Procesando dependencias de Forge...' })
    })
    if (code !== 0 || !existsSync(json)) {
      const installerLog = await readFile(`${installerJar}.log`, 'utf8').catch(() => '')
      const tail = [...output.split(/\r?\n/), ...installerLog.split(/\r?\n/)].filter(Boolean).slice(-8).join(' | ')
      throw new OrvianError('FORGE_INSTALL_FAILED', { exitCode: code ?? undefined, detail: tail.slice(0, 500) }, { message: `Fallo al instalar Forge (código ${code}): ${tail}` })
    }
    await mkdir(orvianDir(commonDir), { recursive: true })
    await writeFile(marker, new Date().toISOString())
  } catch (err) {
    await rm(join(commonDir, 'versions', id), { recursive: true, force: true })
    if (err instanceof OrvianError) throw err
    throw new OrvianError('FORGE_INSTALL_FAILED', {}, { cause: err, message: `No se pudo ejecutar Java para instalar Forge: ${err instanceof Error ? err.message : String(err)}` })
  } finally {
    await rm(installerJar, { force: true }).catch(() => undefined)
    await rm(`${installerJar}.log`, { force: true }).catch(() => undefined)
  }
  reporter.done('forge')
}

// ─── Libraries and assets ─────────────────────────────────────────────────────

export interface DownloadItem {
  kind: 'library' | 'asset'
  url: string
  dest: string
  size?: number
  sha1?: string
}

/** Downloads with a bounded worker pool and returns every item that still failed after retries. */
export async function downloadAll(items: DownloadItem[], reporter: InstallReporter, concurrency = 16): Promise<DownloadItem[]> {
  const failed: DownloadItem[] = []
  const bytesTotal = items.reduce((sum, item) => sum + (item.size ?? 0), 0)
  let next = 0
  let done = 0
  let bytesDone = 0

  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const item = items[next++]
      try {
        await download(item.url, item.dest, { size: item.size, sha1: item.sha1 })
      } catch (err) {
        failed.push(item)
        log.error('[Install] No se pudo descargar %s: %s', item.url, err instanceof Error ? err.message : String(err))
      }
      done++
      bytesDone += item.size ?? 0
      reporter.update({ current: done, total: items.length, bytesDone, bytesTotal, detail: `Descargando dependencias (${done}/${items.length})...` })
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker))
  return failed
}

const depsStamp = (commonDir: string, versionId: string): string => join(orvianDir(commonDir), `deps-${versionId}.json`)

async function readStamp(path: string): Promise<number | undefined> {
  try {
    const value = (JSON.parse(await readFile(path, 'utf8')) as { verifiedAt?: unknown }).verifiedAt
    return typeof value === 'number' ? value : undefined
  } catch {
    return undefined
  }
}

/**
 * Whether a downloaded file can be trusted. A file untouched since the last clean verification
 * (`timestamp`) is accepted after a size check; anything else is checked against its SHA-1.
 */
async function isIntact(path: string, expected: { sha1?: string; size?: number }, timestamp?: number): Promise<boolean> {
  const info = await stat(path).catch(() => null)
  if (!info?.isFile()) return false
  if (expected.size !== undefined && info.size !== expected.size) return false
  if (timestamp !== undefined && info.mtimeMs <= timestamp) return true
  if (expected.sha1) return (await hashFile(path, 'sha1')) === expected.sha1.toLowerCase()
  return info.size > 0
}

async function filterLimited<T>(items: readonly T[], keep: (item: T) => Promise<boolean>, concurrency = 32): Promise<T[]> {
  const flags = new Array<boolean>(items.length)
  let next = 0
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const index = next++
      flags[index] = await keep(items[index])
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker))
  return items.filter((_, index) => flags[index])
}

export interface LibraryRef {
  path: string
  url?: string
  size?: number
  sha1?: string
}

/** Libraries that are absent or damaged. */
export function findMissingLibraries(folder: MinecraftFolder, libraries: readonly LibraryRef[], timestamp?: number): Promise<LibraryRef[]> {
  return filterLimited(libraries, async (lib) => !(await isIntact(folder.getLibraryByPath(lib.path), lib, timestamp)))
}

/** Asset objects (deduplicated by hash) that are absent or damaged, according to the asset index on disk. */
export async function findMissingAssets(folder: MinecraftFolder, assetIndexId: string, timestamp?: number): Promise<Array<{ hash: string; size: number }>> {
  let index: { objects?: Record<string, { hash: string; size: number }> }
  try {
    index = JSON.parse(await readFile(folder.getPath('assets', 'indexes', `${assetIndexId}.json`), 'utf8'))
  } catch {
    throw new OrvianError('UNKNOWN', {}, { message: 'El índice de recursos de Minecraft está dañado. Usa «Reparar instalación».' })
  }
  const unique = new Map<string, { hash: string; size: number }>()
  for (const object of Object.values(index.objects ?? {})) unique.set(object.hash, { hash: object.hash, size: object.size })
  return filterLimited([...unique.values()], async (asset) => !(await isIntact(folder.getAsset(asset.hash), { sha1: asset.hash, size: asset.size }, timestamp)))
}

/**
 * Makes sure every library and asset of `versionId` is present and intact.
 * After a clean pass a stamp records when it happened; later passes skip hashing files that have
 * not been modified since (xmcl's `timestamp` option), so the check costs a stat per file.
 * `fullVerify` ignores the stamp. Missing libraries are fatal; missing assets only skip the stamp,
 * because the game still starts without a few sounds and the next launch retries them.
 */
export async function ensureDependencies(commonDir: string, versionId: string, reporter: InstallReporter, options: { fullVerify?: boolean } = {}): Promise<void> {
  reporter.begin('libraries', 'Verificando dependencias de Minecraft...')
  const folder = MinecraftFolder.from(commonDir)
  const version = await Version.parse(folder, versionId)
  const stampPath = depsStamp(commonDir, versionId)
  const timestamp = options.fullVerify ? undefined : await readStamp(stampPath)
  const startedAt = Date.now()

  const missingLibraries = await findMissingLibraries(folder, version.libraries.map((lib) => lib.download), timestamp)
  const missingAssets = await findMissingAssets(folder, version.assets, timestamp)

  const items: DownloadItem[] = []
  let unrecoverable = 0
  for (const lib of missingLibraries) {
    if (lib.url) {
      items.push({ kind: 'library', url: lib.url, dest: folder.getLibraryByPath(lib.path), size: lib.size, sha1: lib.sha1 })
    } else {
      // No URL: the Forge installer generates this file, so Forge has to be reinstalled.
      unrecoverable++
      log.warn('[Install] Falta %s y no se puede descargar; Forge debe reinstalarse.', lib.path)
    }
  }
  for (const asset of missingAssets) {
    items.push({ kind: 'asset', url: `${ASSET_HOST}/${asset.hash.slice(0, 2)}/${asset.hash}`, dest: folder.getAsset(asset.hash), size: asset.size, sha1: asset.hash })
  }

  let failed: DownloadItem[] = []
  if (items.length > 0) {
    reporter.update({ detail: `Descargando ${items.length} archivos del juego...` })
    failed = await downloadAll(items, reporter)
  }

  const failedLibraries = failed.filter((item) => item.kind === 'library').length + unrecoverable
  if (unrecoverable > 0) await rm(forgeMarker(commonDir, versionId), { force: true })
  if (failedLibraries > 0) throw new OrvianError('LIBRARIES_MISSING', { n: failedLibraries })

  const failedAssets = failed.length - failed.filter((item) => item.kind === 'library').length
  if (failedAssets > 0) {
    log.warn('[Install] %d recursos no se pudieron descargar; el juego arrancará y se reintentará en la próxima partida.', failedAssets)
  } else {
    await mkdir(orvianDir(commonDir), { recursive: true })
    await writeFile(stampPath, JSON.stringify({ verifiedAt: startedAt }))
  }
  reporter.done('libraries')
}
