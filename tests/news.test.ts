import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { OrvianManifest } from '../src/shared/manifest'
import { bodyToNotes, NewsService } from '../electron/news'

describe('bodyToNotes', () => {
  it('keeps the words and drops the Markdown', () => {
    const body = '## Novedades\n\n- Añadido **Jade** y `Embeddium`\n* Corregido [un fallo](https://example.test/x)\n1. Primero\n2) Segundo\n<b>html</b> fuera\n\n![img](a.png)'
    expect(bodyToNotes(body)).toEqual(['Novedades', 'Añadido Jade y Embeddium', 'Corregido un fallo', 'Primero', 'Segundo', 'html fuera'])
  })
  it('never lets markup through as HTML', () => {
    expect(bodyToNotes('<script>alert(1)</script>texto <img src=x onerror=alert(1)>')).toEqual(['alert(1)texto'])
  })
  it('limits the number and length of lines', () => {
    expect(bodyToNotes(Array.from({ length: 50 }, (_, i) => `línea ${i}`).join('\n'))).toHaveLength(20)
    const long = bodyToNotes('x'.repeat(1000))[0]
    expect(long.length).toBe(300)
    expect(long.endsWith('…')).toBe(true)
  })
  it('handles empty input', () => {
    expect(bodyToNotes(null)).toEqual([])
    expect(bodyToNotes('')).toEqual([])
    expect(bodyToNotes('   \n\n  ')).toEqual([])
  })
})

describe('NewsService', () => {
  let root = ''
  let now = 1_000_000
  let requests = 0
  let releases: unknown = []
  let failing = false
  const service = () => new NewsService({ dataRoot: root, repo: 'o/r', now: () => now })
  const manifest = { pack: { version: '1.0.9' }, publishedAt: '2026-10-01T00:00:00.000Z', changelog: ['- uno', '- dos'] } as OrvianManifest

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'orvian-news-'))
    now = 1_000_000
    requests = 0
    failing = false
    releases = [
      { tag_name: 'v1.0.9', draft: false, published_at: '2026-10-02T10:00:00Z', body: '- Nuevo mod' },
      { tag_name: 'v1.0.8-draft', draft: true, body: 'oculto' },
      { tag_name: '1.0.8', draft: false, published_at: '2026-09-20T10:00:00Z', body: null }
    ]
    vi.stubGlobal('fetch', async () => {
      requests++
      if (failing) throw new TypeError('fetch failed', { cause: Object.assign(new Error('x'), { code: 'ENOTFOUND' }) })
      return new Response(JSON.stringify(releases), { headers: { 'content-type': 'application/json' } })
    })
  })
  afterEach(async () => {
    vi.unstubAllGlobals()
    await rm(root, { recursive: true, force: true })
  })

  it('turns published releases into news, skipping drafts and the "v" prefix', async () => {
    expect(await service().get()).toEqual([
      { version: '1.0.9', publishedAt: '2026-10-02T10:00:00Z', notes: ['Nuevo mod'] },
      { version: '1.0.8', publishedAt: '2026-09-20T10:00:00Z', notes: [] }
    ])
  })

  it('serves the saved copy within the TTL and refreshes when forced or stale', async () => {
    const s = service()
    await s.get()
    await s.get()
    expect(requests).toBe(1)
    await s.get({ force: true })
    expect(requests).toBe(2)
    now += 31 * 60_000
    await s.get()
    expect(requests).toBe(3)
  })

  it('offline: uses the saved copy even when stale', async () => {
    await service().get()
    failing = true
    now += 3 * 60 * 60_000
    const items = await service().get()
    expect(items[0].version).toBe('1.0.9')
  })

  it('offline without a saved copy: falls back to the pack changelog, or to nothing', async () => {
    failing = true
    expect(await service().get({ manifest })).toEqual([{ version: '1.0.9', publishedAt: '2026-10-01T00:00:00.000Z', notes: ['uno', 'dos'] }])
    expect(await service().get()).toEqual([])
  })

  it('ignores a corrupt saved copy and a response that has no usable releases', async () => {
    await mkdir(join(root, 'launcher'), { recursive: true })
    await writeFile(join(root, 'launcher', 'news.json'), '{nope')
    releases = [{ tag_name: 'v1', draft: true }]
    expect(await service().get({ manifest })).toEqual([{ version: '1.0.9', publishedAt: '2026-10-01T00:00:00.000Z', notes: ['uno', 'dos'] }])
    // nothing useful was received, so the damaged file is left alone rather than replaced with an empty copy
    expect(await readFile(join(root, 'launcher', 'news.json'), 'utf8')).toBe('{nope')
  })
})
