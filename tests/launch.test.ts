import { EventEmitter } from 'node:events'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { launch, Version } from '@xmcl/core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@xmcl/core', async (importOriginal) => ({ ...(await importOriginal<typeof import('@xmcl/core')>()), launch: vi.fn(), Version: { parse: vi.fn() } }))
vi.mock('../electron/java', () => ({ ensureJava17: vi.fn() }))
vi.mock('../electron/modpack/sync', () => ({ syncModpack: vi.fn() }))
vi.mock('../electron/game/install', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../electron/game/install')>()),
  ensureVanilla: vi.fn(),
  ensureForge: vi.fn(),
  ensureDependencies: vi.fn()
}))

import { ensureDependencies, ensureForge, ensureVanilla } from '../electron/game/install'
import { isGameBusy, isMinecraftRunning, killMinecraftProcess, playGame, repairGame, type GameDeps } from '../electron/game/launch'
import type { ProgressEvent } from '../electron/game/progress'
import { ensureJava17 } from '../electron/java'
import { syncModpack } from '../electron/modpack/sync'
import type { OrvianManifest } from '../src/shared/manifest'

const manifest = (overrides: Partial<OrvianManifest> & { version?: string } = {}) =>
  ({ schemaVersion: 1, pack: { id: 'orvian', name: 'Orvian', version: overrides.version ?? '1.0.5', minecraft: '1.20.1', loader: 'forge', forge: '47.4.23' }, runtime: { java: 17 }, minimumLauncher: '0.1.0', publishedAt: '2026-10-01T00:00:00.000Z', changelog: [], files: [], ...overrides }) as OrvianManifest

class FakeProcess extends EventEmitter {
  stdout = new PassThrough()
  stderr = new PassThrough()
  pid = undefined
  kill = vi.fn(() => true)
}

describe('game pipeline', () => {
  let root = ''
  let events: ProgressEvent[]
  let proc: FakeProcess
  let deps: GameDeps & { onPackSynced: ReturnType<typeof vi.fn>; onGameExit: ReturnType<typeof vi.fn> }
  const order: string[] = []

  const writeInstalled = async (version: string) => {
    await mkdir(join(root, 'instances', 'orvian', '.orvian'), { recursive: true })
    await writeFile(join(root, 'instances', 'orvian', '.orvian', 'official-state.json'), JSON.stringify({ version, files: {} }))
  }
  const flush = () => new Promise((r) => setTimeout(r, 20))

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'orvian-launch-'))
    events = []
    order.length = 0
    proc = new FakeProcess()
    vi.mocked(ensureJava17).mockReset().mockImplementation(async () => (order.push('java'), 'C:\\java\\javaw.exe'))
    vi.mocked(ensureVanilla).mockReset().mockImplementation(async () => void order.push('vanilla'))
    vi.mocked(ensureForge).mockReset().mockImplementation(async () => void order.push('forge'))
    vi.mocked(ensureDependencies).mockReset().mockImplementation(async () => void order.push('deps'))
    vi.mocked(syncModpack).mockReset().mockImplementation((async () => (order.push('sync'), { installed: 1, replaced: 0, preservedConfigs: 0, stagedDefaults: 0, unchanged: 0, trustedFromState: 0 })) as never)
    vi.mocked(Version.parse).mockReset().mockResolvedValue({ id: 'v' } as never)
    vi.mocked(launch).mockReset().mockImplementation((async () => (order.push('launch'), proc)) as never)
    deps = {
      dataRoot: root,
      appVersion: '1.0.4',
      hasAccount: vi.fn(async () => true),
      getSession: vi.fn(async () => ({ account: { accessToken: 'mc-token-123', name: 'Steve', uuid: 'u'.repeat(32), expiresAt: 0 }, stale: false })),
      getManifest: vi.fn(async () => manifest()),
      getRamGb: vi.fn(async () => 6),
      emit: (e) => void events.push(e),
      onPackSynced: vi.fn(),
      onGameExit: vi.fn()
    }
  })

  afterEach(async () => {
    killMinecraftProcess()
    proc.emit('exit', 0, null)
    await flush()
    await rm(root, { recursive: true, force: true })
  })

  it('refuses to play without an account and does no work', async () => {
    deps.hasAccount = vi.fn(async () => false)
    const result = await playGame(deps)
    expect(result).toMatchObject({ ok: false, message: 'Inicia sesión en tu cuenta de Microsoft antes de jugar.' })
    expect(order).toEqual([])
  })

  it('reports "not installed" when offline on a first run', async () => {
    deps.getManifest = vi.fn(async () => null)
    const result = await playGame(deps)
    expect(result.error).toMatchObject({ code: 'OFFLINE_NOT_INSTALLED' })
    expect(result.message).toContain('Necesitas conexión')
    expect(order).toEqual([])
  })

  it('refuses a pack that needs a newer launcher before changing anything', async () => {
    deps.getManifest = vi.fn(async () => manifest({ minimumLauncher: '1.1.0' }))
    const result = await playGame(deps)
    expect(result.error).toMatchObject({ code: 'LAUNCHER_TOO_OLD', details: { required: '1.1.0' } })
    expect(order).toEqual([])
  })

  it('runs every step in order and launches with the Microsoft session', async () => {
    const result = await playGame(deps)
    expect(result).toEqual({ ok: true, message: 'Minecraft ha iniciado correctamente.' })
    expect(order).toEqual(['java', 'vanilla', 'forge', 'deps', 'sync', 'launch'])
    expect(deps.onPackSynced).toHaveBeenCalledWith('1.0.5')

    const options = vi.mocked(launch).mock.calls[0][0]
    expect(options).toMatchObject({ javaPath: 'C:\\java\\javaw.exe', accessToken: 'mc-token-123', gameProfile: { name: 'Steve' }, minMemory: 1024, maxMemory: 6144, launcherName: 'Orvian', launcherBrand: '1.0.4' })
    expect('userType' in options).toBe(false)
    expect(options.quickPlayMultiplayer).toBeUndefined()

    expect(events.every((e, i) => i === 0 || e.progress >= events[i - 1].progress)).toBe(true)
    expect(events.at(-1)).toMatchObject({ step: 'finalizing' })
    expect(isMinecraftRunning()).toBe(true)
  })

  it('opens the Orvian server when asked', async () => {
    await playGame(deps, { quickPlay: true })
    expect(vi.mocked(launch).mock.calls[0][0].quickPlayMultiplayer).toBe('payo.exaroton.me:25565')
  })

  it('plays the installed version without consulting the manifest or syncing', async () => {
    await writeInstalled('1.0.3')
    const result = await playGame(deps, { playInstalled: true })
    expect(result.ok).toBe(true)
    expect(deps.getManifest).not.toHaveBeenCalled()
    expect(order).toEqual(['java', 'vanilla', 'forge', 'deps', 'launch'])
  })

  it('cannot play an installed version that does not exist', async () => {
    const result = await playGame(deps, { playInstalled: true })
    expect(result.error?.code).toBe('OFFLINE_NOT_INSTALLED')
  })

  it('serialises pipelines and refuses a second game', async () => {
    let release!: () => void
    vi.mocked(ensureJava17).mockImplementation(() => new Promise((resolve) => (release = () => resolve('javaw'))) as never)
    const first = playGame(deps)
    await flush()
    expect(isGameBusy()).toBe(true)
    expect((await playGame(deps)).error?.code).toBe('BUSY')
    expect((await repairGame(deps)).error?.code).toBe('BUSY')
    release()
    await first
    expect(isGameBusy()).toBe(false)
    expect((await playGame(deps)).error?.code).toBe('GAME_ALREADY_RUNNING')
  })

  it('repair verifies everything in full, never asks for a session and never launches', async () => {
    const result = await repairGame(deps)
    expect(result).toEqual({ ok: true, message: 'Instalación verificada y reparada.' })
    expect(order).toEqual(['java', 'vanilla', 'forge', 'deps', 'sync'])
    expect(deps.getSession).not.toHaveBeenCalled()
    expect(vi.mocked(ensureJava17).mock.calls[0][2]).toEqual({ force: true })
    expect(vi.mocked(ensureVanilla).mock.calls[0][3]).toEqual({ fullVerify: true })
    expect(vi.mocked(ensureDependencies).mock.calls[0][3]).toEqual({ fullVerify: true })
    expect(vi.mocked(syncModpack).mock.calls[0][4]).toEqual({ forceVerify: true })
    expect(isMinecraftRunning()).toBe(false)
  })

  it('a normal play does not force verification', async () => {
    await playGame(deps)
    expect(vi.mocked(ensureDependencies).mock.calls[0][3]).toEqual({ fullVerify: false })
    expect(vi.mocked(syncModpack).mock.calls[0][4]).toEqual({ forceVerify: false })
  })

  it('turns a failing step into a typed result and releases the lock', async () => {
    vi.mocked(ensureDependencies).mockRejectedValue(Object.assign(new Error('x'), { code: 'ENOSPC' }))
    const result = await playGame(deps)
    expect(result).toMatchObject({ ok: false, error: { code: 'DISK_FULL' } })
    expect(isGameBusy()).toBe(false)
    expect(isMinecraftRunning()).toBe(false)
  })

  it('clears the running flag when the launch itself fails', async () => {
    vi.mocked(launch).mockRejectedValue(new Error('Missing 3 libraries!'))
    const result = await playGame(deps)
    expect(result.ok).toBe(false)
    expect(isMinecraftRunning()).toBe(false)
  })

  it('records the game output with secrets removed', async () => {
    await playGame(deps)
    proc.stdout.write('ModLauncher running: args [--accessToken, mc-token-123]\nBearer abc.def.ghi\n')
    proc.stderr.write('stderr line\n')
    proc.emit('exit', 0, null)
    await flush()
    const text = await readFile(join(root, 'launcher', 'logs', 'minecraft-latest.log'), 'utf8')
    expect(text).toContain('stderr line')
    expect(text).toContain('Bearer ***')
    expect(text).not.toContain('abc.def.ghi')
  })

  it('reports a normal close', async () => {
    await playGame(deps)
    proc.emit('exit', 0, null)
    await flush()
    expect(events.at(-1)).toMatchObject({ state: 'idle' })
    expect(deps.onGameExit).toHaveBeenCalledWith({ kind: 'clean' })
    expect(isMinecraftRunning()).toBe(false)
  })

  it('reports a crash with the summary from the crash report', async () => {
    await playGame(deps)
    proc.stdout.write('---- Minecraft Crash Report ----\nDescription: Ticking entity\n\njava.lang.NullPointerException: boom\n')
    proc.emit('exit', 1, null)
    await flush()
    expect(events.at(-1)).toMatchObject({ state: 'error', detail: 'Ticking entity: java.lang.NullPointerException: boom' })
    expect(deps.onGameExit).toHaveBeenCalledWith(expect.objectContaining({ kind: 'crash', exitCode: 1 }))
  })

  it('does not call it a crash when the launcher closed the game', async () => {
    await playGame(deps)
    killMinecraftProcess()
    proc.emit('exit', 1, 'SIGKILL')
    await flush()
    expect(deps.onGameExit).toHaveBeenCalledWith({ kind: 'clean' })
    expect(isMinecraftRunning()).toBe(false)
  })

  it('announces when the game window is ready', async () => {
    await playGame(deps)
    proc.stdout.write('[Render thread/INFO]: LWJGL Version: 3.3.1\n')
    await flush()
    expect(events.some((e) => e.state === 'playing')).toBe(true)
  })
})
