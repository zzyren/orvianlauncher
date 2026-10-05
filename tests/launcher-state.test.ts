import { describe, expect, it } from 'vitest'
import { toPayload, OrvianError } from '../src/shared/errors'
import { derivePhase, getPrimaryAction, isNewer, type InstallProgress, type LauncherPhase, type LauncherState, type PhaseFacts } from '../src/shared/launcher-state'

const progress = (fraction = 0.42, detail = 'Descargando modpack · 120/290 MB'): InstallProgress => ({ step: 'modpack', detail, fraction })
const facts = (overrides: Partial<PhaseFacts> = {}): PhaseFacts => ({
  booted: true, hasAccount: true, signingIn: false, sessionExpired: false, checking: false,
  manifest: { version: '1.0.4', minimumLauncher: '0.1.0', source: 'network' }, installedVersion: '1.0.4', appVersion: '1.0.4',
  activity: null, crash: null, error: null, ...overrides
})
const kind = (f: PhaseFacts) => derivePhase(f).kind

describe('isNewer', () => {
  it.each([['1.0.5', '1.0.4', true], ['1.0.4', '1.0.4', false], ['1.0.3', '1.0.4', false], [null, '1.0.4', false], ['1.0.4', null, false]] as const)('%s vs %s -> %s', (a, b, out) =>
    expect(isNewer(a, b)).toBe(out)
  )
})

describe('derivePhase', () => {
  it('walks the normal journey of a player', () => {
    expect(kind(facts({ booted: false }))).toBe('booting')
    expect(kind(facts({ hasAccount: false }))).toBe('signed-out')
    expect(kind(facts({ hasAccount: false, signingIn: true }))).toBe('signing-in')
    expect(kind(facts({ installedVersion: null }))).toBe('not-installed')
    expect(kind(facts({ manifest: { version: '1.0.5', minimumLauncher: '0.1.0', source: 'network' } }))).toBe('update-available')
    expect(kind(facts())).toBe('ready')
  })

  it('shows an expired session instead of plain signed-out', () => {
    expect(kind(facts({ hasAccount: false, sessionExpired: true }))).toBe('session-expired')
  })

  it('work in progress outranks everything else', () => {
    const base = facts({ hasAccount: false, error: { error: toPayload(new OrvianError('BUSY')), retry: 'play' }, crash: { exitCode: 1, summary: 's' } })
    expect(derivePhase({ ...base, activity: { kind: 'installing', progress: progress() } })).toMatchObject({ kind: 'installing', progress: { fraction: 0.42 } })
    expect(derivePhase({ ...base, activity: { kind: 'repairing', progress: progress() } }).kind).toBe('repairing')
    expect(derivePhase({ ...base, activity: { kind: 'launching' } }).kind).toBe('launching')
    expect(derivePhase({ ...base, activity: { kind: 'running', startedAt: 5 } })).toEqual({ kind: 'running', startedAt: 5 })
  })

  it('an error takes the screen until it is dismissed, a crash waits for a signed-in player', () => {
    const error = { error: toPayload(new OrvianError('DISK_FULL')), retry: 'play' as const }
    expect(derivePhase(facts({ error }))).toMatchObject({ kind: 'error', retry: 'play', error: { code: 'DISK_FULL' } })
    expect(derivePhase(facts({ crash: { exitCode: 1, summary: 'boom', reportPath: '/r.txt' } }))).toEqual({ kind: 'crashed', exitCode: 1, summary: 'boom', reportPath: '/r.txt' })
    expect(kind(facts({ hasAccount: false, crash: { exitCode: 1, summary: 'boom' } }))).toBe('signed-out')
  })

  it('requires a launcher update when the pack asks for a newer launcher', () => {
    expect(derivePhase(facts({ manifest: { version: '1.0.5', minimumLauncher: '1.1.0', source: 'network' } }))).toEqual({ kind: 'launcher-update-required', required: '1.1.0' })
    expect(kind(facts({ manifest: { version: '1.0.5', minimumLauncher: '1.0.4', source: 'network' } }))).toBe('update-available')
  })

  it('handles being offline with and without an installation', () => {
    expect(kind(facts({ manifest: null, installedVersion: '1.0.4' }))).toBe('offline-ready')
    expect(kind(facts({ manifest: null, installedVersion: null }))).toBe('offline-unavailable')
    expect(kind(facts({ manifest: { version: '1.0.4', minimumLauncher: '0.1.0', source: 'cache' } }))).toBe('offline-ready')
    expect(kind(facts({ manifest: { version: '1.0.5', minimumLauncher: '0.1.0', source: 'cache' }, installedVersion: '1.0.3' }))).toBe('offline-ready')
    expect(kind(facts({ manifest: { version: '1.0.5', minimumLauncher: '0.1.0', source: 'cache' }, installedVersion: null }))).toBe('offline-unavailable')
  })

  it('reports checking only while the first answer is pending', () => {
    expect(kind(facts({ manifest: null, installedVersion: null, checking: true }))).toBe('checking')
    expect(kind(facts({ checking: true }))).toBe('ready')
  })
})

const stateFor = (phase: LauncherPhase, pack: Partial<LauncherState['pack']> = {}): Pick<LauncherState, 'phase' | 'pack'> => ({
  phase, pack: { installed: '1.0.3', latest: '1.0.4', hasUpdate: true, offline: false, changelog: [], ...pack }
})

describe('getPrimaryAction', () => {
  const action = (phase: LauncherPhase, pack?: Partial<LauncherState['pack']>) => getPrimaryAction(stateFor(phase, pack))

  it('has text, a state and an action for every phase', () => {
    const phases: LauncherPhase[] = [
      { kind: 'booting' }, { kind: 'signed-out' }, { kind: 'signing-in' }, { kind: 'session-expired' }, { kind: 'checking' }, { kind: 'not-installed' }, { kind: 'update-available' }, { kind: 'ready' },
      { kind: 'offline-ready' }, { kind: 'offline-unavailable' }, { kind: 'launcher-update-required', required: '1.1.0' }, { kind: 'installing', progress: progress() }, { kind: 'repairing', progress: progress() },
      { kind: 'launching' }, { kind: 'running', startedAt: 0 }, { kind: 'crashed', exitCode: 1, summary: 's' }, { kind: 'error', error: toPayload(new OrvianError('UNKNOWN')), retry: 'play' }
    ]
    for (const phase of phases) {
      const a = action(phase)
      expect(a.label.length, phase.kind).toBeGreaterThan(0)
      expect(a.label, phase.kind).not.toMatch(/[A-ZÁÉÍÓÚ]{4,}/) // sentence case, no shouting
      expect(a.enabled === (a.action !== 'none'), phase.kind).toBe(true)
    }
  })

  it('matches the target UX table', () => {
    expect(action({ kind: 'ready' })).toMatchObject({ label: 'Jugar', sublabel: 'Orvian v1.0.3', action: 'play', enabled: true })
    expect(action({ kind: 'update-available' }, { downloadBytes: 34 * 1024 * 1024 })).toMatchObject({ label: 'Actualizar y jugar', sublabel: 'v1.0.3 → v1.0.4 · 34 MB', action: 'play' })
    expect(action({ kind: 'not-installed' }, { installed: null, downloadBytes: 1.1 * 1024 ** 3 })).toMatchObject({ label: 'Instalar', sublabel: 'Primera instalación · 1,1 GB' })
    expect(action({ kind: 'not-installed' }, { installed: null })).toMatchObject({ sublabel: 'Primera instalación' })
    expect(action({ kind: 'offline-ready' })).toMatchObject({ label: 'Jugar sin conexión', action: 'play-installed' })
    expect(action({ kind: 'offline-unavailable' })).toMatchObject({ enabled: false, secondary: { action: 'check' } })
    expect(action({ kind: 'signing-in' })).toMatchObject({ enabled: false, secondary: { label: 'Cancelar', action: 'cancel-login' } })
    expect(action({ kind: 'running', startedAt: 0 })).toMatchObject({ label: 'Jugando', secondary: { action: 'force-quit' } })
    expect(action({ kind: 'launcher-update-required', required: '1.1.0' })).toMatchObject({ action: 'update-launcher' })
  })

  it('shows live progress while installing and repairing, keeping the button disabled', () => {
    expect(action({ kind: 'installing', progress: progress(0.425) })).toEqual({ label: 'Instalando… 43 %', sublabel: 'Descargando modpack · 120/290 MB', enabled: false, action: 'none' })
    expect(action({ kind: 'repairing', progress: progress(2) }).label).toBe('Reparando… 100 %')
    expect(action({ kind: 'installing', progress: progress(-1) }).label).toBe('Instalando… 0 %')
  })

  it('an error offers the retry that matches what failed', () => {
    const phase = (retry: 'play' | 'repair' | 'check' | 'login'): LauncherPhase => ({ kind: 'error', error: toPayload(new OrvianError('DISK_FULL')), retry })
    expect(action(phase('play'))).toMatchObject({ label: 'Reintentar', sublabel: 'Espacio insuficiente', action: 'play' })
    expect(action(phase('repair')).action).toBe('repair')
    expect(action(phase('check')).action).toBe('check')
    expect(action(phase('login')).action).toBe('login')
  })

  it('a crash lets the player try again straight away', () => {
    expect(action({ kind: 'crashed', exitCode: 1, summary: 'x' })).toMatchObject({ label: 'Jugar', action: 'play', enabled: true })
  })
})
