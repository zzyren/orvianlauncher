import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { anonymizePaths, buildDiagnostics, readLogTail } from '../electron/diagnostics'

const base = { appVersion: '1.0.4', phase: 'error', packInstalled: '1.0.3', packLatest: '1.0.4', platform: 'win32', arch: 'x64', electron: '33.4.11', logLines: ['linea 1', 'linea 2'], now: new Date('2026-10-05T12:00:00Z') }

describe('anonymizePaths', () => {
  it.each([
    ['C:\\Users\\manu5\\AppData\\Roaming\\Orvian', 'C:\\Users\\<usuario>\\AppData\\Roaming\\Orvian'],
    ['c:/users/Ana/x', 'c:/users/<usuario>/x'],
    ['/home/alice/.config/orvian', '/home/<usuario>/.config/orvian'],
    ['/Users/bob/Library', '/Users/<usuario>/Library'],
    ['nothing private here', 'nothing private here']
  ])('%s', (input, expected) => expect(anonymizePaths(input)).toBe(expected))
})

describe('buildDiagnostics', () => {
  it('summarises versions, state and recent log lines', () => {
    const text = buildDiagnostics(base)
    expect(text).toContain('Orvian Launcher 1.0.4')
    expect(text).toContain('Fecha: 2026-10-05T12:00:00.000Z')
    expect(text).toContain('Modpack instalado: 1.0.3 · publicado: 1.0.4')
    expect(text).toContain('win32 x64 · Electron 33.4.11')
    expect(text).toContain('Últimas 2 líneas del registro:\nlinea 1\nlinea 2')
    expect(text).not.toContain('Error:')
  })

  it('includes the error when there is one', () => {
    const text = buildDiagnostics({ ...base, error: { code: 'DISK_FULL', title: 'Espacio insuficiente', technical: 'ENOSPC: no space left' } })
    expect(text).toContain('Error: DISK_FULL · Espacio insuficiente\nENOSPC: no space left')
  })

  it('removes secrets and the Windows account name from everything it includes', () => {
    const text = buildDiagnostics({
      ...base,
      packInstalled: null,
      error: { code: 'UNKNOWN', title: 't', technical: 'failed at C:\\Users\\manu5\\AppData\\Roaming\\Orvian\\x' },
      logLines: ['--accessToken eyJhbGciOiJIUzI1NiJ9.abcdefghij.klmnopqrstu', 'Authorization: Bearer abc.def.ghi', 'token ghp_abcdefghijklmnopqrstuvwxyz0123456789']
    })
    expect(text).not.toContain('manu5')
    expect(text).not.toContain('eyJhbGci')
    expect(text).not.toContain('abc.def.ghi')
    expect(text).not.toContain('ghp_abcdef')
    expect(text).toContain('Modpack instalado: ninguno')
  })
})

describe('readLogTail', () => {
  it('returns the last lines and tolerates a missing file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'orvian-diag-'))
    await writeFile(join(dir, 'l.log'), Array.from({ length: 80 }, (_, i) => `l${i}`).join('\n') + '\n')
    const tail = await readLogTail(join(dir, 'l.log'), 50)
    expect(tail).toHaveLength(50)
    expect(tail[0]).toBe('l30')
    expect(tail.at(-1)).toBe('l79')
    expect(await readLogTail(join(dir, 'nope.log'))).toEqual([])
    await rm(dir, { recursive: true, force: true })
  })
})
