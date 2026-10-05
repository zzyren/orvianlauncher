import { useEffect, useRef, useState } from 'react'
import { ConfirmDialog, Dialog } from '../components/Dialog'
import { Button } from '../components/Button'
import { ErrorPanel } from '../components/ErrorPanel'
import { InstallSteps } from '../components/InstallSteps'
import { NewsList } from '../components/NewsList'
import { PlayAction } from '../components/PlayAction'
import { ServerCard } from '../components/ServerCard'
import { useToast } from '../components/Toast'
import { useLauncherActions } from '../hooks/useLauncherActions'
import type { LauncherState } from '../../shared/launcher-state'
import { formatBytes } from '../../shared/format'

const STEP_ANNOUNCEMENTS = {
  java: 'Preparando Java',
  minecraft: 'Preparando Minecraft',
  forge: 'Instalando Forge',
  libraries: 'Verificando bibliotecas y recursos',
  modpack: 'Instalando el modpack',
  finalizing: 'Iniciando el juego'
} as const

export default function Home({ state }: { state: LauncherState }) {
  const { phase, pack } = state
  const { perform, performErrorAction } = useLauncherActions()
  const toast = useToast()
  const [killOpen, setKillOpen] = useState(false)

  const working = phase.kind === 'installing' || phase.kind === 'repairing'
  const announcement = useStepAnnouncement(phase.kind === 'installing' || phase.kind === 'repairing' ? phase.progress.step : null)

  const playOnServer = (): void => {
    window.orvian.play({ quickPlay: true, playInstalled: state.pack.offline }).catch(() => toast({ kind: 'error', message: 'No se pudo iniciar el juego.' }))
  }
  const canQuickPlay = phase.kind === 'ready' || phase.kind === 'update-available' || phase.kind === 'offline-ready' || phase.kind === 'crashed'

  return (
    <div className="home view-enter">
      <div className="home-scrim" aria-hidden="true" />
      <div className="home-grid">
        <section className="home-main" aria-labelledby="home-title">
          <p className="home-eyebrow" translate="no">Minecraft 1.20.1 · Forge</p>
          <h1 id="home-title" className="home-title" translate="no">Orvian</h1>
          <p className="home-pack">{packLine(state)}</p>

          <PlayAction
            state={state}
            onAction={(action) => void perform(action)}
            onPlayOnServer={playOnServer}
            onRepair={() => void perform('repair')}
            onKill={() => setKillOpen(true)}
          />

          {pack.hasUpdate && phase.kind !== 'installing' && phase.kind !== 'launching' && phase.kind !== 'running' && (
            <p className="home-update-line">
              Nueva versión del pack v{pack.latest}{pack.downloadBytes ? ` · ${formatBytes(pack.downloadBytes)}` : ''}
              {pack.changelog.length > 0 && <a href="#novedades" className="home-update-link" onClick={(e) => { e.preventDefault(); document.getElementById('news-title')?.scrollIntoView({ block: 'start' }) }}> · Ver cambios</a>}
            </p>
          )}

          {phase.kind === 'error' && <ErrorPanel error={phase.error} onAction={(action) => void performErrorAction(action)} onDismiss={() => void window.orvian.dismissError()} />}

          {working && (
            <>
              <p className="home-install-note">Puedes cerrar esta ventana: seguiremos en segundo plano.</p>
              <InstallSteps progress={phase.progress} />
            </>
          )}
        </section>

        <aside className="home-side" aria-label="Servidor y novedades">
          <ServerCard server={state.server} onRefresh={() => void window.orvian.refreshServer()} onPlay={canQuickPlay ? playOnServer : undefined} />
          <NewsList items={state.news} />
        </aside>
      </div>

      <div className="visually-hidden" role="status">{announcement}</div>

      <ConfirmDialog
        open={killOpen}
        destructive
        title="¿Forzar el cierre de Minecraft?"
        description="Se cerrará el juego al instante. Los cambios del mundo que no se hayan guardado se perderán."
        confirmLabel="Forzar cierre"
        onCancel={() => setKillOpen(false)}
        onConfirm={() => {
          setKillOpen(false)
          void perform('force-quit')
        }}
      />

      <CrashDialog state={state} />
    </div>
  )
}

function packLine(state: LauncherState): string {
  const { pack, phase } = state
  if (phase.kind === 'booting' || phase.kind === 'checking') return 'Comprobando el modpack…'
  if (pack.installed) return `Modpack instalado v${pack.installed}${pack.offline ? ' · sin conexión' : ''}`
  return pack.offline ? 'Sin conexión: no se pudo consultar el modpack.' : 'El modpack se instalará la primera vez que juegues.'
}

/** Announces a stage once when it starts, so screen readers follow the install without a flood of updates. */
function useStepAnnouncement(step: keyof typeof STEP_ANNOUNCEMENTS | null): string {
  const [text, setText] = useState('')
  const last = useRef<string | null>(null)
  useEffect(() => {
    if (step === last.current) return
    last.current = step
    setText(step ? STEP_ANNOUNCEMENTS[step] : '')
  }, [step])
  return text
}

function CrashDialog({ state }: { state: LauncherState }) {
  const { phase } = state
  const { performErrorAction } = useLauncherActions()
  const toast = useToast()
  const open = phase.kind === 'crashed'
  const dismiss = (): void => void window.orvian.dismissError()

  return (
    <Dialog
      open={open}
      title="Minecraft se cerró inesperadamente"
      description={phase.kind === 'crashed' ? phase.summary || 'No hay un resumen del fallo; el informe completo tiene los detalles.' : undefined}
      onClose={dismiss}
      size="md"
      actions={
        <>
          <Button variant="ghost" onClick={dismiss}>Cerrar</Button>
          <Button variant="secondary" onClick={() => void performErrorAction({ id: 'view-crash', label: 'Ver informe' })}>Ver informe</Button>
          <Button
            variant="secondary"
            onClick={() => void window.orvian.copyDiagnostics().then(() => toast({ kind: 'success', message: 'Diagnóstico copiado al portapapeles.' }))}
          >
            Copiar diagnóstico
          </Button>
          <Button variant="primary" data-autofocus="" onClick={() => void window.orvian.dismissError().then(() => window.orvian.repair())}>Reparar e intentar de nuevo</Button>
        </>
      }
    >
      {phase.kind === 'crashed' && phase.exitCode !== null && <p className="dialog-meta">Código de salida {phase.exitCode}</p>}
    </Dialog>
  )
}
