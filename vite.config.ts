import type { Plugin } from 'vite'
import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

// The React fast-refresh preamble is an inline script and HMR uses a websocket, so the dev
// server needs a looser policy than the packaged app. Applies to `vite serve` only.
const DEV_CSP =
  "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' data: https://fonts.gstatic.com; img-src 'self' data: https://cdn.modrinth.com https://docs.modrinth.com https://*.forgecdn.net https://minotar.net; connect-src 'self' ws://127.0.0.1:5173 http://127.0.0.1:5173; object-src 'none'; base-uri 'none'; form-action 'none'"

function devCsp(): Plugin {
  return {
    name: 'orvian-dev-csp',
    apply: 'serve',
    transformIndexHtml: (html) => html.replace(/(http-equiv="Content-Security-Policy"\s+content=")[^"]*(")/, `$1${DEV_CSP}$2`)
  }
}

export default defineConfig({
  plugins: [react(), devCsp()],
  root: '.',
  base: './',
  build: {
    outDir: 'dist',
    emptyOutDir: true
  },
  test: {
    setupFiles: ['./tests/setup.ts']
  }
})
