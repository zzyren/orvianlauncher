import { defineConfig } from 'vitest/config'

// Separate from vite.config.ts: tests need neither the React plugin nor the dev CSP plugin.
export default defineConfig({
  test: {
    // Browser-driven specs in e2e/ run with Playwright (npm run test:e2e)
    exclude: ['e2e/**', 'node_modules/**', 'dist/**', 'dist-electron/**', 'release/**'],
    setupFiles: ['./tests/setup.ts']
  }
})
