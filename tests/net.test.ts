import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { OrvianError } from '../src/shared/errors'
import { download, fetchJson, hashFile } from '../electron/net'

const BODY = Buffer.from('orvian test payload '.repeat(50))
const sha256 = createHash('sha256').update(BODY).digest('hex')
const sha1 = createHash('sha1').update(BODY).digest('hex')

let server: Server
let base = ''
let hits: Record<string, number> = {}

beforeAll(async () => {
  server = createServer((req, res) => {
    const path = (req.url ?? '/').split('?')[0]
    hits[path] = (hits[path] ?? 0) + 1
    if (path === '/ok') return void res.end(BODY)
    if (path === '/json') return void res.setHeader('content-type', 'application/json').end('{"a":1}')
    if (path === '/missing') return void res.writeHead(404).end('nope')
    if (path === '/flaky') {
      if (hits[path] === 1) return void res.writeHead(503).end('busy')
      return void res.end(BODY)
    }
    if (path === '/corrupt') return void res.end(Buffer.from('x'.repeat(BODY.length)))
    if (path === '/stall') {
      res.writeHead(200, { 'content-length': String(BODY.length) })
      res.write(BODY.subarray(0, 10))
      return // never ends: simulates a dead connection
    }
    res.writeHead(500).end()
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterAll(async () => {
  server.closeAllConnections()
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

describe('download', () => {
  let dir = ''
  beforeEach(async () => {
    hits = {}
    dir = await mkdtemp(join(tmpdir(), 'orvian-net-'))
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  const fast = { retryDelayMs: () => 0 }

  it('writes the file atomically and verifies the hash', async () => {
    const dest = join(dir, 'a', 'file.bin')
    const result = await download(`${base}/ok`, dest, { sha256, size: BODY.length, ...fast })
    expect(result).toMatchObject({ skipped: false, bytes: BODY.length })
    expect(await readFile(dest)).toEqual(BODY)
    expect(existsSync(`${dest}.part`)).toBe(false)
  })

  it('reuses a valid existing file without a request', async () => {
    const dest = join(dir, 'file.bin')
    await writeFile(dest, BODY)
    const result = await download(`${base}/ok`, dest, { sha1, size: BODY.length, ...fast })
    expect(result.skipped).toBe(true)
    expect(hits['/ok']).toBeUndefined()
  })

  it('does not trust an existing file when neither size nor hash is known', async () => {
    const dest = join(dir, 'file.bin')
    await writeFile(dest, 'old')
    const result = await download(`${base}/ok`, dest, fast)
    expect(result.skipped).toBe(false)
    expect(await readFile(dest)).toEqual(BODY)
  })

  it('retries transient server errors', async () => {
    const dest = join(dir, 'file.bin')
    await download(`${base}/flaky`, dest, { sha256, ...fast })
    expect(hits['/flaky']).toBe(2)
  })

  it('does not retry a 404 and reports the status', async () => {
    const dest = join(dir, 'file.bin')
    const error = await download(`${base}/missing`, dest, fast).catch((e) => e)
    expect(error).toBeInstanceOf(OrvianError)
    expect(error).toMatchObject({ code: 'DOWNLOAD_FAILED', details: { status: 404 } })
    expect(hits['/missing']).toBe(1)
  })

  it('rejects corrupted content and leaves no file behind', async () => {
    const dest = join(dir, 'file.bin')
    const error = await download(`${base}/corrupt`, dest, { sha256, attempts: 2, ...fast }).catch((e) => e)
    expect(error).toMatchObject({ code: 'HASH_MISMATCH' })
    expect(existsSync(dest)).toBe(false)
    expect(existsSync(`${dest}.part`)).toBe(false)
    expect(hits['/corrupt']).toBe(2)
  })

  it('keeps the previous file when the replacement fails verification', async () => {
    const dest = join(dir, 'file.bin')
    await writeFile(dest, 'previous good content')
    await download(`${base}/corrupt`, dest, { sha256, attempts: 1, ...fast }).catch(() => undefined)
    expect(await readFile(dest, 'utf8')).toBe('previous good content')
  })

  it('aborts a stalled transfer after the idle timeout', async () => {
    const dest = join(dir, 'file.bin')
    const error = await download(`${base}/stall`, dest, { idleTimeoutMs: 150, attempts: 1, ...fast }).catch((e) => e)
    expect(error).toMatchObject({ code: 'DOWNLOAD_FAILED', details: { reason: 'timeout' } })
    expect(existsSync(`${dest}.part`)).toBe(false)
  })

  it('enforces maxBytes while streaming', async () => {
    const dest = join(dir, 'file.bin')
    const error = await download(`${base}/ok`, dest, { maxBytes: 100, ...fast }).catch((e) => e)
    expect(error).toMatchObject({ code: 'DOWNLOAD_FAILED', details: { reason: 'too-large' } })
    expect(hits['/ok']).toBe(1)
    await expect(stat(dest)).rejects.toThrow()
  })

  it('reports progress', async () => {
    const seen: number[] = []
    await download(`${base}/ok`, join(dir, 'p.bin'), { onProgress: (p) => seen.push(p.bytesDone), ...fast })
    expect(seen.at(-1)).toBe(BODY.length)
  })

  it('maps a refused connection to NETWORK_OFFLINE', async () => {
    const error = await download('http://127.0.0.1:1/x', join(dir, 'f'), { attempts: 1, ...fast }).catch((e) => e)
    expect(error).toMatchObject({ code: 'NETWORK_OFFLINE' })
  })
})

describe('fetchJson', () => {
  it('parses JSON', async () => {
    expect(await fetchJson<{ a: number }>(`${base}/json`)).toEqual({ a: 1 })
  })

  it('throws a typed error on HTTP failure without leaking the query string', async () => {
    const error = (await fetchJson(`${base}/missing?token=secret`).catch((e) => e)) as OrvianError
    expect(error).toMatchObject({ code: 'DOWNLOAD_FAILED', details: { status: 404 } })
    expect(JSON.stringify(error.details)).not.toContain('secret')
    expect(error.message).not.toContain('secret')
  })
})

describe('hashFile', () => {
  it('hashes a file in a stream', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'orvian-hash-'))
    await writeFile(join(dir, 'x'), BODY)
    expect(await hashFile(join(dir, 'x'), 'sha256')).toBe(sha256)
    await rm(dir, { recursive: true, force: true })
  })
})
