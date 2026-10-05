import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { OrvianError, toPayload } from '../src/shared/errors'
import type { LauncherState } from '../src/shared/launcher-state'
import type { ProgressEvent } from '../electron/game/progress'
import { LauncherStore } from '../electron/state'

describe('LauncherStore', () => {
  let sent: LauncherState[]
  let now: number
  let store: LauncherStore
  const pack = (version = '1.0.4', source: 'network' | 'cache' = 'network', minimumLauncher = '0.1.0') => ({ version, minimumLauncher, source, changelog: ['uno'] })
  const kind = () => store.getState().phase.kind
  const ready = () => {
    store.setAccount({ name: 'Steve', uuid: 'u' })
    store.setPack(pack(), '1.0.4')
    store.markBooted()
  }
  const progress = (step: ProgressEvent['step'], fraction = 0.5, extra: Partial<ProgressEvent> = {}): ProgressEvent => ({ state: 's', progress: fraction, detail: `paso ${step}`, step, ...extra })

  beforeEach(() => {
    vi.useFakeTimers()
    sent = []
    now = 1_000
    store = new LauncherStore({ appVersion: '1.0.4', broadcast: (s) => void sent.push(s), now: () => now, throttleMs: 100 })
  })
  afterEach(() => vi.useRealTimers())

  it('starts booting, then reflects what is known', () => {
    expect(kind()).toBe('booting')
    store.setAccount({ name: 'Steve', uuid: 'abc' }, true)
    store.setPack(pack('1.0.5'), '1.0.4', 34_000_000)
    store.markBooted()
    expect(store.getState()).toMatchObject({
      phase: { kind: 'update-available' },
      account: { name: 'Steve', uuid: 'abc' },
      isAdmin: true,
      pack: { installed: '1.0.4', latest: '1.0.5', hasUpdate: true, offline: false, downloadBytes: 34_000_000, changelog: ['uno'] }
    })
  })

  it('only admins get the admin flag, and only while signed in', () => {
    store.setAccount({ name: 'Steve', uuid: 'abc' }, false)
    expect(store.getState().isAdmin).toBe(false)
    store.setAccount({ name: 'Steve', uuid: 'abc' }, true)
    store.setAccount(null, true)
    expect(store.getState().isAdmin).toBe(false)
  })

  it('does not report a download size once there is nothing to download', () => {
    store.setPack(pack('1.0.4'), '1.0.4', 999)
    expect(store.getState().pack.downloadBytes).toBeUndefined()
    store.setPack(pack('1.0.5'), null, 1234)
    expect(store.getState().pack.downloadBytes).toBe(1234)
  })

  it('marks pack information from the saved copy as offline', () => {
    ready()
    store.setPack(pack('1.0.4', 'cache'), '1.0.4')
    expect(store.getState()).toMatchObject({ phase: { kind: 'offline-ready' }, pack: { offline: true } })
  })

  describe('sign-in', () => {
    it('signing in takes the screen and clears an old error; expiry asks for a new sign-in', () => {
      ready()
      store.setError(toPayload(new OrvianError('DISK_FULL')))
      expect(kind()).toBe('error')
      store.setSigningIn(true)
      expect(kind()).toBe('signing-in')
      store.setSigningIn(false)
      expect(kind()).toBe('ready')
      store.expireSession()
      expect(store.getState()).toMatchObject({ phase: { kind: 'session-expired' }, account: null, isAdmin: false })
      store.setAccount({ name: 'Steve', uuid: 'u' })
      expect(kind()).toBe('ready')
    })
  })

  describe('install and launch', () => {
    it('follows an install through its steps and into the running game', () => {
      ready()
      store.beginActivity('installing')
      expect(store.getState().phase).toMatchObject({ kind: 'installing', progress: { step: 'java', fraction: 0 } })

      store.applyProgress(progress('libraries', 0.6, { current: 30, total: 100, bytesDone: 5, bytesTotal: 10, bytesPerSecond: 7 }))
      expect(store.getState().phase).toMatchObject({ kind: 'installing', progress: { step: 'libraries', fraction: 0.6, current: 30, total: 100, bytesPerSecond: 7, detail: 'paso libraries' } })

      store.applyProgress(progress('finalizing', 0.98))
      expect(kind()).toBe('launching')
      store.markRunning()
      expect(store.getState().phase).toEqual({ kind: 'running', startedAt: 1000 })

      now += 5000
      store.markRunning()
      expect(store.getState().phase).toEqual({ kind: 'running', startedAt: 1000 })

      store.endActivity()
      expect(kind()).toBe('ready')
    })

    it('a repair stays a repair through its last step and never becomes a launch', () => {
      ready()
      store.beginActivity('repairing')
      store.applyProgress(progress('finalizing', 0.99))
      expect(store.getState().phase).toMatchObject({ kind: 'repairing', progress: { step: 'finalizing' } })
      store.endActivity()
      expect(kind()).toBe('ready')
    })

    it('ignores progress that arrives when nothing is running', () => {
      ready()
      store.applyProgress(progress('java'))
      expect(kind()).toBe('ready')
      store.beginActivity('installing')
      store.endActivity()
      store.applyProgress(progress('forge'))
      expect(kind()).toBe('ready')
    })

    it('markRunning does nothing outside a launch', () => {
      ready()
      store.markRunning()
      expect(kind()).toBe('ready')
    })
  })

  describe('errors and crashes', () => {
    it('keeps the error until dismissed or until the next attempt starts', () => {
      ready()
      store.setError(toPayload(new OrvianError('LIBRARIES_MISSING', { n: 3 })), 'repair')
      expect(store.getState().phase).toMatchObject({ kind: 'error', retry: 'repair', error: { code: 'LIBRARIES_MISSING' } })
      store.dismissError()
      expect(kind()).toBe('ready')
      store.setError(toPayload(new OrvianError('BUSY')))
      store.beginActivity('installing')
      store.endActivity()
      expect(kind()).toBe('ready')
    })

    it('shows a crash until the player plays again or dismisses it', () => {
      ready()
      store.setCrash({ exitCode: 1, summary: 'boom', reportPath: '/r.txt' })
      expect(store.getState().phase).toEqual({ kind: 'crashed', exitCode: 1, summary: 'boom', reportPath: '/r.txt' })
      store.beginActivity('installing')
      store.endActivity()
      expect(kind()).toBe('ready')
      store.setCrash({ exitCode: 2, summary: 'again' })
      store.dismissError()
      expect(kind()).toBe('ready')
    })
  })

  describe('broadcasting', () => {
    it('sends immediately when idle and collapses a burst into the latest state', () => {
      ready()
      vi.runOnlyPendingTimers()
      sent.length = 0
      now += 1000
      store.setServer({ address: 'mc', state: 'checking' })
      expect(sent).toHaveLength(1)
      store.setServer({ address: 'mc', state: 'online' })
      store.setServer({ address: 'mc', state: 'offline' })
      store.setNews([{ version: '1', notes: [] }])
      expect(sent).toHaveLength(1)
      now += 100
      vi.advanceTimersByTime(100)
      expect(sent).toHaveLength(2)
      expect(sent[1].server.state).toBe('offline')
      expect(sent[1].news).toHaveLength(1)
    })

    it('flush() sends the current state right away', () => {
      ready()
      sent.length = 0
      store.setServer({ address: 'mc', state: 'online' })
      store.setServer({ address: 'mc', state: 'offline' })
      store.flush()
      expect(sent.at(-1)!.server.state).toBe('offline')
      const count = sent.length
      vi.advanceTimersByTime(1000)
      expect(sent).toHaveLength(count)
    })

    it('sends a snapshot that is safe to structured-clone to a window', () => {
      ready()
      store.beginActivity('installing')
      store.applyProgress(progress('modpack', 0.9, { bytesDone: 1, bytesTotal: 2 }))
      expect(() => structuredClone(store.getState())).not.toThrow()
    })
  })

  it('carries settings, server, news and the launcher update', () => {
    store.setSettings({ ramGb: 8, ramMin: 2, ramMax: 13 })
    store.setServer({ address: 'mc', state: 'online', players: { online: 1, max: 2 } })
    store.setNews([{ version: '1.0.4', notes: ['x'] }])
    store.setLauncherUpdate({ status: 'downloading', currentVersion: '1.0.4', newVersion: '1.0.5', percent: 40 })
    expect(store.getState()).toMatchObject({ settings: { ramGb: 8, ramMax: 13 }, server: { state: 'online' }, news: [{ version: '1.0.4' }], launcherUpdate: { status: 'downloading', percent: 40 } })
  })
})
