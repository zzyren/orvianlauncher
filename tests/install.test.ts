import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { MinecraftFolder, Version } from '@xmcl/core'
import { spawn } from 'node:child_process'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../electron/net', async (importOriginal) => ({ ...(await importOriginal<typeof import('../electron/net')>()), download: vi.fn(), fetchJson: vi.fn(), fetchWithTimeout: vi.fn() }))
vi.mock('@xmcl/core', async (importOriginal) => ({ ...(await importOriginal<typeof import('@xmcl/core')>()), Version: { parse: vi.fn() } }))
vi.mock('node:child_process', () => ({ spawn: vi.fn() }))

import { download, fetchJson, fetchWithTimeout } from '../electron/net'
import { downloadAll, ensureDependencies, ensureForge, ensureVanilla, findMissingAssets, findMissingLibraries, forgeIds, isVanillaInstalled, type DownloadItem } from '../electron/game/install'
import type { InstallReporter } from '../electron/game/progress'

const sha1 = (data: Buffer | string) => createHash('sha1').update(data).digest('hex')
const reporter = (): InstallReporter & { calls: string[]; updates: Array<Record<string, unknown>> } => {
  const calls: string[] = []
  const updates: Array<Record<string, unknown>> = []
  return { calls, updates, begin: (s) => void calls.push(`begin:${s}`), update: (u) => void updates.push(u as Record<string, unknown>), done: (s) => void calls.push(`done:${s}`) }
}

const MC = '1.20.1'
const JAR = Buffer.from('client jar bytes')
const INDEX = Buffer.from('{"objects":{}}')
const versionJson = () => ({
  downloads: { client: { url: 'https://piston-data.mojang.com/v1/objects/c/client.jar', size: JAR.length, sha1: sha1(JAR) } },
  assetIndex: { id: '5', url: 'https://piston-meta.mojang.com/v1/packages/i/5.json', size: INDEX.length, sha1: sha1(INDEX) }
})

async function put(path: string, content: Buffer | string) {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, content)
}

describe('vanilla', () => {
  let common = ''
  beforeEach(async () => {
    common = await mkdtemp(join(tmpdir(), 'orvian-install-'))
    vi.mocked(download).mockReset()
    vi.mocked(fetchJson).mockReset()
  })
  afterEach(async () => {
    await rm(common, { recursive: true, force: true })
  })

  const installFixture = async () => {
    await put(join(common, 'versions', MC, `${MC}.json`), JSON.stringify(versionJson()))
    await put(join(common, 'versions', MC, `${MC}.jar`), JAR)
    await put(join(common, 'assets', 'indexes', '5.json'), INDEX)
    await put(join(common, 'launcher_profiles.json'), '{}')
  }

  it('recognises a complete install from files alone', async () => {
    await installFixture()
    expect(await isVanillaInstalled(common, MC)).toBe(true)
  })

  it.each([
    ['the client jar is missing', async () => rm(join(common, 'versions', MC, `${MC}.jar`))],
    ['the jar has the wrong size', async () => writeFile(join(common, 'versions', MC, `${MC}.jar`), 'short')],
    ['launcher_profiles.json is missing', async () => rm(join(common, 'launcher_profiles.json'))],
    ['the asset index is missing', async () => rm(join(common, 'assets', 'indexes', '5.json'))],
    ['the descriptor is corrupt', async () => writeFile(join(common, 'versions', MC, `${MC}.json`), '{nope')]
  ])('is not installed when %s', async (_label, damage) => {
    await installFixture()
    await damage()
    expect(await isVanillaInstalled(common, MC)).toBe(false)
  })

  it('only a full verification notices same-size corruption', async () => {
    await installFixture()
    await writeFile(join(common, 'versions', MC, `${MC}.jar`), Buffer.from('x'.repeat(JAR.length)))
    expect(await isVanillaInstalled(common, MC)).toBe(true)
    expect(await isVanillaInstalled(common, MC, true)).toBe(false)
  })

  it('does not touch the network when everything is installed (offline launch)', async () => {
    await installFixture()
    const r = reporter()
    await ensureVanilla(common, MC, r)
    expect(fetchJson).not.toHaveBeenCalled()
    expect(download).not.toHaveBeenCalled()
    expect(r.calls).toEqual(['begin:minecraft', 'done:minecraft'])
  })

  it('downloads descriptor, client and asset index with their hashes on a fresh install', async () => {
    const json = Buffer.from(JSON.stringify(versionJson()))
    vi.mocked(fetchJson).mockResolvedValue({ versions: [{ id: '1.19.4', url: 'x', sha1: 'y' }, { id: MC, url: 'https://piston-meta.mojang.com/v1/packages/v/1.20.1.json', sha1: sha1(json) }] })
    const contents: Record<string, Buffer> = { 'v/1.20.1.json': json, 'c/client.jar': JAR, 'i/5.json': INDEX }
    vi.mocked(download).mockImplementation(async (url, dest) => {
      const body = Object.entries(contents).find(([key]) => url.endsWith(key))![1]
      await put(dest, body)
      return { path: dest, bytes: body.length, skipped: false }
    })

    await ensureVanilla(common, MC, reporter())

    expect(vi.mocked(download).mock.calls.map(([url, , opts]) => [url.split('/').slice(-2).join('/'), opts?.sha1])).toEqual([
      ['v/1.20.1.json', sha1(json)],
      ['c/client.jar', sha1(JAR)],
      ['i/5.json', sha1(INDEX)]
    ])
    expect(await isVanillaInstalled(common, MC)).toBe(true)
    expect(JSON.parse(await readFile(join(common, 'launcher_profiles.json'), 'utf8')).selectedProfile).toBe('(Default)')
  })

  it('fails clearly when Mojang does not list the version', async () => {
    vi.mocked(fetchJson).mockResolvedValue({ versions: [] })
    await expect(ensureVanilla(common, MC, reporter())).rejects.toThrow(/1\.20\.1/)
  })

  it('propagates an offline failure when a download is needed', async () => {
    vi.mocked(fetchJson).mockRejectedValue(Object.assign(new Error('offline'), { code: 'NETWORK_OFFLINE' }))
    await expect(ensureVanilla(common, MC, reporter())).rejects.toThrow('offline')
  })
})

describe('forge', () => {
  let common = ''
  const { id } = forgeIds(MC, '47.4.23')
  const json = () => join(common, 'versions', id, `${id}.json`)
  const marker = () => join(common, '.orvian', `forge-${id}.ok`)

  const fakeInstaller = (behaviour: { code: number; produceJson?: boolean; emitError?: boolean; output?: string }) => {
    vi.mocked(spawn).mockImplementation(((_cmd: string, args: string[]) => {
      const proc = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter }
      proc.stdout = new EventEmitter()
      proc.stderr = new EventEmitter()
      setImmediate(async () => {
        if (behaviour.emitError) return void proc.emit('error', new Error('spawn ENOENT'))
        proc.stdout.emit('data', Buffer.from(behaviour.output ?? 'Downloading libraries\nProcessing data\n'))
        if (behaviour.produceJson) await put(json(), '{"id":"forge"}')
        proc.emit('close', behaviour.code)
      })
      expect(args).toEqual(['-jar', join(common, 'forge-installer.jar'), '--installClient', common])
      return proc
    }) as never)
  }

  beforeEach(async () => {
    common = await mkdtemp(join(tmpdir(), 'orvian-forge-'))
    vi.mocked(download).mockReset().mockImplementation(async (_url, dest) => {
      await put(dest, 'installer')
      return { path: dest, bytes: 9, skipped: false }
    })
    vi.mocked(fetchWithTimeout).mockReset().mockResolvedValue(new Response(`${'a'.repeat(40)}  forge-installer.jar\n`))
    vi.mocked(spawn).mockReset()
    vi.mocked(Version.parse).mockReset()
  })
  afterEach(async () => {
    await rm(common, { recursive: true, force: true })
  })

  const run = (r = reporter()) => ensureForge(common, 'javaw.exe', { mc: MC, forge: '47.4.23' }, r)

  it('trusts a completed install (marker present) without running anything', async () => {
    await put(json(), '{}')
    await put(marker(), 'ok')
    await run()
    expect(spawn).not.toHaveBeenCalled()
    expect(download).not.toHaveBeenCalled()
  })

  it('adopts an install made by an older launcher when all its libraries exist', async () => {
    await put(json(), '{}')
    await put(join(common, 'libraries', 'a', 'a.jar'), 'x')
    vi.mocked(Version.parse).mockResolvedValue({ libraries: [{ download: { path: 'a/a.jar' } }, { download: { path: '' } }] } as never)
    await run()
    expect(spawn).not.toHaveBeenCalled()
    expect(existsSync(marker())).toBe(true)
  })

  it('reinstalls when a leftover install is missing libraries', async () => {
    await put(json(), '{"stale":true}')
    vi.mocked(Version.parse).mockResolvedValue({ libraries: [{ download: { path: 'gone/gone.jar' } }] } as never)
    fakeInstaller({ code: 0, produceJson: true })
    await run()
    expect(spawn).toHaveBeenCalledOnce()
    expect(await readFile(json(), 'utf8')).toBe('{"id":"forge"}')
    expect(existsSync(marker())).toBe(true)
    expect(existsSync(join(common, 'forge-installer.jar'))).toBe(false)
  })

  it('installs from scratch, verifying the installer against the published SHA-1', async () => {
    fakeInstaller({ code: 0, produceJson: true })
    const r = reporter()
    await run(r)
    expect(vi.mocked(download).mock.calls[0][0]).toBe('https://maven.minecraftforge.net/net/minecraftforge/forge/1.20.1-47.4.23/forge-1.20.1-47.4.23-installer.jar')
    expect(vi.mocked(download).mock.calls[0][2]).toMatchObject({ sha1: 'a'.repeat(40) })
    expect(r.updates.map((u) => u.detail)).toContain('Descargando dependencias de Forge...')
    expect(r.calls.at(-1)).toBe('done:forge')
  })

  it('still installs (with a warning) when the published checksum cannot be fetched', async () => {
    vi.mocked(fetchWithTimeout).mockRejectedValue(new Error('offline'))
    fakeInstaller({ code: 0, produceJson: true })
    await run()
    expect(vi.mocked(download).mock.calls[0][2]).toMatchObject({ sha1: undefined })
  })

  it('removes the half-installed version and reports the installer tail on failure', async () => {
    fakeInstaller({ code: 1, produceJson: true, output: 'line1\nERROR: could not download libfoo\n' })
    const error = await run().catch((e) => e)
    expect(error).toMatchObject({ code: 'FORGE_INSTALL_FAILED', details: { exitCode: 1 } })
    expect(error.details.detail).toContain('libfoo')
    expect(existsSync(join(common, 'versions', id))).toBe(false)
    expect(existsSync(marker())).toBe(false)
    expect(existsSync(join(common, 'forge-installer.jar'))).toBe(false)
  })

  it('fails when the installer exits cleanly but produced nothing', async () => {
    fakeInstaller({ code: 0, produceJson: false })
    await expect(run()).rejects.toMatchObject({ code: 'FORGE_INSTALL_FAILED' })
    expect(existsSync(marker())).toBe(false)
  })

  it('reports a Java that cannot be started', async () => {
    fakeInstaller({ code: 0, emitError: true })
    await expect(run()).rejects.toMatchObject({ code: 'FORGE_INSTALL_FAILED' })
  })
})

describe('downloadAll', () => {
  beforeEach(() => {
    vi.mocked(download).mockReset()
  })
  const items = (n: number): DownloadItem[] => Array.from({ length: n }, (_, i) => ({ kind: i % 2 ? 'asset' : 'library', url: `https://x/${i}`, dest: `/d/${i}`, size: 10, sha1: String(i) }) as DownloadItem)

  it('never runs more downloads at once than the limit', async () => {
    let active = 0
    let peak = 0
    vi.mocked(download).mockImplementation(async (_u, dest) => {
      active++
      peak = Math.max(peak, active)
      await new Promise((r) => setTimeout(r, 5))
      active--
      return { path: dest, bytes: 10, skipped: false }
    })
    const failed = await downloadAll(items(30), reporter(), 4)
    expect(failed).toEqual([])
    expect(peak).toBe(4)
    expect(download).toHaveBeenCalledTimes(30)
  })

  it('returns every failed item instead of throwing and keeps going', async () => {
    vi.mocked(download).mockImplementation(async (url, dest) => {
      if (url.endsWith('/3') || url.endsWith('/7')) throw new Error('boom')
      return { path: dest, bytes: 10, skipped: false }
    })
    const failed = await downloadAll(items(10), reporter(), 3)
    expect(failed.map((f) => f.url).sort()).toEqual(['https://x/3', 'https://x/7'])
    expect(download).toHaveBeenCalledTimes(10)
  })

  it('reports counts and bytes', async () => {
    vi.mocked(download).mockImplementation(async (_u, dest) => ({ path: dest, bytes: 10, skipped: false }))
    const r = reporter()
    await downloadAll(items(5), r, 1)
    expect(r.updates.at(-1)).toMatchObject({ current: 5, total: 5, bytesDone: 50, bytesTotal: 50 })
  })

  it('handles an empty list', async () => {
    expect(await downloadAll([], reporter())).toEqual([])
  })
})

const LIB_A = Buffer.from('library a')
const LIB_B = Buffer.from('library b!')
const ASSET_1 = Buffer.from('asset one')
const ASSET_2 = Buffer.from('asset two!')
const longAgo = new Date('2020-01-01T00:00:00Z')

describe('library and asset checks', () => {
  let common = ''
  let folder: MinecraftFolder
  beforeEach(async () => {
    common = await mkdtemp(join(tmpdir(), 'orvian-diag-'))
    folder = MinecraftFolder.from(common)
  })
  afterEach(async () => {
    await rm(common, { recursive: true, force: true })
  })
  const lib = (path: string, data: Buffer) => ({ path, size: data.length, sha1: sha1(data), url: `https://libs/${path}` })

  it('flags absent, truncated and corrupted libraries and accepts intact ones', async () => {
    await put(folder.getLibraryByPath('ok/ok.jar'), LIB_A)
    await put(folder.getLibraryByPath('short/short.jar'), 'li')
    await put(folder.getLibraryByPath('bad/bad.jar'), Buffer.from('LIBRARY A'))
    const missing = await findMissingLibraries(folder, [lib('ok/ok.jar', LIB_A), lib('absent/absent.jar', LIB_A), lib('short/short.jar', LIB_A), lib('bad/bad.jar', LIB_A)])
    expect(missing.map((m) => m.path).sort()).toEqual(['absent/absent.jar', 'bad/bad.jar', 'short/short.jar'])
  })

  it('without a hash, accepts any non-empty file of the right size', async () => {
    await put(folder.getLibraryByPath('nohash/a.jar'), 'content')
    await put(folder.getLibraryByPath('nohash/empty.jar'), '')
    const missing = await findMissingLibraries(folder, [{ path: 'nohash/a.jar' }, { path: 'nohash/empty.jar' }])
    expect(missing.map((m) => m.path)).toEqual(['nohash/empty.jar'])
  })

  it('trusts a file untouched since the verification stamp, but still catches a wrong size', async () => {
    const corruptSameSize = folder.getLibraryByPath('c/c.jar')
    await put(corruptSameSize, Buffer.from('LIBRARY A'))
    await utimes(corruptSameSize, longAgo, longAgo)
    const truncated = folder.getLibraryByPath('t/t.jar')
    await put(truncated, 'li')
    await utimes(truncated, longAgo, longAgo)
    const libs = [lib('c/c.jar', LIB_A), lib('t/t.jar', LIB_A)]
    expect((await findMissingLibraries(folder, libs, Date.now())).map((m) => m.path)).toEqual(['t/t.jar'])
    expect((await findMissingLibraries(folder, libs)).map((m) => m.path).sort()).toEqual(['c/c.jar', 't/t.jar'])
  })

  it('re-hashes a file modified after the stamp', async () => {
    await put(folder.getLibraryByPath('m/m.jar'), Buffer.from('LIBRARY A'))
    expect(await findMissingLibraries(folder, [lib('m/m.jar', LIB_A)], Date.now() - 60_000)).toHaveLength(1)
  })

  const writeIndex = (objects: Record<string, { hash: string; size: number }>) => put(folder.getPath('assets', 'indexes', '5.json'), JSON.stringify({ objects }))

  it('deduplicates assets by hash and reports missing or damaged objects', async () => {
    const h1 = sha1(ASSET_1)
    const h2 = sha1(ASSET_2)
    await writeIndex({ 'a.ogg': { hash: h1, size: ASSET_1.length }, 'alias.ogg': { hash: h1, size: ASSET_1.length }, 'b.ogg': { hash: h2, size: ASSET_2.length } })
    await put(folder.getAsset(h1), ASSET_1)
    expect(await findMissingAssets(folder, '5')).toEqual([{ hash: h2, size: ASSET_2.length }])
    await put(folder.getAsset(h2), Buffer.from('ASSET TWO!'))
    expect(await findMissingAssets(folder, '5')).toEqual([{ hash: h2, size: ASSET_2.length }])
  })

  it('reports a missing or corrupt asset index clearly', async () => {
    await expect(findMissingAssets(folder, '5')).rejects.toThrow(/índice de recursos/)
    await put(folder.getPath('assets', 'indexes', '5.json'), '{nope')
    await expect(findMissingAssets(folder, '5')).rejects.toThrow(/Reparar/)
  })
})

describe('dependencies', () => {
  let common = ''
  let folder: MinecraftFolder
  const versionId = forgeIds(MC, '47.4.23').id
  const stamp = () => join(common, '.orvian', `deps-${versionId}.json`)
  const marker = () => join(common, '.orvian', `forge-${versionId}.ok`)
  const h1 = sha1(ASSET_1)
  const h2 = sha1(ASSET_2)
  const libRef = (path: string, data: Buffer, url = `https://libs/${path}`) => ({ download: { path, url, size: data.length, sha1: sha1(data) } })

  /** Fake download: writes the bytes the URL stands for, like a successful transfer would. */
  const serveFiles = (failing: string[] = []) =>
    vi.mocked(download).mockImplementation(async (url, dest) => {
      if (failing.some((f) => url.includes(f))) throw new Error('404')
      const body = url.includes('a.jar') ? LIB_A : url.includes('b.jar') ? LIB_B : url.includes(h1) ? ASSET_1 : ASSET_2
      await put(dest, body)
      return { path: dest, bytes: body.length, skipped: false }
    })

  beforeEach(async () => {
    common = await mkdtemp(join(tmpdir(), 'orvian-deps-'))
    folder = MinecraftFolder.from(common)
    vi.mocked(download).mockReset()
    serveFiles()
    vi.mocked(Version.parse).mockReset().mockResolvedValue({ libraries: [libRef('a/a.jar', LIB_A), libRef('b/b.jar', LIB_B)], assets: '5' } as never)
    await put(folder.getPath('assets', 'indexes', '5.json'), JSON.stringify({ objects: { x: { hash: h1, size: ASSET_1.length }, y: { hash: h2, size: ASSET_2.length } } }))
  })
  afterEach(async () => {
    await rm(common, { recursive: true, force: true })
  })

  const installEverything = async () => {
    await put(folder.getLibraryByPath('a/a.jar'), LIB_A)
    await put(folder.getLibraryByPath('b/b.jar'), LIB_B)
    await put(folder.getAsset(h1), ASSET_1)
    await put(folder.getAsset(h2), ASSET_2)
  }

  it('downloads what is missing from the right URLs with sizes and hashes, then stamps', async () => {
    await put(folder.getLibraryByPath('a/a.jar'), LIB_A)
    await put(folder.getAsset(h1), ASSET_1)
    const before = Date.now()
    await ensureDependencies(common, versionId, reporter())
    expect(vi.mocked(download).mock.calls.map(([url]) => url).sort()).toEqual(['https://libs/b/b.jar', `https://resources.download.minecraft.net/${h2.slice(0, 2)}/${h2}`].sort())
    expect(vi.mocked(download).mock.calls.find(([url]) => url === 'https://libs/b/b.jar')![2]).toMatchObject({ size: LIB_B.length, sha1: sha1(LIB_B) })
    expect(JSON.parse(await readFile(stamp(), 'utf8')).verifiedAt).toBeGreaterThanOrEqual(before)
  })

  it('does nothing and stays quiet when everything is intact', async () => {
    await installEverything()
    await ensureDependencies(common, versionId, reporter())
    expect(download).not.toHaveBeenCalled()
    expect(existsSync(stamp())).toBe(true)
  })

  it('after a clean pass, skips hashing for files untouched since, unless a full verification is requested', async () => {
    await installEverything()
    await ensureDependencies(common, versionId, reporter())
    // Same-size corruption that keeps an old modification time: only a full check can see it
    const target = folder.getLibraryByPath('a/a.jar')
    await writeFile(target, Buffer.from('LIBRARY A'))
    await utimes(target, longAgo, longAgo)

    await ensureDependencies(common, versionId, reporter())
    expect(download).not.toHaveBeenCalled()

    await ensureDependencies(common, versionId, reporter(), { fullVerify: true })
    expect(vi.mocked(download).mock.calls.map(([url]) => url)).toEqual(['https://libs/a/a.jar'])
    expect(await readFile(target)).toEqual(LIB_A)
  })

  it('fails with the number of libraries that could not be downloaded, and does not stamp', async () => {
    serveFiles(['a.jar', 'b.jar'])
    await expect(ensureDependencies(common, versionId, reporter())).rejects.toMatchObject({ code: 'LIBRARIES_MISSING', details: { n: 2 } })
    expect(existsSync(stamp())).toBe(false)
  })

  it('lets the game start when only some assets failed, but retries them next time', async () => {
    await put(folder.getLibraryByPath('a/a.jar'), LIB_A)
    await put(folder.getLibraryByPath('b/b.jar'), LIB_B)
    serveFiles([h1, h2])
    await expect(ensureDependencies(common, versionId, reporter())).resolves.toBeUndefined()
    expect(existsSync(stamp())).toBe(false)
  })

  it('asks for a Forge reinstall when a missing library has no download URL', async () => {
    await put(marker(), 'ok')
    vi.mocked(Version.parse).mockResolvedValue({ libraries: [libRef('generated/g.jar', LIB_A, '')], assets: '5' } as never)
    await expect(ensureDependencies(common, versionId, reporter())).rejects.toMatchObject({ code: 'LIBRARIES_MISSING', details: { n: 1 } })
    expect(existsSync(marker())).toBe(false)
  })

  it('treats a corrupt stamp as no stamp', async () => {
    await installEverything()
    await put(stamp(), 'garbage')
    await ensureDependencies(common, versionId, reporter())
    expect(JSON.parse(await readFile(stamp(), 'utf8')).verifiedAt).toEqual(expect.any(Number))
  })
})
