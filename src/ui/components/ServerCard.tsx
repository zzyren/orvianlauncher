import { RefreshCw } from 'lucide-react'
import type { ServerStatus } from '../../shared/launcher-state'
import { Button, IconButton } from './Button'

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
      {onPlay && (
        <Button variant="secondary" onClick={onPlay} disabled={server.state === 'offline'}>Jugar en el servidor</Button>
      )}
    </section>
  )
}
