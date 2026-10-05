import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { IpcMainInvokeEvent } from 'electron'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { OrvianError } from '../src/shared/errors'
import { createIpc } from '../electron/ipc'
import { assertAllowedHost, pickCurseForgeFile, pickModrinthFile, registerModsIpc, sanitizeModFilename } from '../electron/modManager'

const sha1 = (b: Buffer) => createHash('sha1').update(b).digest('hex')
const sha512 = (b: Buffer) => createHash('sha512').update(b).digest('hex')

describe('sanitizeModFilename', () => {
  it('returns safe names unchanged', () => expect(sanitizeModFilename('jei-1.20.1.jar')).toBe('jei-1.20.1.jar'))
  it.each(['../../../Startup/x.jar', '..\\x.jar', '/abs.jar', 'evil.bat', 'evil.jar.bat', 'a/b.jar', undefined, 42])('rejects %j', (name) => {
    expect(() => sanitizeModFilename(name)).toThrow(OrvianError)
  })
})

describe('assertAllowedHost', () => {
  it('accepts the service CDNs, including subdomains', () => {
    expect(assertAllowedHost('https://cdn.modrinth.com/data/a/b.jar', ['cdn.modrinth.com'], 'a.jar')).toBeTruthy()
    expect(assertAllowedHost('https://edge.forgecdn.net/files/1/2/a.jar', ['forgecdn.net'], 'a.jar')).toBeTruthy()
    expect(assertAllowedHost('https://mediafilez.forgecdn.net/files/1/2/a.jar', ['forgecdn.net'], 'a.jar')).toBeTruthy()
  })
  it.each(['http://cdn.modrinth.com/a.jar', 'https://evil.test/a.jar', 'https://cdn.modrinth.com.evil.test/a.jar', 'https://notforgecdn.net/a.jar', 'javascript:alert(1)', 'nonsense'])(
    'rejects %s',
    (url) => expect(() => assertAllowedHost(url, ['cdn.modrinth.com', 'forgecdn.net'], 'a.jar')).toThrow(OrvianError)
  )
})

describe('pickModrinthFile', () => {
  const good = { url: 'https://cdn.modrinth.com/data/x/a.jar', filename: 'a.jar', primary: true, size: 3, hashes: { sha1: 'a'.repeat(40), sha512: 'b'.repeat(128) } }
  it('prefers the primary file and carries both hashes', () => {
    const picked = pickModrinthFile([{ ...good, primary: false, filename: 'other.jar' }, good])
    expect(picked).toMatchObject({ filename: 'a.jar', sha512: 'b'.repeat(128) })
  })
  it('refuses a file without any hash', () => {
    expect(() => pickModrinthFile([{ ...good, hashes: {} }])).toThrowError(expect.objectContaining({ code: 'DOWNLOAD_UNVERIFIABLE' }))
  })
  it('refuses a malicious file name and a foreign host', () => {
    expect(() => pickModrinthFile([{ ...good, filename: '../../x.jar' }])).toThrow()
    expect(() => pickModrinthFile([{ ...good, url: 'https://evil.test/a.jar' }])).toThrow()
  })
  it('refuses an empty file list', () => expect(() => pickModrinthFile([])).toThrow())
})

describe('pickCurseForgeFile', () => {
  const good = { id: 4567890, fileName: 'a.jar', downloadUrl: 'https://edge.forgecdn.net/files/4567/890/a.jar', fileLength: 3, hashes: [{ value: 'c'.repeat(40), algo: 1 }, { value: 'd'.repeat(32), algo: 2 }] }
  it('uses SHA-1 and ignores MD5', () => expect(pickCurseForgeFile(good).sha1).toBe('c'.repeat(40)))
  it('refuses a file that only has MD5', () => {
    expect(() => pickCurseForgeFile({ ...good, hashes: [{ value: 'd'.repeat(32), algo: 2 }] })).toThrowError(expect.objectContaining({ code: 'DOWNLOAD_UNVERIFIABLE' }))
  })
  it('builds the CDN url from the id when the API gives none, with the name url-encoded', () => {
    const picked = pickCurseForgeFile({ ...good, downloadUrl: null, fileName: 'my mod.jar' })
    expect(picked.url).toBe('https://edge.forgecdn.net/files/4567/890/my%20mod.jar')
  })
  it('refuses a foreign download host', () => {
    expect(() => pickCurseForgeFile({ ...good, downloadUrl: 'https://evil.test/a.jar' })).toThrow()
  })
})

describe('mods IPC (service responses stubbed)', () => {
  let dataRoot = ''
  let modsDir = ''
  const handlers = new Map<string, (event: IpcMainInvokeEvent, ...args: unknown[]) => Promise<unknown>>()
  const trusted = 'file:///app/dist/index.html'
  const call = (channel: string, ...args: unknown[]) => handlers.get(channel)!({ senderFrame: { url: trusted } } as unknown as IpcMainInvokeEvent, ...args) as Promise<unknown>

  const modBytes = Buffer.from('fake jar content')
  const routes = new Map<string, () => Response>()

  beforeEach(async () => {
    dataRoot = await mkdtemp(join(tmpdir(), 'orvian-mods-'))
    modsDir = join(dataRoot, 'instances', 'orvian', 'mods')
    await mkdir(modsDir, { recursive: true })
    handlers.clear()
    routes.clear()
    vi.stubGlobal('fetch', async (input: string | URL) => {
      const url = String(input)
      const route = [...routes.entries()].find(([prefix]) => url.startsWith(prefix))
      return route ? route[1]() : new Response('not found', { status: 404 })
    })
    registerModsIpc(createIpc({ handle: (c, l) => void handlers.set(c, l as never) }, { isTrustedUrl: (u) => u === trusted }), dataRoot)
  })

  afterEach(async () => {
    vi.unstubAllGlobals()
    await rm(dataRoot, { recursive: true, force: true })
  })

  const modrinthVersion = (file: object, dependencies: object[] = []) =>
    new Response(JSON.stringify([{ id: 'v1', files: [file], dependencies }]), { headers: { 'content-type': 'application/json' } })

  it('installs a verified mod and records its metadata', async () => {
    routes.set('https://api.modrinth.com/v2/project/AbCd1234/version', () =>
      modrinthVersion({ url: 'https://cdn.modrinth.com/data/AbCd1234/jei.jar', filename: 'jei.jar', primary: true, size: modBytes.length, hashes: { sha1: sha1(modBytes), sha512: sha512(modBytes) } })
    )
    routes.set('https://cdn.modrinth.com/', () => new Response(modBytes))

    const result = await call('mods:install-modrinth', 'AbCd1234')
    expect(result).toMatchObject({ ok: true, filename: 'jei.jar', failedDependencies: [] })
    expect(await readFile(join(modsDir, 'jei.jar'))).toEqual(modBytes)
    const meta = JSON.parse(await readFile(join(dataRoot, 'instances', 'orvian', '.orvian', 'custom-mods.json'), 'utf8'))
    expect(meta['jei.jar']).toMatchObject({ projectId: 'AbCd1234', platform: 'modrinth', sha1: sha1(modBytes) })
    expect(((await call('mods:list')) as Array<{ filename: string }>).map((m) => m.filename)).toEqual(['jei.jar'])
  })

  it('writes nothing when the service returns a traversal file name', async () => {
    routes.set('https://api.modrinth.com/v2/project/AbCd1234/version', () =>
      modrinthVersion({ url: 'https://cdn.modrinth.com/x.jar', filename: '../../../escaped.jar', primary: true, hashes: { sha1: sha1(modBytes) } })
    )
    routes.set('https://cdn.modrinth.com/', () => new Response(modBytes))
    await expect(call('mods:install-modrinth', 'AbCd1234')).rejects.toThrow()
    expect(await readdir(modsDir)).toEqual([])
    expect(existsSync(join(dataRoot, 'escaped.jar'))).toBe(false)
  })

  it('rejects a download whose hash does not match and leaves no file', async () => {
    routes.set('https://api.modrinth.com/v2/project/AbCd1234/version', () =>
      modrinthVersion({ url: 'https://cdn.modrinth.com/x.jar', filename: 'x.jar', primary: true, hashes: { sha1: sha1(Buffer.from('something else')) } })
    )
    routes.set('https://cdn.modrinth.com/', () => new Response(modBytes))
    await expect(call('mods:install-modrinth', 'AbCd1234')).rejects.toThrow()
    expect(await readdir(modsDir)).toEqual([])
  })

  it('reports a failed dependency without failing the main install', async () => {
    routes.set('https://api.modrinth.com/v2/project/AbCd1234/version', () =>
      modrinthVersion({ url: 'https://cdn.modrinth.com/main.jar', filename: 'main.jar', primary: true, hashes: { sha1: sha1(modBytes) } }, [{ dependency_type: 'required', project_id: 'Dep00001' }])
    )
    routes.set('https://api.modrinth.com/v2/project/Dep00001/version', () => new Response('boom', { status: 500 }))
    routes.set('https://cdn.modrinth.com/', () => new Response(modBytes))
    const result = await call('mods:install-modrinth', 'AbCd1234')
    expect(result).toMatchObject({ ok: true, filename: 'main.jar', failedDependencies: ['Dep00001'] })
  })

  it('refuses to overwrite or delete an official modpack mod', async () => {
    await mkdir(join(dataRoot, 'instances', 'orvian', '.orvian'), { recursive: true })
    await writeFile(join(dataRoot, 'instances', 'orvian', '.orvian', 'official-state.json'), JSON.stringify({ version: '1.0.0', files: { 'mods/Official.jar': 'x' } }))
    await writeFile(join(modsDir, 'Official.jar'), 'official bytes')

    routes.set('https://api.modrinth.com/v2/project/AbCd1234/version', () =>
      modrinthVersion({ url: 'https://cdn.modrinth.com/o.jar', filename: 'official.jar', primary: true, hashes: { sha1: sha1(modBytes) } })
    )
    routes.set('https://cdn.modrinth.com/', () => new Response(modBytes))
    await expect(call('mods:install-modrinth', 'AbCd1234')).rejects.toThrow(/modpack oficial/)
    await expect(call('mods:delete', 'Official.jar')).rejects.toThrow(/oficiales/)
    expect(await readFile(join(modsDir, 'Official.jar'), 'utf8')).toBe('official bytes')
  })

  it('deletes only plain .jar names inside the mods folder', async () => {
    await writeFile(join(modsDir, 'custom.jar'), 'x')
    await writeFile(join(dataRoot, 'victim.txt'), 'keep me')
    await expect(call('mods:delete', '../../../victim.txt')).rejects.toThrow()
    await expect(call('mods:delete', '..\\victim.jar')).rejects.toThrow()
    expect(await call('mods:delete', 'custom.jar')).toEqual({ ok: true })
    expect(existsSync(join(modsDir, 'custom.jar'))).toBe(false)
    expect(existsSync(join(dataRoot, 'victim.txt'))).toBe(true)
  })

  it('rejects malformed project ids before touching the network', async () => {
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    await expect(call('mods:install-modrinth', '../../x')).rejects.toThrow(/Solicitud no válida/)
    await expect(call('mods:install-curseforge', 'abc')).rejects.toThrow(/Solicitud no válida/)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('runs installs one at a time', async () => {
    let active = 0
    let maxActive = 0
    routes.set('https://api.modrinth.com/v2/project/', () => modrinthVersion({ url: 'https://cdn.modrinth.com/q.jar', filename: 'q.jar', primary: true, hashes: { sha1: sha1(modBytes) } }))
    vi.stubGlobal('fetch', async (input: string | URL) => {
      const url = String(input)
      if (url.startsWith('https://cdn.modrinth.com/')) {
        active++
        maxActive = Math.max(maxActive, active)
        await new Promise((r) => setTimeout(r, 30))
        active--
        return new Response(modBytes)
      }
      return routes.get('https://api.modrinth.com/v2/project/')!()
    })
    await Promise.all([call('mods:install-modrinth', 'AAAAAAAA'), call('mods:install-modrinth', 'BBBBBBBB')])
    expect(maxActive).toBe(1)
  })
})
