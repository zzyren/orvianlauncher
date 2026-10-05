import { fileURLToPath } from 'node:url'
import type { IpcMain, IpcMainInvokeEvent } from 'electron'
import { z } from 'zod'
import { OrvianError, userMessage } from '../src/shared/errors'
import { log } from './logger'

export interface AppUrlContext {
  /** `file://` URL of the built renderer entry (production). */
  indexFileUrl: string
  /** Vite dev server URL; when set, its origin is the only trusted one (development). */
  devServerUrl?: string
}

/** True only for the launcher's own renderer page; the hash (e.g. `#tray`) is ignored. */
export function isAppUrl(raw: string, context: AppUrlContext): boolean {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return false
  }
  if (context.devServerUrl) {
    return url.origin === new URL(context.devServerUrl).origin
  }
  if (url.protocol !== 'file:') return false
  const normalize = (file: string): string => (process.platform === 'win32' ? file.toLowerCase() : file)
  try {
    return normalize(fileURLToPath(url)) === normalize(fileURLToPath(context.indexFileUrl))
  } catch {
    return false
  }
}

type Args<S extends readonly z.ZodTypeAny[]> = { [K in keyof S]: z.infer<S[K]> }

export interface Ipc {
  /**
   * Registers an invoke handler that (1) only answers the launcher's own renderer frame,
   * (2) validates every positional argument with Zod and rejects extras, and (3) logs failures.
   * Return values and thrown errors keep their legacy shape for the current renderer.
   */
  handle<const S extends readonly z.ZodTypeAny[], R>(
    channel: string,
    schemas: S,
    fn: (event: IpcMainInvokeEvent, ...args: Args<S>) => R | Promise<R>
  ): void
}

export interface IpcOptions {
  isTrustedUrl: (url: string) => boolean
}

export function createIpc(ipcMain: Pick<IpcMain, 'handle'>, options: IpcOptions): Ipc {
  return {
    handle(channel, schemas, fn) {
      ipcMain.handle(channel, async (event, ...raw: unknown[]) => {
        const senderUrl = event.senderFrame?.url ?? ''
        if (!options.isTrustedUrl(senderUrl)) {
          log.warn('[ipc] %s rechazado: emisor no confiable (%s)', channel, senderUrl.split('#')[0] || 'desconocido')
          throw new Error(userMessage(new OrvianError('FORBIDDEN', { channel })))
        }

        let parsed: unknown[]
        try {
          if (raw.length > schemas.length) throw new Error('demasiados argumentos')
          parsed = schemas.map((schema, index) => schema.parse(raw[index]))
        } catch (err) {
          const issue = err instanceof z.ZodError ? (err.issues[0]?.message ?? 'argumento no válido') : (err as Error).message
          log.warn('[ipc] %s: argumentos no válidos (%s)', channel, issue)
          throw new Error(userMessage(new OrvianError('INVALID_ARGUMENT', { channel, issue })))
        }

        try {
          return await fn(event, ...(parsed as Args<typeof schemas>))
        } catch (err) {
          log.error('[ipc] %s falló: %s', channel, err instanceof Error ? (err.stack ?? err.message) : String(err))
          throw err instanceof OrvianError ? new Error(userMessage(err)) : err
        }
      })
    }
  }
}
