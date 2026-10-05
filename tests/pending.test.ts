import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { discardPendingConfigs, listPendingConfigs, restorePendingConfigs } from '../electron/modpack/pending'

let dir: string

async function put(rel: string, content: string): Promise<void> {
  const file = join(dir, rel)
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, content)
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'orvian-pending-'))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('pending configs', () => {
  it('is empty when nothing was staged', async () => {
    expect(await listPendingConfigs(dir)).toEqual({ files: [] })
  })

  it('lists staged files once even when several versions staged the same one', async () => {
    await put('.orvian/pending-config/1.0.1/config/a.toml', 'v1')
    await put('.orvian/pending-config/1.0.2/config/a.toml', 'v2')
    await put('.orvian/pending-config/1.0.2/config/sub/b.json', 'b')
    expect((await listPendingConfigs(dir)).files).toEqual(['config/a.toml', 'config/sub/b.json'])
  })

  it('restores the newest default over the player file and clears the staging area', async () => {
    await put('config/a.toml', 'mine')
    await put('.orvian/pending-config/1.0.9/config/a.toml', 'old default')
    await put('.orvian/pending-config/1.0.10/config/a.toml', 'new default')
    const result = await restorePendingConfigs(dir)
    expect(result.restored).toBe(1)
    expect(await readFile(join(dir, 'config/a.toml'), 'utf8')).toBe('new default')
    expect(existsSync(join(dir, '.orvian/pending-config'))).toBe(false)
    expect((await readdir(join(dir, 'config'))).filter((name) => name.endsWith('.orvian-tmp'))).toEqual([])
  })

  it('discarding keeps the player files', async () => {
    await put('config/a.toml', 'mine')
    await put('.orvian/pending-config/1.0.1/config/a.toml', 'default')
    await discardPendingConfigs(dir)
    expect(await readFile(join(dir, 'config/a.toml'), 'utf8')).toBe('mine')
    expect((await listPendingConfigs(dir)).files).toEqual([])
  })
})
