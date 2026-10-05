import { existsSync } from 'node:fs'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { redactSecrets } from '../src/shared/redact'
import { createLogger } from '../electron/logger'

describe('redactSecrets', () => {
  it.each([
    ['Authorization: Bearer eyJabcdefghij.klmnopqrstu.vwxyz1234', 'eyJabcdefghij'],
    ['launch --username Steve --accessToken s3cr3t-token-value --version 1.20.1', 's3cr3t-token-value'],
    ['{"access_token":"MSA.abc123","name":"x"}', 'MSA.abc123'],
    ['refresh_token=M.R3_BAY.abcdef&x=1', 'M.R3_BAY.abcdef'],
    ['https://login.live.com/oauth20_desktop.srf?code=M.C507_BAY.2.U.abc&lc=1', 'M.C507_BAY.2.U.abc'],
    ['token ghp_abcdefghijklmnopqrstuvwxyz0123456789', 'ghp_abcdefghijklmnopqrstuvwxyz0123456789'],
    ['token github_pat_11ABCDEFG0abcdefghijklmnop_abcdefghijklmnop', 'github_pat_11ABCDEFG0abcdefghijklmnop_abcdefghijklmnop']
  ])('removes the secret from %s', (input, secret) => {
    const out = redactSecrets(input)
    expect(out).not.toContain(secret)
    expect(out).toContain('***')
  })

  it('leaves ordinary text alone', () => {
    const text = 'Descargando modpack v1.0.4 (34 MB) desde https://github.com/zzyren/orvianmodpack'
    expect(redactSecrets(text)).toBe(text)
  })
})

describe('createLogger', () => {
  let dir = ''
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true })
  })

  it('writes timestamped, redacted lines to the log file', async () => {
    dir = await mkdtemp(join(tmpdir(), 'orvian-log-'))
    const logger = createLogger({ dir, now: () => new Date('2026-10-05T12:00:00.000Z') })
    logger.info('login ok accessToken=%s', 'abc123secret')
    logger.close()
    const text = await readFile(join(dir, 'launcher.log'), 'utf8')
    expect(text).toBe('2026-10-05T12:00:00.000Z INFO  login ok accessToken=***\n')
  })

  it('respects the minimum level', async () => {
    dir = await mkdtemp(join(tmpdir(), 'orvian-log-'))
    const logger = createLogger({ dir, level: 'warn' })
    logger.info('hidden')
    logger.warn('shown')
    logger.close()
    const text = await readFile(join(dir, 'launcher.log'), 'utf8')
    expect(text).not.toContain('hidden')
    expect(text).toContain('shown')
  })

  it('rotates by size and keeps at most maxFiles files', async () => {
    dir = await mkdtemp(join(tmpdir(), 'orvian-log-'))
    const logger = createLogger({ dir, maxBytes: 200, maxFiles: 3 })
    for (let i = 0; i < 40; i++) logger.info('linea numero %d con relleno suficiente para rotar', i)
    logger.close()
    const files = (await readdir(dir)).sort()
    expect(files).toEqual(['launcher.1.log', 'launcher.2.log', 'launcher.log'])
    expect(existsSync(join(dir, 'launcher.3.log'))).toBe(false)
    const newest = await readFile(join(dir, 'launcher.log'), 'utf8')
    expect(newest).toContain('numero 39')
  })

  it('never throws when the directory cannot be written', async () => {
    dir = await mkdtemp(join(tmpdir(), 'orvian-log-'))
    await writeFile(join(dir, 'a-file'), 'x')
    const logger = createLogger({ dir: join(dir, 'a-file', 'logs') }) // a directory below a regular file: ENOTDIR
    expect(() => logger.error('still fine')).not.toThrow()
  })
})
