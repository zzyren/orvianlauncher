import { useEffect, useState } from 'react'
import { ExternalLink, FolderOpen, HardDrive, Power, X } from 'lucide-react'
import { getPrimaryAction } from '../../shared/launcher-state'
import { Avatar } from '../components/Avatar'
import { Button, IconButton } from '../components/Button'
import { ConfirmDialog } from '../components/Dialog'
import { ProgressBar } from '../components/ProgressBar'
import { useLauncherActions } from '../hooks/useLauncherActions'
import { useLauncherState } from '../hooks/useLauncherState'
import { ipcErrorMessage } from '../ipcError'

/** Quick menu of the tray icon. It renders the same launcher state as the main window and never polls. */
export default function Tray() {
  const state = useLauncherState()
  const { perform, performErrorAction } = useLauncherActions()
  const [quitPrompt, setQuitPrompt] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)

  useEffect(() => window.orvian.onPromptMcQuit(() => setQuitPrompt(true)), [])

  if (!state) return <div className="tray" aria-busy="true" />

  const { phase } = state
  const primary = getPrimaryAction(state)
  const working = phase.kind === 'installing' || phase.kind === 'repairing'
  const error = actionError ?? (phase.kind === 'error' ? phase.error.title : null)

  const run = async (): Promise<void> => {
    setActionError(null)
    if (primary.action === 'login' || primary.action === 'update-launcher') {
      await window.orvian.showMainWindow()
      return
    }
    await perform(primary.action)
  }

  const quit = (): void => {
    window.orvian
      .isMinecraftRunning()
      .then((running) => (running ? setQuitPrompt(true) : window.orvian.quitApp()))
      .catch((err: unknown) => setActionError(ipcErrorMessage(err)))
  }

  return (
    <div className="tray">
      <header className="tray-header">
        <div className="tray-brand">
          <img src="./logo-64.png" alt="" width={24} height={24} draggable={false} />
          <span className="tray-name" translate="no">Orvian</span>
        </div>
        <IconButton label="Cerrar el menú rápido" onClick={() => void window.orvian.hideTrayWindow()}>
          <X size={16} strokeWidth={1.75} aria-hidden="true" />
        </IconButton>
      </header>

      <div className="tray-body">
        {state.account ? (
          <div className="tray-player">
            <Avatar uuid={state.account.uuid} name={state.account.name} size={32} />
            <div className="tray-player-info">
              <span className="tray-player-name" translate="no">{state.account.name}</span>
              <span className="tray-player-status">{phase.kind === 'running' ? 'Jugando a Minecraft' : primary.enabled ? primary.sublabel : primary.label}</span>
            </div>
          </div>
        ) : (
          <button type="button" className="tray-signin" onClick={() => void window.orvian.showMainWindow()}>
            <span className="tray-signin-title">Iniciar sesión con Microsoft</span>
            <span className="tray-signin-sub">Se abrirá el launcher para conectar tu cuenta</span>
          </button>
        )}

        {error && <p className="tray-error" role="alert">{error}</p>}

        <button type="button" className="tray-play" disabled={!primary.enabled} onClick={() => void run()}>
          <span className="tray-play-label">{primary.label}</span>
          <span className="tray-play-sub">{primary.sublabel}</span>
          {working && <ProgressBar className="tray-progress" label="Progreso de la instalación" value={phase.progress.fraction} />}
        </button>

        {phase.kind === 'error' && phase.error.actions[0] && (
          <Button size="sm" variant="secondary" onClick={() => void performErrorAction(phase.error.actions[0])}>{phase.error.actions[0].label}</Button>
        )}

        <Button variant="secondary" icon={<ExternalLink size={16} strokeWidth={1.75} aria-hidden="true" />} onClick={() => void window.orvian.showMainWindow()}>
          Abrir el launcher
        </Button>
      </div>

      <footer className="tray-footer">
        <Button size="sm" variant="ghost" icon={<FolderOpen size={14} strokeWidth={1.75} aria-hidden="true" />} onClick={() => void window.orvian.openFolder('mods')}>Mods</Button>
        <Button size="sm" variant="ghost" icon={<HardDrive size={14} strokeWidth={1.75} aria-hidden="true" />} onClick={() => void window.orvian.openFolder('logs')}>Registros</Button>
        <Button size="sm" variant="ghost" icon={<Power size={14} strokeWidth={1.75} aria-hidden="true" />} onClick={quit}>Salir</Button>
      </footer>

      <ConfirmDialog
        open={quitPrompt}
        destructive
        title="Minecraft sigue abierto"
        description="No se puede cerrar el launcher dejando Minecraft abierto. ¿Quieres cerrar Minecraft y salir?"
        confirmLabel="Cerrar Minecraft y salir"
        onCancel={() => setQuitPrompt(false)}
        onConfirm={() => {
          setQuitPrompt(false)
          void window.orvian.forceQuit()
        }}
      />
    </div>
  )
}
