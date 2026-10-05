import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { OrvianManifest } from '../src/shared/manifest'
import { initConfig } from '../electron/config'
import { ManifestPoller, ManifestProvider, hasUpdate, normalizeManifest, readInstalledVersion, type PollResult } from '../electron/modpack/manifest'

const file = (path: string) => ({ path, sha256: 'a'.repeat(64), size: 10, url: 'https://github.com/o/r/releases/download/v1.0.5/modpack.zip', type: 'mod' as const, required: true, userMutable: false, userDeletable: false })
const manifest = (version = '1.0.5', files = [file('mods/a.jar')]): OrvianManifest => ({
  schemaVersion: 1, pack: { id: 'orvian', name: 'Orvian', version, minecraft: '1.20.1', loader: 'forge', forge: '47.4.23' }, runtime: { java: 17 },
  minimumLauncher: '0.1.0', publishedAt: '2026-10-01T00:00:00.000Z', changelog: ['x'], files
})
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const offline = () => new TypeError('fetch failed', { cause: Object.assign(new Error('x'), { code: 'ENOTFOUND' }) })

describe('normalizeManifest / hasUpdate', () => {
  it('strips archive prefixes and .bobby files without mutating the input', () => {
    const input = manifest('1.0.5', [file('overrides/mods/a.jar'), file('.minecraft/config/b.toml'), file('/mods/c.jar'), file('.bobby/x.dat'), file('mods/d.jar')])
    const frozen = structuredClone(input)
    const out = normalizeManifest(input)
    expect(out.files.map((f) => f.path)).toEqual(['mods/a.jar', 'config/b.toml', 'mods/c.jar', 'mods/d.jar'])
    expect(input).toEqual(frozen)
  })

  it.each([
    ['1.0.3', '1.0.4', true],
    ['1.0.4', '1.0.4', false],
    ['1.0.5', '1.0.4', false],
    ['1.0.4-beta', '1.0.4', true],
    [null, '1.0.4', false],
    ['1.0.4', null, false]
  ])('installed %s, latest %s -> %s', (installed, latest, expected) => expect(hasUpdate(installed, latest)).toBe(expected))
})

describe('ManifestProvider', () => {
  let root = ''
  let requests: string[] = []
  let routes: Array<[string, () => Response | Promise<Response>]> = []
  let now = 1_000_000
  const cacheFile = () => join(root, 'launcher', 'orvian-manifest.json')
  const provider = () => new ManifestProvider({ dataRoot: root, now: () => now })

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'orvian-manifest-'))
    requests = []
    routes = []
    now = 1_000_000
    initConfig(true, {})
    vi.stubGlobal('fetch', async (input: string | URL) => {
      const url = String(input)
      requests.push(url.replace(/\?t=\d+/, ''))
      const route = routes.find(([prefix]) => url.startsWith(prefix))
      if (!route) return new Response('nope', { status: 404 })
      return route[1]()
    })
  })
  afterEach(async () => {
    vi.unstubAllGlobals()
    initConfig(true, {})
    await rm(root, { recursive: true, force: true })
  })

  const DIRECT = 'https://github.com/zzyren/orvianmodpack/releases/latest/download/orvian-manifest.json'
  const API = 'https://api.github.com/repos/zzyren/orvianmodpack/releases/latest'

  it('fetches, validates, normalises and caches the manifest on disk', async () => {
    routes.push([DIRECT, () => json(manifest('1.0.5', [file('overrides/mods/a.jar')]))])
    const result = await provider().get()
    expect(result).toMatchObject({ source: 'network', manifest: { pack: { version: '1.0.5' } } })
    expect(result!.manifest.files[0].path).toBe('mods/a.jar')
    expect(JSON.parse(await readFile(cacheFile(), 'utf8')).pack.version).toBe('1.0.5')
    expect(existsSync(`${cacheFile()}.tmp`)).toBe(false)
  })

  it('serves from memory within the TTL and refetches when forced', async () => {
    routes.push([DIRECT, () => json(manifest())])
    const p = provider()
    await p.get()
    await p.get()
    expect(requests).toHaveLength(1)
    await p.get({ force: true })
    expect(requests).toHaveLength(2)
    now += 61_000
    await p.get()
    expect(requests).toHaveLength(3)
  })

  it('shares one request between concurrent callers', async () => {
    routes.push([DIRECT, async () => (await new Promise((r) => setTimeout(r, 20)), json(manifest()))])
    const p = provider()
    await Promise.all([p.get(), p.get(), p.get()])
    expect(requests).toHaveLength(1)
  })

  it('offline: uses the last known manifest, marks it as cached, and does not also ask the API', async () => {
    await mkdir(join(root, 'launcher'), { recursive: true })
    await writeFile(cacheFile(), JSON.stringify(manifest('1.0.4')))
    routes.push([DIRECT, () => { throw offline() }])
    const p = provider()
    const result = await p.get()
    expect(result).toMatchObject({ source: 'cache', manifest: { pack: { version: '1.0.4' } } })
    expect(requests).toEqual([DIRECT])
    // a cached answer never counts as fresh: the next call tries the network again
    await p.get()
    expect(requests).toHaveLength(2)
  })

  it('offline without any cache: nothing (there is no bundled fallback)', async () => {
    routes.push([DIRECT, () => { throw offline() }])
    expect(await provider().get()).toBeNull()
  })

  it('falls back to the GitHub API when the direct download answers with an HTTP error', async () => {
    routes.push([DIRECT, () => new Response('gone', { status: 404 })])
    routes.push([API, () => json({ assets: [{ name: 'other.txt', browser_download_url: 'https://x/other' }, { name: 'orvian-manifest.json', browser_download_url: 'https://assets.example/manifest.json' }] })])
    routes.push(['https://assets.example/manifest.json', () => json(manifest('1.0.6'))])
    expect(await provider().get()).toMatchObject({ source: 'network', manifest: { pack: { version: '1.0.6' } } })
  })

  it('rejects a manifest that fails validation and keeps the cached one', async () => {
    await mkdir(join(root, 'launcher'), { recursive: true })
    await writeFile(cacheFile(), JSON.stringify(manifest('1.0.4')))
    routes.push([DIRECT, () => json({ ...manifest('1.0.9'), files: [file('../escape.jar')] })])
    routes.push([API, () => new Response('', { status: 404 })])
    const result = await provider().get()
    expect(result).toMatchObject({ source: 'cache', manifest: { pack: { version: '1.0.4' } } })
  })

  it('ignores a corrupt cache file', async () => {
    await mkdir(join(root, 'launcher'), { recursive: true })
    await writeFile(cacheFile(), '{nope')
    routes.push([DIRECT, () => { throw offline() }])
    expect(await provider().get()).toBeNull()
  })

  it('uses only the override URL when one is configured for development', async () => {
    initConfig(false, { ORVIAN_MANIFEST_URL: 'http://127.0.0.1:9/m.json' })
    routes.push(['http://127.0.0.1:9/m.json', () => new Response('x', { status: 500 })])
    expect(await provider().get()).toBeNull()
    expect(requests).toEqual(['http://127.0.0.1:9/m.json'])
  })

  it('remember() makes a freshly published manifest current immediately', async () => {
    const p = provider()
    await p.remember(manifest('2.0.0'))
    expect(await p.get()).toMatchObject({ source: 'network', manifest: { pack: { version: '2.0.0' } } })
    expect(requests).toHaveLength(0)
    expect(JSON.parse(await readFile(cacheFile(), 'utf8')).pack.version).toBe('2.0.0')
  })
})

describe('readInstalledVersion', () => {
  it('reads the version from the official state, tolerating absence and damage', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'orvian-installed-'))
    expect(await readInstalledVersion(dir)).toBeNull()
    await mkdir(join(dir, '.orvian'), { recursive: true })
    await writeFile(join(dir, '.orvian', 'official-state.json'), JSON.stringify({ version: '1.0.3', files: {} }))
    expect(await readInstalledVersion(dir)).toBe('1.0.3')
    await writeFile(join(dir, '.orvian', 'official-state.json'), '{nope')
    expect(await readInstalledVersion(dir)).toBeNull()
    await rm(dir, { recursive: true, force: true })
  })
})

describe('ManifestPoller', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  const setup = (results: Array<{ latest: string | null; source: 'network' | 'cache' }>, extra: { paused?: () => boolean; installed?: string | null } = {}) => {
    let call = 0
    const seen: Array<[PollResult, boolean]> = []
    const get = vi.fn(async () => {
      const r = results[Math.min(call++, results.length - 1)]
      return r.latest ? { manifest: manifest(r.latest), source: r.source } : null
    })
    const poller = new ManifestPoller({
      provider: { get },
      readInstalled: async () => (extra.installed === undefined ? '1.0.4' : extra.installed),
      isPaused: extra.paused ?? (() => false),
      onResult: (r, changed) => void seen.push([r, changed])
    })
    return { poller, get, seen }
  }

  it('checks every five minutes and flags only real changes', async () => {
    const { poller, get, seen } = setup([{ latest: '1.0.4', source: 'network' }, { latest: '1.0.4', source: 'network' }, { latest: '1.0.5', source: 'network' }])
    poller.start()
    await vi.advanceTimersByTimeAsync(5 * 60_000)
    await vi.advanceTimersByTimeAsync(5 * 60_000)
    await vi.advanceTimersByTimeAsync(5 * 60_000)
    expect(get).toHaveBeenCalledTimes(3)
    expect(seen.map(([r, changed]) => [r.latest, r.hasUpdate, changed])).toEqual([['1.0.4', false, true], ['1.0.4', false, false], ['1.0.5', true, true]])
    poller.stop()
  })

  it('backs off exponentially while the network is down and recovers afterwards', async () => {
    const { poller } = setup([{ latest: '1.0.4', source: 'cache' }])
    expect(poller.nextDelayMs()).toBe(5 * 60_000)
    await poller.checkNow()
    expect(poller.nextDelayMs()).toBe(10 * 60_000)
    await poller.checkNow()
    expect(poller.nextDelayMs()).toBe(20 * 60_000)
    await poller.checkNow()
    expect(poller.nextDelayMs()).toBe(30 * 60_000)
    for (let i = 0; i < 5; i++) await poller.checkNow()
    expect(poller.nextDelayMs()).toBe(30 * 60_000)
  })

  it('goes back to the base interval after a successful network check', async () => {
    const { poller } = setup([{ latest: null, source: 'cache' }, { latest: '1.0.4', source: 'network' }])
    await poller.checkNow()
    expect(poller.nextDelayMs()).toBe(10 * 60_000)
    await poller.checkNow()
    expect(poller.nextDelayMs()).toBe(5 * 60_000)
  })

  it('does not check while paused (game running) but keeps its schedule', async () => {
    let paused = true
    const { poller, get } = setup([{ latest: '1.0.4', source: 'network' }], { paused: () => paused })
    poller.start()
    await vi.advanceTimersByTimeAsync(5 * 60_000)
    expect(get).not.toHaveBeenCalled()
    paused = false
    await vi.advanceTimersByTimeAsync(5 * 60_000)
    expect(get).toHaveBeenCalledTimes(1)
    poller.stop()
  })

  it('stop() cancels pending checks', async () => {
    const { poller, get } = setup([{ latest: '1.0.4', source: 'network' }])
    poller.start()
    poller.stop()
    await vi.advanceTimersByTimeAsync(60 * 60_000)
    expect(get).not.toHaveBeenCalled()
  })

  it('note() sets the baseline for change detection', async () => {
    const { poller, seen } = setup([{ latest: '1.0.4', source: 'network' }])
    poller.note('1.0.4', '1.0.4')
    await poller.checkNow()
    expect(seen[0][1]).toBe(false)
  })
})
