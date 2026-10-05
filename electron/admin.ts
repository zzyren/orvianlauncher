import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { dialog, BrowserWindow, safeStorage } from 'electron'
import { z } from 'zod'
import { OrvianError } from '../src/shared/errors'
import { compareVersions, type OrvianManifest } from '../src/shared/manifest'
import { getConfig, isAdminUuid } from './config'
import type { Ipc } from './ipc'
import { log } from './logger'
import { fetchJson } from './net'
import type { SecretBox } from './secretBox'
import { buildManifestFromPrismZip, publishReleaseToGitHub } from './publisher'

const TOKEN_PATTERN = /^(ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})$/

export type { SecretBox }

export function isPlausibleGithubToken(value: string): boolean {
  return TOKEN_PATTERN.test(value)
}

/**
 * Keeps the GitHub publishing token encrypted at rest and inside the main process only:
 * the renderer can set, clear and ask whether one exists, but can never read it back.
 */
export class AdminTokenStore {
  constructor(
    private readonly file: string,
    private readonly box: SecretBox
  ) {}

  canEncrypt(): boolean {
    return this.box.isEncryptionAvailable()
  }

  async hasToken(): Promise<boolean> {
    return (await this.get()) !== null
  }

  async get(): Promise<string | null> {
    try {
      const encrypted = Buffer.from(await readFile(this.file, 'utf8'), 'base64')
      return this.box.decryptString(encrypted)
    } catch {
      return null
    }
  }

  async set(token: string): Promise<void> {
    if (!this.canEncrypt()) {
      throw new Error('Este equipo no permite guardar secretos de forma segura; el token no se ha guardado.')
    }
    await mkdir(dirname(this.file), { recursive: true })
    await writeFile(this.file, this.box.encryptString(token).toString('base64'), 'utf8')
  }

  async clear(): Promise<void> {
    await rm(this.file, { force: true })
  }
}

export interface VerifyResult {
  /** `true` confirmed push access, `false` GitHub said no, `null` could not be checked (offline). */
  verified: boolean | null
  reason?: string
}

/** Confirms the token can push to the pack repository, without ever logging it. */
export async function verifyGithubToken(token: string, repo: string): Promise<VerifyResult> {
  try {
    const info = await fetchJson<{ permissions?: { push?: boolean } }>(`https://api.github.com/repos/${repo}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' }
    })
    return info.permissions?.push ? { verified: true } : { verified: false, reason: `El token no tiene permiso de escritura sobre ${repo}.` }
  } catch (err) {
    if (err instanceof OrvianError && err.details.status && [401, 403, 404].includes(Number(err.details.status))) {
      return { verified: false, reason: `El token no es válido o no tiene acceso a ${repo}.` }
    }
    return { verified: null }
  }
}

export interface AdminDeps {
  dataRoot: string
  getAccount: () => Promise<{ uuid: string } | null>
  emitProgress: (state: string, progress: number, detail: string) => void
  getLatestVersion: () => string | null
  onPublished: (manifest: OrvianManifest, version: string) => void
}

const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/

export function registerAdminIpc(ipc: Ipc, deps: AdminDeps): AdminTokenStore {
  const tokens = new AdminTokenStore(join(deps.dataRoot, 'launcher', 'admin.json'), safeStorage)
  /** The file the admin picked, referenced by an opaque id so the renderer never supplies a path. */
  let selection: { id: string; path: string } | null = null

  async function requireAdmin(): Promise<void> {
    const account = await deps.getAccount()
    if (!account || !isAdminUuid(account.uuid)) throw new OrvianError('FORBIDDEN', { reason: 'not-admin' })
  }

  ipc.handle('admin:token-status', [], async () => {
    await requireAdmin()
    return { hasToken: await tokens.hasToken(), canEncrypt: tokens.canEncrypt() }
  })

  ipc.handle('admin:token-set', [z.string().max(512)], async (_event, raw) => {
    await requireAdmin()
    const token = raw.trim()
    if (!isPlausibleGithubToken(token)) {
      throw new Error('El token no tiene un formato válido. Debe empezar por github_pat_ o ghp_.')
    }
    const check = await verifyGithubToken(token, getConfig().packRepo)
    if (check.verified === false) throw new Error(check.reason)
    await tokens.set(token)
    log.info('[Admin] Token de publicación guardado (verificado: %s)', check.verified === null ? 'no se pudo comprobar' : 'sí')
    return { ok: true, verified: check.verified === true }
  })

  ipc.handle('admin:token-clear', [], async () => {
    await requireAdmin()
    await tokens.clear()
    return { ok: true }
  })

  ipc.handle('admin:pick-archive', [], async (event) => {
    await requireAdmin()
    const win = BrowserWindow.fromWebContents(event.sender) ?? BrowserWindow.getFocusedWindow()
    const options: Electron.OpenDialogOptions = {
      title: 'Seleccionar modpack exportado de Prism Launcher (.zip)',
      filters: [
        { name: 'Prism Launcher / Minecraft ZIP', extensions: ['zip', 'mrpack'] },
        { name: 'Todos los archivos', extensions: ['*'] }
      ],
      properties: ['openFile']
    }
    const result = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options)
    if (result.canceled || result.filePaths.length === 0) return { canceled: true, selectionId: null, fileName: null, size: 0 }
    const path = result.filePaths[0]
    selection = { id: randomUUID(), path }
    const info = await stat(path)
    return { canceled: false, selectionId: selection.id, fileName: path.split(/[\\/]/).pop() ?? path, size: info.size }
  })

  ipc.handle(
    'admin:publish',
    [
      z.object({
        selectionId: z.string().uuid(),
        version: z.string().regex(VERSION_PATTERN, 'Versión no válida (usa 1.2.3 o 1.2.3-beta.1)'),
        changelog: z.string().max(10_000),
        overwrite: z.boolean().optional()
      })
    ],
    async (_event, params) => {
      await requireAdmin()
      if (!selection || selection.id !== params.selectionId) throw new Error('Vuelve a seleccionar el archivo del modpack.')
      const token = await tokens.get()
      if (!token) throw new Error('Guarda primero un token de GitHub para poder publicar.')

      const latest = deps.getLatestVersion()
      if (!params.overwrite && latest && compareVersions(params.version, latest) <= 0) {
        throw new Error(`La versión ${params.version} debe ser posterior a la publicada (${latest}).`)
      }

      const repo = getConfig().packRepo
      deps.emitProgress('publishing', 0.1, 'Leyendo archivo ZIP de Prism Launcher...')
      const zipBuffer = await readFile(selection.path)
      const changelogLines = params.changelog.split('\n').map((l) => l.trim()).filter(Boolean)

      deps.emitProgress('publishing', 0.3, 'Generando manifiesto de Orvian...')
      const { manifest } = await buildManifestFromPrismZip(zipBuffer, params.version, changelogLines, repo, (detail, p) =>
        deps.emitProgress('publishing', p ?? 0.4, detail)
      )

      deps.emitProgress('publishing', 0.6, 'Publicando release en GitHub...')
      const result = await publishReleaseToGitHub({
        token,
        repo,
        version: params.version,
        changelog: params.changelog,
        manifest,
        zipBuffer,
        onProgress: (detail, p) => deps.emitProgress('publishing', p ?? 0.8, detail)
      })

      deps.onPublished(manifest, params.version)
      log.info('[Admin] Versión %s publicada', params.version)
      return { ok: true, releaseUrl: result.releaseUrl, message: `Versión ${params.version} publicada en GitHub.` }
    }
  )

  return tokens
}
