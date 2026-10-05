import { useEffect } from 'react'
import { AlertTriangle, X, Info, ShieldAlert } from 'lucide-react'

export interface CustomDialogProps {
  isOpen: boolean
  title: string
  message: string
  detail?: string
  type?: 'danger' | 'warning' | 'info'
  confirmText?: string
  cancelText?: string
  compact?: boolean
  onConfirm: () => void
  onCancel: () => void
}

export default function CustomDialog({
  isOpen,
  title,
  message,
  detail,
  type = 'warning',
  confirmText = 'Aceptar',
  cancelText = 'Cancelar',
  compact = false,
  onConfirm,
  onCancel
}: CustomDialogProps) {
  useEffect(() => {
    if (!isOpen) return
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel()
      if (e.key === 'Enter') onConfirm()
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [isOpen, onConfirm, onCancel])

  if (!isOpen) return null

  return (
    <div className={`custom-dialog-backdrop ${compact ? 'compact' : ''}`} onClick={onCancel}>
      <div 
        className={`custom-dialog-modal ${type} ${compact ? 'compact' : ''}`} 
        onClick={e => e.stopPropagation()}
      >
        <button 
          className="dialog-close-btn" 
          onClick={onCancel}
          title="Cerrar ventana"
        >
          <X size={16} />
        </button>

        <div className="dialog-header-area">
          <div className={`dialog-icon-badge ${type}`}>
            {type === 'danger' ? (
              <ShieldAlert size={28} />
            ) : type === 'warning' ? (
              <AlertTriangle size={28} />
            ) : (
              <Info size={28} />
            )}
          </div>
          <div className="dialog-title-group">
            <h3 className="dialog-title">{title}</h3>
            <p className="dialog-message">{message}</p>
          </div>
        </div>

        {detail && <div className="dialog-detail-box">{detail}</div>}

        <div className="dialog-actions-row">
          <button 
            type="button" 
            className="dialog-btn cancel-btn" 
            onClick={onCancel}
          >
            {cancelText}
          </button>
          <button 
            type="button" 
            className={`dialog-btn confirm-btn ${type}`} 
            onClick={onConfirm}
          >
            {confirmText}
          </button>
        </div>
      </div>
    </div>
  )
}
