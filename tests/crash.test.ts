import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { analyzeExit, findNewCrashReport, summarizeCrashReport, type ExitInfo } from '../electron/game/crash'

const REPORT = `---- Minecraft Crash Report ----
// Why did you do that?

Time: 2026-10-05 18:00:00
Description: Exception in server tick loop

java.lang.IllegalStateException: Failed to load mixin config
\tat net.minecraft.Foo.bar(Foo.java:12)
`

const exit = (overrides: Partial<ExitInfo> = {}): ExitInfo => ({ code: 0, signal: null, crashReport: '', crashReportLocation: '', killedByLauncher: false, ...overrides })

describe('summarizeCrashReport', () => {
  it('joins the description with the first exception line', () => {
    expect(summarizeCrashReport(REPORT)).toBe('Exception in server tick loop: java.lang.IllegalStateException: Failed to load mixin config')
  })
  it('works with only a description, and with nothing', () => {
    expect(summarizeCrashReport('Description: Ticking entity')).toBe('Ticking entity')
    expect(summarizeCrashReport('')).toBe('')
  })
  it('truncates very long summaries', () => {
    const long = `Description: ${'x'.repeat(500)}`
    const out = summarizeCrashReport(long)
    expect(out.length).toBeLessThanOrEqual(220)
    expect(out.endsWith('…')).toBe(true)
  })
})

describe('analyzeExit', () => {
  it('treats exit code 0 as a normal close', () => {
    expect(analyzeExit(exit())).toEqual({ kind: 'clean' })
  })
  it('never reports a crash when the launcher ended the process itself', () => {
    expect(analyzeExit(exit({ code: 1, killedByLauncher: true }))).toEqual({ kind: 'clean' })
    expect(analyzeExit(exit({ code: null, signal: 'SIGKILL', killedByLauncher: true }))).toEqual({ kind: 'clean' })
  })
  it('reports a crash with the report summary and location', () => {
    expect(analyzeExit(exit({ code: 1, crashReport: REPORT, crashReportLocation: 'C:\\g\\crash-reports\\crash-1.txt' }))).toEqual({
      kind: 'crash',
      exitCode: 1,
      summary: 'Exception in server tick loop: java.lang.IllegalStateException: Failed to load mixin config',
      reportPath: 'C:\\g\\crash-reports\\crash-1.txt'
    })
  })
  it('falls back to the newest report file and to a generic summary', () => {
    const result = analyzeExit(exit({ code: -1073740791 }), '/g/hs_err_pid42.log')
    expect(result).toMatchObject({ kind: 'crash', exitCode: -1073740791, reportPath: '/g/hs_err_pid42.log' })
    expect((result as { summary: string }).summary).toContain('-1073740791')
  })
  it('reports termination by an external signal as a crash', () => {
    expect(analyzeExit(exit({ code: null, signal: 'SIGSEGV' }))).toMatchObject({ kind: 'crash', exitCode: null })
  })
})

describe('findNewCrashReport', () => {
  let dir = ''
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'orvian-crash-'))
    await mkdir(join(dir, 'crash-reports'), { recursive: true })
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })
  const put = async (rel: string, ageMs: number) => {
    const file = join(dir, rel)
    await writeFile(file, 'x')
    const when = new Date(Date.now() - ageMs)
    await utimes(file, when, when)
    return file
  }

  it('returns the newest crash report written after the session started', async () => {
    const since = Date.now() - 60_000
    await put('crash-reports/crash-old.txt', 3_600_000)
    const mid = await put('crash-reports/crash-a.txt', 30_000)
    expect(await findNewCrashReport(dir, since)).toBe(mid)
    const newest = await put('crash-reports/crash-b.txt', 5_000)
    expect(await findNewCrashReport(dir, since)).toBe(newest)
  })
  it('also finds JVM fatal error logs and ignores unrelated files', async () => {
    const since = Date.now() - 60_000
    await put('crash-reports/notes.txt', 1000)
    const hs = await put('hs_err_pid1234.log', 1000)
    await put('latest.log', 1000)
    expect(await findNewCrashReport(dir, since)).toBe(hs)
  })
  it('returns nothing when there is no new report or no folder', async () => {
    expect(await findNewCrashReport(dir, Date.now())).toBeUndefined()
    expect(await findNewCrashReport(join(dir, 'missing'), 0)).toBeUndefined()
  })
})
