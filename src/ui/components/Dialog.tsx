import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { Button } from './Button'
import { Field } from './Field'

interface DialogProps {
  open: boolean
  title: string
  description?: ReactNode
  /** Esc and a click on the backdrop call this; ignored when `dismissible` is false. */
  onClose: () => void
  dismissible?: boolean
  size?: 'sm' | 'md'
  children?: ReactNode
  actions: ReactNode
}

/**
 * Modal built on the native <dialog>: the browser makes the rest of the page inert, traps Tab,
 * handles Esc and returns focus to the control that opened it. The element marked
 * `data-autofocus` (or the first control) gets the initial focus.
 */
export function Dialog({ open, title, description, onClose, dismissible = true, size = 'sm', children, actions }: DialogProps) {
  const ref = useRef<HTMLDialogElement>(null)
  const titleId = useId()
  const descriptionId = useId()

  useEffect(() => {
    const dialog = ref.current
    if (!dialog) return
    if (open && !dialog.open) {
      dialog.showModal()
      dialog.querySelector<HTMLElement>('[data-autofocus]')?.focus()
    } else if (!open && dialog.open) {
      dialog.close()
    }
  }, [open])

  return (
    <dialog
      ref={ref}
      className={`dialog dialog-${size}`}
      aria-labelledby={titleId}
      aria-describedby={description ? descriptionId : undefined}
      onCancel={(event) => {
        // Esc: let React state decide, so the dialog never closes behind the app's back
        event.preventDefault()
        if (dismissible) onClose()
      }}
      onMouseDown={(event) => {
        if (dismissible && event.target === ref.current) onClose()
      }}
    >
      {open && (
        <div className="dialog-content">
          <h2 id={titleId} className="dialog-title">{title}</h2>
          {description && <div id={descriptionId} className="dialog-description">{description}</div>}
          {children}
          <div className="dialog-actions">{actions}</div>
        </div>
      )}
    </dialog>
  )
}

interface ConfirmDialogProps {
  open: boolean
  title: string
  description?: ReactNode
  confirmLabel: string
  cancelLabel?: string
  /** A destructive action: the safe button gets the initial focus and the confirm button is red. */
  destructive?: boolean
  /** When set, the confirm button stays disabled until the player types this exact word. */
  requireText?: string
  busy?: boolean
  onConfirm: () => void
  onCancel: () => void
  children?: ReactNode
}

export function ConfirmDialog({ open, title, description, confirmLabel, cancelLabel = 'Cancelar', destructive = false, requireText, busy = false, onConfirm, onCancel, children }: ConfirmDialogProps) {
  const [typed, setTyped] = useState('')
  useEffect(() => {
    if (!open) setTyped('')
  }, [open])
  const unlocked = !requireText || typed.trim() === requireText

  return (
    <Dialog
      open={open}
      title={title}
      description={description}
      onClose={onCancel}
      actions={
        <>
          <Button variant="secondary" onClick={onCancel} data-autofocus={destructive ? '' : undefined}>{cancelLabel}</Button>
          <Button variant={destructive ? 'danger' : 'primary'} onClick={onConfirm} disabled={!unlocked} loading={busy} data-autofocus={destructive ? undefined : ''}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      {children}
      {requireText && (
        <Field label={`Escribe ${requireText} para confirmar`}>
          {(props) => (
            <input {...props} className="input" autoComplete="off" spellCheck={false} value={typed} onChange={(event) => setTyped(event.target.value)} />
          )}
        </Field>
      )}
    </Dialog>
  )
}
