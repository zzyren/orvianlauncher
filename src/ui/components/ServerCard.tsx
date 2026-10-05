import { Moon, RefreshCw } from 'lucide-react'
import type { ServerStatus } from '../../shared/launcher-state'
import { IconButton } from './Button'

interface ServerCardProps {
  server: ServerStatus
  onRefresh: () => void
}

const STATE_LABEL: Record<ServerStatus['state'], string> = {
  unknown: 'Sin comprobar',
  checking: 'Comprobando…',
  online: 'En línea',
  offline: 'Sin conexión',
  sleeping: 'Dormido',
  starting: 'Despertando…'
}

/** Never shows the address: the player only needs to know whether the server is ready. */
export function ServerCard({ server, onRefresh }: ServerCardProps) {
  const players = server.state === 'online' ? server.players : undefined
  const fill = players && players.max > 0 ? Math.min(1, players.online / players.max) : 0
  const latencyTone = server.latencyMs === undefined ? '' : server.latencyMs < 80 ? 'good' : server.latencyMs < 160 ? 'ok' : 'slow'

  return (
    <section className="card server-card" aria-labelledby="server-card-title">
      <div className="card-header">
        <h2 id="server-card-title" className="card-title">Servidor</h2>
        <IconButton label="Comprobar el servidor ahora" onClick={onRefresh} disabled={server.state === 'checking'}>
          <RefreshCw size={16} strokeWidth={1.75} aria-hidden="true" className={server.state === 'checking' ? 'spin' : undefined} />
        </IconButton>
      </div>
      <p className="server-status" data-state={server.state}>
        {server.state === 'sleeping' ? <Moon size={14} strokeWidth={2} className="server-moon" aria-hidden="true" /> : <span className="status-dot" aria-hidden="true" />}
        <span key={server.state} className="server-state-label">{STATE_LABEL[server.state]}</span>
        {server.state === 'online' && server.latencyMs !== undefined && <span className={`server-ping server-ping-${latencyTone}`}>{server.latencyMs} ms</span>}
      </p>
      {players && (
        <div className="server-players">
          <div className="server-players-head">
            <span>Jugadores</span>
            <span translate="no">{players.online} / {players.max}</span>
          </div>
          <div className="meter" role="img" aria-label={`${players.online} de ${players.max} jugadores`}>
            <span className="meter-fill" style={{ transform: `scaleX(${fill})` }} />
          </div>
        </div>
      )}
      {server.state === 'online' && server.motd && <p className="server-motd selectable">{server.motd}</p>}
      {server.state === 'online' && server.version && <p className="server-version" translate="no">{server.version}</p>}
      {server.state === 'sleeping' && <p className="server-motd">El servidor duerme para ahorrar recursos. Se despertará al pulsar Jugar; tardará cerca de un minuto y esperarás en una sala de espera.</p>}
      {server.state === 'starting' && <p className="server-motd">El servidor está arrancando. Puedes pulsar Jugar: entrarás en cuanto esté listo.</p>}
      {server.state === 'offline' && <p className="server-motd">No se pudo contactar con el servidor. Comprueba tu conexión.</p>}
    </section>
  )
}
