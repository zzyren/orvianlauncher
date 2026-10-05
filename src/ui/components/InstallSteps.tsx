import { Check, Circle, Loader2 } from 'lucide-react'
import { INSTALL_STEPS, type InstallProgress, type InstallStep } from '../../shared/launcher-state'
import { formatBytes, formatSpeed } from '../../shared/format'

const LABELS: Record<InstallStep, string> = {
  java: 'Java',
  minecraft: 'Minecraft',
  forge: 'Forge',
  libraries: 'Bibliotecas y recursos',
  modpack: 'Modpack de Orvian',
  finalizing: 'Inicio del juego'
}

/** The six stages of an installation with the current one expanded: counts, size and speed. */
export function InstallSteps({ progress }: { progress: InstallProgress }) {
  const currentIndex = INSTALL_STEPS.indexOf(progress.step)
  return (
    <ol className="install-steps" aria-label="Pasos de la instalación">
      {INSTALL_STEPS.map((step, index) => {
        const state = index < currentIndex ? 'done' : index === currentIndex ? 'current' : 'pending'
        return (
          <li key={step} className={`install-step install-step-${state}`} aria-current={state === 'current' ? 'step' : undefined}>
            <span className="install-step-icon" aria-hidden="true">
              {state === 'done' ? <Check size={16} strokeWidth={2} /> : state === 'current' ? <Loader2 size={16} strokeWidth={1.75} className="spin" /> : <Circle size={14} strokeWidth={1.75} />}
            </span>
            <span className="install-step-name">{LABELS[step]}</span>
            {state === 'current' && <span className="install-step-meta">{stepMeta(progress)}</span>}
            {state === 'done' && <span className="visually-hidden"> completado</span>}
          </li>
        )
      })}
    </ol>
  )
}

function stepMeta(progress: InstallProgress): string {
  const parts: string[] = []
  if (progress.bytesTotal) parts.push(`${formatBytes(progress.bytesDone ?? 0)} / ${formatBytes(progress.bytesTotal)}`)
  else if (progress.total) parts.push(`${progress.current ?? 0} / ${progress.total}`)
  if (progress.bytesPerSecond) parts.push(formatSpeed(progress.bytesPerSecond))
  return parts.join(' · ')
}
