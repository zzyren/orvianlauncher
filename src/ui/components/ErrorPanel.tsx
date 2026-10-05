import { AlertTriangle } from 'lucide-react'
import type { ErrorAction, OrvianErrorPayload } from '../../shared/errors'
import { Button } from './Button'

interface ErrorPanelProps {
  error: OrvianErrorPayload
  onAction: (action: ErrorAction) => void
  onDismiss?: () => void
}

/** What went wrong in plain words, with the next step as a button. Technical detail is folded away. */
export function ErrorPanel({ error, onAction, onDismiss }: ErrorPanelProps) {
  return (
    <section className="error-panel" role="alert" aria-labelledby="error-panel-title">
      <AlertTriangle size={20} strokeWidth={1.75} aria-hidden="true" className="error-panel-icon" />
      <div className="error-panel-body">
        <h2 id="error-panel-title" className="error-panel-title">{error.title}</h2>
        <p className="error-panel-text">{error.body}</p>
        {error.technical && (
          <details className="error-panel-details">
            <summary>Detalles técnicos</summary>
            <pre className="selectable">{error.technical}</pre>
          </details>
        )}
        <div className="error-panel-actions">
          {error.actions.map((action, index) => (
            <Button key={`${action.id}-${index}`} size="sm" variant={index === 0 ? 'primary' : 'secondary'} onClick={() => onAction(action)}>
              {action.label}
            </Button>
          ))}
          {onDismiss && !error.actions.some((a) => a.id === 'dismiss') && (
            <Button size="sm" variant="ghost" onClick={onDismiss}>Descartar</Button>
          )}
        </div>
      </div>
    </section>
  )
}
