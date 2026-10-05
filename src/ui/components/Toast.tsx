import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from 'react'
import { AlertCircle, CheckCircle2, Info, X } from 'lucide-react'
import { IconButton } from './Button'
import { cx } from './cx'

export type ToastKind = 'success' | 'error' | 'info'

interface ToastInput {
  kind: ToastKind
  message: string
}

interface ToastItem extends ToastInput {
  id: number
}

const MAX_TOASTS = 3
const AUTO_DISMISS_MS = 5000

const ToastContext = createContext<((toast: ToastInput) => void) | null>(null)

/** Short feedback for results of the player's own actions. Errors stay until dismissed. */
export function useToast(): (toast: ToastInput) => void {
  const push = useContext(ToastContext)
  if (!push) throw new Error('useToast needs a ToastProvider')
  return push
}

const ICONS = { success: CheckCircle2, error: AlertCircle, info: Info } as const

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([])
  const nextId = useRef(1)

  const dismiss = useCallback((id: number) => setToasts((current) => current.filter((toast) => toast.id !== id)), [])

  const push = useCallback(
    (toast: ToastInput) => {
      const id = nextId.current++
      setToasts((current) => [...current.slice(-(MAX_TOASTS - 1)), { ...toast, id }])
      if (toast.kind !== 'error') window.setTimeout(() => dismiss(id), AUTO_DISMISS_MS)
    },
    [dismiss]
  )

  const value = useMemo(() => push, [push])

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="toast-region">
        {toasts.map((toast) => {
          const Icon = ICONS[toast.kind]
          return (
            <div key={toast.id} className={cx('toast', `toast-${toast.kind}`)} role={toast.kind === 'error' ? 'alert' : 'status'}>
              <Icon size={18} strokeWidth={1.75} aria-hidden="true" />
              <span className="toast-message">{toast.message}</span>
              <IconButton label="Cerrar aviso" onClick={() => dismiss(toast.id)}>
                <X size={16} strokeWidth={1.75} aria-hidden="true" />
              </IconButton>
            </div>
          )
        })}
      </div>
    </ToastContext.Provider>
  )
}
