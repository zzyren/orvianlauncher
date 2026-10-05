import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { Readable, Transform } from 'node:stream'
import type { ReadableStream as WebReadableStream } from 'node:stream/web'
import { open, readAllEntries, readEntry } from '@xmcl/unzip'
import { z } from 'zod'
import { detectArchivePrefix, normalizeArchivePath } from '../src/shared/archive'
import { ManifestSchema, type OrvianManifest, type PackFile } from '../src/shared/manifest'
import { getConfig } from './config'
import { log } from './logger'
import { getUserAgent, hashFile } from './net'

export type PublishProgressCallback = (step: string, progress?: number) => void

// ─── Building the manifest ────────────────────────────────────────────────────

/** Folders and files that never belong in the shared modpack (worlds, caches, per-user data). */
const IGNORED_PREFIXES = ['logs/', 'crash-reports/', 'screenshots/', 'saves/', 'backups/', 'webcache/', 'webcache2/', '.bobby/', 'modernfix/', 'xaerowaypoints/', 'xaeroworldmap/', 'mods/.connector/']
const IGNORED_FILES = [
  'instance.cfg', 'mmc-pack.json', 'modrinth.index.json', 'patches/', 'fabricloader.log', 'hotbar.nbt', 'usercache.json', 'usernamecache.json', 'servers.dat_old',
  'config/voicechat/category-volumes.properties', 'config/voicechat/player-volumes.properties', 'config/voicechat/username-cache.json'
]
const VALID_ROOTS = ['mods/', 'config/', 'defaultconfigs/', 'shaderpacks/', 'resourcepacks/', 'options']

function isPackFile(rel: string): boolean {
  if (!rel) return false
  const lower = rel.toLowerCase()
  if (lower.startsWith('xaero/')) return false
  if (IGNORED_PREFIXES.some((p) => lower.startsWith(p.toLowerCase()) || lower.includes(`/${p.toLowerCase()}`))) return false
  if (IGNORED_FILES.some((f) => rel === f || rel.endsWith(`/${f}`))) return false
  if (rel.includes('inventoryprofilesnext/') && !rel.includes('inventoryprofilesnext/integrationHints/')) return false
  return VALID_ROOTS.some((root) => rel.startsWith(root)) || rel === 'servers.dat'
}

function fileType(rel: string): PackFile['type'] {
  if (rel.startsWith('config/')) return 'config'
  if (rel.startsWith('mods/')) return 'mod'
  if (rel.startsWith('defaultconfigs/')) return 'defaultconfig'
  if (rel.startsWith('shaderpacks/')) return 'shaderpack'
  if (rel.startsWith('resourcepacks/')) return 'resourcepack'
  return 'other'
}

export const releaseTag = (version: string): string => (version.startsWith('v') ? version : `v${version}`)

export interface BuildManifestOptions {
  version: string
  changelog: string[]
  repo: string
  /** Oldest launcher able to run this pack. Raise it only when the pack needs a newer launcher. */
  minimumLauncher: string
  onProgress?: PublishProgressCallback
}

/**
 * Reads a Prism Launcher / Modrinth export and describes it: every game file with its hash, plus
 * the archive itself (hash and size) so launchers can verify it before opening it.
 * Works from the file on disk, one entry at a time, so a large export never sits in memory.
 */
export async function buildManifestFromArchive(zipPath: string, options: BuildManifestOptions): Promise<OrvianManifest> {
  const { version, changelog, repo, minimumLauncher, onProgress } = options
  onProgress?.('Abriendo paquete ZIP de Prism Launcher...', 0.1)
  const zip = await open(zipPath)
  try {
    const entries = await readAllEntries(zip)
    const prefix = detectArchivePrefix(entries.map((e) => e.fileName))

    let mcVersion = '1.20.1'
    let forgeVersion = '47.4.23'
    const mmcEntry = entries.find((e) => e.fileName.endsWith('mmc-pack.json'))
    if (mmcEntry) {
      try {
        const mmc = JSON.parse((await readEntry(zip, mmcEntry)).toString('utf8')) as { components?: Array<{ cachedVersion?: string; version?: string; uid?: string }> }
        const mc = mmc.components?.find((c) => c.uid === 'net.minecraft')
        if (mc) mcVersion = mc.version || mc.cachedVersion || mcVersion
        const forge = mmc.components?.find((c) => c.uid === 'net.minecraftforge' || c.uid === 'forge')
        if (forge) forgeVersion = forge.version || forge.cachedVersion || forgeVersion
      } catch (err) {
        log.warn('[Publisher] mmc-pack.json ilegible; se usan las versiones por defecto: %s', String(err))
      }
    }

    onProgress?.('Analizando mods y configuraciones del ZIP...', 0.3)
    const gameEntries = entries
      .filter((e) => !e.fileName.endsWith('/'))
      .map((entry) => ({ entry, rel: normalizeArchivePath(entry.fileName, prefix) }))
      .filter(({ rel }) => isPackFile(rel))

    const archiveUrl = `https://github.com/${repo}/releases/download/${releaseTag(version)}/modpack.zip`
    const files: PackFile[] = []
    for (const [index, { entry, rel }] of gameEntries.entries()) {
      const content = await readEntry(zip, entry)
      const type = fileType(rel)
      const isUserSetting = rel.startsWith('options') || rel === 'servers.dat' || type === 'config'
      files.push({ path: rel, sha256: createHash('sha256').update(content).digest('hex'), size: content.length, url: archiveUrl, type, required: !isUserSetting, userMutable: isUserSetting, userDeletable: false })
      if ((index + 1) % 30 === 0) onProgress?.(`Procesando archivos (${index + 1}/${gameEntries.length})...`, 0.3 + ((index + 1) / gameEntries.length) * 0.3)
    }

    onProgress?.('Calculando la huella del ZIP...', 0.6)
    const archive = { url: archiveUrl, sha256: await hashFile(zipPath, 'sha256'), size: (await stat(zipPath)).size }
    const { server } = getConfig()

    const manifest = {
      schemaVersion: 1,
      pack: { id: 'orvian', name: 'Orvian', version, minecraft: mcVersion, loader: 'forge', forge: forgeVersion },
      runtime: { java: 17 },
      minimumLauncher,
      publishedAt: new Date().toISOString(),
      changelog: changelog.length > 0 ? changelog : [`Actualización Orvian Modpack ${version}`],
      files,
      archive,
      server: { name: server.name, address: server.address, port: server.port }
    }
    const parsed = ManifestSchema.safeParse(manifest)
    if (!parsed.success) {
      const problems = parsed.error.issues.slice(0, 3).map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')
      throw new Error(`El manifiesto generado no es válido (${problems}).`)
    }
    return parsed.data
  } finally {
    zip.close()
  }
}

// ─── Publishing ───────────────────────────────────────────────────────────────

const ReleaseSchema = z.object({
  id: z.number(),
  tag_name: z.string(),
  draft: z.boolean(),
  html_url: z.string(),
  upload_url: z.string(),
  assets: z.array(z.object({ id: z.number(), name: z.string() })).default([])
})
type Release = z.infer<typeof ReleaseSchema>

export interface PublishOptions {
  token: string
  repo: string
  version: string
  changelog: string
  manifest: OrvianManifest
  /** Path of the exported ZIP; it is streamed from disk, never loaded whole. */
  zipPath: string
  /** Allow replacing the assets of a release that is already published. */
  overwrite?: boolean
  onProgress?: PublishProgressCallback
  /** Override for tests. */
  apiBase?: string
}

const MANAGED_ASSETS = ['orvian-manifest.json', 'modpack.zip']

function errorText(body: string): string {
  try {
    const parsed = JSON.parse(body) as { message?: string }
    if (parsed.message) return parsed.message
  } catch {
    // not JSON
  }
  return body.slice(0, 300)
}

/**
 * Publishes so that no client ever sees a manifest without its archive: the release is created as
 * a draft (invisible to `releases/latest`), receives the archive and then the manifest, and only
 * then is published. A failure at any point leaves an invisible draft that the next attempt reuses.
 */
export async function publishReleaseToGitHub(options: PublishOptions): Promise<{ releaseUrl: string }> {
  const { repo, version, changelog, manifest, zipPath, overwrite, onProgress } = options
  const token = options.token.trim()
  const apiBase = options.apiBase ?? 'https://api.github.com'
  const tag = releaseTag(version)
  const baseHeaders = { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'User-Agent': getUserAgent(), 'X-GitHub-Api-Version': '2022-11-28' }

  async function api(method: string, url: string, body?: unknown): Promise<{ status: number; text: string }> {
    const res = await fetch(url, {
      method,
      headers: { ...baseHeaders, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(30_000)
    })
    return { status: res.status, text: await res.text() }
  }
  const must = (res: { status: number; text: string }, what: string): string => {
    if (res.status >= 400) throw new Error(`${what}: GitHub respondió ${res.status} (${errorText(res.text)})`)
    return res.text
  }

  // 1. Find an existing release for this tag (published, or a draft left by an earlier attempt)
  onProgress?.('Conectando con GitHub...', 0.7)
  const list = z.array(ReleaseSchema).parse(JSON.parse(must(await api('GET', `${apiBase}/repos/${repo}/releases?per_page=100`), 'No se pudieron leer las releases')))
  let release: Release | undefined = list.find((r) => r.tag_name === tag)
  if (release && !release.draft && !overwrite) {
    throw new Error(`La versión ${tag} ya está publicada. Publica una versión nueva o confirma que quieres sobrescribirla.`)
  }

  // 2. Create the draft if there is none
  if (!release) {
    onProgress?.(`Creando borrador de ${tag}...`, 0.72)
    release = ReleaseSchema.parse(
      JSON.parse(must(await api('POST', `${apiBase}/repos/${repo}/releases`, { tag_name: tag, name: `Orvian Modpack ${tag}`, body: changelog || `Actualización ${tag} de Orvian Modpack.`, draft: true, prerelease: false }), 'No se pudo crear la release'))
    )
  }

  // 3. Clear assets that a previous attempt (or the release being overwritten) left behind
  for (const asset of release.assets.filter((a) => MANAGED_ASSETS.includes(a.name))) {
    onProgress?.(`Eliminando asset previo (${asset.name})...`)
    must(await api('DELETE', `${apiBase}/repos/${repo}/releases/assets/${asset.id}`), `No se pudo eliminar ${asset.name}`)
  }

  const uploadBase = release.upload_url.replace(/\{\?name,label\}$/, '')
  async function upload(name: string, contentType: string, source: { path: string; size: number } | { text: string }, range: [number, number]): Promise<void> {
    const size = 'text' in source ? Buffer.byteLength(source.text) : source.size
    let body: BodyInit
    if ('text' in source) {
      body = source.text
    } else {
      let sent = 0
      const counter = new Transform({
        transform(chunk: Buffer, _enc, callback) {
          sent += chunk.length
          onProgress?.(`Subiendo ${name} (${Math.round((sent / size) * 100)} %)...`, range[0] + (range[1] - range[0]) * (sent / size))
          callback(null, chunk)
        }
      })
      body = Readable.toWeb(createReadStream(source.path).pipe(counter)) as unknown as WebReadableStream as unknown as BodyInit
    }
    const res = await fetch(`${uploadBase}?name=${encodeURIComponent(name)}`, {
      method: 'POST',
      headers: { ...baseHeaders, 'Content-Type': contentType, 'Content-Length': String(size) },
      body,
      // Node's fetch requires this flag to send a stream
      ...({ duplex: 'half' } as object),
      signal: AbortSignal.timeout(30 * 60_000)
    })
    must({ status: res.status, text: await res.text() }, `No se pudo subir ${name}`)
  }

  // 4. Archive first, then the manifest that points at it
  onProgress?.('Subiendo modpack.zip a GitHub...', 0.75)
  await upload('modpack.zip', 'application/zip', { path: zipPath, size: (await stat(zipPath)).size }, [0.75, 0.93])
  onProgress?.('Subiendo orvian-manifest.json a GitHub Release...', 0.94)
  await upload('orvian-manifest.json', 'application/json', { text: JSON.stringify(manifest, null, 2) }, [0.94, 0.96])

  // 5. Publish
  onProgress?.('Publicando la release...', 0.97)
  const published = ReleaseSchema.parse(
    JSON.parse(must(await api('PATCH', `${apiBase}/repos/${repo}/releases/${release.id}`, { draft: false, name: `Orvian Modpack ${tag}`, body: changelog || `Actualización ${tag} de Orvian Modpack.`, make_latest: 'true' }), 'No se pudo publicar la release'))
  )
  onProgress?.('Publicación completada.', 1)
  return { releaseUrl: published.html_url }
}
