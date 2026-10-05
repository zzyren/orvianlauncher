import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react'
import { Download, FolderOpen, Package, RotateCw, Search, ShieldCheck, Trash2, X } from 'lucide-react'
import type { InstalledMod, ModPlatform, ModSearchHit } from '../../shared/ipc-contract'
import { formatBytes } from '../../shared/format'
import { Badge } from '../components/Badge'
import { Button, IconButton } from '../components/Button'
import { ConfirmDialog } from '../components/Dialog'
import { cx } from '../components/cx'
import { useToast } from '../components/Toast'
import { ipcErrorMessage } from '../ipcError'

type Tab = 'installed' | 'explore'
type Filter = 'all' | 'custom' | 'official'
type Hit = ModSearchHit & { platform: ModPlatform }

const SUGGESTIONS = ['JEI', 'JourneyMap', 'AppleSkin', 'Mouse Tweaks', 'Jade', 'Rubidium']
const PLATFORM_NAME: Record<ModPlatform, string> = { modrinth: 'Modrinth', curseforge: 'CurseForge' }

function formatCount(value?: number): string {
  if (!value) return ''
  return new Intl.NumberFormat('es', { notation: 'compact', maximumFractionDigits: 1 }).format(value)
}

export default function Mods({ gameBusy }: { gameBusy: boolean }) {
  const toast = useToast()
  const [tab, setTab] = useState<Tab>('installed')
  const [mods, setMods] = useState<InstalledMod[] | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [installing, setInstalling] = useState<Set<string>>(new Set())
  const [toDelete, setToDelete] = useState<InstalledMod | null>(null)

  const load = useCallback(async () => {
    setLoadError(null)
    try {
      const list = await window.orvian.listMods()
      setMods([...list].sort((a, b) => (a.isOfficial === b.isOfficial ? a.filename.localeCompare(b.filename) : a.isOfficial ? 1 : -1)))
    } catch (err) {
      setLoadError(ipcErrorMessage(err))
      setMods((current) => current ?? [])
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const installedKeys = useMemo(() => new Set((mods ?? []).filter((m) => m.projectId && m.platform).map((m) => `${m.platform}:${m.projectId}`)), [mods])

  const install = async (hit: Hit): Promise<void> => {
    const key = `${hit.platform}:${hit.project_id}`
    setInstalling((current) => new Set(current).add(key))
    try {
      const result = hit.platform === 'modrinth' ? await window.orvian.installModrinth(hit.project_id) : await window.orvian.installCurseForge(hit.project_id)
      const failed = result.failedDependencies?.length ?? 0
      const extra = result.dependencies?.length ? ` y ${result.dependencies.length} ${result.dependencies.length === 1 ? 'dependencia' : 'dependencias'}` : ''
      toast({ kind: failed > 0 ? 'error' : 'success', message: failed > 0 ? `${result.filename} instalado, pero ${failed} ${failed === 1 ? 'dependencia no se pudo instalar' : 'dependencias no se pudieron instalar'}: puede que el mod no arranque.` : `${result.filename}${extra} instalado.` })
      await load()
    } catch (err) {
      toast({ kind: 'error', message: `No se pudo instalar ${hit.title}. ${ipcErrorMessage(err)}` })
    } finally {
      setInstalling((current) => {
        const next = new Set(current)
        next.delete(key)
        return next
      })
    }
  }

  const confirmDelete = async (): Promise<void> => {
    const mod = toDelete
    setToDelete(null)
    if (!mod) return
    try {
      await window.orvian.deleteMod(mod.filename)
      toast({ kind: 'success', message: `${mod.filename} eliminado.` })
      await load()
    } catch (err) {
      toast({ kind: 'error', message: `No se pudo eliminar ${mod.filename}. ${ipcErrorMessage(err)}` })
    }
  }

  return (
    <div className="view view-enter">
      <div className="view-inner">
        <div className="view-header">
          <div>
            <h1 className="view-title">Mods</h1>
            <p className="view-lead">Añade mods compatibles con Forge 1.20.1 desde Modrinth o CurseForge. Los mods del modpack no se pueden quitar.</p>
          </div>
          <div className="button-row">
            <Button icon={<FolderOpen size={16} strokeWidth={1.75} aria-hidden="true" />} onClick={() => void window.orvian.openFolder('mods')}>Abrir carpeta</Button>
            <IconButton label="Recargar la lista de mods" onClick={() => void load()}>
              <RotateCw size={16} strokeWidth={1.75} aria-hidden="true" className={mods === null ? 'spin' : undefined} />
            </IconButton>
          </div>
        </div>

        <div className="tabs" role="tablist" aria-label="Mods">
          {(['installed', 'explore'] as const).map((id) => (
            <button key={id} type="button" role="tab" id={`mods-tab-${id}`} aria-selected={tab === id} aria-controls={`mods-panel-${id}`} tabIndex={tab === id ? 0 : -1} className="tab" onClick={() => setTab(id)}
              onKeyDown={(event) => {
                if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
                  event.preventDefault()
                  const next = id === 'installed' ? 'explore' : 'installed'
                  setTab(next)
                  document.getElementById(`mods-tab-${next}`)?.focus()
                }
              }}>
              {id === 'installed' ? `Instalados${mods ? ` (${mods.length})` : ''}` : 'Explorar'}
            </button>
          ))}
        </div>

        {gameBusy && <p className="notice notice-info" role="status">Las instalaciones y los borrados se aplican a la carpeta de mods; si el juego está abierto, los cambios se verán al volver a iniciarlo.</p>}

        <div role="tabpanel" id="mods-panel-installed" aria-labelledby="mods-tab-installed" hidden={tab !== 'installed'}>
          {tab === 'installed' && <InstalledList mods={mods} loadError={loadError} onDelete={setToDelete} onExplore={() => setTab('explore')} />}
        </div>
        <div role="tabpanel" id="mods-panel-explore" aria-labelledby="mods-tab-explore" hidden={tab !== 'explore'}>
          {tab === 'explore' && <Explore installedKeys={installedKeys} installing={installing} onInstall={(hit) => void install(hit)} />}
        </div>
      </div>

      <ConfirmDialog
        open={toDelete !== null}
        destructive
        title="¿Eliminar este mod?"
        description={toDelete ? <><code className="selectable" translate="no">{toDelete.filename}</code> se borrará de tu carpeta de mods y dejará de cargarse al jugar.</> : undefined}
        confirmLabel="Eliminar"
        onCancel={() => setToDelete(null)}
        onConfirm={() => void confirmDelete()}
      >
        {toDelete && toDelete.requiredBy.length > 0 && (
          <p className="notice notice-warning">Lo necesitan estos mods, que pueden dejar de funcionar: {toDelete.requiredBy.join(', ')}.</p>
        )}
      </ConfirmDialog>
    </div>
  )
}

// ─── Installed ───────────────────────────────────────────────────────────────

function InstalledList({ mods, loadError, onDelete, onExplore }: { mods: InstalledMod[] | null; loadError: string | null; onDelete: (mod: InstalledMod) => void; onExplore: () => void }) {
  const [filter, setFilter] = useState<Filter>('all')
  const [text, setText] = useState('')

  if (mods === null) {
    return (
      <div className="skeleton-list" aria-busy="true" aria-label="Cargando los mods instalados">
        {Array.from({ length: 6 }, (_, index) => <div key={index} className="skeleton-row" />)}
      </div>
    )
  }

  const custom = mods.filter((m) => !m.isOfficial).length
  const shown = mods.filter((m) => m.filename.toLowerCase().includes(text.trim().toLowerCase()) && (filter === 'all' || (filter === 'custom' ? !m.isOfficial : m.isOfficial)))

  return (
    <>
      {loadError && <p className="notice notice-danger" role="alert">No se pudo leer la carpeta de mods. {loadError}</p>}
      <div className="list-toolbar">
        <div className="segmented" role="group" aria-label="Filtrar mods">
          {([['all', `Todos (${mods.length})`], ['custom', `Tuyos (${custom})`], ['official', `Del modpack (${mods.length - custom})`]] as const).map(([id, label]) => (
            <button key={id} type="button" className="segment" aria-pressed={filter === id} onClick={() => setFilter(id)}>{label}</button>
          ))}
        </div>
        <SearchBox label="Filtrar por nombre de archivo" value={text} onChange={setText} />
      </div>

      {custom === 0 && filter === 'custom' && !text ? (
        <div className="empty-state">
          <Package size={28} strokeWidth={1.75} aria-hidden="true" />
          <p className="empty-title">Todavía no has añadido mods</p>
          <p className="empty-text">El modpack ya incluye lo necesario para jugar. Aquí aparecerán los que instales tú.</p>
          <Button variant="primary" onClick={onExplore}>Explorar mods</Button>
        </div>
      ) : shown.length === 0 ? (
        <div className="empty-state">
          <p className="empty-title">{text ? 'Ningún mod coincide con el filtro' : 'No hay mods en esta lista'}</p>
        </div>
      ) : (
        <ul className="mod-list">
          {shown.map((mod) => (
            <li key={mod.filename} className="mod-row">
              <span className={cx('mod-icon', mod.isOfficial && 'mod-icon-official')} aria-hidden="true">
                {mod.isOfficial ? <ShieldCheck size={18} strokeWidth={1.75} /> : <Package size={18} strokeWidth={1.75} />}
              </span>
              <div className="mod-info">
                <span className="mod-name selectable" translate="no">{mod.filename}</span>
                <span className="mod-meta">
                  <Badge tone={mod.isOfficial ? 'info' : 'accent'}>{mod.isOfficial ? 'Del modpack' : 'Personalizado'}</Badge>
                  {mod.platform && <Badge>{PLATFORM_NAME[mod.platform]}</Badge>}
                  <span>{formatBytes(mod.size)}</span>
                  {mod.dependencies.length > 0 && <span title={mod.dependencies.join('\n')}>Requiere {mod.dependencies.length}</span>}
                  {mod.requiredBy.length > 0 && <span title={mod.requiredBy.join('\n')}>Lo necesitan {mod.requiredBy.length}</span>}
                </span>
              </div>
              {!mod.isOfficial && (
                <IconButton label={`Eliminar ${mod.filename}`} onClick={() => onDelete(mod)}>
                  <Trash2 size={16} strokeWidth={1.75} aria-hidden="true" />
                </IconButton>
              )}
            </li>
          ))}
        </ul>
      )}
    </>
  )
}

function SearchBox({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) {
  return (
    <div className="search-box">
      <Search size={16} strokeWidth={1.75} aria-hidden="true" className="search-icon" />
      <input type="search" className="input search-input" aria-label={label} placeholder={`${label}…`} value={value} autoComplete="off" onChange={(e) => onChange(e.target.value)} />
      {value && (
        <IconButton label="Limpiar" className="search-clear" onClick={() => onChange('')}>
          <X size={14} strokeWidth={1.75} aria-hidden="true" />
        </IconButton>
      )}
    </div>
  )
}

// ─── Explore ─────────────────────────────────────────────────────────────────

function Explore({ installedKeys, installing, onInstall }: { installedKeys: Set<string>; installing: Set<string>; onInstall: (hit: Hit) => void }) {
  const [platform, setPlatform] = useState<ModPlatform>('modrinth')
  const [query, setQuery] = useState('')
  const [searched, setSearched] = useState<{ query: string; platform: ModPlatform } | null>(null)
  const [hits, setHits] = useState<Hit[]>([])
  const [searching, setSearching] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const search = async (text: string, target: ModPlatform): Promise<void> => {
    const clean = text.trim()
    if (!clean) {
      setHits([])
      setSearched(null)
      return
    }
    setSearching(true)
    setError(null)
    try {
      const result = target === 'modrinth' ? await window.orvian.searchModrinth(clean) : await window.orvian.searchCurseForge(clean)
      setHits(result.hits.map((hit) => ({ ...hit, platform: target })))
      setSearched({ query: clean, platform: target })
    } catch (err) {
      setHits([])
      setError(`No se pudo buscar en ${PLATFORM_NAME[target]}. ${ipcErrorMessage(err)}`)
    } finally {
      setSearching(false)
    }
  }

  const submit = (event: FormEvent): void => {
    event.preventDefault()
    void search(query, platform)
  }

  const changePlatform = (next: ModPlatform): void => {
    setPlatform(next)
    setHits([])
    setSearched(null)
    if (query.trim()) void search(query, next)
  }

  return (
    <div className="explore">
      <div className="segmented" role="group" aria-label="Catálogo">
        {(['modrinth', 'curseforge'] as const).map((id) => (
          <button key={id} type="button" className="segment" aria-pressed={platform === id} onClick={() => changePlatform(id)}>{PLATFORM_NAME[id]}</button>
        ))}
      </div>

      <form className="explore-form" onSubmit={submit} role="search">
        <SearchBox label={`Buscar en ${PLATFORM_NAME[platform]}`} value={query} onChange={setQuery} />
        <Button type="submit" variant="primary" icon={<Search size={16} strokeWidth={1.75} aria-hidden="true" />} loading={searching}>Buscar</Button>
      </form>

      <div className="chip-row">
        <span className="chip-label">Populares</span>
        {SUGGESTIONS.map((tag) => (
          <button key={tag} type="button" className="chip" onClick={() => { setQuery(tag); void search(tag, platform) }}>{tag}</button>
        ))}
      </div>

      <div role="status" className="visually-hidden">{searched ? `${hits.length} resultados para ${searched.query}` : ''}</div>
      {error && <p className="notice notice-danger" role="alert">{error}</p>}

      {searched && hits.length === 0 && !error && (
        <div className="empty-state"><p className="empty-title">Sin resultados para «{searched.query}»</p><p className="empty-text">Prueba con otro nombre o cambia de catálogo.</p></div>
      )}

      <ul className="hit-list">
        {hits.map((hit) => {
          const key = `${hit.platform}:${hit.project_id}`
          const installed = installedKeys.has(key)
          const busy = installing.has(key)
          return (
            <li key={key} className="hit-row">
              <ModIcon src={hit.icon_url} title={hit.title} />
              <div className="hit-info">
                <h2 className="hit-title" translate="no">{hit.title}</h2>
                <p className="hit-desc">{hit.description || 'Sin descripción.'}</p>
                <p className="hit-meta">Por {hit.author}{hit.downloads ? ` · ${formatCount(hit.downloads)} descargas` : ''}</p>
              </div>
              <Button variant={installed ? 'secondary' : 'primary'} icon={<Download size={16} strokeWidth={1.75} aria-hidden="true" />} loading={busy} disabled={installed} aria-label={installed ? `${hit.title} ya está instalado` : `Instalar ${hit.title}`} onClick={() => onInstall(hit)}>
                {busy ? 'Instalando…' : installed ? 'Instalado' : 'Instalar'}
              </Button>
            </li>
          )
        })}
      </ul>
    </div>
  )
}

function ModIcon({ src, title }: { src: string; title: string }) {
  const [failed, setFailed] = useState(false)
  return src && !failed ? (
    <img className="hit-icon" src={src} alt="" width={48} height={48} loading="lazy" onError={() => setFailed(true)} />
  ) : (
    <span className="hit-icon hit-icon-fallback" aria-hidden="true">{title.trim().charAt(0).toUpperCase() || '?'}</span>
  )
}
