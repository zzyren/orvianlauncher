import { randomUUID } from 'node:crypto'
import { readdir, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { open, readAllEntries, readEntry } from '@xmcl/unzip'
import { OrvianError } from '../../src/shared/errors'
import { indexArchiveEntries } from '../../src/shared/archive'
import { planUpdate, synchronizeOfficialFiles, type SyncResult } from '../../src/shared/integrity'
import type { OrvianManifest, PackFile } from '../../src/shared/manifest'
import { getConfig } from '../config'
import type { StepUpdate } from '../game/progress'
import { log } from '../logger'
import { download } from '../net'

type ZipFile = Awaited<ReturnType<typeof open>>
type Entry = Awaited<ReturnType<typeof readAllEntries>>[number]

export interface SyncParams {
  instanceDir: string
  manifest: OrvianManifest
  /** Re-hash every file instead of trusting the state recorded by the last install ("repair"). */
  fullVerify: boolean
  onProgress: (update: StepUpdate) => void
}

/** Folders where an interrupted run can leave `.orvian-tmp` files behind. */
const TEMP_SWEEP_DIRS = ['mods', 'config', 'defaultconfigs', 'shaderpacks', 'resourcepacks']

/**
 * Where the pack's archive can be downloaded. A manifest that names it (`archive`) is authoritative;
 * manifests published before that field existed point every file at `<release>/modpack.zip`, whose
 * tag was written with or without a leading "v", so both are tried.
 */
export function archiveCandidates(manifest: OrvianManifest, repo: string): string[] {
  if (manifest.archive) return [manifest.archive.url]
  const version = manifest.pack.version
  const bare = version.startsWith('v') ? version.slice(1) : version
  return [`https://github.com/${repo}/releases/download/v${bare}/modpack.zip`, `https://github.com/${repo}/releases/download/${bare}/modpack.zip`]
}

async function sweepLeftovers(instanceDir: string, keepArchive: string): Promise<void> {
  for (const dir of TEMP_SWEEP_DIRS) {
    const entries = await readdir(join(instanceDir, dir), { recursive: true }).catch(() => [] as string[])
    for (const rel of entries) {
      if (rel.endsWith('.orvian-tmp')) await rm(join(instanceDir, dir, rel), { force: true }).catch(() => undefined)
    }
  }
  const cacheDir = join(instanceDir, '.orvian', 'cache')
  for (const name of await readdir(cacheDir).catch(() => [] as string[])) {
    if (name.endsWith('.part') || (name.startsWith('modpack-') && name.endsWith('.zip') && name !== keepArchive) || name === 'direct') {
      await rm(join(cacheDir, name), { recursive: true, force: true }).catch(() => undefined)
    }
  }
}

function isStatus(err: unknown, status: number): boolean {
  return err instanceof OrvianError && err.code === 'DOWNLOAD_FAILED' && err.details.status === status
}

export async function syncModpack(params: SyncParams): Promise<SyncResult> {
  const { instanceDir, manifest, fullVerify, onProgress } = params
  const version = manifest.pack.version
  const cacheDir = join(instanceDir, '.orvian', 'cache')
  const archiveName = `modpack-${version}.zip`
  const archivePath = join(cacheDir, archiveName)
  const candidates = archiveCandidates(manifest, getConfig().packRepo)

  onProgress({ detail: 'Verificando archivos del modpack...' })
  await sweepLeftovers(instanceDir, archiveName)

  const expected = fullVerify ? undefined : await planUpdate(instanceDir, manifest.files)
  const total = expected ? expected.install + expected.replace : undefined
  let fetched = 0

  let opened: { zip: ZipFile; index: Map<string, Entry> } | null = null
  let opening: Promise<{ zip: ZipFile; index: Map<string, Entry> }> | null = null

  /** Downloads (once) and opens the archive; every file that lives inside it is read from there. */
  const openArchive = (): Promise<{ zip: ZipFile; index: Map<string, Entry> }> => {
    opening ??= (async () => {
      onProgress({ detail: `Descargando modpack v${version}...` })
      let lastError: unknown
      let downloaded = false
      for (const url of candidates) {
        try {
          await download(url, archivePath, {
            sha256: manifest.archive?.sha256,
            size: manifest.archive?.size,
            idleTimeoutMs: 60_000,
            onProgress: ({ bytesDone, bytesTotal }) => onProgress({ bytesDone, bytesTotal, detail: `Descargando modpack v${version}...` })
          })
          downloaded = true
          break
        } catch (err) {
          lastError = err
          if (!isStatus(err, 404)) throw err
        }
      }
      if (!downloaded) throw new OrvianError('PACK_ARCHIVE_MISSING', { v: version }, { cause: lastError, message: `No existe modpack.zip para la versión ${version}` })

      onProgress({ detail: 'Abriendo modpack.zip...' })
      let zip: ZipFile | undefined
      try {
        zip = await open(archivePath)
        const entries = await readAllEntries(zip)
        return (opened = { zip, index: indexArchiveEntries(entries) })
      } catch (err) {
        zip?.close()
        await rm(archivePath, { force: true }).catch(() => undefined)
        throw new OrvianError('DOWNLOAD_FAILED', { file: 'modpack.zip', reason: 'bad-archive' }, { cause: err, message: 'El modpack.zip descargado no es un ZIP válido.' })
      }
    })()
    return opening
  }

  const fetchBytes = async (file: PackFile): Promise<Uint8Array> => {
    let bytes: Uint8Array
    if (candidates.includes(file.url)) {
      const { zip, index } = await openArchive()
      const entry = index.get(file.path) ?? index.get(file.path.toLowerCase())
      if (!entry) throw new OrvianError('MANIFEST_INVALID', { file: file.path }, { message: `El archivo ${file.path} no se encuentra en el modpack.zip.` })
      bytes = new Uint8Array(await readEntry(zip, entry))
    } else {
      // A file hosted on its own URL (e.g. a mod CDN): verified while it downloads, then handed on.
      const temp = join(cacheDir, 'direct', randomUUID())
      try {
        await download(file.url, temp, { sha256: file.sha256, size: file.size })
        bytes = new Uint8Array(await readFile(temp))
      } finally {
        await rm(temp, { force: true }).catch(() => undefined)
      }
    }
    fetched++
    onProgress({ detail: `Sincronizando archivos del modpack... (${fetched}${total ? `/${total}` : ''})`, current: fetched, total })
    return bytes
  }

  try {
    const result = await synchronizeOfficialFiles(instanceDir, version, manifest.files, fetchBytes, { forceVerify: fullVerify })
    // The next sync should not find a stale archive from this version lying around.
    await rm(archivePath, { force: true }).catch(() => undefined)
    log.info('[Modpack] v%s sincronizado: %d instalados, %d reemplazados, %d sin cambios, %d de confianza, %d configs conservadas', version, result.installed, result.replaced, result.unchanged, result.trustedFromState, result.preservedConfigs)
    return result
  } finally {
    ;(opened as { zip: ZipFile } | null)?.zip.close()
    await rm(join(cacheDir, 'direct'), { recursive: true, force: true }).catch(() => undefined)
  }
}
