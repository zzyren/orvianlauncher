import { describe, expect, it } from 'vitest'
import { OrvianError, describeError, fromNodeError, toPayload, userMessage, type OrvianErrorCode } from '../src/shared/errors'

const ALL_CODES: OrvianErrorCode[] = [
  'NETWORK_OFFLINE', 'OFFLINE_NOT_INSTALLED', 'DOWNLOAD_FAILED', 'HASH_MISMATCH', 'DOWNLOAD_UNVERIFIABLE', 'DISK_FULL', 'PERMISSION', 'JAVA_INSTALL_FAILED',
  'FORGE_INSTALL_FAILED', 'LIBRARIES_MISSING', 'PACK_ARCHIVE_MISSING', 'MANIFEST_INVALID', 'LAUNCHER_TOO_OLD',
  'AUTH_CANCELLED', 'AUTH_NO_XBOX', 'AUTH_CHILD', 'AUTH_REGION', 'AUTH_NO_GAME', 'AUTH_EXPIRED',
  'GAME_ALREADY_RUNNING', 'GAME_CRASHED', 'INVALID_ARGUMENT', 'FORBIDDEN', 'BUSY', 'UNKNOWN'
]

describe('error catalog', () => {
  it.each(ALL_CODES)('%s has a title, body and at least one action', (code) => {
    const d = describeError(code)
    expect(d.title.length).toBeGreaterThan(0)
    expect(d.body.length).toBeGreaterThan(0)
    expect(d.actions.length).toBeGreaterThan(0)
    expect(`${d.title}${d.body}`).not.toMatch(/[{}]/)
    expect(`${d.title}${d.body}`).not.toContain('!')
  })

  it('fills placeholders from details and falls back when missing', () => {
    expect(describeError('DOWNLOAD_FAILED', { file: 'jei.jar' }).title).toBe('No se pudo descargar jei.jar')
    expect(describeError('DOWNLOAD_FAILED').title).toBe('No se pudo descargar el archivo')
    expect(describeError('LIBRARIES_MISSING', { n: 3 }).title).toBe('Faltan 3 archivos del juego')
  })

  it('only offers https links', () => {
    for (const code of ALL_CODES) {
      for (const action of describeError(code).actions) {
        if (action.id === 'open-url') expect(action.url).toMatch(/^https:\/\//)
      }
    }
  })
})

describe('fromNodeError', () => {
  const errno = (code: string) => Object.assign(new Error(code), { code })
  it.each([
    ['ENOSPC', 'DISK_FULL'],
    ['EPERM', 'PERMISSION'],
    ['EACCES', 'PERMISSION'],
    ['EBUSY', 'PERMISSION'],
    ['ENOTFOUND', 'NETWORK_OFFLINE'],
    ['ECONNRESET', 'NETWORK_OFFLINE'],
    ['ETIMEDOUT', 'NETWORK_OFFLINE']
  ])('maps %s to %s', (code, expected) => {
    expect(fromNodeError(errno(code)).code).toBe(expected)
  })

  it('looks inside err.cause like undici does', () => {
    const err = new TypeError('fetch failed', { cause: errno('ENOTFOUND') })
    expect(fromNodeError(err).code).toBe('NETWORK_OFFLINE')
  })

  it('returns existing OrvianError instances untouched', () => {
    const original = new OrvianError('BUSY')
    expect(fromNodeError(original)).toBe(original)
  })

  it('turns anything else into UNKNOWN and keeps the message', () => {
    const e = fromNodeError(new Error('boom'))
    expect(e.code).toBe('UNKNOWN')
    expect(e.message).toBe('boom')
  })
})

describe('payload and user messages', () => {
  it('redacts secrets from the technical message', () => {
    const payload = toPayload(new Error('request failed Authorization: Bearer abc.def.ghi-123'))
    expect(payload.technical).not.toContain('abc.def.ghi-123')
  })

  it('keeps legacy plain messages untouched', () => {
    expect(userMessage(new Error('Inicia sesión en tu cuenta de Microsoft antes de jugar.'))).toBe('Inicia sesión en tu cuenta de Microsoft antes de jugar.')
  })

  it('joins title and body for typed errors', () => {
    expect(userMessage(new OrvianError('AUTH_EXPIRED'))).toBe('Tu sesión ha caducado. Vuelve a iniciar sesión para continuar.')
  })

  it('is structured-clone safe', () => {
    const payload = toPayload(new OrvianError('HASH_MISMATCH', { file: 'a.jar' }))
    expect(structuredClone(payload)).toEqual(payload)
  })
})
