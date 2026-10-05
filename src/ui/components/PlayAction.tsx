import { useEffect, useState } from 'react'
import { FolderOpen, MoreHorizontal, Wrench } from 'lucide-react'
import { getPrimaryAction, type LauncherState, type PrimaryActionId } from '../../shared/launcher-state'
import { formatDuration } from '../../shared/format'
import { useDelayedFlag } from '../hooks/useDelayedFlag'
import { Button } from './Button'
import { Menu } from './Menu'
import { ProgressBar } from './ProgressBar'

interface PlayActionProps {
  state: LauncherState
  onAction: (action: PrimaryActionId) => void
  onRepair: () => void
  onKill: () => void
}

/** The one big button. Its text and behaviour come from `getPrimaryAction`, shared with the tray. */
export function PlayAction({ state, onAction, onRepair, onKill }: PlayActionProps) {
  const { phase } = state
  const primary = getPrimaryAction(state)
  const working = phase.kind === 'installing' || phase.kind === 'repairing'
  const indeterminate = useDelayedFlag(phase.kind === 'launching' || phase.kind === 'checking')
  const elapsed = useElapsed(phase.kind === 'running' ? phase.startedAt : null)
  const idle = !working && phase.kind !== 'launching' && phase.kind !== 'running' && phase.kind !== 'signing-in' && phase.kind !== 'booting'

  return (
    <div className="play-action">
      <div className="play-row">
        <button
          type="button"
          className="play-btn"
          disabled={!primary.enabled}
          aria-busy={working || phase.kind === 'launching' || undefined}
          onClick={() => onAction(primary.action)}
        >
          <span className="play-label">{primary.label}</span>
          <span className="play-sub">{elapsed !== null ? `En juego · ${formatDuration(elapsed)}` : primary.sublabel}</span>
          {(working || indeterminate) && (
            <ProgressBar className="play-progress" label={working ? 'Progreso de la instalación' : 'Abriendo Minecraft'} value={phase.kind === 'installing' || phase.kind === 'repairing' ? phase.progress.fraction : undefined} />
          )}
        </button>
        <Menu
          label="Más acciones"
          className="play-menu"
          trigger={<MoreHorizontal size={20} strokeWidth={1.75} aria-hidden="true" />}
          items={[
            { label: 'Reparar ahora', icon: <Wrench size={16} strokeWidth={1.75} aria-hidden="true" />, disabled: !idle || state.account === null, onSelect: onRepair },
            { label: 'Abrir la carpeta de mods', icon: <FolderOpen size={16} strokeWidth={1.75} aria-hidden="true" />, onSelect: () => void window.orvian.openFolder('mods') }
          ]}
        />
      </div>
      {primary.secondary && (
        <div className="play-secondary">
          <Button
            size="sm"
            variant="ghost"
            onClick={() => (primary.secondary?.action === 'force-quit' ? onKill() : onAction(primary.secondary?.action ?? 'none'))}
          >
            {primary.secondary.label}
          </Button>
        </div>
      )}
    </div>
  )
}

/** Seconds since `startedAt`, ticking once a second; null when not applicable. */
function useElapsed(startedAt: number | null): number | null {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (startedAt === null) return
    setNow(Date.now())
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [startedAt])
  return startedAt === null ? null : Math.max(0, (now - startedAt) / 1000)
}
