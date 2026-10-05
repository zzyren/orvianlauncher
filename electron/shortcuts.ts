import { existsSync, readdirSync, unlinkSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { app, shell } from 'electron'
import { log } from './logger'

const SHORTCUT_NAME = 'Orvian Launcher.lnk'
const APP_USER_MODEL_ID = 'com.orvian.launcher'

function sameFile(a: string, b: string): boolean {
  return resolve(a).toLowerCase() === resolve(b).toLowerCase()
}

function insideDir(file: string, dir: string): boolean {
  return resolve(file).toLowerCase().startsWith(resolve(dir).toLowerCase() + '\\')
}

/** Shortcuts that point into this installation but carry the wrong name (e.g. "Electron.lnk"). */
function removeMisnamedShortcuts(folder: string, installDir: string): void {
  if (!existsSync(folder)) return
  for (const entry of readdirSync(folder)) {
    if (!entry.toLowerCase().endsWith('.lnk') || entry.toLowerCase() === SHORTCUT_NAME.toLowerCase()) continue
    const path = join(folder, entry)
    try {
      const { target } = shell.readShortcutLink(path)
      if (target && (insideDir(target, installDir) || sameFile(target, process.execPath))) {
        unlinkSync(path)
        log.info('[Shortcuts] Acceso directo antiguo eliminado: %s', entry)
      }
    } catch {
      // Unreadable or not ours: leave it alone
    }
  }
}

/**
 * Makes sure the Start Menu has "Orvian Launcher" and nothing named after the Electron binary.
 * Runs on every start of an installed build, so installations created by older versions repair themselves.
 */
export function repairShortcuts(): void {
  if (process.platform !== 'win32') return
  try {
    const installDir = dirname(process.execPath)
    const startMenu = join(app.getPath('appData'), 'Microsoft', 'Windows', 'Start Menu', 'Programs')
    removeMisnamedShortcuts(startMenu, installDir)
    removeMisnamedShortcuts(app.getPath('desktop'), installDir)

    const link = join(startMenu, SHORTCUT_NAME)
    const options = {
      target: process.execPath,
      cwd: installDir,
      icon: process.execPath,
      iconIndex: 0,
      description: 'Orvian Launcher',
      appUserModelId: APP_USER_MODEL_ID
    }
    let operation: 'create' | 'replace' | null = 'create'
    if (existsSync(link)) {
      try {
        const current = shell.readShortcutLink(link)
        const upToDate = sameFile(current.target, process.execPath) && current.appUserModelId === APP_USER_MODEL_ID
        operation = upToDate ? null : 'replace'
      } catch {
        operation = 'replace'
      }
    }
    if (operation && !shell.writeShortcutLink(link, operation, options)) {
      log.warn('[Shortcuts] No se pudo escribir %s', basename(link))
    }
  } catch (err) {
    log.warn('[Shortcuts] Reparación de accesos directos fallida (no crítico): %s', String(err))
  }
}
