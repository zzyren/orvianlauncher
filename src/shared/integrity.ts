import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { stat, rename, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { PackFile } from './manifest'
import { decideFileSync, safePackPath } from './manifest'
import { readFile } from 'node:fs/promises'

export async function sha256File(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    const stream = createReadStream(path)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('error', reject)
    stream.on('end', () => resolve(hash.digest('hex')))
  })
}

export async function verifyFile(path: string, expected: Pick<PackFile, 'size' | 'sha256'>): Promise<boolean> {
  try { const info = await stat(path); return info.isFile() && info.size === expected.size && (await sha256File(path)).toLowerCase() === expected.sha256.toLowerCase() } catch { return false }
}

export async function installVerifiedFile(root: string, file: PackFile, bytes: Uint8Array): Promise<void> {
  if (!safePackPath(file.path)) throw new Error('Ruta del manifiesto no permitida')
  if (bytes.byteLength !== file.size) throw new Error(`Tamaño incorrecto en ${file.path}`)
  const actual = createHash('sha256').update(bytes).digest('hex')
  if (actual.toLowerCase() !== file.sha256.toLowerCase()) throw new Error(`SHA-256 incorrecto en ${file.path}`)
  const target = join(root, ...file.path.split('/'))
  const temporary = `${target}.orvian-tmp`
  const { mkdir, writeFile } = await import('node:fs/promises')
  await mkdir(dirname(target), { recursive: true })
  try { await writeFile(temporary, bytes, { flag: 'w' }); await rename(temporary, target) } catch (error) { await rm(temporary, { force: true }); throw error }
}

type OfficialState = { version: string; files: Record<string, string> }

export type SyncResult = {
  installed: number
  replaced: number
  preservedConfigs: number
  stagedDefaults: number
  unchanged: number
  /** Archivos saltados por el fast-path de versión ya instalada (sin re-hash) */
  trustedFromState: number
}

export interface SyncOptions {
  /**
   * Cuando es true, fuerza la verificación SHA-256 completa de cada archivo
   * ignorando el fast-path basado en version match.
   * Usar en "Reparar instalación".
   */
  forceVerify?: boolean
}

/**
 * FAST-PATH (comportamiento normal, forceVerify=false):
 *   Si official-state.json ya registra la misma versión del manifiesto
 *   y el hash guardado coincide con el hash esperado del archivo,
 *   se realiza únicamente un stat() de existencia — SIN re-hashear.
 *   La instalación inicial ya verificó el SHA-256 con installVerifiedFile.
 *
 * FULL-VERIFY (forceVerify=true, o primer install, o versión diferente):
 *   Se ejecuta verifyFile() completo (size + SHA-256) sobre cada archivo.
 *   Si alguno falla, se descarga del ZIP del modpack.
 *
 * En ambos casos, los archivos de configuración modificados por el usuario
 * se preservan y la nueva versión upstream se escribe en .orvian/pending-config.
 */
export async function synchronizeOfficialFiles(
  root: string,
  version: string,
  files: PackFile[],
  fetchBytes: (file: PackFile) => Promise<Uint8Array>,
  opts?: SyncOptions,
): Promise<SyncResult> {
  const statePath = join(root, '.orvian', 'official-state.json')
  const state = await readJson<OfficialState>(statePath, { version: '', files: {} })
  const result: SyncResult = { installed: 0, replaced: 0, preservedConfigs: 0, stagedDefaults: 0, unchanged: 0, trustedFromState: 0 }
  const nextHashes = { ...state.files }

  const forceVerify = opts?.forceVerify ?? false

  // ── Fast-path guard: ¿la versión instalada coincide con la solicitada?
  // Si es así, podemos confiar en el state file para archivos que ya tienen
  // el hash correcto registrado, y solo hacer stat() en vez de sha256File().
  const versionMatch = !forceVerify && state.version === version && state.version !== ''

  for (const file of files) {
    if (!safePackPath(file.path)) throw new Error(`Ruta insegura en manifiesto: ${file.path}`)
    const target = join(root, ...file.path.split('/'))

    // ── FAST-PATH ────────────────────────────────────────────────────────────
    // Condición: versiones coinciden, el archivo está en el state con el hash
    // exacto que el manifiesto espera, y no se fuerza verificación completa.
    //
    // Racional: installVerifiedFile ya verificó size + SHA-256 al instalar.
    // Si nadie (ni el launcher ni el usuario) debe haber modificado archivos
    // de mods o recursos gestionados, podemos confiar en ese registro.
    //
    // Si el archivo NO existe en disco (borrado manualmente, etc.),
    // el fast-path falla y se cae al full-verify/download normal.
    if (versionMatch && state.files[file.path] === file.sha256) {
      const exists = await fileExists(target)
      if (exists) {
        result.trustedFromState++
        // nextHashes ya tiene el valor correcto desde { ...state.files }
        continue
      }
      // Archivo registrado en state pero no existe en disco → reinstalar
      // (cae al bloque de abajo)
    }

    // ── FULL-VERIFY ──────────────────────────────────────────────────────────
    const valid = await verifyFile(target, file)
    if (valid) { result.unchanged++; nextHashes[file.path] = file.sha256; continue }

    const localExists = await fileExists(target)
    const currentHash = localExists ? await sha256File(target) : undefined
    const decision = decideFileSync(file, { exists: localExists, currentHash, lastOfficialHash: state.files[file.path] })

    if (decision === 'keep-user-config') {
      result.preservedConfigs++
      continue
    }
    const bytes = await fetchBytes(file)
    if (decision === 'stage-new-default') {
      const stagedPath = `.orvian/pending-config/${version}/${file.path}`
      await installVerifiedFile(root, { ...file, path: stagedPath }, bytes)
      result.stagedDefaults++
      nextHashes[file.path] = file.sha256
      continue
    }
    await installVerifiedFile(root, file, bytes)
    if (decision === 'install') result.installed++
    else result.replaced++
    nextHashes[file.path] = file.sha256
  }

  // ── Eliminar archivos oficiales de versiones anteriores que ya no existen ──
  // Solo se limpian cuando la versión cambia, para no iterar en el caso normal.
  if (!versionMatch) {
    const incomingPaths = new Set(files.map((f) => f.path))
    for (const oldPath of Object.keys(state.files)) {
      if (!incomingPaths.has(oldPath)) {
        if (
          oldPath.startsWith('mods/') ||
          oldPath.startsWith('defaultconfigs/') ||
          oldPath.startsWith('shaderpacks/') ||
          oldPath.startsWith('resourcepacks/')
        ) {
          const oldTarget = join(root, ...oldPath.split('/'))
          await rm(oldTarget, { force: true }).catch(() => {})
          delete nextHashes[oldPath]
        }
      }
    }
  }

  await writeJsonAtomically(statePath, { version, files: nextHashes } satisfies OfficialState)
  return result
}

async function fileExists(path: string): Promise<boolean> {
  try { return (await stat(path)).isFile() } catch { return false }
}

async function readJson<T>(path: string, fallback: T): Promise<T> {
  try { return JSON.parse(await readFile(path, 'utf8')) as T } catch { return fallback }
}

async function writeJsonAtomically(path: string, value: unknown): Promise<void> {
  const { mkdir, writeFile } = await import('node:fs/promises')
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.tmp`
  try { await writeFile(temporary, JSON.stringify(value, null, 2), 'utf8'); await rename(temporary, path) }
  catch (error) { await rm(temporary, { force: true }); throw error }
}
