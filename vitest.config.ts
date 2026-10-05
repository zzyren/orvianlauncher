import { defineConfig } from 'vitest/config'

// Separate from vite.config.ts: tests need neither the React plugin nor the dev CSP plugin.
export default defineConfig({
  test: {
    setupFiles: ['./tests/setup.ts']
  }
})
