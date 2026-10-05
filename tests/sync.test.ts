import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { OrvianManifest } from '../src/shared/manifest'
import { initConfig } from '../electron/config'
import { archiveCandidates, syncModpack } from '../electron/modpack/sync'
import { buildZip } from './helpers/zip'

const sha256 = (data: Buffer | string) => createHash('sha256').update(data).digest('hex')

let server: Server
let base = ''
let hits: Record<string, number> = {}
let served: Record<string, Buffer | (() => Buffer | number)> = {}

beforeAll(async () => {
  server = createServer((req, res) => {
    const path = req.url ?? '/'
    hits[path] = (hits[path] ?? 0) + 1
    const entry = served[path]
    const body = typeof entry === 'function' ? entry() : entry
    if (typeof body === 'number') return void res.writeHead(body).end()
    if (!body) return void res.writeHead(404).end()
    res.end(body)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})
afterAll(async () => {
  server.closeAllConnections()
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

interface Content { mods: Record<string, string>; configs: Record<string, string> }

describe('syncModpack', () => {
  let dir = ''
  const instance = () => join(dir, 'instance')
  const state = async () => JSON.parse(await readFile(join(instance(), '.orvian', 'official-state.json'), 'utf8'))

  /** Builds a zip in Prism layout and the matching manifest that points at it. */
  function pack(version: string, content: Content, options: { zipPath?: string; withArchive?: boolean; extraFiles?: OrvianManifest['files']; zipEntries?: Record<string, string> } = {}) {
    const entries: Record<string, string> = { 'instance.cfg': 'x', ...(options.zipEntries ?? {}) }
    const files: OrvianManifest['files'] = []
    const zipUrl = `${base}${options.zipPath ?? `/${version}/modpack.zip`}`
    const add = (path: string, body: string, type: 'mod' | 'config') => {
      if (!options.zipEntries) entries[`.minecraft/${path}`] = body
      files.push({ path, sha256: sha256(body), size: Buffer.byteLength(body), url: zipUrl, type, required: type === 'mod', userMutable: type === 'config', userDeletable: false })
    }
    for (const [name, body] of Object.entries(content.mods)) add(`mods/${name}`, body, 'mod')
    for (const [name, body] of Object.entries(content.configs)) add(`config/${name}`, body, 'config')
    const zip = buildZip(entries)
    served[options.zipPath ?? `/${version}/modpack.zip`] = zip
    const manifest = {
      schemaVersion: 1, pack: { id: 'orvian', name: 'Orvian', version, minecraft: '1.20.1', loader: 'forge', forge: '47.4.23' }, runtime: { java: 17 },
      minimumLauncher: '0.1.0', publishedAt: '2026-10-01T00:00:00.000Z', changelog: [], files: [...files, ...(options.extraFiles ?? [])],
      ...(options.withArchive === false ? {} : { archive: { url: zipUrl, sha256: sha256(zip), size: zip.length } })
    } as OrvianManifest
    return { manifest, zip }
  }

  const run = (manifest: OrvianManifest, fullVerify = false, progress: Array<Record<string, unknown>> = []) =>
    syncModpack({ instanceDir: instance(), manifest, fullVerify, onProgress: (u) => void progress.push(u as Record<string, unknown>) })

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'orvian-sync-'))
    hits = {}
    served = {}
    initConfig(true, {})
  })
  afterEach(async () => {
    vi.unstubAllGlobals()
    await rm(dir, { recursive: true, force: true })
  })

  it('installs from the archive, verifies it, and leaves nothing behind', async () => {
    const { manifest } = pack('1.0.0', { mods: { 'a.jar': 'mod A', 'b.jar': 'mod B' }, configs: { 'c.toml': 'default' } })
    const progress: Array<Record<string, unknown>> = []
    const result = await run(manifest, false, progress)
    expect(result).toMatchObject({ installed: 3, replaced: 0 })
    expect(await readFile(join(instance(), 'mods', 'a.jar'), 'utf8')).toBe('mod A')
    expect(await readFile(join(instance(), 'config', 'c.toml'), 'utf8')).toBe('default')
    expect((await state()).version).toBe('1.0.0')
    expect(existsSync(join(instance(), '.orvian', 'sync.marker'))).toBe(false)
    expect(existsSync(join(instance(), '.orvian', 'cache', 'modpack-1.0.0.zip'))).toBe(false)
    expect(progress.some((p) => typeof p.bytesDone === 'number')).toBe(true)
    expect(progress.at(-1)).toMatchObject({ current: 3, total: 3 })
    expect(hits['/1.0.0/modpack.zip']).toBe(1)
  })

  it('does not touch the network when everything is already installed', async () => {
    const { manifest } = pack('1.0.0', { mods: { 'a.jar': 'mod A' }, configs: {} })
    await run(manifest)
    hits = {}
    const result = await run(manifest)
    expect(result).toMatchObject({ installed: 0, replaced: 0, trustedFromState: 1 })
    expect(hits).toEqual({})
  })

  it('on update changes only what differs, keeps edited configs and stages the new default', async () => {
    await run(pack('1.0.0', { mods: { 'a.jar': 'A1', 'gone.jar': 'bye' }, configs: { 'c.toml': 'default v1' } }).manifest)
    await writeFile(join(instance(), 'config', 'c.toml'), 'my own settings')
    const { manifest } = pack('1.0.1', { mods: { 'a.jar': 'A2 is bigger' }, configs: { 'c.toml': 'default v2' } })
    const result = await run(manifest)
    expect(result).toMatchObject({ replaced: 1, stagedDefaults: 1 })
    expect(await readFile(join(instance(), 'mods', 'a.jar'), 'utf8')).toBe('A2 is bigger')
    expect(existsSync(join(instance(), 'mods', 'gone.jar'))).toBe(false)
    expect(await readFile(join(instance(), 'config', 'c.toml'), 'utf8')).toBe('my own settings')
    expect(await readFile(join(instance(), '.orvian', 'pending-config', '1.0.1', 'config', 'c.toml'), 'utf8')).toBe('default v2')
    expect((await state()).version).toBe('1.0.1')
  })

  it('never touches custom mods the player added', async () => {
    await mkdir(join(instance(), 'mods'), { recursive: true })
    await writeFile(join(instance(), 'mods', 'my-custom.jar'), 'custom')
    await run(pack('1.0.0', { mods: { 'a.jar': 'A' }, configs: {} }).manifest)
    await run(pack('1.0.1', { mods: { 'b.jar': 'B' }, configs: {} }).manifest)
    expect(await readFile(join(instance(), 'mods', 'my-custom.jar'), 'utf8')).toBe('custom')
    expect(existsSync(join(instance(), 'mods', 'a.jar'))).toBe(false)
  })

  it('rejects an archive that does not match its published hash without touching the instance', async () => {
    const { manifest } = pack('1.0.0', { mods: { 'a.jar': 'A' }, configs: {} })
    served['/1.0.0/modpack.zip'] = buildZip({ '.minecraft/mods/a.jar': 'TAMPERED' })
    await expect(run(manifest)).rejects.toMatchObject({ code: 'HASH_MISMATCH' })
    expect(existsSync(join(instance(), 'mods'))).toBe(false)
    expect(existsSync(join(instance(), '.orvian', 'official-state.json'))).toBe(false)
    expect(existsSync(join(instance(), '.orvian', 'sync.marker'))).toBe(false)
    expect(await readdir(join(instance(), '.orvian', 'cache'))).toEqual([])
  })

  it('reports a missing archive as "not published yet"', async () => {
    const { manifest } = pack('1.0.0', { mods: { 'a.jar': 'A' }, configs: {} })
    delete served['/1.0.0/modpack.zip']
    await expect(run(manifest)).rejects.toMatchObject({ code: 'PACK_ARCHIVE_MISSING', details: { v: '1.0.0' } })
  })

  it('retries a server error and still succeeds', async () => {
    const { manifest, zip } = pack('1.0.0', { mods: { 'a.jar': 'A' }, configs: {} })
    let calls = 0
    served['/1.0.0/modpack.zip'] = () => (++calls === 1 ? 503 : zip)
    // the shared download layer waits between attempts; keep the test quick by only needing one retry
    await expect(run(manifest)).resolves.toMatchObject({ installed: 1 })
    expect(calls).toBe(2)
  })

  describe('manifests published before the archive field existed', () => {
    it('derives the archive URL from the release tag and tries the tag without "v" as well', async () => {
      const { manifest, zip } = pack('1.0.5', { mods: { 'a.jar': 'A' }, configs: {} }, { withArchive: false })
      const [withV, without] = archiveCandidates(manifest, 'zzyren/orvianmodpack')
      expect(withV).toBe('https://github.com/zzyren/orvianmodpack/releases/download/v1.0.5/modpack.zip')
      expect(without).toBe('https://github.com/zzyren/orvianmodpack/releases/download/1.0.5/modpack.zip')
      expect(archiveCandidates({ ...manifest, pack: { ...manifest.pack, version: 'v1.0.5' } } as OrvianManifest, 'o/r')[0]).toBe('https://github.com/o/r/releases/download/v1.0.5/modpack.zip')

      // point every file at the derived URL, as the old publisher did, and serve it only under the bare tag
      const files = manifest.files.map((f) => ({ ...f, url: withV }))
      const requested: string[] = []
      vi.stubGlobal('fetch', async (input: string | URL) => {
        requested.push(String(input))
        return String(input) === without ? new Response(zip as unknown as BodyInit) : new Response('nope', { status: 404 })
      })
      const result = await run({ ...manifest, files })
      expect(result).toMatchObject({ installed: 1 })
      expect(requested).toEqual([withV, without])
    })

    it('does not fall back to "latest" when neither tag has an archive', async () => {
      const { manifest } = pack('1.0.5', { mods: { 'a.jar': 'A' }, configs: {} }, { withArchive: false })
      const [withV] = archiveCandidates(manifest, 'zzyren/orvianmodpack')
      const requested: string[] = []
      vi.stubGlobal('fetch', async (input: string | URL) => (requested.push(String(input)), new Response('nope', { status: 404 })))
      await expect(run({ ...manifest, files: manifest.files.map((f) => ({ ...f, url: withV })) })).rejects.toMatchObject({ code: 'PACK_ARCHIVE_MISSING' })
      expect(requested.some((u) => u.includes('/latest/'))).toBe(false)
      expect(requested).toHaveLength(2)
    })
  })

  describe('interruption and recovery', () => {
    it('leaves the marker and keeps the verified archive when a file is missing from it, then recovers', async () => {
      // the manifest lists b.jar but the archive does not contain it
      const { manifest } = pack('1.0.0', { mods: { 'a.jar': 'A' }, configs: {} })
      const broken: OrvianManifest = { ...manifest, files: [...manifest.files, { ...manifest.files[0], path: 'mods/b.jar', sha256: sha256('B'), size: 1 }] }
      await expect(run(broken)).rejects.toMatchObject({ code: 'MANIFEST_INVALID' })
      expect(existsSync(join(instance(), '.orvian', 'sync.marker'))).toBe(true)
      expect(existsSync(join(instance(), '.orvian', 'official-state.json'))).toBe(false)
      expect(await readFile(join(instance(), 'mods', 'a.jar'), 'utf8')).toBe('A')

      // the archive stayed on disk, so fixing the problem does not download it again
      expect(hits['/1.0.0/modpack.zip']).toBe(1)
      await run(manifest)
      expect(hits['/1.0.0/modpack.zip']).toBe(1)
      expect(existsSync(join(instance(), '.orvian', 'sync.marker'))).toBe(false)
      expect((await state()).version).toBe('1.0.0')
    })

    it('sweeps temporary leftovers from earlier interrupted runs', async () => {
      await mkdir(join(instance(), 'mods'), { recursive: true })
      await mkdir(join(instance(), 'config', 'deep'), { recursive: true })
      await mkdir(join(instance(), '.orvian', 'cache'), { recursive: true })
      await writeFile(join(instance(), 'mods', 'x.jar.orvian-tmp'), 'half')
      await writeFile(join(instance(), 'config', 'deep', 'y.toml.orvian-tmp'), 'half')
      await writeFile(join(instance(), '.orvian', 'cache', 'modpack-0.9.0.zip.part'), 'half')
      await writeFile(join(instance(), '.orvian', 'cache', 'modpack-0.9.0.zip'), 'old version archive')
      await run(pack('1.0.0', { mods: { 'a.jar': 'A' }, configs: {} }).manifest)
      expect(existsSync(join(instance(), 'mods', 'x.jar.orvian-tmp'))).toBe(false)
      expect(existsSync(join(instance(), 'config', 'deep', 'y.toml.orvian-tmp'))).toBe(false)
      expect(await readdir(join(instance(), '.orvian', 'cache'))).toEqual([])
    })

    it('a full verification repairs same-size corruption that the fast path would trust', async () => {
      const { manifest } = pack('1.0.0', { mods: { 'a.jar': 'AAAA' }, configs: {} })
      await run(manifest)
      await writeFile(join(instance(), 'mods', 'a.jar'), 'BBBB')
      expect(await run(manifest)).toMatchObject({ trustedFromState: 1, replaced: 0 })
      expect(await run(manifest, true)).toMatchObject({ replaced: 1 })
      expect(await readFile(join(instance(), 'mods', 'a.jar'), 'utf8')).toBe('AAAA')
    })
  })

  describe('archive problems', () => {
    it('discards a downloaded file that is not a zip', async () => {
      const garbage = Buffer.from('this is not a zip file at all')
      const { manifest } = pack('1.0.0', { mods: { 'a.jar': 'A' }, configs: {} })
      const bad = { ...manifest, archive: { ...manifest.archive!, sha256: sha256(garbage), size: garbage.length } } as OrvianManifest
      served['/1.0.0/modpack.zip'] = garbage
      await expect(run(bad)).rejects.toMatchObject({ code: 'DOWNLOAD_FAILED', details: { reason: 'bad-archive' } })
      expect(existsSync(join(instance(), '.orvian', 'cache', 'modpack-1.0.0.zip'))).toBe(false)
    })

    it('finds files whose case differs from the archive entry', async () => {
      const { manifest } = pack('1.0.0', { mods: { 'Mixed-Case.jar': 'A' }, configs: {} })
      const lowered = { ...manifest, files: manifest.files.map((f) => ({ ...f, path: f.path.toLowerCase() })) } as OrvianManifest
      expect(await run(lowered)).toMatchObject({ installed: 1 })
    })

    it('reads archives that use the overrides/ layout (Modrinth)', async () => {
      const body = 'A'
      const zip = buildZip({ 'modrinth.index.json': '{}', 'overrides/mods/a.jar': body })
      served['/mr.zip'] = zip
      const manifest = pack('1.0.0', { mods: {}, configs: {} }).manifest
      const withMr = { ...manifest, archive: { url: `${base}/mr.zip`, sha256: sha256(zip), size: zip.length }, files: [{ path: 'mods/a.jar', sha256: sha256(body), size: 1, url: `${base}/mr.zip`, type: 'mod', required: true, userMutable: false, userDeletable: false }] } as OrvianManifest
      expect(await run(withMr)).toMatchObject({ installed: 1 })
    })
  })

  describe('files hosted outside the archive', () => {
    it('downloads them from their own URL and verifies the hash', async () => {
      const body = 'direct mod bytes'
      served['/cdn/direct.jar'] = Buffer.from(body)
      const direct = { path: 'mods/direct.jar', sha256: sha256(body), size: body.length, url: `${base}/cdn/direct.jar`, type: 'mod' as const, required: true, userMutable: false, userDeletable: false }
      const { manifest } = pack('1.0.0', { mods: { 'a.jar': 'A' }, configs: {} }, { extraFiles: [direct] })
      expect(await run(manifest)).toMatchObject({ installed: 2 })
      expect(await readFile(join(instance(), 'mods', 'direct.jar'), 'utf8')).toBe(body)
      expect(await readdir(join(instance(), '.orvian', 'cache'))).toEqual([])
    })

    it('refuses content that does not match the manifest hash', async () => {
      served['/cdn/direct.jar'] = Buffer.from('not what the manifest promised')
      const direct = { path: 'mods/direct.jar', sha256: sha256('promised'), size: 8, url: `${base}/cdn/direct.jar`, type: 'mod' as const, required: true, userMutable: false, userDeletable: false }
      const { manifest } = pack('1.0.0', { mods: {}, configs: {} }, { extraFiles: [direct] })
      await expect(run(manifest)).rejects.toThrow()
      expect(existsSync(join(instance(), 'mods', 'direct.jar'))).toBe(false)
    })

    it('does not download the archive when no file needs it', async () => {
      const body = 'only direct'
      served['/cdn/only.jar'] = Buffer.from(body)
      const direct = { path: 'mods/only.jar', sha256: sha256(body), size: body.length, url: `${base}/cdn/only.jar`, type: 'mod' as const, required: true, userMutable: false, userDeletable: false }
      const { manifest } = pack('1.0.0', { mods: {}, configs: {} }, { extraFiles: [direct] })
      await run(manifest)
      expect(hits['/1.0.0/modpack.zip']).toBeUndefined()
    })
  })
})
