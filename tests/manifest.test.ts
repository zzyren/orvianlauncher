import { describe, expect, it } from 'vitest'
import { compareVersions, decideFileSync, ManifestSchema, safePackPath } from '../src/shared/manifest'

describe('safePackPath', () => {
  it.each(['../escape.jar', '/absolute.jar', 'C:/system.dll', 'mods\\bad.jar', 'mods/../bad.jar', ''])('rejects unsafe path %s', (path) => expect(safePackPath(path)).toBe(false))
  it.each(['mods/example.jar', 'config/client.toml', 'shaderpacks/user/one.zip'])('allows relative pack path %s', (path) => expect(safePackPath(path)).toBe(true))
})

describe('compareVersions', () => {
  it('compares semantic numeric components', () => { expect(compareVersions('1.10.0', '1.9.9')).toBe(1); expect(compareVersions('1.2.0', '1.2.0')).toBe(0); expect(compareVersions('1.1.0', '1.2.0')).toBe(-1) })
  it('ranks prereleases below stable versions', () => expect(compareVersions('1.0.0-alpha', '1.0.0')).toBe(-1))
})

describe('manifest validation and sync planning', () => {
  const file = { path: 'mods/example.jar', sha256: 'a'.repeat(64), size: 100, url: 'https://cdn.example.test/example.jar', type: 'mod', required: true, userMutable: false, userDeletable: false } as const
  it('rejects insecure or traversal manifests', () => {
    const manifest = { schemaVersion: 1, pack: { id: 'orvian', name: 'Orvian', version: '1.0.0', minecraft: '1.20.1', loader: 'forge', forge: 'unverified' }, runtime: { java: 17 }, minimumLauncher: '0.1.0', publishedAt: '2026-03-27T00:00:00.000Z', changelog: [], files: [{ ...file, path: '../outside', url: 'http://example.test/file' }] }
    expect(ManifestSchema.safeParse(manifest).success).toBe(false)
  })
  it('seeds official config once and preserves user edits across pack updates', () => {
    const configFile = { ...file, type: 'config' as const }
    expect(decideFileSync(configFile, { exists: false })).toBe('install')
    expect(decideFileSync(configFile, { exists: true, currentHash: configFile.sha256, lastOfficialHash: configFile.sha256 })).toBe('unchanged')
    expect(decideFileSync(configFile, { exists: true, currentHash: 'user-edited', lastOfficialHash: configFile.sha256 })).toBe('keep-user-config')
  })
  it('stages a changed official default rather than replacing a locally edited config', () => {
    const configFile = { ...file, type: 'config' as const }
    const updated = { ...configFile, sha256: 'b'.repeat(64) }
    expect(decideFileSync(updated, { exists: true, currentHash: 'user-edited', lastOfficialHash: configFile.sha256 })).toBe('stage-new-default')
  })
})
