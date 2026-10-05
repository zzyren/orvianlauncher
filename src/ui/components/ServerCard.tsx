import { useState } from 'react'
import { Copy, Eye, EyeOff, RefreshCw } from 'lucide-react'
import type { ServerStatus } from '../../shared/launcher-state'
import { Button, IconButton } from './Button'
import { useToast } from './Toast'

interface ServerCardProps {
  server: ServerStatus
  /** Offered only when the launcher can start the game right now. */
  onPlay?: () => void
  onRefresh: () => void
}

const STATE_LABEL: Record<ServerStatus['state'], string> = {
  unknown: 'Sin comprobar',
  checking: 'Comprobando…',
  online: 'En línea',
  offline: 'Sin conexión'
}

export function ServerCard({ server, onPlay, onRefresh }: ServerCardProps) {
  const toast = useToast()
  const [revealed, setRevealed] = useState(false)
  const copyAddress = (): void => {
    navigator.clipboard
      .writeText(server.address)
      .then(() => toast({ kind: 'info', message: 'Dirección copiada.' }))
      .catch(() => toast({ kind: 'error', message: 'No se pudo copiar la dirección.' }))
  }

  return (
    <section className="card server-card" aria-labelledby="server-card-title">
      <div className="card-header">
        <h2 id="server-card-title" className="card-title">Servidor</h2>
        <IconButton label="Comprobar el servidor ahora" onClick={onRefresh} disabled={server.state === 'checking'}>
          <RefreshCw size={16} strokeWidth={1.75} aria-hidden="true" className={server.state === 'checking' ? 'spin' : undefined} />
        </IconButton>
      </div>
      <p className="server-status" data-state={server.state}>
        <span className="status-dot" aria-hidden="true" />
        <span>{STATE_LABEL[server.state]}</span>
        {server.state === 'online' && server.players && <span className="server-meta">{server.players.online} / {server.players.max} jugadores</span>}
        {server.state === 'online' && server.latencyMs !== undefined && <span className="server-meta">{server.latencyMs} ms</span>}
      </p>
      {server.state === 'online' && server.motd && <p className="server-motd selectable">{server.motd}</p>}
      {server.state === 'offline' && <p className="server-motd">El servidor puede estar en reposo y arrancar al conectarte.</p>}
      <div className="server-address">
        <code translate="no" className={revealed ? 'selectable' : undefined}>{revealed ? server.address : '•'.repeat(12)}</code>
        <IconButton label={revealed ? 'Ocultar la dirección' : 'Mostrar la dirección'} onClick={() => setRevealed((v) => !v)}>
          {revealed ? <EyeOff size={16} strokeWidth={1.75} aria-hidden="true" /> : <Eye size={16} strokeWidth={1.75} aria-hidden="true" />}
        </IconButton>
        <IconButton label="Copiar la dirección" onClick={copyAddress}>
          <Copy size={16} strokeWidth={1.75} aria-hidden="true" />
        </IconButton>
      </div>
      {onPlay && (
        <Button variant="secondary" onClick={onPlay} disabled={server.state === 'offline'}>Jugar en el servidor</Button>
      )}
    </section>
  )
}
