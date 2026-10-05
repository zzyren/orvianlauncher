import { closeSync, existsSync, mkdirSync, openSync, renameSync, statSync, unlinkSync, writeSync } from 'node:fs'
import { join } from 'node:path'
import { format } from 'node:util'
import { redactSecrets } from '../src/shared/redact'

export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'silent'

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 }

export interface Logger {
  debug(message: string, ...args: unknown[]): void
  info(message: string, ...args: unknown[]): void
  warn(message: string, ...args: unknown[]): void
  error(message: string, ...args: unknown[]): void
}

/**
 * Append-only file with size-based rotation (name.log, name.1.log, ...).
 * Writes are synchronous: volume is low, and ordering must survive a crash.
 * Logging never throws; losing a line is better than breaking the launcher.
 */
export class RotatingFile {
  private fd: number | null = null
  private size = 0

  constructor(
    private readonly dir: string,
    private readonly name: string,
    private readonly maxBytes: number,
    private readonly maxFiles: number
  ) {}

  private path(index: number): string {
    return join(this.dir, index === 0 ? `${this.name}.log` : `${this.name}.${index}.log`)
  }

  private open(): void {
    mkdirSync(this.dir, { recursive: true })
    this.fd = openSync(this.path(0), 'a')
    this.size = statSync(this.path(0)).size
  }

  private rotate(): void {
    if (this.fd !== null) closeSync(this.fd)
    this.fd = null
    const oldest = this.path(this.maxFiles - 1)
    if (existsSync(oldest)) unlinkSync(oldest)
    for (let i = this.maxFiles - 2; i >= 0; i--) {
      if (existsSync(this.path(i))) renameSync(this.path(i), this.path(i + 1))
    }
    this.open()
  }

  /** Begins a new file for a new session: the previous one becomes `name.1.log`. */
  startFresh(): void {
    try {
      if (this.fd === null) this.open()
      if (this.size > 0) this.rotate()
    } catch {
      this.fd = null
    }
  }

  write(text: string): void {
    try {
      if (this.fd === null) this.open()
      const bytes = Buffer.byteLength(text)
      if (this.size > 0 && this.size + bytes > this.maxBytes) this.rotate()
      writeSync(this.fd as number, text)
      this.size += bytes
    } catch {
      this.fd = null
    }
  }

  close(): void {
    try {
      if (this.fd !== null) closeSync(this.fd)
    } catch {
      // Nothing useful to do if closing a log file fails.
    }
    this.fd = null
  }
}

export interface LoggerOptions {
  /** Directory for log files; without it the logger only writes to the console. */
  dir?: string
  name?: string
  maxBytes?: number
  maxFiles?: number
  level?: LogLevel
  mirrorConsole?: boolean
  now?: () => Date
}

export function createLogger(options: LoggerOptions = {}): Logger & { close(): void } {
  const level = options.level ?? 'info'
  const now = options.now ?? (() => new Date())
  const file = options.dir
    ? new RotatingFile(options.dir, options.name ?? 'launcher', options.maxBytes ?? 2 * 1024 * 1024, options.maxFiles ?? 5)
    : null
  const mirror = options.mirrorConsole ?? !file

  const emit = (lvl: Exclude<LogLevel, 'silent'>, message: string, args: unknown[]): void => {
    if (ORDER[lvl] < ORDER[level]) return
    const line = redactSecrets(format(message, ...args))
    file?.write(`${now().toISOString()} ${lvl.toUpperCase().padEnd(5)} ${line}\n`)
    if (mirror) {
      const sink = lvl === 'error' ? console.error : lvl === 'warn' ? console.warn : console.log
      sink(`[${lvl}] ${line}`)
    }
  }

  return {
    debug: (m, ...a) => emit('debug', m, a),
    info: (m, ...a) => emit('info', m, a),
    warn: (m, ...a) => emit('warn', m, a),
    error: (m, ...a) => emit('error', m, a),
    close: () => file?.close()
  }
}

let active: Logger & { close(): void } = createLogger({ level: 'debug' })

/** Stable handle used across the main process; backed by whichever logger is initialised. */
export const log: Logger = {
  debug: (m, ...a) => active.debug(m, ...a),
  info: (m, ...a) => active.info(m, ...a),
  warn: (m, ...a) => active.warn(m, ...a),
  error: (m, ...a) => active.error(m, ...a)
}

export function initLogger(options: LoggerOptions): void {
  active.close()
  active = createLogger(options)
}
