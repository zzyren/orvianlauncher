import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { assertInside, isInside, isSafeFileName } from '../src/shared/paths'

describe('isInside / assertInside', () => {
  it('accepts descendants only', () => {
    expect(isInside('/data/mods', '/data/mods/a.jar')).toBe(true)
    expect(isInside('/data/mods', '/data/mods/sub/a.jar')).toBe(true)
  })

  it.each(['/data/mods', '/data/mods/..', '/data/mods/../x.jar', '/data/modsX/a.jar', '/data', '/etc/passwd', '/data/mods/../../etc/passwd'])(
    'rejects %s',
    (target) => expect(isInside('/data/mods', target)).toBe(false)
  )

  it('assertInside throws and returns the resolved path', () => {
    expect(assertInside('/data/mods', '/data/mods/a.jar')).toBe(resolve('/data/mods/a.jar'))
    expect(() => assertInside('/data/mods', '/data/mods/../a.jar')).toThrow()
  })
})

describe('isSafeFileName', () => {
  it.each([
    'jei-1.20.1-forge-15.3.0.jar',
    'Resourcify (1.20.1-forge)-1.8.6.jar',
    'xaeros_waystones_compatibility-1.1 - 1.20.1.jar',
    'Fastquit-3.0.1+1.20.1forge.JAR',
    "Bliss_v2.1.2_(Chocapic13_Shaders_edit).jar",
    'Ñandú-mod_1.jar'
  ])('accepts %s', (name) => expect(isSafeFileName(name, ['.jar'])).toBe(true))

  it.each([
    '../evil.jar',
    '..\\evil.jar',
    'a/b.jar',
    'C:evil.jar',
    'evil.jar:stream',
    'mod.jar.exe',
    'mod.zip',
    '.hidden.jar',
    'trailing-dot.jar.',
    ' leading.jar',
    'con.jar',
    'NUL.jar',
    'com1.txt.jar',
    'a..b.jar',
    'tab\tname.jar',
    'new\nline.jar',
    'x'.repeat(250) + '.jar',
    '.jar',
    ''
  ])('rejects %j', (name) => expect(isSafeFileName(name, ['.jar'])).toBe(false))

  it('rejects non-strings', () => {
    expect(isSafeFileName(undefined, ['.jar'])).toBe(false)
    expect(isSafeFileName({ toString: () => 'a.jar' }, ['.jar'])).toBe(false)
  })
})
