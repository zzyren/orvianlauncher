import { pathToFileURL } from 'node:url'
import { join } from 'node:path'
import type { IpcMainInvokeEvent } from 'electron'
import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { OrvianError } from '../src/shared/errors'
import { createIpc, isAppUrl, type AppUrlContext } from '../electron/ipc'

const indexFileUrl = pathToFileURL(join('/opt/orvian/resources/app', 'dist', 'index.html')).href
const prod: AppUrlContext = { indexFileUrl }
const dev: AppUrlContext = { indexFileUrl, devServerUrl: 'http://127.0.0.1:5173' }

describe('isAppUrl', () => {
  it('accepts the built renderer, with or without a hash', () => {
    expect(isAppUrl(indexFileUrl, prod)).toBe(true)
    expect(isAppUrl(`${indexFileUrl}#tray`, prod)).toBe(true)
  })

  it('rejects other files, other schemes and garbage in production', () => {
    expect(isAppUrl(pathToFileURL('/tmp/evil.html').href, prod)).toBe(false)
    expect(isAppUrl('https://example.test/', prod)).toBe(false)
    expect(isAppUrl('http://127.0.0.1:5173/', prod)).toBe(false)
    expect(isAppUrl('not a url', prod)).toBe(false)
    expect(isAppUrl('', prod)).toBe(false)
  })

  it('trusts only the dev server origin in development', () => {
    expect(isAppUrl('http://127.0.0.1:5173/#tray', dev)).toBe(true)
    expect(isAppUrl('http://127.0.0.1:5174/', dev)).toBe(false)
    expect(isAppUrl('http://localhost:5173/', dev)).toBe(false)
    expect(isAppUrl(indexFileUrl, dev)).toBe(false)
  })
})

function harness() {
  const handlers = new Map<string, (event: IpcMainInvokeEvent, ...args: unknown[]) => Promise<unknown>>()
  const ipc = createIpc(
    { handle: (channel, listener) => void handlers.set(channel, listener as never) },
    { isTrustedUrl: (url) => isAppUrl(url, prod) }
  )
  const call = (channel: string, args: unknown[] = [], senderUrl: string | null = indexFileUrl) =>
    handlers.get(channel)!({ senderFrame: senderUrl === null ? null : { url: senderUrl } } as unknown as IpcMainInvokeEvent, ...args)
  return { ipc, call }
}

describe('createIpc.handle', () => {
  it('runs the handler with parsed arguments for the trusted frame', async () => {
    const { ipc, call } = harness()
    ipc.handle('x:add', [z.number(), z.number().optional()], (_e, a, b) => a + (b ?? 0))
    expect(await call('x:add', [1, 2])).toBe(3)
    expect(await call('x:add', [5])).toBe(5)
  })

  it('rejects an untrusted or missing frame without running the handler', async () => {
    const { ipc, call } = harness()
    const fn = vi.fn()
    ipc.handle('x:danger', [], fn)
    await expect(call('x:danger', [], 'https://evil.test/')).rejects.toThrow(/Acción no permitida/)
    await expect(call('x:danger', [], null)).rejects.toThrow(/Acción no permitida/)
    expect(fn).not.toHaveBeenCalled()
  })

  it('rejects invalid and surplus arguments', async () => {
    const { ipc, call } = harness()
    const fn = vi.fn()
    ipc.handle('x:one', [z.string().max(3)], fn)
    await expect(call('x:one', ['too long'])).rejects.toThrow(/Solicitud no válida/)
    await expect(call('x:one', [1])).rejects.toThrow(/Solicitud no válida/)
    await expect(call('x:one', ['ok', 'extra'])).rejects.toThrow(/Solicitud no válida/)
    await expect(call('x:one', [])).rejects.toThrow(/Solicitud no válida/)
    expect(fn).not.toHaveBeenCalled()
  })

  it('keeps plain errors as they are and flattens typed ones to readable text', async () => {
    const { ipc, call } = harness()
    ipc.handle('x:plain', [], () => {
      throw new Error('RAM fuera de rango')
    })
    ipc.handle('x:typed', [], () => {
      throw new OrvianError('AUTH_EXPIRED')
    })
    await expect(call('x:plain')).rejects.toThrow('RAM fuera de rango')
    await expect(call('x:typed')).rejects.toThrow('Tu sesión ha caducado. Vuelve a iniciar sesión para continuar.')
  })
})
