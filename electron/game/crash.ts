import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'

export interface ExitInfo {
  code: number | null
  signal: string | null
  crashReport: string
  crashReportLocation: string
  /** True when the launcher itself ended the process (quit, force close). */
  killedByLauncher: boolean
}

export type ExitResult =
  | { kind: 'clean' }
  | { kind: 'crash'; exitCode: number | null; summary: string; reportPath?: string }

const MAX_SUMMARY = 220

/** One readable line from a Minecraft crash report: what the game says happened, and the exception. */
export function summarizeCrashReport(report: string): string {
  const lines = report.split(/\r?\n/)
  const descIndex = lines.findIndex((line) => line.startsWith('Description:'))
  const description = descIndex >= 0 ? lines[descIndex].slice('Description:'.length).trim() : ''
  const exception = lines.slice(descIndex + 1).find((line) => /^[\w.$]+(Exception|Error)\b/.test(line.trim()))?.trim() ?? ''
  const text = [description, exception].filter(Boolean).join(': ')
  return text.length > MAX_SUMMARY ? `${text.slice(0, MAX_SUMMARY - 1)}…` : text
}

/**
 * Newest crash report or JVM fatal-error log written after `since`, if any.
 * Minecraft writes `crash-reports/crash-*.txt`; a JVM crash leaves `hs_err_pid*.log` in the game folder.
 */
export async function findNewCrashReport(gameDir: string, since: number): Promise<string | undefined> {
  const candidates: Array<{ path: string; mtime: number }> = []
  const scan = async (dir: string, pattern: RegExp): Promise<void> => {
    for (const name of await readdir(dir).catch(() => [] as string[])) {
      if (!pattern.test(name)) continue
      const path = join(dir, name)
      const info = await stat(path).catch(() => null)
      if (info?.isFile() && info.mtimeMs >= since) candidates.push({ path, mtime: info.mtimeMs })
    }
  }
  await scan(join(gameDir, 'crash-reports'), /^crash-.*\.txt$/)
  await scan(gameDir, /^hs_err_pid\d+\.log$/)
  return candidates.sort((a, b) => b.mtime - a.mtime)[0]?.path
}

export function analyzeExit(info: ExitInfo, newReportPath?: string): ExitResult {
  if (info.killedByLauncher) return { kind: 'clean' }
  const crashed = (info.code !== null && info.code !== 0) || (info.code === null && info.signal !== null)
  if (!crashed) return { kind: 'clean' }

  const reportPath = info.crashReportLocation || newReportPath || undefined
  const summary =
    summarizeCrashReport(info.crashReport) ||
    (info.code !== null ? `El juego terminó con el código ${info.code}.` : `El juego fue interrumpido (${info.signal}).`)
  return { kind: 'crash', exitCode: info.code, summary, reportPath }
}
