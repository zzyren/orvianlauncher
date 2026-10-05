import { readFile } from 'node:fs/promises'
import { redactSecrets } from '../src/shared/redact'

/** Text a player can paste into a support request: enough to diagnose, nothing private. */

export interface DiagnosticsInput {
  appVersion: string
  phase: string
  packInstalled: string | null
  packLatest: string | null
  platform: string
  arch: string
  electron: string
  error?: { code: string; title: string; technical?: string }
  logLines: string[]
  now?: Date
}

/** Windows and macOS/Linux home folders contain the player's account name; keep the structure, drop the name. */
export function anonymizePaths(text: string): string {
  return text.replace(/([A-Za-z]:[\\/]+Users[\\/]+|\/Users\/|\/home\/)([^\\/\s"')\]]+)/gi, '$1<usuario>')
}

export function buildDiagnostics(input: DiagnosticsInput): string {
  const lines = [
    `Orvian Launcher ${input.appVersion}`,
    `Fecha: ${(input.now ?? new Date()).toISOString()}`,
    `Estado: ${input.phase}`,
    `Modpack instalado: ${input.packInstalled ?? 'ninguno'} · publicado: ${input.packLatest ?? 'desconocido'}`,
    `Sistema: ${input.platform} ${input.arch} · Electron ${input.electron}`
  ]
  if (input.error) {
    lines.push('', `Error: ${input.error.code} · ${input.error.title}`)
    if (input.error.technical) lines.push(input.error.technical)
  }
  lines.push('', `Últimas ${input.logLines.length} líneas del registro:`, ...input.logLines)
  return anonymizePaths(redactSecrets(lines.join('\n')))
}

/** The last `count` lines of a log file; empty when there is no file yet. */
export async function readLogTail(file: string, count = 50): Promise<string[]> {
  try {
    const lines = (await readFile(file, 'utf8')).split(/\r?\n/).filter(Boolean)
    return lines.slice(-count)
  } catch {
    return []
  }
}
