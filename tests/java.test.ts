import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { OrvianError } from '../src/shared/errors'
import { extractJreZip, resolveEntryTarget, selectJreAsset } from '../electron/java'
import { buildZip } from './helpers/zip'

const asset = (overrides: Record<string, unknown> = {}, binary: Record<string, unknown> = {}) => ({
  binary: {
    image_type: 'jre',
    os: 'windows',
    architecture: 'x64',
    package: { link: 'https://github.com/adoptium/temurin17-binaries/releases/download/jdk-17.0.20.1%2B1/OpenJDK17U-jre_x64_windows_hotspot_17.0.20.1_1.zip', checksum: 'a'.repeat(64), size: 43_780_109, name: 'jre.zip', ...overrides },
    ...binary
  }
})

describe('selectJreAsset', () => {
  it('returns the Windows x64 JRE with a lower-cased checksum', () => {
    const picked = selectJreAsset([asset({ checksum: 'A'.repeat(64) })])
    expect(picked).toMatchObject({ sha256: 'a'.repeat(64), size: 43_780_109, name: 'jre.zip' })
  })

  it('skips other platforms and images', () => {
    const picked = selectJreAsset([asset({}, { os: 'linux' }), asset({}, { image_type: 'jdk' }), asset()])
    expect(picked.name).toBe('jre.zip')
  })

  it.each([
    ['not an array', {}],
    ['no matching asset', [asset({}, { os: 'mac' })]],
    ['checksum is not sha256', [asset({ checksum: 'abc123' })]],
    ['size out of range', [asset({ size: 12 })]],
    ['non-https link', [asset({ link: 'http://github.com/x.zip' })]],
    ['foreign host', [asset({ link: 'https://evil.test/x.zip' })]],
    ['missing fields', [asset({ name: undefined })]]
  ])('rejects metadata: %s', (_label, input) => {
    expect(() => selectJreAsset(input)).toThrowError(expect.objectContaining({ code: 'JAVA_INSTALL_FAILED' }))
  })
})

describe('resolveEntryTarget', () => {
  it('strips the top-level folder and keeps the target inside the destination', () => {
    expect(resolveEntryTarget('/rt/staging', 'jdk-17', 'jdk-17/bin/javaw.exe')).toBe('/rt/staging/bin/javaw.exe')
  })
  it('ignores directories and the root folder itself', () => {
    expect(resolveEntryTarget('/rt/staging', 'jdk-17', 'jdk-17/bin/')).toBeNull()
    expect(resolveEntryTarget('/rt/staging', 'jdk-17', 'jdk-17/')).toBeNull()
  })
  it('throws for entries that climb out of the destination', () => {
    expect(() => resolveEntryTarget('/rt/staging', 'jdk-17', 'jdk-17/../../evil.dll')).toThrow()
    expect(() => resolveEntryTarget('/rt/staging', 'jdk-17', 'jdk-17/bin/../../../evil.dll')).toThrow()
  })
})

describe('extractJreZip', () => {
  let dir = ''
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'orvian-java-'))
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('extracts into the destination without the top-level folder', async () => {
    const zip = join(dir, 'jre.zip')
    await writeFile(zip, buildZip({ 'jdk-17/': '', 'jdk-17/bin/javaw.exe': 'EXE', 'jdk-17/lib/modules': 'MODS' }))
    await extractJreZip(zip, join(dir, 'out'), () => undefined)
    expect(await readFile(join(dir, 'out', 'bin', 'javaw.exe'), 'utf8')).toBe('EXE')
    expect(await readFile(join(dir, 'out', 'lib', 'modules'), 'utf8')).toBe('MODS')
  })

  it('refuses an archive that tries to write outside and creates nothing outside', async () => {
    const zip = join(dir, 'evil.zip')
    await writeFile(zip, buildZip({ 'jdk-17/bin/javaw.exe': 'EXE', 'jdk-17/../../escaped.txt': 'PWNED' }))
    await expect(extractJreZip(zip, join(dir, 'out'), () => undefined)).rejects.toThrow()
    expect(existsSync(join(dir, 'escaped.txt'))).toBe(false)
    expect(existsSync(join(dir, '..', 'escaped.txt'))).toBe(false)
  })

  it('rejects an archive with no usable top-level folder', async () => {
    const zip = join(dir, 'empty.zip')
    await writeFile(zip, buildZip({}))
    await expect(extractJreZip(zip, join(dir, 'out'), () => undefined)).rejects.toBeInstanceOf(OrvianError)
  })
})
