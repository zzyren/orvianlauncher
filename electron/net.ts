import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir, rename, rm, stat } from 'node:fs/promises'
import { basename, dirname } from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { ReadableStream as WebReadableStream } from 'node:stream/web'
import { OrvianError, fromNodeError } from '../src/shared/errors'

/** The single HTTP layer of the main process: timeouts, retries, atomic downloads, hash checks. */

let userAgent = 'OrvianLauncher'

export function setUserAgent(value: string): void {
  userAgent = value
}

export function getUserAgent(): string {
  return userAgent
}

/** Drops the query string so signed or token-bearing URLs never reach logs or error details. */
function safeUrl(url: string): string {
  try {
    const parsed = new URL(url)
    return `${parsed.origin}${parsed.pathname}`
  } catch {
    return 'url-no-valida'
  }
}

class HttpStatusError extends Error {
  constructor(readonly status: number) {
    super(`HTTP ${status}`)
    this.name = 'HttpStatusError'
  }
}

/**
 * fetch with a hard timeout until the response headers arrive. Callers that read the body
 * themselves are responsible for their own body timeout (see `fetchJson` and `download`).
 */
export async function fetchWithTimeout(url: string, init: RequestInit = {}, timeoutMs = 15_000): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  const signal = init.signal ? AbortSignal.any([init.signal, controller.signal]) : controller.signal
  try {
    return await fetch(url, { ...init, signal })
  } catch (err) {
    if (controller.signal.aborted && !init.signal?.aborted) {
      throw new OrvianError('DOWNLOAD_FAILED', { url: safeUrl(url), reason: 'timeout' }, { cause: err, message: `Timeout de red: ${safeUrl(url)}` })
    }
    throw fromNodeError(err, { url: safeUrl(url) })
  } finally {
    clearTimeout(timer)
  }
}

export interface FetchJsonOptions {
  timeoutMs?: number
  headers?: Record<string, string>
  signal?: AbortSignal
}

export async function fetchJson<T = unknown>(url: string, options: FetchJsonOptions = {}): Promise<T> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 15_000)
  const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal
  try {
    const res = await fetch(url, {
      signal,
      headers: { 'User-Agent': userAgent, Accept: 'application/json', ...options.headers }
    })
    if (!res.ok) {
      throw new OrvianError('DOWNLOAD_FAILED', { url: safeUrl(url), status: res.status }, { message: `HTTP ${res.status} al obtener ${safeUrl(url)}` })
    }
    return (await res.json()) as T
  } catch (err) {
    if (err instanceof OrvianError) throw err
    if (controller.signal.aborted && !options.signal?.aborted) {
      throw new OrvianError('DOWNLOAD_FAILED', { url: safeUrl(url), reason: 'timeout' }, { cause: err, message: `Timeout de red: ${safeUrl(url)}` })
    }
    throw fromNodeError(err, { url: safeUrl(url) })
  } finally {
    clearTimeout(timer)
  }
}

export type HashAlgorithm = 'sha1' | 'sha256' | 'sha512'

export interface DownloadOptions {
  sha1?: string
  sha256?: string
  sha512?: string
  size?: number
  /** Hard cap enforced while streaming, for untrusted sources. */
  maxBytes?: number
  headers?: Record<string, string>
  signal?: AbortSignal
  /** Abort when no bytes arrive for this long. Default 30 s. */
  idleTimeoutMs?: number
  /** Total attempts including the first. Default 3. */
  attempts?: number
  retryDelayMs?: (attempt: number) => number
  onProgress?: (progress: { bytesDone: number; bytesTotal?: number }) => void
}

export interface DownloadResult {
  path: string
  bytes: number
  /** True when an already valid file was reused and nothing was downloaded. */
  skipped: boolean
}

function expectedHash(options: DownloadOptions): { algorithm: HashAlgorithm; value: string } | undefined {
  if (options.sha256) return { algorithm: 'sha256', value: options.sha256.toLowerCase() }
  if (options.sha512) return { algorithm: 'sha512', value: options.sha512.toLowerCase() }
  if (options.sha1) return { algorithm: 'sha1', value: options.sha1.toLowerCase() }
  return undefined
}

export async function hashFile(path: string, algorithm: HashAlgorithm): Promise<string> {
  const hash = createHash(algorithm)
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer)
  return hash.digest('hex')
}

async function isAlreadyValid(dest: string, options: DownloadOptions): Promise<boolean> {
  const expected = expectedHash(options)
  if (options.size === undefined && !expected) return false
  try {
    const info = await stat(dest)
    if (!info.isFile()) return false
    if (options.size !== undefined && info.size !== options.size) return false
    if (expected && (await hashFile(dest, expected.algorithm)) !== expected.value) return false
    return true
  } catch {
    return false
  }
}

/** Windows cannot rename over a file that exists; retry after removing the old one. */
async function replaceFile(from: string, to: string): Promise<void> {
  try {
    await rename(from, to)
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code !== 'EPERM' && code !== 'EEXIST' && code !== 'EACCES') throw err
    await rm(to, { force: true })
    await rename(from, to)
  }
}

async function attemptDownload(url: string, dest: string, part: string, options: DownloadOptions): Promise<DownloadResult> {
  const idleMs = options.idleTimeoutMs ?? 30_000
  const controller = new AbortController()
  let idleFired = false
  let idleTimer: NodeJS.Timeout | undefined
  const armIdle = (): void => {
    clearTimeout(idleTimer)
    idleTimer = setTimeout(() => {
      idleFired = true
      controller.abort()
    }, idleMs)
  }
  const onExternalAbort = (): void => controller.abort()
  options.signal?.addEventListener('abort', onExternalAbort, { once: true })

  try {
    armIdle()
    const res = await fetch(url, { signal: controller.signal, headers: { 'User-Agent': userAgent, ...options.headers } })
    if (!res.ok || !res.body) throw new HttpStatusError(res.status)

    const headerLength = Number(res.headers.get('content-length'))
    const total = options.size ?? (Number.isFinite(headerLength) && headerLength > 0 ? headerLength : undefined)
    const expected = expectedHash(options)
    const hasher = expected ? createHash(expected.algorithm) : undefined
    let bytes = 0

    const counter = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        bytes += chunk.length
        if (options.maxBytes !== undefined && bytes > options.maxBytes) {
          callback(new OrvianError('DOWNLOAD_FAILED', { file: basename(dest), reason: 'too-large' }, { message: `Descarga superior a ${options.maxBytes} bytes` }))
          return
        }
        hasher?.update(chunk)
        armIdle()
        options.onProgress?.({ bytesDone: bytes, bytesTotal: total })
        callback(null, chunk)
      }
    })

    await pipeline(Readable.fromWeb(res.body as unknown as WebReadableStream), counter, createWriteStream(part), { signal: controller.signal })

    if (options.size !== undefined && bytes !== options.size) {
      throw new OrvianError('HASH_MISMATCH', { file: basename(dest), expectedSize: options.size, actualSize: bytes }, { message: `Tamaño incorrecto en ${basename(dest)}` })
    }
    if (expected && hasher) {
      const actual = hasher.digest('hex')
      if (actual !== expected.value) {
        throw new OrvianError('HASH_MISMATCH', { file: basename(dest), algorithm: expected.algorithm }, { message: `${expected.algorithm.toUpperCase()} incorrecto en ${basename(dest)}` })
      }
    }
    await replaceFile(part, dest)
    return { path: dest, bytes, skipped: false }
  } catch (err) {
    if (idleFired) {
      throw new OrvianError('DOWNLOAD_FAILED', { file: basename(dest), reason: 'timeout' }, { cause: err, message: `Sin datos durante ${idleMs} ms: ${safeUrl(url)}` })
    }
    throw err
  } finally {
    clearTimeout(idleTimer)
    options.signal?.removeEventListener('abort', onExternalAbort)
  }
}

function isRetryable(err: unknown): boolean {
  if (err instanceof HttpStatusError) return err.status >= 500 || err.status === 408 || err.status === 429
  if (err instanceof OrvianError) return err.code !== 'DOWNLOAD_FAILED' || err.details.reason !== 'too-large'
  return true
}

function toDownloadError(err: unknown, url: string, dest: string): unknown {
  if (err instanceof OrvianError) return err
  if (err instanceof HttpStatusError) {
    return new OrvianError('DOWNLOAD_FAILED', { file: basename(dest), url: safeUrl(url), status: err.status }, { cause: err, message: `HTTP ${err.status} al descargar ${safeUrl(url)}` })
  }
  return fromNodeError(err, { file: basename(dest), url: safeUrl(url) })
}

/**
 * Downloads `url` to `dest` through `dest.part`, verifying size and hash before the final
 * rename, so a partial or corrupted file never carries the final name. An already valid
 * destination (size and/or hash given) is reused without touching the network.
 */
export async function download(url: string, dest: string, options: DownloadOptions = {}): Promise<DownloadResult> {
  if (await isAlreadyValid(dest, options)) {
    return { path: dest, bytes: (await stat(dest)).size, skipped: true }
  }
  await mkdir(dirname(dest), { recursive: true })
  const part = `${dest}.part`
  const attempts = Math.max(1, options.attempts ?? 3)
  const delay = options.retryDelayMs ?? ((attempt: number) => 1000 * 2 ** attempt)
  let lastError: unknown

  for (let attempt = 0; attempt < attempts; attempt++) {
    if (options.signal?.aborted) throw options.signal.reason ?? new Error('Descarga cancelada')
    try {
      return await attemptDownload(url, dest, part, options)
    } catch (err) {
      await rm(part, { force: true }).catch(() => undefined)
      lastError = err
      if (options.signal?.aborted) throw err
      if (!isRetryable(err) || attempt === attempts - 1) break
      await new Promise((resolve) => setTimeout(resolve, delay(attempt)))
    }
  }
  throw toDownloadError(lastError, url, dest)
}
