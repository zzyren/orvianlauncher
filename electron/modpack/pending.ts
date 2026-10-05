import { copyFile, mkdir, readdir, rename, rm } from 'node:fs/promises'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { compareVersions, safePackPath } from '../../src/shared/manifest'

/**
 * Config files the player edited are never overwritten by an update; the pack's new default is
 * left in `.orvian/pending-config/<version>/…` instead. These helpers list and apply them.
 */

export interface PendingConfigs {
  /** Paths relative to the game folder, without duplicates. */
  files: string[]
}

const pendingRoot = (instance: string): string => join(instance, '.orvian', 'pending-config')

async function walk(dir: string, base = dir): Promise<string[]> {
  const out: string[] = []
  for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...(await walk(full, base)))
    else if (entry.isFile()) out.push(relative(base, full).split(sep).join('/'))
  }
  return out
}

async function versionDirs(instance: string): Promise<string[]> {
  const entries = await readdir(pendingRoot(instance), { withFileTypes: true }).catch(() => [])
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort((a, b) => compareVersions(a, b))
}

export async function listPendingConfigs(instance: string): Promise<PendingConfigs> {
  const files = new Set<string>()
  for (const version of await versionDirs(instance)) {
    for (const path of await walk(join(pendingRoot(instance), version))) if (safePackPath(path)) files.add(path)
  }
  return { files: [...files].sort() }
}

/** Replaces the player's files with the pack defaults, oldest version first so the newest wins. */
export async function restorePendingConfigs(instance: string): Promise<{ restored: number }> {
  const root = resolve(instance)
  const restored = new Set<string>()
  for (const version of await versionDirs(instance)) {
    const base = join(pendingRoot(instance), version)
    for (const path of await walk(base)) {
      if (!safePackPath(path)) continue
      const target = resolve(root, ...path.split('/'))
      if (!target.startsWith(root + sep)) continue
      await mkdir(dirname(target), { recursive: true })
      const temp = `${target}.orvian-tmp`
      await copyFile(join(base, ...path.split('/')), temp)
      await rename(temp, target)
      restored.add(path)
    }
  }
  await rm(pendingRoot(instance), { recursive: true, force: true })
  return { restored: restored.size }
}

/** The player keeps their own files and no longer wants to be reminded. */
export async function discardPendingConfigs(instance: string): Promise<void> {
  await rm(pendingRoot(instance), { recursive: true, force: true })
}
