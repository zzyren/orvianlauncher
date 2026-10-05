import { existsSync } from 'node:fs'
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../electron/net', async (importOriginal) => ({ ...(await importOriginal<typeof import('../electron/net')>()), fetchJson: vi.fn(), download: vi.fn() }))

import { ensureJava17 } from '../electron/java'
import { fetchJson } from '../electron/net'

/** A stand-in for javaw.exe: a script that prints a Java version banner (or fails). */
async function fakeJava(root: string, behaviour: 'works' | 'broken', counter: string) {
  const bin = join(root, 'runtime', 'java-17', 'bin')
  await mkdir(bin, { recursive: true })
  const script = behaviour === 'works' ? `#!/bin/sh\necho x >> "${counter}"\necho 'openjdk version "17.0.20" 2026-01-20' >&2\nexit 0\n` : `#!/bin/sh\necho x >> "${counter}"\nexit 1\n`
  await writeFile(join(bin, 'javaw.exe'), script)
  await chmod(join(bin, 'javaw.exe'), 0o755)
}

describe.skipIf(process.platform === 'win32')('ensureJava17 verification stamp', () => {
  let root = ''
  let counter = ''
  const stamp = () => join(root, 'runtime', 'java-17', '.orvian-java.json')
  const runs = async () => (existsSync(counter) ? (await import('node:fs/promises').then((fs) => fs.readFile(counter, 'utf8'))).trim().split('\n').length : 0)

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'orvian-java-ensure-'))
    counter = join(root, 'runs.txt')
    vi.mocked(fetchJson).mockReset().mockRejectedValue(new Error('offline'))
  })
  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('verifies an install once, writes the stamp, and does not spawn Java again', async () => {
    await fakeJava(root, 'works', counter)
    const javaw = await ensureJava17(root, () => undefined)
    expect(javaw).toBe(join(root, 'runtime', 'java-17', 'bin', 'javaw.exe'))
    expect(existsSync(stamp())).toBe(true)
    expect(await runs()).toBe(1)

    await ensureJava17(root, () => undefined)
    expect(await runs()).toBe(1)
  })

  it('re-checks an already stamped install when forced, and falls back to installing if it is broken', async () => {
    await fakeJava(root, 'broken', counter)
    await writeFile(stamp(), '{}')
    await expect(ensureJava17(root, () => undefined)).resolves.toContain('javaw.exe')
    expect(await runs()).toBe(0)

    await expect(ensureJava17(root, () => undefined, { force: true })).rejects.toThrow('offline')
    expect(await runs()).toBe(1)
    expect(fetchJson).toHaveBeenCalledOnce()
  })

  it('goes to the network when the runtime is missing', async () => {
    await expect(ensureJava17(root, () => undefined)).rejects.toThrow('offline')
    expect(fetchJson).toHaveBeenCalledOnce()
  })
})
