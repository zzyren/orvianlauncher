import { basename, join } from 'node:path'
import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { z } from 'zod'
import { OrvianError } from '../src/shared/errors'
import { assertInside, isSafeFileName } from '../src/shared/paths'
import { getConfig } from './config'
import type { Ipc } from './ipc'
import { log } from './logger'
import { download, fetchJson } from './net'

type Platform = 'modrinth' | 'curseforge'
type ModMeta = { dependencies: string[]; projectId?: string; platform?: Platform; versionId?: string; sha1?: string }
type MetadataFile = Record<string, ModMeta>

const MAX_MOD_BYTES = 200 * 1024 * 1024
const MODRINTH_HOSTS = ['cdn.modrinth.com']
const CURSEFORGE_HOSTS = ['forgecdn.net']

export interface VerifiedModFile {
  url: string
  filename: string
  size?: number
  sha1?: string
  sha512?: string
}

function unverifiable(file: string, reason: string): OrvianError {
  return new OrvianError('DOWNLOAD_UNVERIFIABLE', { file, reason }, { message: `Descarga no verificable (${reason}): ${file}` })
}

/** A mod file name from a remote API is untrusted input: it must be a plain `.jar` name. */
export function sanitizeModFilename(name: unknown): string {
  if (!isSafeFileName(name, ['.jar'])) {
    throw new OrvianError('DOWNLOAD_FAILED', { file: typeof name === 'string' ? name.slice(0, 60) : '', reason: 'invalid-filename' }, { message: 'El servicio devolvió un nombre de archivo no válido.' })
  }
  return name
}

export function assertAllowedHost(url: string, suffixes: readonly string[], file: string): string {
  let host = ''
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'https:') throw new Error('not https')
    host = parsed.hostname.toLowerCase()
  } catch {
    throw unverifiable(file, 'enlace no válido')
  }
  if (!suffixes.some((suffix) => host === suffix || host.endsWith(`.${suffix}`))) throw unverifiable(file, `host no permitido: ${host}`)
  return url
}

interface ModrinthFile {
  url?: string
  filename?: string
  primary?: boolean
  size?: number
  hashes?: { sha1?: string; sha512?: string }
}

export function pickModrinthFile(files: ModrinthFile[] | undefined): VerifiedModFile {
  const file = files?.find((f) => f.primary) ?? files?.[0]
  if (!file) throw new OrvianError('DOWNLOAD_FAILED', { reason: 'no-file' }, { message: 'La versión no incluye archivos descargables.' })
  const filename = sanitizeModFilename(file.filename)
  const { sha1, sha512 } = file.hashes ?? {}
  if (!sha1 && !sha512) throw unverifiable(filename, 'el servicio no publica un hash')
  return { url: assertAllowedHost(String(file.url), MODRINTH_HOSTS, filename), filename, size: file.size, sha1, sha512 }
}

interface CurseForgeFile {
  id?: number
  fileName?: string
  downloadUrl?: string | null
  fileLength?: number
  hashes?: Array<{ value?: string; algo?: number }>
}

export function pickCurseForgeFile(file: CurseForgeFile): VerifiedModFile {
  const filename = sanitizeModFilename(file.fileName)
  // algo 1 is SHA-1; MD5 (algo 2) is not strong enough to trust a download with.
  const sha1 = file.hashes?.find((h) => h.algo === 1)?.value
  if (!sha1) throw unverifiable(filename, 'CurseForge no publica un SHA-1')
  let url = file.downloadUrl
  if (!url && file.id) url = `https://edge.forgecdn.net/files/${Math.floor(file.id / 1000)}/${file.id % 1000}/${encodeURIComponent(filename)}`
  if (!url) throw unverifiable(filename, 'sin enlace de descarga')
  return { url: assertAllowedHost(url, CURSEFORGE_HOSTS, filename), filename, size: file.fileLength, sha1 }
}

async function readJsonFile<T>(path: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as T
  } catch {
    return fallback
  }
}

export function registerModsIpc(ipc: Ipc, dataRoot: string): void {
  const instance = join(dataRoot, 'instances', 'orvian')
  const modsDir = join(instance, 'mods')
  const statePath = join(instance, '.orvian', 'official-state.json')
  const metaPath = join(instance, '.orvian', 'custom-mods.json')

  const getMeta = (): Promise<MetadataFile> => readJsonFile<MetadataFile>(metaPath, {})
  async function saveMeta(data: MetadataFile): Promise<void> {
    await mkdir(join(instance, '.orvian'), { recursive: true })
    await writeFile(metaPath, JSON.stringify(data, null, 2))
  }

  /** Lower-cased names of the mods that ship with the modpack. */
  async function officialMods(): Promise<Set<string>> {
    const state = await readJsonFile<{ files?: Record<string, string> }>(statePath, {})
    const names = new Set<string>()
    for (const key of Object.keys(state.files ?? {})) {
      if (key.startsWith('mods/')) names.add(key.slice(5).toLowerCase())
    }
    return names
  }

  // Installs touch the same folder and metadata file, so they run one at a time.
  let queue: Promise<unknown> = Promise.resolve()
  function enqueue<T>(job: () => Promise<T>): Promise<T> {
    const run = queue.then(job, job)
    queue = run.catch(() => undefined)
    return run
  }

  async function placeMod(file: VerifiedModFile): Promise<void> {
    const target = assertInside(modsDir, join(modsDir, file.filename))
    await mkdir(modsDir, { recursive: true })
    await download(file.url, target, { sha512: file.sha512, sha1: file.sha512 ? undefined : file.sha1, size: file.size, maxBytes: MAX_MOD_BYTES })
    log.info('[Mods] Instalado %s', file.filename)
  }

  ipc.handle('mods:list', [], async () => {
    const official = await officialMods()
    const meta = await getMeta()
    const reverse: Record<string, string[]> = {}
    for (const [mod, data] of Object.entries(meta)) {
      for (const dep of data.dependencies ?? []) (reverse[dep] ??= []).push(mod)
    }

    const mods: Array<{ filename: string; isOfficial: boolean; size: number; dependencies: string[]; requiredBy: string[]; projectId?: string; platform?: Platform }> = []
    const files = await readdir(modsDir).catch(() => [] as string[])
    for (const file of files) {
      if (!file.endsWith('.jar')) continue
      const info = await stat(join(modsDir, file)).catch(() => null)
      if (!info?.isFile()) continue
      mods.push({
        filename: file,
        isOfficial: official.has(file.toLowerCase()),
        size: info.size,
        dependencies: meta[file]?.dependencies ?? [],
        requiredBy: reverse[file] ?? [],
        projectId: meta[file]?.projectId,
        platform: meta[file]?.platform
      })
    }
    return mods
  })

  ipc.handle('mods:delete', [z.string().min(1).max(255)], async (_event, filename) => {
    if (basename(filename) !== filename || !filename.toLowerCase().endsWith('.jar')) throw new Error('Nombre de archivo inválido.')
    if ((await officialMods()).has(filename.toLowerCase())) throw new Error('Los mods oficiales del modpack no se pueden eliminar.')
    await rm(assertInside(modsDir, join(modsDir, filename)), { force: true })

    const meta = await getMeta()
    if (meta[filename]) {
      delete meta[filename]
      await saveMeta(meta)
    }
    return { ok: true }
  })

  ipc.handle('mods:search-modrinth', [z.string().max(200)], async (_event, query) => {
    const facets = encodeURIComponent(JSON.stringify([['categories:forge'], [`versions:${getConfig().mcVersion}`]]))
    return fetchJson(`https://api.modrinth.com/v2/search?query=${encodeURIComponent(query)}&facets=${facets}&limit=20`)
  })

  async function installModrinthMod(projectId: string, installed: string[], failed: string[], visited: Set<string>, official: Set<string>, isRoot: boolean): Promise<{ filename: string; versionId?: string; sha1?: string }> {
    visited.add(projectId)
    const loaders = encodeURIComponent('["forge"]')
    const gameVersions = encodeURIComponent(JSON.stringify([getConfig().mcVersion]))
    const versions = await fetchJson<Array<{ id?: string; files?: ModrinthFile[]; dependencies?: Array<{ dependency_type?: string; project_id?: string }> }>>(
      `https://api.modrinth.com/v2/project/${projectId}/version?loaders=${loaders}&game_versions=${gameVersions}`
    )
    if (!versions?.length) throw new Error(`No hay versiones compatibles para el mod ${projectId}.`)
    const latest = versions[0]
    const file = pickModrinthFile(latest.files)

    if (official.has(file.filename.toLowerCase())) {
      if (isRoot) throw new Error(`${file.filename} ya forma parte del modpack oficial.`)
      return { filename: file.filename }
    }
    await placeMod(file)

    for (const dep of latest.dependencies ?? []) {
      if (dep.dependency_type !== 'required' || !dep.project_id || visited.has(dep.project_id)) continue
      if (!/^[A-Za-z0-9]{1,64}$/.test(dep.project_id)) continue
      try {
        const child = await installModrinthMod(dep.project_id, installed, failed, visited, official, false)
        if (!installed.includes(child.filename)) installed.push(child.filename)
      } catch (err) {
        failed.push(dep.project_id)
        log.error('[Mods] Falló la dependencia de Modrinth %s: %s', dep.project_id, err instanceof Error ? err.message : String(err))
      }
    }
    return { filename: file.filename, versionId: latest.id, sha1: file.sha1 }
  }

  ipc.handle('mods:install-modrinth', [z.string().regex(/^[A-Za-z0-9]{1,64}$/)], (_event, projectId) =>
    enqueue(async () => {
      const installed: string[] = []
      const failed: string[] = []
      const root = await installModrinthMod(projectId, installed, failed, new Set(), await officialMods(), true)
      const meta = await getMeta()
      meta[root.filename] = { dependencies: installed, projectId, platform: 'modrinth', versionId: root.versionId, sha1: root.sha1 }
      await saveMeta(meta)
      return { ok: true, filename: root.filename, dependencies: installed, failedDependencies: failed }
    })
  )

  ipc.handle('mods:search-curseforge', [z.string().max(200)], async (_event, query) => {
    const json = await fetchJson<{ data?: Array<{ id: number; name: string; summary?: string; logo?: { thumbnailUrl?: string; url?: string }; authors?: Array<{ name?: string }>; downloadCount?: number }> }>(
      `https://api.curse.tools/v1/mods/search?gameId=432&classId=6&searchFilter=${encodeURIComponent(query)}&gameVersion=${getConfig().mcVersion}&modLoaderType=1&pageSize=20`
    )
    const hits = (json.data ?? []).map((mod) => ({
      project_id: String(mod.id),
      title: mod.name,
      description: mod.summary || '',
      icon_url: mod.logo?.thumbnailUrl || mod.logo?.url || '',
      author: mod.authors?.[0]?.name || 'Autor desconocido',
      downloads: mod.downloadCount || 0
    }))
    return { hits }
  })

  async function installCurseForgeMod(modId: string, installed: string[], failed: string[], visited: Set<string>, official: Set<string>, isRoot: boolean): Promise<{ filename: string; versionId?: string; sha1?: string }> {
    visited.add(modId)
    const json = await fetchJson<{ data?: Array<CurseForgeFile & { dependencies?: Array<{ relationType?: number; modId?: number }> }> }>(
      `https://api.curse.tools/v1/mods/${modId}/files?gameVersion=${getConfig().mcVersion}&modLoaderType=1`
    )
    const latest = json.data?.[0]
    if (!latest) throw new Error(`No hay versiones compatibles (Forge ${getConfig().mcVersion}) en CurseForge para ${modId}.`)
    const file = pickCurseForgeFile(latest)

    if (official.has(file.filename.toLowerCase())) {
      if (isRoot) throw new Error(`${file.filename} ya forma parte del modpack oficial.`)
      return { filename: file.filename }
    }
    await placeMod(file)

    for (const dep of latest.dependencies ?? []) {
      // relationType 3 = required dependency
      if (dep.relationType !== 3 || !dep.modId || visited.has(String(dep.modId))) continue
      try {
        const child = await installCurseForgeMod(String(dep.modId), installed, failed, visited, official, false)
        if (!installed.includes(child.filename)) installed.push(child.filename)
      } catch (err) {
        failed.push(String(dep.modId))
        log.error('[Mods] Falló la dependencia de CurseForge %s: %s', dep.modId, err instanceof Error ? err.message : String(err))
      }
    }
    return { filename: file.filename, versionId: latest.id === undefined ? undefined : String(latest.id), sha1: file.sha1 }
  }

  ipc.handle('mods:install-curseforge', [z.union([z.number().int().positive(), z.string().regex(/^\d{1,10}$/)])], (_event, modId) =>
    enqueue(async () => {
      const id = String(modId)
      const installed: string[] = []
      const failed: string[] = []
      const root = await installCurseForgeMod(id, installed, failed, new Set(), await officialMods(), true)
      const meta = await getMeta()
      meta[root.filename] = { dependencies: installed, projectId: id, platform: 'curseforge', versionId: root.versionId, sha1: root.sha1 }
      await saveMeta(meta)
      return { ok: true, filename: root.filename, dependencies: installed, failedDependencies: failed }
    })
  )
}
