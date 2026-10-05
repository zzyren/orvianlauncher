import { describe, expect, it } from 'vitest'
import { forgeVersionId, isAdminUuid, loadConfig } from '../electron/config'

const env = {
  ORVIAN_DATA_DIR: '/tmp/orvian-test',
  ORVIAN_MANIFEST_URL: 'http://127.0.0.1:9999/manifest.json',
  ORVIAN_PACK_REPO: 'someone/staging-pack',
  ORVIAN_SERVER: 'mc.example.test:25570',
  VITE_DEV_SERVER_URL: 'http://127.0.0.1:5173'
}

describe('loadConfig', () => {
  it('ignores every override in a packaged build', () => {
    const config = loadConfig(true, env)
    expect(config.dataDir).toBeUndefined()
    expect(config.manifestUrl).toBeUndefined()
    expect(config.devServerUrl).toBeUndefined()
    expect(config.packRepo).toBe('zzyren/orvianmodpack')
    expect(config.server.address).toBe('payo.exaroton.me')
  })

  it('applies overrides when running unpackaged', () => {
    const config = loadConfig(false, env)
    expect(config).toMatchObject({
      dataDir: '/tmp/orvian-test',
      manifestUrl: 'http://127.0.0.1:9999/manifest.json',
      packRepo: 'someone/staging-pack',
      devServerUrl: 'http://127.0.0.1:5173',
      server: { address: 'mc.example.test', port: 25570 }
    })
  })

  it('rejects malformed overrides instead of using them', () => {
    const config = loadConfig(false, { ORVIAN_PACK_REPO: 'not a repo', ORVIAN_SERVER: 'bad host:99999', ORVIAN_MANIFEST_URL: 'file:///etc/passwd' })
    expect(config.packRepo).toBe('zzyren/orvianmodpack')
    expect(config.server.address).toBe('payo.exaroton.me')
    expect(config.manifestUrl).toBeUndefined()
  })
})

describe('helpers', () => {
  it('builds the forge version id', () => {
    expect(forgeVersionId(loadConfig(true, {}))).toBe('1.20.1-forge-47.4.23')
  })

  it('matches admin UUIDs with or without dashes and any case', () => {
    const config = loadConfig(true, {})
    expect(isAdminUuid('a8603c06-e747-4c44-b0bd-e33067ab6627', config)).toBe(true)
    expect(isAdminUuid('A8603C06E7474C44B0BDE33067AB6627', config)).toBe(true)
    expect(isAdminUuid('00000000000000000000000000000000', config)).toBe(false)
  })
})
