import { MicrosoftAuthenticator } from '@xmcl/user'
import { BrowserWindow, safeStorage, session } from 'electron'
import { join } from 'node:path'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { getConfig } from './config'
import { log } from './logger'
import { fetchWithTimeout } from './net'

const REDIRECT_URI = 'https://login.live.com/oauth20_desktop.srf'

export type AccountInfo = {
  accessToken: string
  name: string
  uuid: string
}

export class AuthService {
  private authenticator = new MicrosoftAuthenticator()
  private accountFile: string

  constructor(dataRoot: string) {
    this.accountFile = join(dataRoot, 'launcher', 'auth.json')
  }

  /** Session kept in memory so a machine without secure storage still works until the app closes. */
  private memory: AccountInfo | null = null

  async loadAccount(): Promise<AccountInfo | null> {
    if (this.memory) return this.memory
    if (!safeStorage.isEncryptionAvailable()) return null
    try {
      const encrypted = await readFile(this.accountFile, 'utf8')
      return JSON.parse(safeStorage.decryptString(Buffer.from(encrypted, 'hex'))) as AccountInfo
    } catch {
      return null
    }
  }

  async saveAccount(info: AccountInfo | null) {
    this.memory = info
    await mkdir(join(this.accountFile, '..'), { recursive: true })
    if (!info) {
      const { rm } = await import('node:fs/promises')
      await rm(this.accountFile, { force: true }).catch(() => undefined)
      // Also clear the persistent Microsoft cookie session
      try {
        await session.fromPartition('persist:microsoft-auth').clearStorageData()
      } catch (err) {
        log.warn('[Auth] No se pudo limpiar la sesión de Microsoft: %s', String(err))
      }
      return
    }
    if (!safeStorage.isEncryptionAvailable()) {
      log.warn('[Auth] El almacenamiento seguro no está disponible: la sesión no se guardará en disco.')
      return
    }
    await writeFile(this.accountFile, safeStorage.encryptString(JSON.stringify(info)).toString('hex'), 'utf8')
  }

  async loginWithMicrosoft(parent?: BrowserWindow): Promise<AccountInfo> {
    const authSession = session.fromPartition('persist:microsoft-auth')

    return new Promise((resolve, reject) => {
      let isClosed = false
      const authWindow = new BrowserWindow({
        width: 500,
        height: 650,
        parent,
        modal: true,
        webPreferences: {
          session: authSession,
          nodeIntegration: false,
          contextIsolation: true
        }
      })

      authWindow.setMenu(null)

      const authUrl = `https://login.live.com/oauth20_authorize.srf?client_id=${getConfig().msClientId}&response_type=code&redirect_uri=${REDIRECT_URI}&scope=XboxLive.signin%20offline_access&prompt=select_account`
      
      authWindow.webContents.on('will-redirect', async (event, url) => {
        if (url.startsWith(REDIRECT_URI)) {
          event.preventDefault()
          const urlObj = new URL(url)
          const code = urlObj.searchParams.get('code')
          isClosed = true
          authWindow.close()
          
          if (!code) {
            return reject(new Error('No se recibió el código de autorización de Microsoft.'))
          }
          
          try {
            const tokenRes = await fetchWithTimeout('https://login.live.com/oauth20_token.srf', {
              method: 'POST',
              body: new URLSearchParams({
                client_id: getConfig().msClientId,
                code: code,
                grant_type: 'authorization_code',
                redirect_uri: REDIRECT_URI
              }),
              headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
            }, 10_000)
            
            const tokenData = await tokenRes.json()
            if (!tokenData.access_token) throw new Error('Fallo al obtener el token de acceso.')
            
            const xboxRes = await this.authenticator.acquireXBoxToken(tokenData.access_token)
            const mcRes = await this.authenticator.loginMinecraftWithXBox(
              xboxRes.minecraftXstsResponse.DisplayClaims.xui[0].uhs,
              xboxRes.minecraftXstsResponse.Token
            )
            
            const profileRes = await fetchWithTimeout('https://api.minecraftservices.com/minecraft/profile', {
              headers: { Authorization: `Bearer ${mcRes.access_token}` }
            }, 10_000)
            if (!profileRes.ok) throw new Error('No se pudo obtener el perfil de Minecraft. ¿Tienes el juego comprado?')
            const profile = await profileRes.json()
            
            const account: AccountInfo = {
              accessToken: mcRes.access_token,
              name: profile.name,
              uuid: profile.id
            }
            
            await this.saveAccount(account)
            resolve(account)
          } catch (err) {
            reject(err)
          }
        }
      })
      
      authWindow.on('closed', () => {
        if (!isClosed) reject(new Error('Inicio de sesión cancelado.'))
      })
      
      void authWindow.loadURL(authUrl)
    })
  }
}
