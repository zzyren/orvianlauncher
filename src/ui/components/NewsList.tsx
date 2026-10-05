import type { NewsItem } from '../../shared/launcher-state'

const relative = new Intl.RelativeTimeFormat('es', { numeric: 'auto' })

/** "hace 3 días": the news come from release dates, so a coarse unit is enough. */
export function relativeDate(iso: string | undefined, now = Date.now()): string {
  if (!iso) return ''
  const time = Date.parse(iso)
  if (Number.isNaN(time)) return ''
  const days = Math.round((time - now) / 86_400_000)
  if (Math.abs(days) < 1) return 'hoy'
  if (Math.abs(days) < 30) return relative.format(days, 'day')
  if (Math.abs(days) < 365) return relative.format(Math.round(days / 30), 'month')
  return relative.format(Math.round(days / 365), 'year')
}

/** Changelog of the current pack version and the three before it. Always rendered as text. */
export function NewsList({ items }: { items: NewsItem[] }) {
  return (
    <section className="card news-card" aria-labelledby="news-title">
      <h2 id="news-title" className="card-title">Novedades</h2>
      {items.length === 0 ? (
        <p className="empty-note">Aún no hay novedades publicadas.</p>
      ) : (
        <div className="news-list">
          {items.map((item, index) => (
            <details key={item.version} className="news-item" open={index === 0}>
              <summary>
                <span className="news-version" translate="no">v{item.version}</span>
                <span className="news-date">{relativeDate(item.publishedAt)}</span>
              </summary>
              {item.notes.length === 0 ? (
                <p className="empty-note">Sin notas para esta versión.</p>
              ) : (
                <ul className="news-notes">
                  {item.notes.map((note, noteIndex) => <li key={noteIndex}>{note}</li>)}
                </ul>
              )}
            </details>
          ))}
        </div>
      )}
    </section>
  )
}
