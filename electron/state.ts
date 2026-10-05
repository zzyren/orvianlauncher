import type { OrvianErrorPayload } from '../src/shared/errors'
import {
  derivePhase,
  isNewer,
  type InstallProgress,
  type LauncherState,
  type NewsItem,
  type PhaseFacts,
  type RetryKind,
  type ServerStatus,
  type UpdaterState
} from '../src/shared/launcher-state'
import type { ProgressEvent } from './game/progress'

/**
 * The single source of truth for what the windows show. Everything that happens in the launcher
 * (sign-in, update checks, installs, the game running) is reported here; windows only receive
 * the resulting state and never poll.
 */

export interface StoreDeps {
  appVersion: string
  broadcast: (state: LauncherState) => void
  now?: () => number
  /** Minimum time between broadcasts; a burst of changes is collapsed into the latest state. */
  throttleMs?: number
}

interface PackFacts {
  version: string
  minimumLauncher: string
  source: 'network' | 'cache'
  changelog: string[]
}

type Activity = NonNullable<PhaseFacts['activity']>

export class LauncherStore {
  private readonly now: () => number
  private readonly throttleMs: number
  private lastBroadcast = 0
  private timer: NodeJS.Timeout | null = null
  private mode: 'installing' | 'repairing' | null = null

  private booted = false
  private account: { name: string; uuid: string } | null = null
  private isAdmin = false
  private signingIn = false
  private sessionExpired = false
  private checking = true
  private pack: PackFacts | null = null
  private installedVersion: string | null = null
  private downloadBytes: number | undefined
  private activity: Activity | null = null
  private crash: PhaseFacts['crash'] = null
  private error: { error: OrvianErrorPayload; retry: RetryKind } | null = null
  private settings = { ramGb: 6, ramMin: 2, ramMax: 12 }
  private server: ServerStatus = { address: '', state: 'unknown' }
  private news: NewsItem[] = []
  private launcherUpdate: UpdaterState

  constructor(private readonly deps: StoreDeps) {
    this.now = deps.now ?? Date.now
    this.throttleMs = deps.throttleMs ?? 100
    this.launcherUpdate = { status: 'idle', currentVersion: deps.appVersion }
  }

  getState(): LauncherState {
    const latest = this.pack?.version ?? null
    return {
      phase: derivePhase({
        booted: this.booted,
        hasAccount: this.account !== null,
        signingIn: this.signingIn,
        sessionExpired: this.sessionExpired,
        checking: this.checking,
        manifest: this.pack ? { version: this.pack.version, minimumLauncher: this.pack.minimumLauncher, source: this.pack.source } : null,
        installedVersion: this.installedVersion,
        appVersion: this.deps.appVersion,
        activity: this.activity,
        crash: this.crash,
        error: this.error
      }),
      appVersion: this.deps.appVersion,
      account: this.account,
      isAdmin: this.isAdmin,
      pack: {
        installed: this.installedVersion,
        latest,
        hasUpdate: isNewer(latest, this.installedVersion),
        offline: this.pack ? this.pack.source === 'cache' : !this.checking,
        downloadBytes: this.downloadBytes,
        changelog: this.pack?.changelog ?? []
      },
      settings: this.settings,
      server: this.server,
      news: this.news,
      launcherUpdate: this.launcherUpdate
    }
  }

  // ─── Facts about the environment ──────────────────────────────────────────

  markBooted(): void {
    this.booted = true
    this.changed()
  }

  setAccount(account: { name: string; uuid: string } | null, isAdmin = false): void {
    this.account = account
    this.isAdmin = account !== null && isAdmin
    if (account) this.sessionExpired = false
    this.changed()
  }

  /** The stored session is no longer usable: the player has to sign in again. */
  expireSession(): void {
    this.account = null
    this.isAdmin = false
    this.sessionExpired = true
    this.changed()
  }

  setSigningIn(value: boolean): void {
    this.signingIn = value
    if (value) this.error = null
    this.changed()
  }

  setChecking(value: boolean): void {
    this.checking = value
    this.changed()
  }

  setPack(pack: PackFacts | null, installedVersion: string | null, downloadBytes?: number): void {
    this.pack = pack
    this.installedVersion = installedVersion
    this.downloadBytes = isNewer(pack?.version ?? null, installedVersion) || installedVersion === null ? downloadBytes : undefined
    this.checking = false
    this.changed()
  }

  setInstalledVersion(version: string | null): void {
    this.installedVersion = version
    this.changed()
  }

  setSettings(settings: { ramGb: number; ramMin: number; ramMax: number }): void {
    this.settings = settings
    this.changed()
  }

  setServer(status: ServerStatus): void {
    this.server = status
    this.changed()
  }

  setNews(items: NewsItem[]): void {
    this.news = items
    this.changed()
  }

  setLauncherUpdate(update: UpdaterState): void {
    this.launcherUpdate = update
    this.changed()
  }

  // ─── What the launcher is doing ───────────────────────────────────────────

  /** A new install, repair or launch begins: whatever happened last time no longer applies. */
  beginActivity(mode: 'installing' | 'repairing'): void {
    this.mode = mode
    this.crash = null
    this.error = null
    this.activity = { kind: mode, progress: { step: 'java', detail: 'Preparando…', fraction: 0 } }
    this.changed()
  }

  applyProgress(event: ProgressEvent): void {
    if (!event.step || !this.mode) return
    // For a normal play, the last step is the game starting.
    if (event.step === 'finalizing' && this.mode === 'installing') {
      this.activity = { kind: 'launching' }
    } else if (this.activity?.kind === 'installing' || this.activity?.kind === 'repairing') {
      const progress: InstallProgress = {
        step: event.step,
        detail: event.detail,
        fraction: event.progress,
        current: event.current,
        total: event.total,
        bytesDone: event.bytesDone,
        bytesTotal: event.bytesTotal,
        bytesPerSecond: event.bytesPerSecond
      }
      this.activity = { kind: this.activity.kind, progress }
    }
    this.changed()
  }

  markRunning(): void {
    if (this.activity?.kind === 'running') return
    if (this.activity?.kind === 'launching' || this.activity?.kind === 'installing') {
      this.activity = { kind: 'running', startedAt: this.now() }
      this.changed()
    }
  }

  /** The pipeline stopped (success of a repair, a failure, or the game closed). */
  endActivity(): void {
    this.activity = null
    this.mode = null
    this.changed()
  }

  setCrash(crash: PhaseFacts['crash']): void {
    this.crash = crash
    this.changed()
  }

  setError(error: OrvianErrorPayload | null, retry: RetryKind = 'play'): void {
    this.error = error ? { error, retry } : null
    this.changed()
  }

  dismissError(): void {
    this.error = null
    this.crash = null
    this.changed()
  }

  // ─── Broadcasting ─────────────────────────────────────────────────────────

  /** Sends the current state now, bypassing the throttle (used when a window asks for it). */
  flush(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    this.lastBroadcast = this.now()
    this.deps.broadcast(this.getState())
  }

  private changed(): void {
    if (this.timer) return
    const wait = this.lastBroadcast + this.throttleMs - this.now()
    if (wait <= 0) {
      this.flush()
      return
    }
    this.timer = setTimeout(() => this.flush(), wait)
    this.timer.unref?.()
  }
}
