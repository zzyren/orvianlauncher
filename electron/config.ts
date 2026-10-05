/**
 * Product constants and the only place that reads environment variables.
 * Overrides exist for development and automated tests; they are ignored in packaged builds.
 */
export interface OrvianConfig {
  mcVersion: string
  /** Fallback Forge build; the manifest's `pack.forge` takes precedence once it is wired in. */
  forgeVersion: string
  packRepo: string
  /** Minecraft profile UUIDs (no dashes, lowercase) allowed to see the admin panel. */
  adminUuids: readonly string[]
  /** Public Minecraft launcher client ID (see security audit S5 before changing). */
  msClientId: string
  minSplashMs: number
  server: { name: string; address: string; port: number }
  /** Overrides, only honoured when the app is not packaged. */
  dataDir?: string
  manifestUrl?: string
  devServerUrl?: string
}

const DEFAULTS: Omit<OrvianConfig, 'dataDir' | 'manifestUrl' | 'devServerUrl'> = {
  mcVersion: '1.20.1',
  forgeVersion: '47.4.23',
  packRepo: 'zzyren/orvianmodpack',
  adminUuids: ['a8603c06e7474c44b0bde33067ab6627'],
  msClientId: '00000000402b5328',
  minSplashMs: 5000,
  server: { name: 'Orvian', address: 'payo.exaroton.me', port: 13133 }
}

const REPO_PATTERN = /^[\w.-]+\/[\w.-]+$/

function parseServer(value: string): OrvianConfig['server'] | undefined {
  const match = /^([\w.-]+)(?::(\d{1,5}))?$/.exec(value.trim())
  if (!match) return undefined
  const port = match[2] ? Number(match[2]) : 25565
  if (port < 1 || port > 65535) return undefined
  return { name: DEFAULTS.server.name, address: match[1], port }
}

export function loadConfig(isPackaged: boolean, env: NodeJS.ProcessEnv = process.env): OrvianConfig {
  const config: OrvianConfig = { ...DEFAULTS }
  if (isPackaged) return config

  if (env.ORVIAN_DATA_DIR) config.dataDir = env.ORVIAN_DATA_DIR
  if (env.ORVIAN_MANIFEST_URL?.startsWith('http')) config.manifestUrl = env.ORVIAN_MANIFEST_URL
  if (env.ORVIAN_PACK_REPO && REPO_PATTERN.test(env.ORVIAN_PACK_REPO)) config.packRepo = env.ORVIAN_PACK_REPO
  if (env.ORVIAN_SPLASH_MS && /^\d{1,5}$/.test(env.ORVIAN_SPLASH_MS)) config.minSplashMs = Number(env.ORVIAN_SPLASH_MS)
  if (env.ORVIAN_SERVER) config.server = parseServer(env.ORVIAN_SERVER) ?? config.server
  if (env.VITE_DEV_SERVER_URL) config.devServerUrl = env.VITE_DEV_SERVER_URL
  return config
}

let current: OrvianConfig = loadConfig(true, {})

export function initConfig(isPackaged: boolean, env: NodeJS.ProcessEnv = process.env): OrvianConfig {
  current = loadConfig(isPackaged, env)
  return current
}

export function getConfig(): OrvianConfig {
  return current
}

export function forgeVersionId(config: OrvianConfig = current): string {
  return `${config.mcVersion}-forge-${config.forgeVersion}`
}

export function isAdminUuid(uuid: string, config: OrvianConfig = current): boolean {
  return config.adminUuids.includes(uuid.replace(/-/g, '').toLowerCase())
}
