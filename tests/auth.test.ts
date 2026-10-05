import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MicrosoftMinecraftXboxLoginError } from '@xmcl/user'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const clearStorageData = vi.fn(async () => undefined)
vi.mock('electron', () => ({
  BrowserWindow: class {},
  safeStorage: {},
  shell: {},
  session: { fromPartition: () => ({ clearStorageData, setPermissionRequestHandler: () => undefined }) }
}))

import { AuthService, isMicrosoftAuthUrl, mapMinecraftLoginError, mapXstsError, type XboxAuthenticator } from '../electron/auth'
import type { SecretBox } from '../electron/secretBox'

const NOW = 1_800_000_000_000
const HOUR = 3_600_000

const box = (available = true): SecretBox => ({
  isEncryptionAvailable: () => available,
  encryptString: (plain) => Buffer.from(`enc:${plain}`),
  decryptString: (data) => {
    const text = data.toString()
    if (!text.startsWith('enc:')) throw new Error('not encrypted')
    return text.slice(4)
  }
})

const stored = (overrides: Record<string, unknown> = {}) => ({
  v: 2, msRefreshToken: 'old-refresh', accessToken: 'old-mc-token', expiresAt: NOW + 10 * HOUR, name: 'Steve', uuid: 'a'.repeat(32), xuid: '123', ...overrides
})

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const networkError = () => new TypeError('fetch failed', { cause: Object.assign(new Error('getaddrinfo'), { code: 'ENOTFOUND' }) })

describe('isMicrosoftAuthUrl', () => {
  it.each(['https://login.live.com/oauth20_authorize.srf?x=1', 'https://login.microsoftonline.com/consumers/', 'https://account.live.com/x', 'https://xsts.auth.xboxlive.com/', 'https://aadcdn.msauth.net/a.js'])('allows %s', (u) =>
    expect(isMicrosoftAuthUrl(u)).toBe(true)
  )
  it.each(['http://login.live.com/', 'https://evil.test/', 'https://login.live.com.evil.test/', 'https://notlive.com/', 'file:///etc/passwd', 'javascript:alert(1)', 'nonsense'])('blocks %s', (u) =>
    expect(isMicrosoftAuthUrl(u)).toBe(false)
  )
})

describe('error mapping', () => {
  it.each([
    [2148916233, 'AUTH_NO_XBOX'],
    [2148916235, 'AUTH_REGION'],
    [2148916236, 'AUTH_REGION'],
    [2148916237, 'AUTH_REGION'],
    [2148916238, 'AUTH_CHILD']
  ])('maps XErr %i to %s', (xerr, code) => {
    expect(mapXstsError(Object.assign(new Error('Failed to authorize with xbox live'), { XErr: xerr })).code).toBe(code)
  })
  it('keeps network failures classifiable and unknown XErr as UNKNOWN', () => {
    expect(mapXstsError(networkError()).code).toBe('NETWORK_OFFLINE')
    expect(mapXstsError(Object.assign(new Error('x'), { XErr: 1 })).code).toBe('UNKNOWN')
  })
  it('maps Minecraft login failures', () => {
    expect(mapMinecraftLoginError(new MicrosoftMinecraftXboxLoginError(401, '')).code).toBe('AUTH_EXPIRED')
    const transient = mapMinecraftLoginError(new MicrosoftMinecraftXboxLoginError(503, '', undefined, true))
    expect(transient).toMatchObject({ code: 'UNKNOWN' })
    expect(transient.message).toContain('503')
    expect(transient.message).toContain('unos minutos')
  })
})

describe('AuthService sessions', () => {
  let root = ''
  let hits: Record<string, number> = {}
  let now = NOW
  let routes: Record<string, () => Response | Promise<Response>> = {}
  let authenticator: XboxAuthenticator
  const authFile = () => join(root, 'launcher', 'auth.json')

  const seed = async (session: object | string, secretBox = box()) => {
    await mkdir(join(root, 'launcher'), { recursive: true })
    await writeFile(authFile(), secretBox.encryptString(typeof session === 'string' ? session : JSON.stringify(session)).toString('hex'))
  }
  const read = async () => JSON.parse(box().decryptString(Buffer.from(await readFile(authFile(), 'utf8'), 'hex')))

  const service = (secretBox = box()) =>
    new AuthService(root, {
      box: secretBox,
      now: () => now,
      authenticator,
      fetch: async (url) => {
        const key = Object.keys(routes).find((prefix) => url.startsWith(prefix))
        hits[key ?? url] = (hits[key ?? url] ?? 0) + 1
        return key ? routes[key]() : new Response('?', { status: 404 })
      }
    })

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'orvian-auth-'))
    hits = {}
    now = NOW
    clearStorageData.mockClear()
    authenticator = {
      acquireXBoxToken: vi.fn(async () => ({ minecraftXstsResponse: { Token: 'xsts', DisplayClaims: { xui: [{ uhs: 'uhs-1', gtg: 'g', xid: 'rp-xid' }] } }, liveXstsResponse: { Token: 'live', DisplayClaims: { xui: [{ uhs: 'uhs-2', gtg: 'g', xid: '999' }] } } })) as never,
      loginMinecraftWithXBox: vi.fn(async () => ({ access_token: 'new-mc-token', expires_in: 86_400 })) as never
    }
    routes = {
      'https://login.live.com/oauth20_token.srf': () => json({ access_token: 'ms-access', refresh_token: 'new-refresh' }),
      'https://api.minecraftservices.com/minecraft/profile': () => json({ id: 'b'.repeat(32), name: 'Alex' })
    }
  })
  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  const TOKEN = 'https://login.live.com/oauth20_token.srf'
  const PROFILE = 'https://api.minecraftservices.com/minecraft/profile'

  it('reports who is signed in without any network call', async () => {
    await seed(stored())
    expect(await service().loadAccount()).toMatchObject({ name: 'Steve', accessToken: 'old-mc-token' })
    expect(hits).toEqual({})
  })

  it('treats a session saved by an older launcher (no refresh token) as signed out', async () => {
    await seed({ accessToken: 'legacy', name: 'Steve', uuid: 'a'.repeat(32) })
    expect(await service().loadAccount()).toBeNull()
  })

  it('refuses to read or keep anything on disk without secure storage', async () => {
    await seed(stored())
    expect(await service(box(false)).loadAccount()).toBeNull()
  })

  it('returns a still-valid session without refreshing', async () => {
    await seed(stored())
    const { account, stale } = await service().getValidSession()
    expect(account.accessToken).toBe('old-mc-token')
    expect(stale).toBe(false)
    expect(hits).toEqual({})
  })

  it('refreshes silently when the token is about to expire and persists the new one', async () => {
    await seed(stored({ expiresAt: NOW + 2 * 60_000 }))
    const { account, stale } = await service().getValidSession()
    expect(stale).toBe(false)
    expect(account).toMatchObject({ accessToken: 'new-mc-token', name: 'Alex', expiresAt: NOW + 86_400_000, xuid: '999' })
    expect(await read()).toMatchObject({ v: 2, msRefreshToken: 'new-refresh', accessToken: 'new-mc-token', name: 'Alex' })
    expect(hits[TOKEN]).toBe(1)
  })

  it('shares one refresh between concurrent callers', async () => {
    await seed(stored({ expiresAt: NOW - 1000 }))
    const svc = service()
    const results = await Promise.all([svc.getValidSession(), svc.getValidSession(), svc.getValidSession()])
    expect(new Set(results.map((r) => r.account.accessToken))).toEqual(new Set(['new-mc-token']))
    expect(hits[TOKEN]).toBe(1)
  })

  it('keeps the old refresh token when Microsoft does not rotate it', async () => {
    routes[TOKEN] = () => json({ access_token: 'ms-access' })
    await seed(stored({ expiresAt: NOW - 1000 }))
    await service().getValidSession()
    expect((await read()).msRefreshToken).toBe('old-refresh')
  })

  it('signs out and reports AUTH_EXPIRED when Microsoft rejects the refresh token', async () => {
    routes[TOKEN] = () => json({ error: 'invalid_grant' }, 400)
    await seed(stored({ expiresAt: NOW - 1000 }))
    const svc = service()
    await expect(svc.getValidSession()).rejects.toMatchObject({ code: 'AUTH_EXPIRED' })
    expect(existsSync(authFile())).toBe(false)
    expect(await svc.loadAccount()).toBeNull()
    expect(clearStorageData).toHaveBeenCalled()
  })

  it('falls back to the stored token when offline so the game can still start', async () => {
    routes[TOKEN] = () => { throw networkError() }
    await seed(stored({ expiresAt: NOW - 1000 }))
    const { account, stale } = await service().getValidSession()
    expect(stale).toBe(true)
    expect(account.accessToken).toBe('old-mc-token')
    expect(existsSync(authFile())).toBe(true)
  })

  it('signs out when the account no longer owns the game', async () => {
    routes[PROFILE] = () => json({}, 404)
    await seed(stored({ expiresAt: NOW - 1000 }))
    await expect(service().getValidSession()).rejects.toMatchObject({ code: 'AUTH_NO_GAME' })
    expect(existsSync(authFile())).toBe(false)
  })

  it('keeps the previous profile when only the profile lookup fails', async () => {
    routes[PROFILE] = () => json({}, 500)
    await seed(stored({ expiresAt: NOW - 1000 }))
    const { account } = await service().getValidSession()
    expect(account).toMatchObject({ accessToken: 'new-mc-token', name: 'Steve' })
  })

  it('surfaces Xbox account problems without signing the user out', async () => {
    authenticator.acquireXBoxToken = vi.fn(async () => { throw Object.assign(new Error('xsts'), { XErr: 2148916238 }) }) as never
    await seed(stored({ expiresAt: NOW - 1000 }))
    await expect(service().getValidSession()).rejects.toMatchObject({ code: 'AUTH_CHILD' })
    expect(existsSync(authFile())).toBe(true)
  })

  it('reports signed-out clearly', async () => {
    await expect(service().getValidSession()).rejects.toMatchObject({ code: 'AUTH_EXPIRED', details: { reason: 'signed-out' } })
  })

  it('without secure storage keeps the renewed session in memory only', async () => {
    const svc = service(box(false))
    // Nothing on disk can be read, so there is no session to renew until the user signs in.
    await expect(svc.getValidSession()).rejects.toMatchObject({ code: 'AUTH_EXPIRED' })
    expect(existsSync(authFile())).toBe(false)
  })

  it('logout removes the file and the browser session', async () => {
    await seed(stored())
    const svc = service()
    await svc.logout()
    expect(existsSync(authFile())).toBe(false)
    expect(await svc.loadAccount()).toBeNull()
  })

  it('never writes the Microsoft refresh token in plain text', async () => {
    await seed(stored({ expiresAt: NOW - 1000 }))
    await service().getValidSession()
    expect(await readFile(authFile(), 'utf8')).not.toContain('new-refresh')
  })
})
