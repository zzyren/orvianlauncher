import { WifiOff } from 'lucide-react'
import type { LauncherState } from '../../shared/launcher-state'
import { Avatar } from './Avatar'
import { Button } from './Button'
import { useToast } from './Toast'

/** Always-visible strip: who is signed in, connectivity, versions and the launcher's own update. */
export function StatusBar({ state }: { state: LauncherState }) {
  const toast = useToast()
  const { launcherUpdate: update, phase } = state
  const gameRunning = phase.kind === 'running' || phase.kind === 'launching'

  const run = (action: () => Promise<unknown>): void => {
    action().catch(() => toast({ kind: 'error', message: 'No se pudo actualizar el launcher. Inténtalo de nuevo más tarde.' }))
  }

  return (
    <footer className="statusbar">
      <div className="statusbar-group">
        {state.account && (
          <span className="statusbar-account">
            <Avatar uuid={state.account.uuid} name={state.account.name} />
            <span translate="no">{state.account.name}</span>
          </span>
        )}
        {state.pack.offline && (
          <span className="statusbar-offline">
            <WifiOff size={14} strokeWidth={1.75} aria-hidden="true" />
            <span>Sin conexión</span>
          </span>
        )}
      </div>

      <div className="statusbar-group statusbar-update" role="status">
        {update.status === 'available' && (
          <>
            <span>Launcher v{update.newVersion} disponible</span>
            <Button size="sm" variant="ghost" onClick={() => run(() => window.orvian.updaterDownload())}>Descargar</Button>
          </>
        )}
        {update.status === 'downloading' && <span>Descargando el launcher… {update.percent ?? 0} %</span>}
        {update.status === 'downloaded' && (
          <>
            <span>{gameRunning ? 'Launcher v' + update.newVersion + ' listo: se instalará al cerrar Minecraft' : 'Launcher v' + update.newVersion + ' listo'}</span>
            <Button size="sm" variant="ghost" disabled={gameRunning} onClick={() => run(async () => window.orvian.updaterInstall())}>Reiniciar y actualizar</Button>
          </>
        )}
        {update.status === 'error' && (
          <>
            <span>No se pudo comprobar el launcher</span>
            <Button size="sm" variant="ghost" onClick={() => run(() => window.orvian.updaterCheck())}>Reintentar</Button>
          </>
        )}
      </div>

      <div className="statusbar-group statusbar-versions">
        <span translate="no">Launcher v{state.appVersion}</span>
        {state.pack.installed && <span translate="no">Pack v{state.pack.installed}</span>}
      </div>
    </footer>
  )
}
