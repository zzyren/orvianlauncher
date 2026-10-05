import { defineConfig } from '@playwright/test'

// The specs launch the built app themselves (`npm run build` first); see e2e/launcher.ts.
export default defineConfig({
  testDir: 'e2e',
  timeout: 90_000,
  expect: { timeout: 10_000 },
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['github']] : 'list'
})
