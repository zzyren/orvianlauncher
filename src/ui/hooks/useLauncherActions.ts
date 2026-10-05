import { useCallback } from 'react'
import type { ErrorAction } from '../../shared/errors'
import type { PrimaryActionId } from '../../shared/launcher-state'
import { useToast } from '../components/Toast'
import { ipcErrorMessage } from '../ipcError'

type Perform = (action: PrimaryActionId) => Promise<void>

/** Turns the ids produced by `getPrimaryAction` and by error panels into calls to the main process. */
export function useLauncherActions(): { perform: Perform; performErrorAction: (action: ErrorAction) => Promise<void> } {
  const toast = useToast()

  const perform = useCallback<Perform>(
    async (action) => {
      try {
        switch (action) {
          case 'play':
            await window.orvian.play({ quickPlay: true })
            break
          case 'play-installed':
            await window.orvian.play({ quickPlay: true, playInstalled: true })
            break
          case 'repair':
            await window.orvian.repair()
            break
          case 'check':
            await window.orvian.checkForUpdates()
            break
          case 'login': {
            const result = await window.orvian.login()
            if (!result.ok && !result.cancelled) toast({ kind: 'error', message: result.message })
            break
          }
          case 'cancel-login':
            await window.orvian.cancelLogin()
            break
          case 'update-launcher':
            await window.orvian.updaterCheck()
            await window.orvian.updaterDownload()
            break
          case 'force-quit':
            await window.orvian.killGame()
            break
          case 'none':
            break
        }
      } catch (err) {
        toast({ kind: 'error', message: ipcErrorMessage(err) })
      }
    },
    [toast]
  )

  const performErrorAction = useCallback(
    async (action: ErrorAction) => {
      try {
        switch (action.id) {
          case 'retry':
            await window.orvian.dismissError()
            await window.orvian.play()
            break
          case 'repair':
            await window.orvian.dismissError()
            await window.orvian.repair()
            break
          case 'play-offline':
            await window.orvian.dismissError()
            await window.orvian.play({ playInstalled: true })
            break
          case 'copy-diagnostics': {
            await window.orvian.copyDiagnostics()
            toast({ kind: 'success', message: 'Diagnóstico copiado al portapapeles.' })
            break
          }
          case 'open-logs':
            await window.orvian.openFolder('logs')
            break
          case 'open-folder':
            await window.orvian.openFolder('mods')
            break
          case 'view-crash':
            await window.orvian.openFolder('crash-reports')
            break
          case 'login':
            await window.orvian.dismissError()
            await perform('login')
            break
          case 'update-launcher':
            await perform('update-launcher')
            break
          case 'open-url':
            if (action.url) await window.orvian.openExternal(action.url)
            break
          case 'dismiss':
            await window.orvian.dismissError()
            break
        }
      } catch (err) {
        toast({ kind: 'error', message: ipcErrorMessage(err) })
      }
    },
    [perform, toast]
  )

  return { perform, performErrorAction }
}
