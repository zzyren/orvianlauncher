import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { IpcMainInvokeEvent } from 'electron'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ dialog: {}, BrowserWindow: {}, safeStorage: {} }))

import { AdminTokenStore, isPlausibleGithubToken, registerAdminIpc, verifyGithubToken, type SecretBox } from '../electron/admin'
import { createIpc } from '../electron/ipc'

const TOKEN = 'github_pat_11ABCDEFG0abcdefghijklmnop_abcdefghijklmnopqrstuvwxyz'

/** A reversible fake: real safeStorage is DPAPI, but the store only needs encrypt/decrypt round trips. */
const box = (available = true): SecretBox => ({
  isEncryptionAvailable: () => available,
  encryptString: (plain) => Buffer.from(plain.split('').reverse().join('') + '|enc'),
  decryptString: (data) => {
    const text = data.toString()
    if (!text.endsWith('|enc')) throw new Error('not encrypted')
    return text.slice(0, -4).split('').reverse().join('')
  }
})

describe('isPlausibleGithubToken', () => {
  it.each([TOKEN, 'ghp_abcdefghijklmnopqrstuvwxyz0123456789'])('accepts %s', (t) => expect(isPlausibleGithubToken(t)).toBe(true))
  it.each(['', 'ghp_short', 'hello', 'Bearer ' + TOKEN, TOKEN + ' extra', 'gho_abcdefghijklmnopqrstuvwxyz0123456789'])('rejects %j', (t) => expect(isPlausibleGithubToken(t)).toBe(false))
})

describe('AdminTokenStore', () => {
  let dir = ''
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'orvian-admin-'))
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('stores the token encrypted and reads it back', async () => {
    const file = join(dir, 'launcher', 'admin.json')
    const store = new AdminTokenStore(file, box())
    expect(await store.hasToken()).toBe(false)
    await store.set(TOKEN)
    expect(await readFile(file, 'utf8')).not.toContain(TOKEN)
    expect(await store.get()).toBe(TOKEN)
    expect(await store.hasToken()).toBe(true)
  })

  it('refuses to store anything when encryption is unavailable', async () => {
    const store = new AdminTokenStore(join(dir, 'admin.json'), box(false))
    await expect(store.set(TOKEN)).rejects.toThrow(/secretos/)
    expect(await store.hasToken()).toBe(false)
  })

  it('clears the token', async () => {
    const store = new AdminTokenStore(join(dir, 'admin.json'), box())
    await store.set(TOKEN)
    await store.clear()
    expect(await store.get()).toBeNull()
  })

  it('treats a corrupted file as no token', async () => {
    const file = join(dir, 'admin.json')
    await new AdminTokenStore(file, box()).set(TOKEN)
    const other = new AdminTokenStore(file, { ...box(), decryptString: () => { throw new Error('bad key') } })
    expect(await other.get()).toBeNull()
  })
})

describe('verifyGithubToken', () => {
  afterEach(() => vi.unstubAllGlobals())
  const stub = (res: () => Response | Promise<Response>) => vi.stubGlobal('fetch', async () => res())

  it('confirms push access', async () => {
    stub(() => new Response(JSON.stringify({ permissions: { push: true } })))
    expect(await verifyGithubToken(TOKEN, 'a/b')).toEqual({ verified: true })
  })
  it('flags a read-only token', async () => {
    stub(() => new Response(JSON.stringify({ permissions: { push: false } })))
    expect(await verifyGithubToken(TOKEN, 'a/b')).toMatchObject({ verified: false })
  })
  it.each([401, 403, 404])('treats HTTP %i as unusable', async (status) => {
    stub(() => new Response('{}', { status }))
    expect(await verifyGithubToken(TOKEN, 'a/b')).toMatchObject({ verified: false })
  })
  it('reports "could not check" when offline', async () => {
    vi.stubGlobal('fetch', async () => { throw new TypeError('fetch failed', { cause: Object.assign(new Error('x'), { code: 'ENOTFOUND' }) }) })
    expect(await verifyGithubToken(TOKEN, 'a/b')).toEqual({ verified: null })
  })
})

describe('admin IPC gate', () => {
  const trusted = 'file:///app/dist/index.html'
  const handlers = new Map<string, (event: IpcMainInvokeEvent, ...args: unknown[]) => Promise<unknown>>()
  const call = (channel: string, ...args: unknown[]) => handlers.get(channel)!({ senderFrame: { url: trusted } } as unknown as IpcMainInvokeEvent, ...args) as Promise<unknown>
  let dir = ''

  const register = (uuid: string | null, latest: string | null = '1.0.4') => {
    handlers.clear()
    registerAdminIpc(createIpc({ handle: (c, l) => void handlers.set(c, l as never) }, { isTrustedUrl: (u) => u === trusted }), {
      dataRoot: dir,
      getAccount: async () => (uuid ? { uuid } : null),
      emitProgress: () => undefined,
      getLatestVersion: () => latest,
      getMinimumLauncher: () => undefined,
      onPublished: () => undefined
    })
  }

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'orvian-admin-ipc-'))
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it.each([['signed out', null], ['a regular player', '11111111111111111111111111111111']])('rejects every admin channel for %s', async (_label, uuid) => {
    register(uuid)
    for (const [channel, args] of [['admin:token-status', []], ['admin:token-set', [TOKEN]], ['admin:token-clear', []], ['admin:pick-archive', []], ['admin:publish', [{ selectionId: crypto.randomUUID(), version: '9.9.9', changelog: '' }]]] as const) {
      await expect(call(channel, ...args)).rejects.toThrow(/Acción no permitida/)
    }
  })

  it('rejects malformed tokens and versions for an admin before doing any work', async () => {
    register('a8603c06-e747-4c44-b0bd-e33067ab6627')
    await expect(call('admin:token-set', 'not a token')).rejects.toThrow(/formato válido/)
    await expect(call('admin:publish', { selectionId: 'nope', version: '1.2.3', changelog: '' })).rejects.toThrow(/Solicitud no válida/)
    await expect(call('admin:publish', { selectionId: crypto.randomUUID(), version: '1.2', changelog: '' })).rejects.toThrow(/Solicitud no válida/)
  })

  it('refuses to publish a file that was not picked through the dialog', async () => {
    register('a8603c06-e747-4c44-b0bd-e33067ab6627')
    await expect(call('admin:publish', { selectionId: crypto.randomUUID(), version: '9.9.9', changelog: '' })).rejects.toThrow(/Vuelve a seleccionar/)
  })
})
