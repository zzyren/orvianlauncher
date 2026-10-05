import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { BrowserWindow, safeStorage, session, shell } from 'electron'
import { MicrosoftAuthenticator, MicrosoftMinecraftXboxLoginError } from '@xmcl/user'
import { z } from 'zod'
import { OrvianError, fromNodeError, type OrvianErrorCode } from '../src/shared/errors'
import { getConfig } from './config'
import { log } from './logger'
import { fetchWithTimeout } from './net'
import type { SecretBox } from './secretBox'

const REDIRECT_URI = 'https://login.live.com/oauth20_desktop.srf'
const TOKEN_URL = 'https://login.live.com/oauth20_token.srf'
const PROFILE_URL = 'https://api.minecraftservices.com/minecraft/profile'
const SCOPE = 'XboxLive.signin offline_access'
/** Renew the Minecraft token when less than this remains, so a long session never starts expired. */
const REFRESH_MARGIN_MS = 5 * 60_000

export interface AccountInfo {
  /** Minecraft access token; may be stale when `getValidSession` reports `stale`. */
  accessToken: string
  name: string
  uuid: string
  xuid?: string
  /** Epoch milliseconds at which `accessToken` stops being accepted. */
  expiresAt: number
}

const StoredSession = z.object({
  v: z.literal(2),
  msRefreshToken: z.string().min(1),
  accessToken: z.string().min(1),
  expiresAt: z.number(),
  name: z.string().min(1),
  uuid: z.string().min(1),
  xuid: z.string().optional()
})
type StoredSession = z.infer<typeof StoredSession>

/** Hosts a Microsoft sign-in page may legitimately navigate through. */
const AUTH_HOST_SUFFIXES = ['live.com', 'microsoftonline.com', 'microsoft.com', 'xboxlive.com', 'xbox.com', 'msauth.net', 'msftauth.net', 'office.com']

export function isMicrosoftAuthUrl(raw: string): boolean {
  try {
    const url = new URL(raw)
    if (url.protocol !== 'https:') return false
    const host = url.hostname.toLowerCase()
    return AUTH_HOST_SUFFIXES.some((suffix) => host === suffix || host.endsWith(`.${suffix}`))
  } catch {
    return false
  }
}

const XSTS_ERRORS: Record<number, OrvianErrorCode> = {
  2148916233: 'AUTH_NO_XBOX',
  2148916235: 'AUTH_REGION',
  2148916236: 'AUTH_REGION',
  2148916237: 'AUTH_REGION',
  2148916238: 'AUTH_CHILD'
}

/** Xbox Live signals account problems with an `XErr` code on the failed XSTS response. */
export function mapXstsError(err: unknown): OrvianError {
  const xerr = Number((err as { XErr?: unknown } | null)?.XErr)
  const code = XSTS_ERRORS[xerr]
  if (code) return new OrvianError(code, { xerr }, { cause: err, message: `XSTS XErr ${xerr}` })
  return fromNodeError(err)
}

export function mapMinecraftLoginError(err: unknown): OrvianError {
  if (err instanceof MicrosoftMinecraftXboxLoginError) {
    if (err.status === 401) return new OrvianError('AUTH_EXPIRED', {}, { cause: err, message: `login_with_xbox HTTP ${err.status}` })
    const hint = err.retryable ? ' Vuelve a intentarlo en unos minutos.' : ''
    return new OrvianError('UNKNOWN', { status: err.status }, { cause: err, message: `Minecraft rechazó el inicio de sesión (HTTP ${err.status}).${hint}` })
  }
  return fromNodeError(err)
}

export interface XboxAuthenticator {
  acquireXBoxToken: MicrosoftAuthenticator['acquireXBoxToken']
  loginMinecraftWithXBox: MicrosoftAuthenticator['loginMinecraftWithXBox']
}

export interface AuthDeps {
  box?: SecretBox
  authenticator?: XboxAuthenticator
  fetch?: (url: string, init?: RequestInit) => Promise<Response>
  now?: () => number
}

const SESSION_PARTITION = 'persist:microsoft-auth'

export class AuthService {
  private readonly accountFile: string
  private readonly box: SecretBox
  private readonly now: () => number
  private readonly http: (url: string, init?: RequestInit) => Promise<Response>
  private readonly authenticator: XboxAuthenticator
  /** Session kept in memory so a machine without secure storage still works until the app closes. */
  private memory: StoredSession | null = null
  /** Serialises session checks: a rotated refresh token must never be used twice. */
  private sessionQueue: Promise<unknown> = Promise.resolve()
  private loginWindow: BrowserWindow | null = null

  constructor(dataRoot: string, deps: AuthDeps = {}) {
    this.accountFile = join(dataRoot, 'launcher', 'auth.json')
    this.box = deps.box ?? safeStorage
    this.now = deps.now ?? Date.now
    this.http = deps.fetch ?? ((url, init) => fetchWithTimeout(url, init, 15_000))
    this.authenticator =
      deps.authenticator ??
      new MicrosoftAuthenticator({
        fetch: ((input: RequestInfo | URL, init?: RequestInit) =>
          this.http(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, init)) as typeof fetch
      })
  }

  // ─── Storage ───────────────────────────────────────────────────────────────

  private async readStored(): Promise<StoredSession | null> {
    if (this.memory) return this.memory
    if (!this.box.isEncryptionAvailable()) return null
    let raw: unknown
    try {
      raw = JSON.parse(this.box.decryptString(Buffer.from(await readFile(this.accountFile, 'utf8'), 'hex')))
    } catch {
      return null
    }
    const parsed = StoredSession.safeParse(raw)
    if (!parsed.success) {
      // Sessions saved by older launchers had no refresh token: a new sign-in is required once.
      log.info('[Auth] Sesión guardada con un formato antiguo; hace falta iniciar sesión de nuevo.')
      return null
    }
    return (this.memory = parsed.data)
  }

  private async persist(session: StoredSession): Promise<void> {
    this.memory = session
    if (!this.box.isEncryptionAvailable()) {
      log.warn('[Auth] El almacenamiento seguro no está disponible: la sesión no se guardará en disco.')
      return
    }
    await mkdir(join(this.accountFile, '..'), { recursive: true })
    await writeFile(this.accountFile, this.box.encryptString(JSON.stringify(session)).toString('hex'), 'utf8')
  }

  private static toAccount(stored: StoredSession): AccountInfo {
    return { accessToken: stored.accessToken, name: stored.name, uuid: stored.uuid, xuid: stored.xuid, expiresAt: stored.expiresAt }
  }

  /** Who is signed in. Never touches the network and may carry an expired access token. */
  async loadAccount(): Promise<AccountInfo | null> {
    const stored = await this.readStored()
    return stored ? AuthService.toAccount(stored) : null
  }

  async logout(): Promise<void> {
    this.memory = null
    await rm(this.accountFile, { force: true }).catch(() => undefined)
    try {
      await session.fromPartition(SESSION_PARTITION).clearStorageData()
    } catch (err) {
      log.warn('[Auth] No se pudo limpiar la sesión de Microsoft: %s', String(err))
    }
  }

  // ─── Microsoft / Xbox / Minecraft exchange ─────────────────────────────────

  private async requestTokens(params: Record<string, string>, purpose: 'login' | 'refresh'): Promise<{ accessToken: string; refreshToken?: string }> {
    const res = await this.http(TOKEN_URL, {
      method: 'POST',
      body: new URLSearchParams({ client_id: getConfig().msClientId, redirect_uri: REDIRECT_URI, scope: SCOPE, ...params }),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
    })
    const data = (await res.json().catch(() => ({}))) as { access_token?: string; refresh_token?: string; error?: string }
    if (!res.ok || !data.access_token) {
      if (purpose === 'refresh' && (data.error === 'invalid_grant' || res.status === 400 || res.status === 401)) {
        throw new OrvianError('AUTH_EXPIRED', { error: data.error }, { message: `Refresh rechazado (${data.error ?? res.status})` })
      }
      throw new OrvianError('UNKNOWN', { status: res.status }, { message: `No se pudo completar el inicio de sesión con Microsoft (${data.error ?? `HTTP ${res.status}`}).` })
    }
    return { accessToken: data.access_token, refreshToken: data.refresh_token }
  }

  private async minecraftLogin(msAccessToken: string): Promise<{ accessToken: string; expiresAt: number; xuid?: string }> {
    let xbox: Awaited<ReturnType<XboxAuthenticator['acquireXBoxToken']>>
    try {
      xbox = await this.authenticator.acquireXBoxToken(msAccessToken)
    } catch (err) {
      throw mapXstsError(err)
    }
    const claim = xbox.minecraftXstsResponse.DisplayClaims?.xui?.[0]
    if (!claim?.uhs) throw new OrvianError('UNKNOWN', {}, { message: 'Xbox no devolvió los datos de usuario necesarios.' })

    let mc: Awaited<ReturnType<XboxAuthenticator['loginMinecraftWithXBox']>>
    try {
      mc = await this.authenticator.loginMinecraftWithXBox(claim.uhs, xbox.minecraftXstsResponse.Token)
    } catch (err) {
      throw mapMinecraftLoginError(err)
    }
    const xuid = xbox.liveXstsResponse?.DisplayClaims?.xui?.[0]?.xid ?? claim.xid
    return { accessToken: mc.access_token, expiresAt: this.now() + mc.expires_in * 1000, xuid }
  }

  private async fetchProfile(mcAccessToken: string): Promise<{ id: string; name: string }> {
    const res = await this.http(PROFILE_URL, { headers: { Authorization: `Bearer ${mcAccessToken}` } })
    if (res.status === 404) throw new OrvianError('AUTH_NO_GAME')
    if (res.status === 401) throw new OrvianError('AUTH_EXPIRED')
    if (!res.ok) throw new OrvianError('UNKNOWN', { status: res.status }, { message: `No se pudo obtener el perfil de Minecraft (HTTP ${res.status}).` })
    const profile = (await res.json().catch(() => null)) as { id?: unknown; name?: unknown } | null
    if (typeof profile?.id !== 'string' || typeof profile.name !== 'string') {
      throw new OrvianError('UNKNOWN', {}, { message: 'El perfil de Minecraft devuelto no es válido.' })
    }
    return { id: profile.id, name: profile.name }
  }

  private async refresh(stored: StoredSession): Promise<StoredSession> {
    const tokens = await this.requestTokens({ grant_type: 'refresh_token', refresh_token: stored.msRefreshToken }, 'refresh')
    const mc = await this.minecraftLogin(tokens.accessToken)
    let { name, uuid } = stored
    try {
      ;({ name, id: uuid } = await this.fetchProfile(mc.accessToken))
    } catch (err) {
      if (err instanceof OrvianError && err.code === 'AUTH_NO_GAME') throw err
      log.warn('[Auth] No se pudo actualizar el perfil; se conserva el anterior.')
    }
    return { v: 2, msRefreshToken: tokens.refreshToken ?? stored.msRefreshToken, accessToken: mc.accessToken, expiresAt: mc.expiresAt, name, uuid, xuid: mc.xuid ?? stored.xuid }
  }

  /**
   * Returns a session whose Minecraft token is valid for at least a few minutes, renewing it
   * silently when needed. If the network is down the stored token is returned as `stale` so the
   * game can still start (single player works); a rejected refresh signs the user out.
   */
  getValidSession(): Promise<{ account: AccountInfo; stale: boolean }> {
    const run = this.sessionQueue.then(() => this.validSession())
    this.sessionQueue = run.catch(() => undefined)
    return run
  }

  private async validSession(): Promise<{ account: AccountInfo; stale: boolean }> {
    const stored = await this.readStored()
    if (!stored) throw new OrvianError('AUTH_EXPIRED', { reason: 'signed-out' })
    if (stored.expiresAt - REFRESH_MARGIN_MS > this.now()) return { account: AuthService.toAccount(stored), stale: false }

    try {
      const renewed = await this.refresh(stored)
      await this.persist(renewed)
      log.info('[Auth] Sesión de Minecraft renovada.')
      return { account: AuthService.toAccount(renewed), stale: false }
    } catch (err) {
      const error = fromNodeError(err)
      if (error.code === 'NETWORK_OFFLINE' || (error.code === 'DOWNLOAD_FAILED' && error.details.reason === 'timeout')) {
        log.warn('[Auth] Sin conexión al renovar la sesión; se usa la guardada.')
        return { account: AuthService.toAccount(stored), stale: true }
      }
      if (error.code === 'AUTH_EXPIRED' || error.code === 'AUTH_NO_GAME') {
        log.warn('[Auth] La sesión ya no es válida (%s); se cierra.', error.code)
        await this.logout()
      }
      throw error
    }
  }

  // ─── Interactive sign-in ───────────────────────────────────────────────────

  cancelLogin(): void {
    if (this.loginWindow && !this.loginWindow.isDestroyed()) this.loginWindow.close()
  }

  async loginWithMicrosoft(parent?: BrowserWindow): Promise<AccountInfo> {
    if (this.loginWindow) throw new OrvianError('BUSY', { reason: 'login-in-progress' })
    const authSession = session.fromPartition(SESSION_PARTITION)
    authSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
    const state = randomUUID()
    const authUrl =
      `https://login.live.com/oauth20_authorize.srf?client_id=${getConfig().msClientId}&response_type=code` +
      `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&scope=${encodeURIComponent(SCOPE)}&prompt=select_account&state=${state}`

    const code = await new Promise<string>((resolve, reject) => {
      let settled = false
      const win = new BrowserWindow({
        width: 500,
        height: 650,
        parent,
        modal: parent !== undefined,
        webPreferences: { session: authSession, nodeIntegration: false, contextIsolation: true, sandbox: true }
      })
      this.loginWindow = win
      win.setMenu(null)

      const finish = (outcome: { code: string } | { error: OrvianError }): void => {
        if (settled) return
        settled = true
        if (!win.isDestroyed()) win.close()
        if ('code' in outcome) resolve(outcome.code)
        else reject(outcome.error)
      }

      const onNavigate = (event: Electron.Event, url: string): void => {
        if (url.startsWith(REDIRECT_URI)) {
          event.preventDefault()
          const params = new URL(url).searchParams
          if (params.get('state') !== state) {
            finish({ error: new OrvianError('UNKNOWN', {}, { message: 'La respuesta de Microsoft no coincide con la solicitud de inicio de sesión.' }) })
          } else if (params.get('error')) {
            finish({ error: new OrvianError('AUTH_CANCELLED', { error: params.get('error') ?? undefined }) })
          } else if (params.get('code')) {
            finish({ code: params.get('code') as string })
          } else {
            finish({ error: new OrvianError('UNKNOWN', {}, { message: 'No se recibió el código de autorización de Microsoft.' }) })
          }
          return
        }
        if (!isMicrosoftAuthUrl(url)) {
          event.preventDefault()
          log.warn('[Auth] Navegación bloqueada hacia %s', url.split(/[?#]/)[0])
        }
      }
      win.webContents.on('will-redirect', onNavigate)
      win.webContents.on('will-navigate', onNavigate)
      win.webContents.on('will-attach-webview', (event) => event.preventDefault())
      win.webContents.setWindowOpenHandler(({ url }) => {
        try {
          if (new URL(url).protocol === 'https:') void shell.openExternal(url)
        } catch {
          // Ignore malformed URLs.
        }
        return { action: 'deny' }
      })
      win.on('closed', () => {
        this.loginWindow = null
        finish({ error: new OrvianError('AUTH_CANCELLED') })
      })
      win.loadURL(authUrl).catch((err: unknown) => finish({ error: fromNodeError(err) }))
    })

    const tokens = await this.requestTokens({ grant_type: 'authorization_code', code }, 'login')
    const mc = await this.minecraftLogin(tokens.accessToken)
    const profile = await this.fetchProfile(mc.accessToken)
    if (!tokens.refreshToken) {
      throw new OrvianError('UNKNOWN', {}, { message: 'Microsoft no devolvió un token de renovación; no se puede mantener la sesión.' })
    }
    const stored: StoredSession = { v: 2, msRefreshToken: tokens.refreshToken, accessToken: mc.accessToken, expiresAt: mc.expiresAt, name: profile.name, uuid: profile.id, xuid: mc.xuid }
    await this.persist(stored)
    log.info('[Auth] Sesión iniciada como %s', stored.name)
    return AuthService.toAccount(stored)
  }
}
