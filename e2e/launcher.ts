import { _electron as electron, test as base, expect, type ElectronApplication, type Page } from '@playwright/test'
import { createServer, type Server } from 'node:http'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

/**
 * Starts the real (unpackaged) launcher against a throw-away data folder and a local manifest.
 * The ORVIAN_* overrides are honoured only because the app is not packaged.
 */

const MANIFEST = {
  schemaVersion: 1,
  pack: { id: 'orvian', name: 'Orvian', version: '9.9.9', minecraft: '1.20.1', loader: 'forge', forge: '47.4.23' },
  runtime: { java: 17 },
  minimumLauncher: '0.0.1',
  publishedAt: '2026-01-01T00:00:00.000Z',
  changelog: ['Cambio de prueba uno', 'Cambio de prueba dos'],
  files: []
}

export interface RunningLauncher {
  app: ElectronApplication
  window: Page
  dataDir: string
  /** Console errors and warnings reported by the window since it opened. */
  problems: string[]
  /** Closes the app and starts it again on the same data folder. */
  restart(): Promise<void>
}

export interface LauncherOptions {
  /** Files to create inside the data folder before the first start, by relative path. */
  seed?: Record<string, string>
}

async function startManifestServer(): Promise<{ server: Server; url: string }> {
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify(MANIFEST))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('No se pudo abrir el servidor de pruebas')
  return { server, url: `http://127.0.0.1:${address.port}/orvian-manifest.json` }
}

export const test = base.extend<{ launch: (options?: LauncherOptions) => Promise<RunningLauncher> }>({
  // Playwright reads the fixtures a callback needs from its destructured argument; this one needs none
  // eslint-disable-next-line no-empty-pattern
  launch: async ({}, use) => {
    const cleanups: Array<() => Promise<void>> = []

    await use(async (options = {}) => {
      const dataDir = await mkdtemp(join(tmpdir(), 'orvian-e2e-'))
      for (const [relative, content] of Object.entries(options.seed ?? {})) {
        const file = join(dataDir, relative)
        await mkdir(dirname(file), { recursive: true })
        await writeFile(file, content)
      }
      const { server, url } = await startManifestServer()

      const running = {
        dataDir,
        problems: [] as string[],
        app: undefined as unknown as ElectronApplication,
        window: undefined as unknown as Page,
        restart: async () => {
          await running.app.close()
          await open()
        }
      }

      const open = async (): Promise<void> => {
        running.app = await electron.launch({
          args: ['.', ...(process.platform === 'linux' ? ['--no-sandbox', '--disable-gpu'] : [])],
          env: {
            ...process.env,
            ORVIAN_DATA_DIR: dataDir,
            ORVIAN_MANIFEST_URL: url,
            // A repository that does not exist: the news fall back to the manifest's changelog, offline or not
            ORVIAN_PACK_REPO: 'orvian-e2e/does-not-exist',
            ORVIAN_SPLASH_MS: '200'
          }
        })
        const isMain = (page: Page): boolean => page.url().includes('index.html') && !page.url().includes('#tray')
        const found = running.app.windows().find(isMain) ?? (await running.app.waitForEvent('window', { predicate: isMain }))
        running.window = found
        found.on('console', (message) => {
          if (message.type() === 'error' || message.type() === 'warning') running.problems.push(message.text())
        })
        found.on('pageerror', (error) => running.problems.push(error.message))
        await found.waitForSelector('.app')
      }

      cleanups.push(async () => {
        await running.app?.close().catch(() => undefined)
        await new Promise((resolve) => server.close(resolve))
        await rm(dataDir, { recursive: true, force: true })
      })

      await open()
      return running
    })

    for (const cleanup of cleanups.reverse()) await cleanup()
  }
})

export { expect }
