import { useState, useEffect } from 'react'
import { 
  Package, Search, Download, Trash2, ShieldCheck, DownloadCloud, 
  Flame, Layers, CheckCircle2, AlertCircle, FolderOpen, RotateCw, X 
} from 'lucide-react'
import CustomDialog from './CustomDialog'

type ModItem = { 
  filename: string
  isOfficial: boolean
  size: number
  dependencies: string[]
  requiredBy: string[]
}
type PlatformType = 'modrinth' | 'curseforge'
type FilterType = 'all' | 'custom' | 'official'

type ModHit = { 
  project_id: string
  title: string
  description: string
  icon_url: string
  author: string
  downloads?: number
  platform: PlatformType
}

const POPULAR_SUGGESTIONS = ['JEI', 'JourneyMap', 'AppleSkin', 'Mouse Tweaks', 'Jade', 'Rubidium']

function formatNumber(num?: number): string {
  if (!num) return ''
  if (num >= 1_000_000) return `${(num / 1_000_000).toFixed(1)}M`
  if (num >= 1_000) return `${(num / 1_000).toFixed(0)}K`
  return `${num}`
}

export default function ModsView() {
  const [mods, setMods] = useState<ModItem[]>([])
  const [loading, setLoading] = useState(true)
  const [platform, setPlatform] = useState<PlatformType>('modrinth')
  const [search, setSearch] = useState('')
  const [hits, setHits] = useState<ModHit[]>([])
  const [searching, setSearching] = useState(false)
  const [installing, setInstalling] = useState<string | null>(null)
  const [installSuccess, setInstallSuccess] = useState<string | null>(null)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [filterText, setFilterText] = useState('')
  const [activeTab, setActiveTab] = useState<FilterType>('all')
  const [modToDelete, setModToDelete] = useState<string | null>(null)

  const loadMods = async () => {
    setLoading(true)
    try {
      const list = await window.orvian.listMods()
      setMods(list.sort((a, b) => {
        if (a.isOfficial === b.isOfficial) return a.filename.localeCompare(b.filename)
        return a.isOfficial ? 1 : -1 // Custom mods first
      }))
    } catch (e) {
      console.error(e)
    }
    setLoading(false)
  }

  useEffect(() => {
    void loadMods()
  }, [])

  const executeSearch = async (queryText: string, targetPlatform: PlatformType) => {
    if (!queryText.trim()) {
      setHits([])
      return
    }
    setSearching(true)
    setErrorMessage(null)
    try {
      if (targetPlatform === 'modrinth') {
        const res = await window.orvian.searchModrinth(queryText)
        setHits(res.hits.map(h => ({ ...h, platform: 'modrinth' })))
      } else {
        const res = await window.orvian.searchCurseForge(queryText)
        setHits(res.hits.map(h => ({ ...h, platform: 'curseforge' })))
      }
    } catch (e: any) {
      console.error(e)
      setErrorMessage(`Error al buscar en ${targetPlatform === 'modrinth' ? 'Modrinth' : 'CurseForge'}: ${e?.message || e}`)
    }
    setSearching(false)
  }

  const handleSearchSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    void executeSearch(search, platform)
  }

  const handlePlatformChange = (newPlatform: PlatformType) => {
    setPlatform(newPlatform)
    setHits([])
    if (search.trim()) {
      void executeSearch(search, newPlatform)
    }
  }

  const handleSuggestionClick = (tag: string) => {
    setSearch(tag)
    void executeSearch(tag, platform)
  }

  const installMod = async (hit: ModHit) => {
    setInstalling(hit.project_id)
    setErrorMessage(null)
    try {
      let res: { ok: boolean; filename: string; dependencies?: string[] }
      if (hit.platform === 'modrinth') {
        res = await window.orvian.installModrinth(hit.project_id)
      } else {
        res = await window.orvian.installCurseForge(hit.project_id)
      }

      let msg = `¡Mod "${res.filename}" instalado correctamente!`
      if (res.dependencies && res.dependencies.length > 0) {
        msg = `¡Mod "${res.filename}" y sus dependencias (${res.dependencies.length}) instalados correctamente!`
      }
      setInstallSuccess(msg)
      setTimeout(() => setInstallSuccess(null), 5000)
      await loadMods()
    } catch (e: any) {
      setErrorMessage(`Error al instalar mod: ${e?.message || e}`)
    }
    setInstalling(null)
  }

  const handleDeleteRequest = (filename: string) => {
    setModToDelete(filename)
  }

  const confirmDeleteMod = async () => {
    if (!modToDelete) return
    const filename = modToDelete
    setModToDelete(null)
    try {
      await window.orvian.deleteMod(filename)
      setInstallSuccess(`Mod "${filename}" eliminado correctamente.`)
      setTimeout(() => setInstallSuccess(null), 4000)
      await loadMods()
    } catch (e: any) {
      setErrorMessage(`Error al eliminar mod: ${e?.message || e}`)
    }
  }

  // Filtrado de mods instalados
  const customModsCount = mods.filter(m => !m.isOfficial).length
  const officialModsCount = mods.filter(m => m.isOfficial).length

  const filteredMods = mods.filter(m => {
    const matchesFilter = m.filename.toLowerCase().includes(filterText.toLowerCase())
    if (!matchesFilter) return false
    if (activeTab === 'custom') return !m.isOfficial
    if (activeTab === 'official') return m.isOfficial
    return true
  })

  return (
    <div className="lunar-settings animate-fade-in">
      <div className="settings-container mods-layout-container">
        
        {/* ENCABEZADO PRINCIPAL ELEGANTE */}
        <div className="mods-view-header">
          <div className="mods-header-titles">
            <h2>
              <Package size={30} className="header-icon" /> 
              Mods y Personalización
            </h2>
            <p className="mods-header-sub">
              Instala mods adicionales compatibles con Forge 1.20.1 desde Modrinth o CurseForge.
            </p>
          </div>

          <div className="mods-header-actions">
            <button 
              className="lunar-action-btn secondary" 
              onClick={() => void window.orvian.openFolder('mods')}
              title="Abrir la carpeta física de mods en el explorador"
            >
              <FolderOpen size={16} />
              <span>Abrir Carpeta</span>
            </button>
            <button 
              className="lunar-action-btn secondary icon-only" 
              onClick={() => void loadMods()}
              title="Recargar lista de mods"
            >
              <RotateCw size={16} className={loading ? 'spin-anim' : ''} />
            </button>
          </div>
        </div>

        {/* FEEDBACK BANNERS */}
        {installSuccess && (
          <div className="mod-alert-banner success">
            <CheckCircle2 size={18} />
            <span>{installSuccess}</span>
            <button className="banner-close" onClick={() => setInstallSuccess(null)}><X size={14} /></button>
          </div>
        )}

        {errorMessage && (
          <div className="mod-alert-banner error">
            <AlertCircle size={18} />
            <span>{errorMessage}</span>
            <button className="banner-close" onClick={() => setErrorMessage(null)}><X size={14} /></button>
          </div>
        )}

        {/* HUB DE BÚSQUEDA Y EXPLORACIÓN */}
        <div className="mods-hub-box">
          {/* BARRA SUPERIOR DEL BUSCADOR: SELECTOR DE PLATAFORMA */}
          <div className="mods-hub-top">
            <div className="mods-hub-title">
              <DownloadCloud size={20} className="hub-title-icon" />
              <span>Explorar Catálogo de Mods</span>
            </div>

            <div className="mod-platform-toggle-group">
              <button 
                type="button"
                className={`platform-toggle-btn modrinth ${platform === 'modrinth' ? 'active' : ''}`}
                onClick={() => handlePlatformChange('modrinth')}
              >
                <Layers size={15} />
                <span>Modrinth</span>
              </button>
              <button 
                type="button"
                className={`platform-toggle-btn curseforge ${platform === 'curseforge' ? 'active' : ''}`}
                onClick={() => handlePlatformChange('curseforge')}
              >
                <Flame size={15} />
                <span>CurseForge</span>
              </button>
            </div>
          </div>

          {/* INPUT DE BÚSQUEDA */}
          <form onSubmit={handleSearchSubmit} className="mods-search-form">
            <div className="mods-search-input-wrapper">
              <Search size={18} className="search-field-icon" />
              <input 
                type="text" 
                className="mods-search-input" 
                placeholder={`Buscar en ${platform === 'modrinth' ? 'Modrinth' : 'CurseForge'} (Forge 1.20.1)...`}
                value={search} 
                onChange={e => setSearch(e.target.value)} 
              />
              {search && (
                <button 
                  type="button" 
                  className="search-clear-btn"
                  onClick={() => { setSearch(''); setHits([]); }}
                  title="Limpiar búsqueda"
                >
                  <X size={14} />
                </button>
              )}
            </div>
            <button 
              type="submit" 
              className={`lunar-action-btn search-submit-btn ${platform === 'curseforge' ? 'curse-btn' : ''}`} 
              disabled={searching}
            >
              <Search size={16} /> 
              <span>{searching ? 'Buscando...' : 'Buscar'}</span>
            </button>
          </form>

          {/* SUGERENCIAS RÁPIDAS (ESPACIADO LIMPIO, SIN CORTES) */}
          <div className="mods-suggestions-row">
            <span className="suggestions-label">Populares:</span>
            <div className="suggestions-chips-list">
              {POPULAR_SUGGESTIONS.map(tag => (
                <button 
                  key={tag} 
                  type="button"
                  className="mod-suggestion-chip"
                  onClick={() => handleSuggestionClick(tag)}
                >
                  {tag}
                </button>
              ))}
            </div>
          </div>

          {/* RESULTADOS DE BÚSQUEDA */}
          {hits.length > 0 && (
            <div className="mod-search-results-section">
              <div className="results-header">
                <span className="results-count">
                  {hits.length} resultados en <strong>{platform === 'modrinth' ? 'Modrinth' : 'CurseForge'}</strong>
                </span>
              </div>

              <div className="mod-results-container">
                {hits.map(hit => {
                  const isInstalled = mods.some(m => 
                    m.filename.toLowerCase().includes(hit.title.toLowerCase().replace(/[^a-z0-9]/g, ''))
                  )
                  return (
                    <div key={hit.project_id} className={`mod-card ${hit.platform}`}>
                      <img 
                        src={hit.icon_url || (hit.platform === 'curseforge' ? 'https://media.forgecdn.net/avatars/thumbnails/1966/417/256/256/639215622492875415.png' : 'https://docs.modrinth.com/img/modrinth_mod.svg')} 
                        alt="" 
                        className="mod-card-icon" 
                        onError={(e) => {
                          (e.target as HTMLImageElement).src = 'https://docs.modrinth.com/img/modrinth_mod.svg'
                        }}
                      />
                      <div className="mod-card-details">
                        <div className="mod-card-title-row">
                          <h4 className="mod-card-title">{hit.title}</h4>
                          <span className={`mod-platform-tag ${hit.platform}`}>
                            {hit.platform === 'curseforge' ? <><Flame size={11} /> CurseForge</> : <><Layers size={11} /> Modrinth</>}
                          </span>
                        </div>
                        <p className="mod-card-desc">
                          {hit.description || 'Sin descripción disponible.'}
                        </p>
                        <div className="mod-card-meta">
                          <span className="mod-card-author">Por {hit.author}</span>
                          {hit.downloads ? <span>• {formatNumber(hit.downloads)} descargas</span> : null}
                          <span className="mod-version-tag">• Forge 1.20.1</span>
                        </div>
                      </div>
                      <button 
                        className={`lunar-action-btn ${hit.platform === 'curseforge' ? 'curse-btn' : ''} ${isInstalled ? 'secondary' : ''}`}
                        onClick={() => installMod(hit)} 
                        disabled={installing === hit.project_id}
                        style={{ alignSelf: 'center', minWidth: '120px' }}
                      >
                        <Download size={15} /> 
                        <span>
                          {installing === hit.project_id 
                            ? 'Bajando...' 
                            : (isInstalled ? 'Reinstalar' : 'Instalar')}
                        </span>
                      </button>
                    </div>
                  )
                })}
              </div>
            </div>
          )}
        </div>

        {/* LISTA DE MODS INSTALADOS */}
        <div className="installed-mods-section">
          <div className="installed-mods-header">
            <div className="installed-header-left">
              <h3>
                <Package size={20} color="var(--accent-primary)" />
                Mods Instalados en Orvian
              </h3>
              <span className="installed-count-pill">{mods.length}</span>
            </div>

            {/* PESTAÑAS DE FILTRO */}
            <div className="installed-filter-tabs">
              <button 
                className={`filter-tab ${activeTab === 'all' ? 'active' : ''}`}
                onClick={() => setActiveTab('all')}
              >
                Todos ({mods.length})
              </button>
              <button 
                className={`filter-tab ${activeTab === 'custom' ? 'active' : ''}`}
                onClick={() => setActiveTab('custom')}
              >
                Personalizados ({customModsCount})
              </button>
              <button 
                className={`filter-tab ${activeTab === 'official' ? 'active' : ''}`}
                onClick={() => setActiveTab('official')}
              >
                Oficiales ({officialModsCount})
              </button>
            </div>
          </div>

          <div className="installed-filter-row">
            <div className="mods-search-input-wrapper filter-wrapper">
              <Search size={16} className="search-field-icon" />
              <input 
                type="text" 
                className="mods-search-input filter-input" 
                placeholder="Filtrar por nombre de archivo..." 
                value={filterText} 
                onChange={e => setFilterText(e.target.value)} 
              />
              {filterText && (
                <button 
                  type="button" 
                  className="search-clear-btn"
                  onClick={() => setFilterText('')}
                >
                  <X size={14} />
                </button>
              )}
            </div>
          </div>

          <div className="installed-mods-list">
            {loading ? (
              <div className="empty-mods-state">
                <RotateCw size={24} className="spin-anim" />
                <span>Cargando lista de mods...</span>
              </div>
            ) : filteredMods.length === 0 ? (
              <div className="empty-mods-state">
                <span>No se encontraron mods coincidentes.</span>
              </div>
            ) : (
              filteredMods.map(mod => (
                <div key={mod.filename} className="installed-mod-card">
                  <div className="installed-mod-left">
                    {mod.isOfficial ? (
                      <span className="mod-type-icon official" title="Mod Oficial del Modpack (Protegido)">
                        <ShieldCheck size={18} />
                      </span>
                    ) : (
                      <span className="mod-type-icon custom" title="Mod Personalizado">
                        <Package size={18} />
                      </span>
                    )}
                    <div className="installed-mod-names">
                      <span className="installed-mod-filename">{mod.filename}</span>
                      <span className="installed-mod-tag">
                        {mod.isOfficial ? 'Mod Oficial' : 'Personalizado'}
                      </span>
                      {mod.dependencies && mod.dependencies.length > 0 && (
                        <span className="installed-mod-deps" title={mod.dependencies.join('\n')} style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginLeft: '8px' }}>
                          • Requiere {mod.dependencies.length} dependencias
                        </span>
                      )}
                      {mod.requiredBy && mod.requiredBy.length > 0 && (
                        <span className="installed-mod-deps" title={mod.requiredBy.join('\n')} style={{ fontSize: '0.75rem', color: 'var(--accent-primary)', marginLeft: '8px' }}>
                          • Requerido por {mod.requiredBy.length} mod(s)
                        </span>
                      )}
                    </div>
                  </div>

                  <div className="installed-mod-right">
                    <span className="installed-mod-size">
                      {(mod.size / 1024 / 1024).toFixed(2)} MB
                    </span>
                    {!mod.isOfficial && (
                      <button 
                        className="lunar-action-btn danger delete-btn" 
                        onClick={() => handleDeleteRequest(mod.filename)} 
                        title="Eliminar este mod personalizado"
                      >
                        <Trash2 size={14} />
                        <span>Eliminar</span>
                      </button>
                    )}
                  </div>
                </div>
              ))
            )}
          </div>
        </div>

      </div>

      {/* DIÁLOGO PERSONALIZADO: ELIMINAR MOD */}
      <CustomDialog
        isOpen={Boolean(modToDelete)}
        type="danger"
        title="Eliminar Mod"
        message="¿Estás seguro de que deseas eliminar este archivo de mod?"
        detail={modToDelete ? `Archivo: ${modToDelete}\n\nEl mod se borrará de forma definitiva de tu carpeta de mods y no se cargará al iniciar el juego.` : undefined}
        confirmText="Eliminar Mod"
        cancelText="Cancelar"
        onConfirm={confirmDeleteMod}
        onCancel={() => setModToDelete(null)}
      />
    </div>
  )
}
