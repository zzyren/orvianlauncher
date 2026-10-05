import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { resetLauncherData } from '../electron/reset'

describe('resetLauncherData', () => {
  let root = ''
  const instance = () => join(root, 'instances', 'orvian')
  const put = async (rel: string, content = 'x') => {
    const file = join(root, rel)
    await mkdir(join(file, '..'), { recursive: true })
    await writeFile(file, content)
  }

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'orvian-reset-'))
    await put('launcher/auth.json')
    await put('launcher/admin.json')
    await put('launcher/config.json')
    await put('launcher/logs/launcher.log', 'keep the log')
    await put('runtime/java-17/bin/javaw.exe')
    await put('common/versions/1.20.1/1.20.1.jar')
    await put('instances/orvian/mods/a.jar')
    await put('instances/orvian/config/a.toml')
    await put('instances/orvian/.orvian/official-state.json')
    await put('instances/orvian/saves/mundo/level.dat', 'my world')
    await put('instances/orvian/screenshots/a.png')
    await put('instances/orvian/resourcepacks/p.zip')
    await put('instances/orvian/shaderpacks/s.zip')
    await put('instances/orvian/options.txt', 'fov:90')
    await put('instances/orvian/servers.dat')
    await put('instances/other/file.txt')
  })
  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('keeps worlds, screenshots, packs and options by default', async () => {
    const { preserved } = await resetLauncherData(root, { deleteWorlds: false })
    expect(preserved.sort()).toEqual(['options.txt', 'resourcepacks', 'saves', 'screenshots', 'servers.dat', 'shaderpacks'])
    expect(await readFile(join(instance(), 'saves', 'mundo', 'level.dat'), 'utf8')).toBe('my world')
    expect(await readFile(join(instance(), 'options.txt'), 'utf8')).toBe('fov:90')
    for (const gone of ['mods', 'config', '.orvian']) expect(existsSync(join(instance(), gone))).toBe(false)
    for (const gone of ['launcher/auth.json', 'launcher/admin.json', 'launcher/config.json', 'runtime', 'common', 'instances/other']) {
      expect(existsSync(join(root, gone))).toBe(false)
    }
  })

  it('always keeps the launcher log', async () => {
    await resetLauncherData(root, { deleteWorlds: false })
    expect(await readFile(join(root, 'launcher', 'logs', 'launcher.log'), 'utf8')).toBe('keep the log')
    await resetLauncherData(root, { deleteWorlds: true })
    expect(await readFile(join(root, 'launcher', 'logs', 'launcher.log'), 'utf8')).toBe('keep the log')
  })

  it('deletes worlds only when asked', async () => {
    await resetLauncherData(root, { deleteWorlds: true })
    expect(existsSync(join(instance(), 'saves'))).toBe(false)
    expect(existsSync(join(instance(), 'options.txt'))).toBe(false)
    expect(existsSync(join(root, 'instances', 'other'))).toBe(false)
  })

  it('leaves a launchable skeleton behind', async () => {
    await resetLauncherData(root, { deleteWorlds: true })
    expect(existsSync(join(root, 'launcher', 'logs'))).toBe(true)
    expect(existsSync(instance())).toBe(true)
  })

  it('works on an empty data root', async () => {
    const empty = await mkdtemp(join(tmpdir(), 'orvian-reset-empty-'))
    await expect(resetLauncherData(empty, { deleteWorlds: false })).resolves.toEqual({ preserved: [] })
    await rm(empty, { recursive: true, force: true })
  })
})
