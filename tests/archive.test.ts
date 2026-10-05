import { describe, expect, it } from 'vitest'
import { detectArchivePrefix, indexArchiveEntries, normalizeArchivePath } from '../src/shared/archive'

describe('detectArchivePrefix', () => {
  it.each([
    [['instance.cfg', '.minecraft/mods/a.jar'], '.minecraft/'],
    [['MyPack/.minecraft/mods/a.jar', 'MyPack/instance.cfg'], 'MyPack/.minecraft/'],
    [['modrinth.index.json', 'overrides/config/a.toml'], 'overrides/'],
    [['mods/a.jar', 'config/a.toml'], ''],
    [['.minecraft\\mods\\a.jar'], '.minecraft/'],
    [[], '']
  ])('%j -> %j', (names, expected) => expect(detectArchivePrefix(names)).toBe(expected))
})

describe('normalizeArchivePath', () => {
  it.each([
    ['.minecraft/mods/a.jar', '.minecraft/', 'mods/a.jar'],
    ['MyPack/.minecraft/config/x.toml', 'MyPack/.minecraft/', 'config/x.toml'],
    ['overrides/mods/a.jar', 'overrides/', 'mods/a.jar'],
    ['minecraft/options.txt', '', 'options.txt'],
    ['mods/a.jar', '', 'mods/a.jar'],
    ['/mods/a.jar', '', 'mods/a.jar'],
    ['.minecraft\\mods\\a.jar', '.minecraft/', 'mods/a.jar']
  ])('%s with prefix %j -> %s', (name, prefix, expected) => expect(normalizeArchivePath(name, prefix)).toBe(expected))
})

describe('indexArchiveEntries', () => {
  it('finds entries by manifest path, case-insensitively, and skips directories', () => {
    const entries = [{ fileName: 'overrides/' }, { fileName: 'overrides/mods/Jei.jar' }, { fileName: 'overrides/config/a.toml' }, { fileName: 'modrinth.index.json' }]
    const index = indexArchiveEntries(entries)
    expect(index.get('mods/Jei.jar')).toBe(entries[1])
    expect(index.get('mods/jei.jar')).toBe(entries[1])
    expect(index.get('config/a.toml')).toBe(entries[2])
    expect(index.has('')).toBe(false)
  })
})
