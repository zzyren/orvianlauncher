import { useEffect, useState } from 'react'
import { Copy, Minus, Square, X } from 'lucide-react'
import { IconButton } from './Button'

export type ViewId = 'home' | 'mods' | 'settings' | 'admin'

const LABELS: Record<ViewId, string> = { home: 'Inicio', mods: 'Mods', settings: 'Ajustes', admin: 'Admin' }

interface TitleBarProps {
  view: ViewId
  views: ViewId[]
  onNavigate: (view: ViewId) => void
}

export function TitleBar({ view, views, onNavigate }: TitleBarProps) {
  const [maximized, setMaximized] = useState(false)

  useEffect(() => {
    void window.orvian.isWindowMaximized().then(setMaximized).catch(() => undefined)
    return window.orvian.onWindowState((value) => setMaximized(value))
  }, [])

  return (
    <header className="titlebar">
      <div className="titlebar-brand">
        <img src="./logo-64.png" alt="" width={24} height={24} draggable={false} />
        <span className="titlebar-name" translate="no">Orvian</span>
      </div>
      <nav className="titlebar-nav" aria-label="Principal">
        {views.map((id) => (
          <button key={id} type="button" className="nav-link" aria-current={view === id ? 'page' : undefined} onClick={() => onNavigate(id)}>
            {LABELS[id]}
          </button>
        ))}
      </nav>
      <div className="titlebar-controls">
        <IconButton label="Minimizar" className="window-btn" onClick={() => void window.orvian.minimizeWindow()}>
          <Minus size={16} strokeWidth={1.75} aria-hidden="true" />
        </IconButton>
        <IconButton label={maximized ? 'Restaurar' : 'Maximizar'} className="window-btn" onClick={() => void window.orvian.toggleMaximizeWindow().then(setMaximized)}>
          {maximized ? <Copy size={14} strokeWidth={1.75} aria-hidden="true" /> : <Square size={14} strokeWidth={1.75} aria-hidden="true" />}
        </IconButton>
        <IconButton label="Ocultar en la bandeja del sistema" className="window-btn window-close" onClick={() => void window.orvian.closeWindow()}>
          <X size={16} strokeWidth={1.75} aria-hidden="true" />
        </IconButton>
      </div>
    </header>
  )
}
