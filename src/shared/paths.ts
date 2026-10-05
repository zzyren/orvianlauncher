import { isAbsolute, relative, resolve } from 'node:path'

/** True when `target` resolves to a location strictly inside `root` (never `root` itself). */
export function isInside(root: string, target: string): boolean {
  const rel = relative(resolve(root), resolve(target))
  return rel !== '' && rel !== '..' && !rel.startsWith('..\\') && !rel.startsWith('../') && !isAbsolute(rel)
}

/** Throws unless `target` is strictly inside `root`; returns the resolved target. */
export function assertInside(root: string, target: string): string {
  if (!isInside(root, target)) throw new Error('La ruta queda fuera de la carpeta permitida.')
  return resolve(target)
}

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i

/**
 * Accepts only a plain file name with the given extension: no separators, drive or stream
 * markers, control characters, leading/trailing dots or spaces, and no Windows device names.
 */
export function isSafeFileName(name: unknown, extensions: readonly string[]): name is string {
  if (typeof name !== 'string' || name.length === 0 || name.length > 200) return false
  if (!/^[\p{L}\p{N} ._+()[\],'!&@#=~-]+$/u.test(name)) return false
  if (name.startsWith('.') || name.startsWith(' ') || name.endsWith(' ') || name.endsWith('.') || name.includes('..')) return false
  const lower = name.toLowerCase()
  const extension = extensions.find((ext) => lower.endsWith(ext))
  if (!extension) return false
  const stem = name.slice(0, name.length - extension.length)
  return stem.length > 0 && !WINDOWS_RESERVED.test(stem.split('.')[0])
}
