/**
 * Path rules for modpack archives exported from Prism Launcher or Modrinth. The same rules are
 * needed when publishing (to build the manifest), when reading the manifest, and when syncing
 * (to find each file inside the archive), so they live in one place.
 */

/** Folder inside the archive that holds the game files: `.minecraft/`, `overrides/`, or none. */
export function detectArchivePrefix(names: readonly string[]): string {
  const normalized = names.map((name) => name.replace(/\\/g, '/'))
  const dotMinecraft = normalized.find((name) => name.includes('.minecraft/'))
  if (dotMinecraft) return dotMinecraft.slice(0, dotMinecraft.indexOf('.minecraft/') + '.minecraft/'.length)
  return normalized.some((name) => name.startsWith('overrides/')) ? 'overrides/' : ''
}

/** Archive entry name -> path relative to the game directory. */
export function normalizeArchivePath(name: string, prefix: string): string {
  let rel = name.replace(/\\/g, '/')
  if (rel.includes('.minecraft/')) rel = rel.slice(rel.indexOf('.minecraft/') + '.minecraft/'.length)
  else if (rel.startsWith('minecraft/')) rel = rel.slice('minecraft/'.length)
  else if (prefix && rel.startsWith(prefix)) rel = rel.slice(prefix.length)
  return rel.replace(/^\/+/, '')
}

/** Lookup table from a manifest path to the archive entry holding it (exact and case-insensitive). */
export function indexArchiveEntries<T extends { fileName: string }>(entries: readonly T[]): Map<string, T> {
  const prefix = detectArchivePrefix(entries.map((e) => e.fileName))
  const index = new Map<string, T>()
  for (const entry of entries) {
    if (entry.fileName.endsWith('/')) continue
    const rel = normalizeArchivePath(entry.fileName, prefix)
    if (!rel) continue
    index.set(rel, entry)
    index.set(rel.toLowerCase(), entry)
  }
  return index
}
