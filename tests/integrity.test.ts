import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { installVerifiedFile, planUpdate, sha256File, synchronizeOfficialFiles, verifyFile } from '../src/shared/integrity'

describe('official file integrity', () => {
  let dir = ''
  afterEach(async () => { if (dir) await rm(dir, { recursive: true, force: true }) })

  it('verifies size and SHA-256 and atomically installs verified content', async () => {
    dir = await mkdtemp(join(tmpdir(), 'orvian-test-'))
    const bytes = Buffer.from('official test content')
    const file = { path: 'config/sample.txt', size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), url: 'https://example.test/sample.txt', type: 'config' as const, required: true, userMutable: false, userDeletable: false }
    await installVerifiedFile(dir, file, bytes)
    const target = join(dir, 'config', 'sample.txt')
    expect(await verifyFile(target, file)).toBe(true)
    expect(await sha256File(target)).toBe(file.sha256)
    expect(await readFile(target, 'utf8')).toBe(bytes.toString())
    await expect(installVerifiedFile(dir, file, Buffer.from('tampered'))).rejects.toThrow()
  })

  it('preserves an edited user config and stages the new official default on update', async () => {
    dir = await mkdtemp(join(tmpdir(), 'orvian-config-test-'))
    const original = Buffer.from('official default v1')
    const first = { path: 'config/client.toml', size: original.length, sha256: createHash('sha256').update(original).digest('hex'), url: 'https://example.test/v1', type: 'config' as const, required: true, userMutable: false, userDeletable: false }
    await synchronizeOfficialFiles(dir, '1.0.0', [first], async () => original)
    await writeFile(join(dir, 'config', 'client.toml'), 'my personal settings')

    const updatedBytes = Buffer.from('official default v2')
    const updated = { ...first, size: updatedBytes.length, sha256: createHash('sha256').update(updatedBytes).digest('hex'), url: 'https://example.test/v2' }
    const result = await synchronizeOfficialFiles(dir, '1.1.0', [updated], async () => updatedBytes)
    expect(result.stagedDefaults).toBe(1)
    expect(await readFile(join(dir, 'config', 'client.toml'), 'utf8')).toBe('my personal settings')
    expect(await readFile(join(dir, '.orvian', 'pending-config', '1.1.0', 'config', 'client.toml'), 'utf8')).toBe(updatedBytes.toString())
  })

  // ── Tests del fast-path ────────────────────────────────────────────────────

  it('fast-path: NO llama fetchBytes cuando la versión ya está instalada y los archivos existen', async () => {
    dir = await mkdtemp(join(tmpdir(), 'orvian-fastpath-test-'))
    const bytes = Buffer.from('mod content v1.0.0')
    const file = {
      path: 'mods/some-mod.jar',
      size: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      url: 'https://example.test/modpack.zip',
      type: 'mod' as const,
      required: true,
      userMutable: false,
      userDeletable: false
    }

    // Primera instalación (fast-path NO activo: versión vacía en state)
    let fetchCallCount = 0
    const fetchBytes = vi.fn(async () => { fetchCallCount++; return new Uint8Array(bytes) })
    await synchronizeOfficialFiles(dir, '1.0.0', [file], fetchBytes)
    expect(fetchCallCount).toBe(1) // Se descargó en la primera instalación

    // Segunda vez con la MISMA versión — fast-path debe activarse
    fetchCallCount = 0
    const result = await synchronizeOfficialFiles(dir, '1.0.0', [file], fetchBytes)
    expect(fetchCallCount).toBe(0) // NO debe llamar a fetchBytes
    expect(result.trustedFromState).toBe(1) // Un archivo via fast-path
    expect(result.installed).toBe(0)
    expect(result.replaced).toBe(0)
  })

  it('fast-path: SÍ descarga cuando la versión cambia', async () => {
    dir = await mkdtemp(join(tmpdir(), 'orvian-update-test-'))
    const bytesV1 = Buffer.from('mod content v1.0.0')
    const bytesV2 = Buffer.from('mod content v2.0.0 updated')

    const fileV1 = {
      path: 'mods/some-mod.jar',
      size: bytesV1.length,
      sha256: createHash('sha256').update(bytesV1).digest('hex'),
      url: 'https://example.test/modpack.zip',
      type: 'mod' as const,
      required: true,
      userMutable: false,
      userDeletable: false
    }
    const fileV2 = {
      ...fileV1,
      size: bytesV2.length,
      sha256: createHash('sha256').update(bytesV2).digest('hex')
    }

    // Instalar v1.0.0
    await synchronizeOfficialFiles(dir, '1.0.0', [fileV1], async () => new Uint8Array(bytesV1))

    // Actualizar a v2.0.0 — fast-path NO debe activarse (versión diferente)
    let fetchCallCount = 0
    const fetchBytesV2 = vi.fn(async () => { fetchCallCount++; return new Uint8Array(bytesV2) })
    const result = await synchronizeOfficialFiles(dir, '2.0.0', [fileV2], fetchBytesV2)

    expect(fetchCallCount).toBe(1) // Debe haber descargado
    expect(result.replaced).toBe(1)
    expect(result.trustedFromState).toBe(0)
  })

  it('fast-path: SI falta un archivo en disco se reinstala aunque la versión coincida', async () => {
    dir = await mkdtemp(join(tmpdir(), 'orvian-missing-test-'))
    const bytes = Buffer.from('mod content')
    const file = {
      path: 'mods/important-mod.jar',
      size: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      url: 'https://example.test/modpack.zip',
      type: 'mod' as const,
      required: true,
      userMutable: false,
      userDeletable: false
    }

    // Instalar
    await synchronizeOfficialFiles(dir, '1.0.0', [file], async () => new Uint8Array(bytes))

    // Eliminar el archivo manualmente (simula un usuario que lo borró)
    await rm(join(dir, 'mods', 'important-mod.jar'), { force: true })

    // Volver a sincronizar con misma versión — debe re-instalar el archivo faltante
    let fetchCallCount = 0
    const fetchBytes = vi.fn(async () => { fetchCallCount++; return new Uint8Array(bytes) })
    const result = await synchronizeOfficialFiles(dir, '1.0.0', [file], fetchBytes)

    expect(fetchCallCount).toBe(1) // Debe haber re-descargado el archivo faltante
    expect(result.installed).toBe(1)
  })

  it('forceVerify: con forceVerify=true NO usa fast-path aunque la versión coincida', async () => {
    dir = await mkdtemp(join(tmpdir(), 'orvian-forceverify-test-'))
    const bytes = Buffer.from('mod content')
    const file = {
      path: 'mods/some-mod.jar',
      size: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      url: 'https://example.test/modpack.zip',
      type: 'mod' as const,
      required: true,
      userMutable: false,
      userDeletable: false
    }

    // Instalar
    await synchronizeOfficialFiles(dir, '1.0.0', [file], async () => new Uint8Array(bytes))

    // Con forceVerify=true: debe hacer SHA-256 completo (unchanged, no trustedFromState)
    const result = await synchronizeOfficialFiles(dir, '1.0.0', [file], async () => { throw new Error('No debería llamarse') }, { forceVerify: true })

    expect(result.trustedFromState).toBe(0) // Fast-path desactivado
    expect(result.unchanged).toBe(1)        // SHA-256 verificado y coincide
    expect(result.installed).toBe(0)
  })
})

describe('interrupted sync and size-checked fast path', () => {
  let dir = ''
  afterEach(async () => { if (dir) await rm(dir, { recursive: true, force: true }) })

  const make = (path: string, content: string, type: 'mod' | 'config' = 'mod') => {
    const bytes = Buffer.from(content)
    return { file: { path, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), url: 'https://example.test/pack.zip', type, required: true, userMutable: false, userDeletable: false }, bytes }
  }
  const marker = () => join(dir, '.orvian', 'sync.marker')

  it('writes a marker before the first change and removes it once the state is committed', async () => {
    dir = await mkdtemp(join(tmpdir(), 'orvian-marker-'))
    const a = make('mods/a.jar', 'aaa')
    let markerSeenDuringWrite = false
    await synchronizeOfficialFiles(dir, '1.0.0', [a.file], async () => {
      markerSeenDuringWrite = existsSync(marker())
      return new Uint8Array(a.bytes)
    })
    expect(markerSeenDuringWrite).toBe(false) // download happens before the first write
    expect(existsSync(marker())).toBe(false)
    expect(JSON.parse(await readFile(join(dir, '.orvian', 'official-state.json'), 'utf8')).version).toBe('1.0.0')
  })

  it('leaves the marker behind when the sync dies after changing a file', async () => {
    dir = await mkdtemp(join(tmpdir(), 'orvian-marker-'))
    const a = make('mods/a.jar', 'aaa')
    const b = make('mods/b.jar', 'bbb')
    let calls = 0
    await expect(
      synchronizeOfficialFiles(dir, '1.0.0', [a.file, b.file], async (f) => {
        if (++calls === 2) throw new Error('connection lost')
        return new Uint8Array(f.path === a.file.path ? a.bytes : b.bytes)
      })
    ).rejects.toThrow('connection lost')
    expect(existsSync(marker())).toBe(true)
    expect(existsSync(join(dir, '.orvian', 'official-state.json'))).toBe(false)
    expect(existsSync(join(dir, 'mods', 'a.jar'))).toBe(true)
  })

  it('after an interruption, verifies every file in full even when the state claims the version is installed', async () => {
    dir = await mkdtemp(join(tmpdir(), 'orvian-marker-'))
    const a = make('mods/a.jar', 'aaa')
    await synchronizeOfficialFiles(dir, '1.0.0', [a.file], async () => new Uint8Array(a.bytes))
    // Same size, different content: only a hash check can notice
    await writeFile(join(dir, 'mods', 'a.jar'), 'XXX')
    await writeFile(marker(), '{}')

    const result = await synchronizeOfficialFiles(dir, '1.0.0', [a.file], async () => new Uint8Array(a.bytes))
    expect(result.trustedFromState).toBe(0)
    expect(result.replaced).toBe(1)
    expect(await readFile(join(dir, 'mods', 'a.jar'), 'utf8')).toBe('aaa')
    expect(existsSync(marker())).toBe(false)
  })

  it('the fast path now notices a truncated file', async () => {
    dir = await mkdtemp(join(tmpdir(), 'orvian-marker-'))
    const a = make('mods/a.jar', 'aaaaaa')
    await synchronizeOfficialFiles(dir, '1.0.0', [a.file], async () => new Uint8Array(a.bytes))
    await writeFile(join(dir, 'mods', 'a.jar'), 'aa')
    const fetchBytes = vi.fn(async () => new Uint8Array(a.bytes))
    const result = await synchronizeOfficialFiles(dir, '1.0.0', [a.file], fetchBytes)
    expect(fetchBytes).toHaveBeenCalledOnce()
    expect(result.trustedFromState).toBe(0)
  })

  it('a clean no-op sync never writes the marker', async () => {
    dir = await mkdtemp(join(tmpdir(), 'orvian-marker-'))
    const a = make('mods/a.jar', 'aaa')
    await synchronizeOfficialFiles(dir, '1.0.0', [a.file], async () => new Uint8Array(a.bytes))
    await synchronizeOfficialFiles(dir, '1.0.0', [a.file], async () => { throw new Error('no fetch expected') })
    expect(existsSync(marker())).toBe(false)
  })
})

describe('planUpdate', () => {
  let dir = ''
  afterEach(async () => { if (dir) await rm(dir, { recursive: true, force: true }) })
  const make = (path: string, content: string) => {
    const bytes = Buffer.from(content)
    return { file: { path, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), url: 'https://example.test/pack.zip', type: 'mod' as const, required: true, userMutable: false, userDeletable: false }, bytes }
  }

  it('estimates what an update would download without touching the instance', async () => {
    dir = await mkdtemp(join(tmpdir(), 'orvian-plan-'))
    const keep = make('mods/keep.jar', 'keep')
    const old = make('mods/change.jar', 'v1 content')
    const gone = make('mods/gone.jar', 'gone')
    await synchronizeOfficialFiles(dir, '1.0.0', [keep.file, old.file, gone.file], async (f) => new Uint8Array([keep, old, gone].find((x) => x.file.path === f.path)!.bytes))

    const changed = make('mods/change.jar', 'v2 content, bigger')
    const added = make('mods/new.jar', 'brand new mod')
    const plan = await planUpdate(dir, [keep.file, changed.file, added.file])
    expect(plan).toEqual({ install: 1, replace: 1, unchanged: 1, remove: 1, bytesToDownload: changed.file.size + added.file.size })
    expect(await readFile(join(dir, 'mods', 'change.jar'), 'utf8')).toBe('v1 content')
  })

  it('treats a missing or wrong-size file as needing a download', async () => {
    dir = await mkdtemp(join(tmpdir(), 'orvian-plan-'))
    const a = make('mods/a.jar', 'aaaa')
    await synchronizeOfficialFiles(dir, '1.0.0', [a.file], async () => new Uint8Array(a.bytes))
    await writeFile(join(dir, 'mods', 'a.jar'), 'a')
    expect((await planUpdate(dir, [a.file])).replace).toBe(1)
    await rm(join(dir, 'mods', 'a.jar'))
    expect((await planUpdate(dir, [a.file])).install).toBe(1)
  })

  it('ignores unsafe manifest paths', async () => {
    dir = await mkdtemp(join(tmpdir(), 'orvian-plan-'))
    const evil = make('../escape.jar', 'x')
    expect(await planUpdate(dir, [evil.file])).toMatchObject({ install: 0, bytesToDownload: 0 })
  })
})
