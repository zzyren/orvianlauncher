import { createHash } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer, type IncomingMessage, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { ManifestSchema, type OrvianManifest } from '../src/shared/manifest'
import { initConfig } from '../electron/config'
import { buildManifestFromArchive, publishReleaseToGitHub, releaseTag } from '../electron/publisher'
import { buildZip } from './helpers/zip'

const sha256 = (data: Buffer | string) => createHash('sha256').update(data).digest('hex')
const TOKEN = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789'

// ─── A tiny stand-in for the parts of the GitHub API the publisher uses ──────
interface FakeRelease { id: number; tag_name: string; draft: boolean; assets: Array<{ id: number; name: string }> }

let server: Server
let base = ''
let releases: FakeRelease[] = []
let calls: string[] = []
let uploads: Map<string, Buffer> = new Map()
let failUpload: string | null = null
let authHeaders: string[] = []
let nextId = 100

function view(r: FakeRelease) {
  return { ...r, html_url: `https://github.com/o/r/releases/tag/${r.tag_name}`, upload_url: `${base}/uploads/${r.id}/assets{?name,label}` }
}
const readBody = (req: IncomingMessage) => new Promise<Buffer>((resolve) => { const chunks: Buffer[] = []; req.on('data', (c) => chunks.push(c)); req.on('end', () => resolve(Buffer.concat(chunks))) })

beforeAll(async () => {
  server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', base)
    authHeaders.push(String(req.headers.authorization))
    const body = await readBody(req)
    const json = (status: number, data: unknown) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(data))
    const method = req.method

    if (method === 'GET' && url.pathname === '/repos/o/r/releases') { calls.push('GET releases'); return json(200, releases.map(view)) }
    if (method === 'POST' && url.pathname === '/repos/o/r/releases') {
      const payload = JSON.parse(body.toString())
      calls.push(`POST release draft=${payload.draft}`)
      const release = { id: nextId++, tag_name: payload.tag_name, draft: payload.draft, assets: [] }
      releases.push(release)
      return json(201, view(release))
    }
    const del = /^\/repos\/o\/r\/releases\/assets\/(\d+)$/.exec(url.pathname)
    if (method === 'DELETE' && del) {
      for (const r of releases) r.assets = r.assets.filter((a) => a.id !== Number(del[1]))
      calls.push(`DELETE asset ${del[1]}`)
      return void res.writeHead(204).end()
    }
    const up = /^\/uploads\/(\d+)\/assets$/.exec(url.pathname)
    if (method === 'POST' && up) {
      const name = url.searchParams.get('name')!
      calls.push(`UPLOAD ${name} (${body.length} bytes, content-length ${req.headers['content-length']})`)
      if (failUpload === name) return json(500, { message: 'Server Error' })
      uploads.set(name, body)
      releases.find((r) => r.id === Number(up[1]))!.assets.push({ id: nextId++, name })
      return json(201, {})
    }
    const patch = /^\/repos\/o\/r\/releases\/(\d+)$/.exec(url.pathname)
    if (method === 'PATCH' && patch) {
      const payload = JSON.parse(body.toString())
      const release = releases.find((r) => r.id === Number(patch[1]))!
      release.draft = payload.draft
      calls.push(`PATCH draft=${payload.draft} make_latest=${payload.make_latest}`)
      return json(200, view(release))
    }
    json(404, { message: 'Not Found' })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})
afterAll(async () => {
  server.closeAllConnections()
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

describe('releaseTag', () => {
  it.each([['1.0.5', 'v1.0.5'], ['v1.0.5', 'v1.0.5'], ['1.0.5-beta.1', 'v1.0.5-beta.1']])('%s -> %s', (v, tag) => expect(releaseTag(v)).toBe(tag))
})

describe('buildManifestFromArchive', () => {
  let dir = ''
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'orvian-build-')); initConfig(true, {}) })
  afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

  const prism = (extra: Record<string, string> = {}, mmc: object = { components: [{ uid: 'net.minecraft', version: '1.20.1' }, { uid: 'net.minecraftforge', version: '47.4.24' }] }) => ({
    'instance.cfg': 'name=Orvian',
    'mmc-pack.json': JSON.stringify(mmc),
    '.minecraft/mods/a.jar': 'mod a',
    '.minecraft/mods/.connector/cache.bin': 'ignored',
    '.minecraft/config/c.toml': 'cfg',
    '.minecraft/config/inventoryprofilesnext/personal.json': 'ignored',
    '.minecraft/config/inventoryprofilesnext/integrationHints/h.json': 'kept',
    '.minecraft/config/voicechat/username-cache.json': 'ignored',
    '.minecraft/options.txt': 'fov:90',
    '.minecraft/servers.dat': 'srv',
    '.minecraft/shaderpacks/Bliss.zip': 'shader',
    '.minecraft/resourcepacks/rp.zip': 'rp',
    '.minecraft/saves/world/level.dat': 'ignored',
    '.minecraft/logs/latest.log': 'ignored',
    '.minecraft/crash-reports/c.txt': 'ignored',
    '.minecraft/XaeroWaypoints/x.txt': 'ignored',
    '.minecraft/random-file.txt': 'ignored (not a pack folder)',
    ...extra
  })
  const build = async (entries: Record<string, string>, version = '1.0.5') => {
    const zip = buildZip(entries)
    const path = join(dir, 'export.zip')
    await writeFile(path, zip)
    const manifest = await buildManifestFromArchive(path, { version, changelog: ['- uno'], repo: 'zzyren/orvianmodpack', minimumLauncher: '0.1.0' })
    return { manifest, zip }
  }

  it('describes the pack files, keeps worlds and per-user data out, and reads the Forge version', async () => {
    const { manifest } = await build(prism())
    expect(manifest.files.map((f) => f.path).sort()).toEqual([
      'config/c.toml', 'config/inventoryprofilesnext/integrationHints/h.json', 'mods/a.jar', 'options.txt', 'resourcepacks/rp.zip', 'servers.dat', 'shaderpacks/Bliss.zip'
    ])
    expect(manifest.pack).toMatchObject({ version: '1.0.5', minecraft: '1.20.1', forge: '47.4.24' })
    expect(manifest.changelog).toEqual(['- uno'])
  })

  it('classifies files and marks what players may change', async () => {
    const { manifest } = await build(prism())
    const by = (p: string) => manifest.files.find((f) => f.path === p)!
    expect(by('mods/a.jar')).toMatchObject({ type: 'mod', required: true, userMutable: false, sha256: sha256('mod a'), size: 5 })
    expect(by('config/c.toml')).toMatchObject({ type: 'config', required: false, userMutable: true })
    expect(by('options.txt')).toMatchObject({ type: 'other', required: false, userMutable: true })
    expect(by('servers.dat')).toMatchObject({ required: false, userMutable: true })
    expect(by('shaderpacks/Bliss.zip').type).toBe('shaderpack')
    expect(by('resourcepacks/rp.zip').type).toBe('resourcepack')
  })

  it('points every file at the archive and records its hash and size', async () => {
    const { manifest, zip } = await build(prism())
    const url = 'https://github.com/zzyren/orvianmodpack/releases/download/v1.0.5/modpack.zip'
    expect(manifest.archive).toEqual({ url, sha256: sha256(zip), size: zip.length })
    expect(manifest.files.every((f) => f.url === url)).toBe(true)
    expect(manifest.server).toMatchObject({ address: 'payo.exaroton.me', port: 13133 })
    expect(ManifestSchema.safeParse(manifest).success).toBe(true)
  })

  it('understands the Modrinth overrides/ layout', async () => {
    const { manifest } = await build({ 'modrinth.index.json': '{}', 'overrides/mods/a.jar': 'mod a', 'overrides/config/c.toml': 'cfg' })
    expect(manifest.files.map((f) => f.path).sort()).toEqual(['config/c.toml', 'mods/a.jar'])
  })

  it('refuses to describe a pack for a Minecraft version the launcher does not support', async () => {
    await expect(build(prism({}, { components: [{ uid: 'net.minecraft', version: '1.21' }] }))).rejects.toThrow(/manifiesto generado no es válido/)
  })

  it('falls back to default versions when mmc-pack.json is unreadable', async () => {
    const { manifest } = await build(prism({ 'mmc-pack.json': '{nope' }))
    expect(manifest.pack).toMatchObject({ minecraft: '1.20.1', forge: '47.4.23' })
  })

  it('reports progress while analysing', async () => {
    const zip = buildZip(prism())
    const path = join(dir, 'p.zip')
    await writeFile(path, zip)
    const steps: number[] = []
    await buildManifestFromArchive(path, { version: '1.0.5', changelog: [], repo: 'o/r', minimumLauncher: '0.1.0', onProgress: (_d, p) => void (p !== undefined && steps.push(p)) })
    expect(steps.length).toBeGreaterThan(2)
    expect([...steps].sort((a, b) => a - b)).toEqual(steps)
  })
})

describe('publishReleaseToGitHub', () => {
  let dir = ''
  let zipPath = ''
  let zip: Buffer
  let manifest: OrvianManifest

  beforeEach(async () => {
    releases = []
    calls = []
    uploads = new Map()
    failUpload = null
    authHeaders = []
    nextId = 100
    dir = await mkdtemp(join(tmpdir(), 'orvian-publish-'))
    zip = buildZip({ '.minecraft/mods/a.jar': 'mod a', '.minecraft/config/c.toml': 'cfg' })
    zipPath = join(dir, 'export.zip')
    await writeFile(zipPath, zip)
    initConfig(true, {})
    manifest = await buildManifestFromArchive(zipPath, { version: '1.0.5', changelog: ['x'], repo: 'o/r', minimumLauncher: '0.1.0' })
  })
  afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

  const publish = (extra: Partial<Parameters<typeof publishReleaseToGitHub>[0]> = {}, onProgress?: (d: string, p?: number) => void) =>
    publishReleaseToGitHub({ token: TOKEN, repo: 'o/r', version: '1.0.5', changelog: '- cambios', manifest, zipPath, apiBase: base, onProgress, ...extra })

  it('creates a draft, uploads the archive and then the manifest, and only then publishes', async () => {
    const result = await publish()
    expect(result.releaseUrl).toBe('https://github.com/o/r/releases/tag/v1.0.5')
    expect(calls).toEqual([
      'GET releases',
      'POST release draft=true',
      `UPLOAD modpack.zip (${zip.length} bytes, content-length ${zip.length})`,
      expect.stringMatching(/^UPLOAD orvian-manifest\.json \(\d+ bytes/),
      'PATCH draft=false make_latest=true'
    ])
    expect(releases[0].draft).toBe(false)
  })

  it('uploads exactly the file from disk and the manifest that describes it', async () => {
    await publish()
    expect(uploads.get('modpack.zip')!.equals(zip)).toBe(true)
    const uploaded = JSON.parse(uploads.get('orvian-manifest.json')!.toString())
    expect(uploaded.archive.sha256).toBe(sha256(uploads.get('modpack.zip')!))
    expect(uploaded.archive.size).toBe(uploads.get('modpack.zip')!.length)
    expect(ManifestSchema.safeParse(uploaded).success).toBe(true)
  })

  it('sends the token only in the Authorization header', async () => {
    await publish()
    expect(authHeaders.every((h) => h === `Bearer ${TOKEN}`)).toBe(true)
    expect(JSON.stringify([...uploads.keys()])).not.toContain(TOKEN)
  })

  it('refuses to touch a version that is already published unless overwriting', async () => {
    releases.push({ id: 7, tag_name: 'v1.0.5', draft: false, assets: [{ id: 70, name: 'modpack.zip' }] })
    await expect(publish()).rejects.toThrow(/ya está publicada/)
    expect(calls).toEqual(['GET releases'])
  })

  it('overwrites a published release in place, replacing only its managed assets', async () => {
    releases.push({ id: 7, tag_name: 'v1.0.5', draft: false, assets: [{ id: 70, name: 'modpack.zip' }, { id: 71, name: 'orvian-manifest.json' }, { id: 72, name: 'notes.txt' }] })
    await publish({ overwrite: true })
    expect(calls.filter((c) => c.startsWith('DELETE')).sort()).toEqual(['DELETE asset 70', 'DELETE asset 71'])
    expect(calls.some((c) => c.startsWith('POST release'))).toBe(false)
    expect(releases[0].assets.map((a) => a.name).sort()).toEqual(['modpack.zip', 'notes.txt', 'orvian-manifest.json'])
  })

  it('reuses a draft left by a failed earlier attempt instead of creating another', async () => {
    releases.push({ id: 9, tag_name: 'v1.0.5', draft: true, assets: [{ id: 90, name: 'modpack.zip' }] })
    await publish()
    expect(calls.some((c) => c.startsWith('POST release'))).toBe(false)
    expect(calls).toContain('DELETE asset 90')
    expect(releases).toHaveLength(1)
    expect(releases[0].draft).toBe(false)
  })

  it('never publishes when the archive upload fails, leaving an invisible draft to retry', async () => {
    failUpload = 'modpack.zip'
    await expect(publish()).rejects.toThrow(/No se pudo subir modpack\.zip.*500/)
    expect(calls.some((c) => c.startsWith('PATCH'))).toBe(false)
    expect(releases[0].draft).toBe(true)
    failUpload = null
    await publish()
    expect(releases).toHaveLength(1)
    expect(releases[0].draft).toBe(false)
  })

  it('never publishes when the manifest upload fails', async () => {
    failUpload = 'orvian-manifest.json'
    await expect(publish()).rejects.toThrow(/orvian-manifest\.json/)
    expect(releases[0].draft).toBe(true)
  })

  it('reports monotonic progress ending at 100 %', async () => {
    const seen: number[] = []
    await publish({}, (_d, p) => void (p !== undefined && seen.push(p)))
    expect(seen.at(-1)).toBe(1)
    expect([...seen].sort((a, b) => a - b)).toEqual(seen)
  })

  it('surfaces GitHub errors without leaking the token', async () => {
    const error = (await publish({ repo: 'o/missing' }).catch((e: unknown) => e)) as Error
    expect(error.message).toMatch(/No se pudieron leer las releases.*404/)
    expect(error.message).not.toContain(TOKEN)
  })
})
