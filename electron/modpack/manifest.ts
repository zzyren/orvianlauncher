import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fromNodeError } from '../../src/shared/errors'
import { writeJsonAtomically } from '../../src/shared/integrity'
import { compareVersions, ManifestSchema, type OrvianManifest } from '../../src/shared/manifest'
import { normalizeArchivePath } from '../../src/shared/archive'
import { getConfig } from '../config'
import { log } from '../logger'
import { fetchJson } from '../net'

/**
 * Where the modpack manifest comes from: the latest GitHub release, remembered on disk so the
 * launcher keeps working offline. Nothing else is trusted as a fallback.
 */

export interface ManifestResult {
  manifest: OrvianManifest
  /** `cache` means the network could not be reached and the last known manifest is being used. */
  source: 'network' | 'cache'
}

/** Paths in published manifests may still carry the archive's folder prefix; make them game-relative. */
export function normalizeManifest(input: OrvianManifest): OrvianManifest {
  const manifest = structuredClone(input)
  manifest.files = manifest.files
    .filter((file) => !file.path.includes('.bobby/'))
    .map((file) => ({ ...file, path: normalizeArchivePath(file.path, 'overrides/') }))
  return manifest
}

/** An update exists only when the published version is newer, so a rolled-back release never "updates" backwards. */
export function hasUpdate(installed: string | null, latest: string | null): boolean {
  return Boolean(installed && latest && compareVersions(latest, installed) > 0)
}

export async function readInstalledVersion(instanceDir: string): Promise<string | null> {
  try {
    const state = JSON.parse(await readFile(join(instanceDir, '.orvian', 'official-state.json'), 'utf8')) as { version?: string }
    return state.version || null
  } catch {
    return null
  }
}

function parseManifest(raw: unknown, origin: string): OrvianManifest | null {
  const parsed = ManifestSchema.safeParse(raw)
  if (!parsed.success) {
    log.warn('[Manifest] Manifiesto no válido (%s): %s', origin, parsed.error.issues.slice(0, 3).map((i) => `${i.path.join('.')}: ${i.message}`).join('; '))
    return null
  }
  return normalizeManifest(parsed.data)
}

function isNetworkFailure(err: unknown): boolean {
  const error = fromNodeError(err)
  return error.code === 'NETWORK_OFFLINE' || (error.code === 'DOWNLOAD_FAILED' && error.details.reason === 'timeout')
}

export interface ManifestProviderOptions {
  dataRoot: string
  ttlMs?: number
  now?: () => number
}

export class ManifestProvider {
  private readonly cacheFile: string
  private readonly ttlMs: number
  private readonly now: () => number
  private memory: { result: ManifestResult; at: number } | null = null
  private inflight: Promise<ManifestResult | null> | null = null

  constructor(options: ManifestProviderOptions) {
    this.cacheFile = join(options.dataRoot, 'launcher', 'orvian-manifest.json')
    this.ttlMs = options.ttlMs ?? 60_000
    this.now = options.now ?? Date.now
  }

  /** What is known right now without any I/O. */
  peek(): ManifestResult | null {
    return this.memory?.result ?? null
  }

  async get(options: { force?: boolean } = {}): Promise<ManifestResult | null> {
    if (!options.force && this.memory?.result.source === 'network' && this.now() - this.memory.at < this.ttlMs) return this.memory.result
    // Concurrent callers share one request instead of racing several to GitHub.
    this.inflight ??= this.load().finally(() => {
      this.inflight = null
    })
    return this.inflight
  }

  /** After publishing from this machine: the new manifest is the truth, no need to wait for GitHub. */
  async remember(manifest: OrvianManifest): Promise<void> {
    const normalized = normalizeManifest(manifest)
    this.memory = { result: { manifest: normalized, source: 'network' }, at: this.now() }
    await writeJsonAtomically(this.cacheFile, normalized).catch((err) => log.warn('[Manifest] No se pudo guardar la caché: %s', String(err)))
  }

  forget(): void {
    this.memory = null
  }

  private async load(): Promise<ManifestResult | null> {
    const remote = await this.fetchRemote()
    if (remote) {
      this.memory = { result: { manifest: remote, source: 'network' }, at: this.now() }
      await writeJsonAtomically(this.cacheFile, remote).catch((err) => log.warn('[Manifest] No se pudo guardar la caché: %s', String(err)))
      return this.memory.result
    }

    const cached = await this.readCache()
    if (cached) {
      log.info('[Manifest] Sin acceso al manifiesto remoto; se usa el último conocido (v%s).', cached.pack.version)
      // Timestamp 0 forces the next call to try the network again.
      this.memory = { result: { manifest: cached, source: 'cache' }, at: 0 }
      return this.memory.result
    }
    return null
  }

  private async readCache(): Promise<OrvianManifest | null> {
    try {
      return parseManifest(JSON.parse(await readFile(this.cacheFile, 'utf8')), 'caché')
    } catch {
      return null
    }
  }

  private async fetchRemote(): Promise<OrvianManifest | null> {
    const config = getConfig()
    const headers = { 'Cache-Control': 'no-cache' }
    const direct = config.manifestUrl ?? `https://github.com/${config.packRepo}/releases/latest/download/orvian-manifest.json?t=${this.now()}`
    try {
      return parseManifest(await fetchJson<unknown>(direct, { timeoutMs: 10_000, headers }), 'release')
    } catch (err) {
      // Offline or timing out: asking the API as well would only double the wait.
      if (isNetworkFailure(err) || config.manifestUrl) {
        log.info('[Manifest] No se pudo obtener el manifiesto: %s', err instanceof Error ? err.message : String(err))
        return null
      }
      log.warn('[Manifest] La descarga directa falló (%s); se consulta la API de GitHub.', err instanceof Error ? err.message : String(err))
    }

    try {
      const release = await fetchJson<{ assets?: Array<{ name: string; browser_download_url: string }> }>(`https://api.github.com/repos/${config.packRepo}/releases/latest`, { timeoutMs: 10_000, headers })
      const asset = release.assets?.find((a) => a.name === 'orvian-manifest.json')
      if (!asset) return null
      return parseManifest(await fetchJson<unknown>(asset.browser_download_url, { timeoutMs: 10_000, headers }), 'API')
    } catch (err) {
      log.info('[Manifest] La API de GitHub tampoco respondió: %s', err instanceof Error ? err.message : String(err))
      return null
    }
  }
}

export interface PollResult {
  installed: string | null
  latest: string | null
  hasUpdate: boolean
  source: 'network' | 'cache' | 'none'
}

export interface PollerDeps {
  provider: Pick<ManifestProvider, 'get'>
  readInstalled: () => Promise<string | null>
  /** True while the game runs: nothing is checked or announced then. */
  isPaused: () => boolean
  onResult: (result: PollResult, changed: boolean) => void
  baseDelayMs?: number
  maxDelayMs?: number
}

/** Periodic update check: every few minutes while reachable, backing off while the network is down. */
export class ManifestPoller {
  private timer: NodeJS.Timeout | null = null
  private failures = 0
  private last: PollResult | null = null
  private running = false
  private readonly baseDelayMs: number
  private readonly maxDelayMs: number

  constructor(private readonly deps: PollerDeps) {
    this.baseDelayMs = deps.baseDelayMs ?? 5 * 60_000
    this.maxDelayMs = deps.maxDelayMs ?? 30 * 60_000
  }

  nextDelayMs(): number {
    return Math.min(this.baseDelayMs * 2 ** this.failures, this.maxDelayMs)
  }

  start(): void {
    this.running = true
    this.schedule()
  }

  stop(): void {
    this.running = false
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }

  private schedule(): void {
    if (!this.running) return
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => void this.tick(), this.nextDelayMs())
    this.timer.unref?.()
  }

  private async tick(): Promise<void> {
    if (!this.deps.isPaused()) await this.checkNow(true).catch((err) => log.warn('[Manifest] Comprobación fallida: %s', String(err)))
    this.schedule()
  }

  async checkNow(force = true): Promise<PollResult> {
    const [found, installed] = await Promise.all([this.deps.provider.get({ force }), this.deps.readInstalled()])
    const latest = found?.manifest.pack.version ?? null
    const result: PollResult = { installed, latest, hasUpdate: hasUpdate(installed, latest), source: found?.source ?? 'none' }
    this.failures = result.source === 'network' ? 0 : Math.min(this.failures + 1, 6)
    const changed = !this.last || this.last.latest !== result.latest || this.last.installed !== result.installed
    this.last = result
    this.deps.onResult(result, changed)
    return result
  }

  /** Lets other code (a finished install, a published release) update what "changed" is measured against. */
  note(installed: string | null, latest: string | null): void {
    this.last = { installed, latest, hasUpdate: hasUpdate(installed, latest), source: this.last?.source ?? 'none' }
  }
}

