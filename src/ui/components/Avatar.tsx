import { useState } from 'react'

/** Player head from minotar; falls back to the initial when it cannot load (offline, blocked). */
export function Avatar({ uuid, name, size = 20 }: { uuid?: string | null; name?: string | null; size?: 20 | 32 | 48 }) {
  const [failed, setFailed] = useState(false)
  const initial = (name ?? '?').trim().charAt(0).toUpperCase() || '?'
  return (
    <span className="avatar" style={{ width: size, height: size }} aria-hidden="true">
      {uuid && !failed ? (
        <img src={`https://minotar.net/helm/${uuid}/${size * 2}.png`} alt="" width={size} height={size} onError={() => setFailed(true)} draggable={false} />
      ) : (
        <span className="avatar-initial" style={{ fontSize: Math.round(size * 0.5) }}>{initial}</span>
      )}
    </span>
  )
}
