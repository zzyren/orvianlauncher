import { useEffect, useRef, useState, useCallback } from 'react'
import { LogIn, LogOut, HardDrive, Wrench, X, Link2, Shield, Trash2, UploadCloud, FileArchive, CheckCircle2, ExternalLink, Minus, Square, Copy, Power, Loader2, RefreshCw } from 'lucide-react'
import CustomDialog from './CustomDialog'
import { ipcErrorMessage } from './ipcError'

type Status = { 
  appVersion: string
  packVersion: string | null
  installedVersion?: string | null
  hasUpdate?: boolean
  ready: boolean
  authenticated: boolean
  playerName: string | null
  playerUuid: string | null
  isAdmin: boolean
  ramGb: number
  configured: boolean 
  isPlaying?: boolean
}
type View = 'home' | 'settings' | 'admin' | 'mods'

import ModsView from './Mods'
import UpdaterDialog from './UpdaterDialog'

export default function App() {
  const [view, setView] = useState<View>('home')
  const [status, setStatus] = useState<Status | null>(null)
  const [message, setMessage] = useState('Verificando instalación...')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [ram, setRam] = useState(6)
  const [isMaximized, setIsMaximized] = useState(false)
  const [mcPromptOpen, setMcPromptOpen] = useState(false)
  const [factoryResetDialogOpen, setFactoryResetDialogOpen] = useState(false)
  const [logoTilt, setLogoTilt] = useState({ x: 0, y: 0 })
  const [checkingUpdate, setCheckingUpdate] = useState(false)
  const [updateCheckResult, setUpdateCheckResult] = useState<string | null>(null)

  const handleSplashMouseMove = (e: React.MouseEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect()
    const centerX = rect.left + rect.width / 2
    const centerY = rect.top + rect.height / 2
    const normX = (e.clientX - centerX) / (rect.width / 2)
    const normY = (e.clientY - centerY) / (rect.height / 2)
    setLogoTilt({
      x: Math.max(-7, Math.min(7, -normY * 7)),
      y: Math.max(-9, Math.min(9, normX * 9))
    })
  }

  const handleSplashMouseLeave = () => {
    setLogoTilt({ x: 0, y: 0 })
  }

  // Estados del publicador de updates (Admin)
  const [mrpackFile, setMrpackFile] = useState<{ selectionId: string; name: string } | null>(null)
  const [newVersion, setNewVersion] = useState('')
  const [changelog, setChangelog] = useState('')
  const [overwrite, setOverwrite] = useState(false)
  const [minimumLauncher, setMinimumLauncher] = useState('')
  const [tokenInput, setTokenInput] = useState('')
  const [tokenStatus, setTokenStatus] = useState<{ hasToken: boolean; canEncrypt: boolean } | null>(null)
  const [tokenBusy, setTokenBusy] = useState(false)
  const [tokenMessage, setTokenMessage] = useState<string | null>(null)
  // Older versions kept the publishing token in localStorage. Take it out of there immediately and
  // hand it to the main process (encrypted) the first time the admin panel opens.
  const legacyTokenRef = useRef('')
  useEffect(() => {
    // In an effect (not during render) so React StrictMode's double invocation cannot lose the value.
    const legacy = localStorage.getItem('orvian_admin_gh_token')
    if (legacy) {
      legacyTokenRef.current = legacy
      localStorage.removeItem('orvian_admin_gh_token')
    }
  }, [])
  const [publishSuccess, setPublishSuccess] = useState<string | null>(null)
  const [publishStep, setPublishStep] = useState<string | null>(null)
  const [publishError, setPublishError] = useState<string | null>(null)

  // ─── refreshStatus: obtiene el estado actual del launcher ────────────────
  const refreshStatus = useCallback((fresh = false) => {
    void window.orvian.getStatus(fresh ? { fresh: true } : undefined).then((s) => { 
      setStatus(s)
      setRam(s.ramGb)
      if (!busy) {
        if (s.hasUpdate) {
          setMessage(`Actualización disponible: v${s.packVersion}`)
        } else {
          setMessage(s.ready ? 'Listo para jugar' : (s.authenticated ? 'Preparando...' : 'Inicia sesión para jugar'))
        }
      }
    }).catch(() => setMessage('Error de lectura'))
  }, [busy])

  // ─── Comprobación manual de actualización del modpack ────────────────────
  const handleCheckModpackUpdate = useCallback(async () => {
    if (checkingUpdate) return
    setCheckingUpdate(true)
    setUpdateCheckResult(null)
    try {
      const result = await window.orvian.checkForUpdates()
      setUpdateCheckResult(result.message)
      // Actualizar status con los nuevos datos
      refreshStatus(false)
    } catch {
      setUpdateCheckResult('Error al comprobar actualizaciones.')
    } finally {
      setCheckingUpdate(false)
    }
  }, [checkingUpdate, refreshStatus])

  useEffect(() => {
    if (window.location.hash !== '#tray') {
      window.orvian.appReady?.()
    }
    refreshStatus()

    const unsubWin = window.orvian.onWindowState?.((max) => setIsMaximized(max))
    const unsubMcPrompt = window.orvian.onPromptMcQuit?.(() => {
      setMcPromptOpen(true)
    })

    // ─── Suscripción al canal dedicado pack:status ─────────────────────────
    // El main process lo emite cuando el background polling detecta un cambio.
    // Esto evita que el usuario tenga que reiniciar el launcher para ver la update.
    const unsubPackStatus = window.orvian.onPackStatus?.((packStatus) => {
      setStatus(prev => {
        if (!prev) return prev
        const changed = prev.hasUpdate !== packStatus.hasUpdate || 
                        prev.packVersion !== packStatus.latestVersion ||
                        prev.installedVersion !== packStatus.installedVersion
        if (!changed) return prev
        const next = {
          ...prev,
          packVersion: packStatus.latestVersion,
          installedVersion: packStatus.installedVersion,
          hasUpdate: packStatus.hasUpdate
        }
        // Actualizar mensaje si no estamos ocupados
        if (!busy) {
          if (packStatus.hasUpdate) {
            setMessage(`Actualización disponible: v${packStatus.latestVersion}`)
          } else if (prev.ready) {
            setMessage('Listo para jugar')
          }
        }
        return next
      })
    })

    const unsubProgress = window.orvian.onProgress((event) => {
      if (event.state !== 'playing' && event.state !== 'done' && event.state !== 'error' && event.state !== 'idle') {
        setMessage(event.detail)
        if (event.state !== 'publishing') setBusy(true)
      } else {
        setBusy(false)
      }
      if (event.state === 'publishing') {
        setPublishStep(event.detail)
      }
      if (event.state === 'playing' || event.state === 'error' || event.state === 'done') {
        refreshStatus()
      }
      setError(null)
    })

    // ─── Recomprobar al ganar el foco de la ventana ────────────────────────
    // Esto garantiza que si el launcher estuvo en segundo plano y se publicó
    // una nueva versión, la UI se actualice al volver a enfocarla.
    const handleWindowFocus = () => {
      // Usar getStatus sin forceRefresh (usa caché si < 1 min)
      // El polling en background ya habrá enviado pack:status si hay cambios
      refreshStatus()
    }
    window.addEventListener('focus', handleWindowFocus)

    return () => {
      unsubWin?.()
      unsubMcPrompt?.()
      unsubPackStatus?.()
      unsubProgress?.()
      window.removeEventListener('focus', handleWindowFocus)
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (status?.isPlaying) {
      const timer = setInterval(() => refreshStatus(), 3000)
      return () => clearInterval(timer)
    }
  }, [status?.isPlaying, refreshStatus])

  async function run(action: () => Promise<{ ok?: boolean; message?: string }>, activeMessage: string) {
    setBusy(true)
    setMessage(activeMessage)
    setError(null)
    try { 
      const result = await action()
      if (result.ok) {
        refreshStatus()
      } else {
        setError(result.message ?? 'Pendiente de configuración')
        setMessage('Error')
      }
    }
    catch (err) { 
      const msg = err instanceof Error ? err.message : 'Error inesperado'
      setError(msg)
      setMessage('Error')
    }
    finally { 
      setBusy(false) 
    }
  }

  const handleFactoryReset = () => {
    setFactoryResetDialogOpen(true)
  }

  const executeFactoryReset = async () => {
    setBusy(true)
    setMessage('Restableciendo todo de fábrica...')
    setError(null)
    try {
      localStorage.clear()
      sessionStorage.clear()
      setTokenInput('')
      setMrpackFile(null)
      setNewVersion('')
      setChangelog('')
      setPublishSuccess(null)
      setPublishError(null)

      const result = await window.orvian.resetInstallation({ deleteWorlds: false })
      if (result.ok) {
        setView('home')
        setRam(6)
        setStatus(null)
        refreshStatus()
        setMessage('Launcher restablecido como nuevo.')
      } else {
        setError(result.message || 'No se pudo restablecer')
        setMessage('Error al restablecer')
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error al restablecer')
      setMessage('Error')
    } finally {
      setBusy(false)
    }
  }

  const saveToken = async () => {
    setTokenBusy(true)
    setTokenMessage(null)
    try {
      const result = await window.orvian.adminSetToken(tokenInput.trim())
      setTokenInput('')
      setTokenStatus(await window.orvian.adminTokenStatus())
      setTokenMessage(result.verified ? 'Token guardado y verificado.' : 'Token guardado. No se pudo comprobar su acceso (¿sin conexión?).')
    } catch (err) {
      setTokenMessage(ipcErrorMessage(err))
    } finally {
      setTokenBusy(false)
    }
  }

  const removeToken = async () => {
    setTokenBusy(true)
    setTokenMessage(null)
    try {
      await window.orvian.adminClearToken()
      setTokenStatus(await window.orvian.adminTokenStatus())
    } catch (err) {
      setTokenMessage(ipcErrorMessage(err))
    } finally {
      setTokenBusy(false)
    }
  }

  const ready = status?.ready ?? false
  const isAdmin = status?.isAdmin ?? false

  useEffect(() => {
    if (view !== 'admin' || !isAdmin) return
    void (async () => {
      try {
        const legacy = legacyTokenRef.current
        legacyTokenRef.current = ''
        if (legacy) {
          // A token that no longer works is simply dropped: it was already removed from localStorage.
          await window.orvian.adminSetToken(legacy).catch(() => undefined)
        }
        setTokenStatus(await window.orvian.adminTokenStatus())
      } catch (err) {
        setTokenMessage(ipcErrorMessage(err))
      }
    })()
  }, [view, isAdmin])

  return (
    <div className="lunar-shell">
      {/* BARRA SUPERIOR */}
      <nav className="lunar-topbar">
        <div className="topbar-left">
          <img src="./logo.png" alt="Orvian" className="lunar-logo-img" />
          <span className="lunar-logo-text">Orvian</span>
        </div>
        
        <div className="topbar-center">
          <button className={view === 'home' ? 'tab active' : 'tab'} onClick={() => setView('home')}>Inicio</button>
          <button className={view === 'mods' ? 'tab active' : 'tab'} onClick={() => setView('mods')}>Mods</button>
          <button className={view === 'settings' ? 'tab active' : 'tab'} onClick={() => setView('settings')}>Ajustes</button>
          {isAdmin && (
            <button className={`tab admin-tab ${view === 'admin' ? 'active' : ''}`} onClick={() => setView('admin')}>
              <Shield size={14} /> Admin
            </button>
          )}
        </div>

        <div className="topbar-right">
          <button 
            className="topbar-icon-btn" 
            title="Minimizar"
            onClick={() => void window.orvian.minimizeWindow()}
          >
            <Minus size={15} />
          </button>
          <button 
            className="topbar-icon-btn" 
            title={isMaximized ? "Restaurar" : "Maximizar"}
            onClick={async () => {
              const max = await window.orvian.toggleMaximizeWindow()
              setIsMaximized(max)
            }}
          >
            {isMaximized ? <Copy size={13} style={{ transform: 'rotate(90deg)' }} /> : <Square size={13} />}
          </button>
          <button 
            className="topbar-icon-btn close-btn" 
            title="Minimizar a la bandeja del sistema"
            onClick={() => void window.orvian.closeWindow()}
          >
            <X size={16} />
          </button>
        </div>
      </nav>

      <main className="lunar-main">
        {view === 'home' && (
          <div className="lunar-home animate-fade-in">
            <div 
              className="splash-area"
              onMouseMove={handleSplashMouseMove}
              onMouseLeave={handleSplashMouseLeave}
            >
              <div className="launch-container">
                {/* LOGO HERO FLOTANTE CELESTIAL Y ARMONIOSO */}
                <div 
                  className="hero-logo-wrapper"
                  style={{
                    transform: `perspective(1000px) rotateX(${logoTilt.x}deg) rotateY(${logoTilt.y}deg)`
                  }}
                >
                  <div className="hero-emblem-stage">
                    {/* HALO CÓSMICO RADIANTE (SE MUEVE EN PLENA ARMONÍA CON EL LOGO) */}
                    <div className="hero-emblem-aura" />
                    <div className="hero-emblem-sheen" />

                    {/* EMBLEMA PLANETARIO FLOTANTE */}
                    <img 
                      src="./logo.png" 
                      alt="Orvian" 
                      className="hero-floating-logo" 
                      draggable={false}
                    />
                  </div>

                  {/* TIPOGRAFÍA DE MARCA HERO */}
                  <div className="hero-brand-block">
                    <h1 className="hero-brand-name">ORVIAN</h1>
                    <div className="hero-brand-meta">
                      <span className="hero-badge-pill">CLIENTE OFICIAL</span>
                      <span className="hero-badge-version">v{status?.appVersion ?? '0.1.0'}</span>
                    </div>
                  </div>

                  {/* SOMBRA 3D SINCRONIZADA */}
                  <div 
                    className="hero-logo-shadow"
                    style={{
                      transform: `translateX(${-logoTilt.y * 1.2}px)`
                    }}
                  />
                </div>

                <button 
                  className={`launch-btn ${!ready || busy || status?.isPlaying ? 'disabled' : ''} ${busy ? 'busy' : ''} ${error ? 'has-error' : ''}`}
                  disabled={busy || !ready || status?.isPlaying}
                  onClick={() => void run(() => window.orvian.play(), 'Preparando Java 17...')}
                >
                  {busy && (
                    <div className="launch-btn-progress-track">
                      <div className="launch-btn-progress-fill" />
                    </div>
                  )}
                  <div className="launch-text">
                    {busy ? 'PREPARANDO...' : (status?.isPlaying ? 'JUGANDO...' : (error ? 'REINTENTAR' : (status?.hasUpdate ? 'ACTUALIZAR' : 'JUGAR')))}
                  </div>
                  <div className="launch-subtext">
                    {busy ? (
                      <>
                        <Loader2 size={12} className="launch-spinner" />
                        <span>{message}</span>
                      </>
                    ) : (
                      <>
                        <Link2 size={12} />
                        <span>
                          {status?.isPlaying 
                            ? 'Minecraft está en ejecución' 
                            : (status?.hasUpdate 
                              ? `NUEVA VERSIÓN v${status.packVersion}` 
                              : (ready 
                                ? 'LISTO PARA JUGAR' 
                                : (status?.authenticated ? 'CONFIGURANDO' : 'INICIA SESIÓN PARA JUGAR')))}
                        </span>
                      </>
                    )}
                  </div>
                </button>

                {error && !busy && (
                  <div className="error-message">
                    <span>⚠ {error}</span>
                  </div>
                )}
              </div>
            </div>

            <div className="home-footer">
              <div className="footer-left">
                {status?.authenticated ? (
                  <div className="account-badge">
                    <img src={`https://minotar.net/helm/${status?.playerUuid ?? 'Steve'}/32.png`} alt="Skin" />
                    <span>{status?.playerName ?? 'Sesión iniciada'}</span>
                  </div>
                ) : (
                  <button className="login-link" onClick={() => void run(() => window.orvian.login(), 'Conectando...')} disabled={busy}>
                    <LogIn size={14} /> Iniciar sesión con Microsoft
                  </button>
                )}
              </div>
              <div className="footer-right">
                <span>Orvian v{status?.appVersion ?? '0.1.0'}{status?.packVersion ? ` • Pack v${status.packVersion}` : ''}</span>
              </div>
            </div>
          </div>
        )}

        {view === 'mods' && <ModsView />}

        {view === 'settings' && (
          <div className="lunar-settings animate-fade-in">
            <div className="settings-container">
              <h2>Ajustes</h2>
              
              <div className="settings-grid">
                <div className="settings-box">
                  <h3>Memoria RAM</h3>
                  <p className="setting-desc">Memoria máxima para Minecraft. 6 GB suele ser suficiente.</p>
                  <div className="ram-control">
                    <div className="ram-value">{ram} GB</div>
                    <input 
                      type="range" min="2" max="12" step="1" 
                      value={ram} 
                      onChange={(e) => setRam(Number(e.target.value))} 
                      onMouseUp={() => void window.orvian.setRam(ram)} 
                      onTouchEnd={() => void window.orvian.setRam(ram)}
                    />
                  </div>
                </div>

                <div className="settings-box">
                  <h3>Actualizaciones del Modpack</h3>
                  <p className="setting-desc">
                    {status?.installedVersion
                      ? `Versión instalada: v${status.installedVersion}${status.packVersion ? ` • Última: v${status.packVersion}` : ''}`
                      : 'Comprueba si hay una nueva versión del modpack disponible.'}
                  </p>
                  <div className="diag-actions">
                    <button 
                      className="lunar-action-btn" 
                      onClick={() => void handleCheckModpackUpdate()}
                      disabled={checkingUpdate || busy}
                    >
                      {checkingUpdate ? <Loader2 size={14} className="launch-spinner" /> : <RefreshCw size={14} />}
                      {checkingUpdate ? 'Comprobando...' : 'Buscar actualizaciones'}
                    </button>
                  </div>
                  {updateCheckResult && (
                    <p className="setting-desc" style={{ marginTop: 8, color: status?.hasUpdate ? 'var(--color-accent)' : 'var(--color-text-muted)' }}>
                      {updateCheckResult}
                    </p>
                  )}
                </div>

                <div className="settings-box">
                  <h3>Diagnóstico</h3>
                  <div className="diag-actions">
                    <button className="lunar-action-btn" onClick={() => void run(() => window.orvian.repair(), 'Reparando...')}>
                      <Wrench size={14} /> Reparar instalación
                    </button>
                    <button className="lunar-action-btn" onClick={() => void window.orvian.openFolder('logs')}>
                      <HardDrive size={14} /> Ver registros
                    </button>
                    <button 
                      className="lunar-action-btn danger" 
                      onClick={() => void handleFactoryReset()}
                      disabled={busy}
                    >
                      <Trash2 size={14} /> Dejar de fábrica
                    </button>
                    <button 
                      className="lunar-action-btn" 
                      onClick={async () => {
                        try {
                          const isRunning = status?.isPlaying || (await window.orvian.isMinecraftRunning())
                          if (isRunning) {
                            setMcPromptOpen(true)
                            return
                          }
                        } catch (e) {
                          console.error(e)
                        }
                        void window.orvian.quitApp()
                      }}
                      title="Cerrar completamente Orvian Launcher"
                    >
                      <Power size={14} /> Salir del Launcher
                    </button>
                  </div>
                </div>

                <div className="settings-box">
                  <h3>Cuenta</h3>
                  <p className="setting-desc">{status?.authenticated ? `Conectado como ${status.playerName ?? 'jugador'}.` : 'Necesitas iniciar sesión para verificar tu licencia de Minecraft.'}</p>
                  <div className="diag-actions">
                    {status?.authenticated ? (
                      <button className="lunar-action-btn danger" onClick={() => { void window.orvian.logout(); setStatus(s => s ? {...s, authenticated: false, ready: false, playerName: null, playerUuid: null, isAdmin: false} : null); setMessage('Inicia sesión para jugar'); setError(null); setView('home'); }}>
                        <LogOut size={14} /> Cerrar sesión
                      </button>
                    ) : (
                      <button className="lunar-action-btn" onClick={() => void run(() => window.orvian.login(), 'Conectando...')} disabled={busy}>
                        <LogIn size={14} /> Iniciar sesión
                      </button>
                    )}
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* PANEL DE ADMINISTRACIÓN — Dedicado a subir updates a GitHub */}
        {view === 'admin' && isAdmin && (
          <div className="lunar-settings animate-fade-in">
            <div className="settings-container admin-panel-container">
              <div className="admin-header">
                <div>
                  <h2><Shield size={22} /> Publicador de Actualizaciones</h2>
                  <p className="admin-subtitle">Sube una nueva versión del modpack directamente a GitHub (<code>zzyren/orvianmodpack</code>)</p>
                </div>
                <span className="admin-badge">ADMIN</span>
              </div>

              {publishSuccess && (
                <div className="publish-success-card">
                  <CheckCircle2 size={20} />
                  <div className="publish-success-text">
                    <strong>¡Actualización publicada correctamente!</strong>
                    <span>Todos los clientes de Orvian detectarán y descargarán esta versión automáticamente al abrir el launcher.</span>
                  </div>
                  <button className="publish-dismiss-btn" onClick={() => setPublishSuccess(null)}>
                    <X size={16} />
                  </button>
                </div>
              )}

              <div className="settings-grid admin-publisher-grid">
                <div className="settings-box admin-upload-box">
                  <h3>1. ZIP de Prism Launcher</h3>
                  <p className="setting-desc">Exporta tu instancia desde Prism Launcher (como .zip) y selecciónala aquí.</p>
                  
                  <div className="mrpack-dropzone" onClick={async () => {
                    const res = await window.orvian.pickMrpack()
                    if (!res.canceled && res.selectionId && res.fileName) {
                      setMrpackFile({ selectionId: res.selectionId, name: res.fileName })
                      // Autodetectar posible versión a partir del nombre
                      const vMatch = res.fileName.match(/v?(\d+\.\d+(\.\d+)?(-[a-zA-Z0-9.]+)?)/)
                      if (vMatch && !newVersion) {
                        setNewVersion(vMatch[1])
                      }
                    }
                  }}>
                    <FileArchive size={32} className="dropzone-icon" />
                    {mrpackFile ? (
                      <div className="dropzone-selected">
                        <span className="dropzone-filename">{mrpackFile.name}</span>
                        <span className="dropzone-sub">Clic para cambiar de archivo</span>
                      </div>
                    ) : (
                      <div className="dropzone-empty">
                        <span className="dropzone-title">Examinar ZIP de Prism Launcher</span>
                        <span className="dropzone-sub">Haz clic para buscar el archivo .zip</span>
                      </div>
                    )}
                  </div>
                </div>

                <div className="settings-box admin-details-box">
                  <h3>2. Datos de la Release</h3>
                  
                  <div className="admin-form-group">
                    <label>Versión del modpack</label>
                    <input 
                      type="text" 
                      className="admin-input" 
                      placeholder="Ej: 1.0.1 o 0.1.6-alpha" 
                      value={newVersion} 
                      onChange={(e) => setNewVersion(e.target.value)} 
                    />
                    <span className="admin-hint">Versión activa actual: {status?.packVersion ?? '1.0.0'}</span>
                  </div>

                  <div className="admin-form-group">
                    <div className="admin-label-row">
                      <label htmlFor="admin-token">Token de GitHub para publicar</label>
                      <button
                        type="button"
                        className="admin-help-link"
                        onClick={() => void window.orvian.openExternal('https://github.com/settings/personal-access-tokens/new')}
                      >
                        <ExternalLink size={12} /> Crear token en GitHub
                      </button>
                    </div>
                    {tokenStatus?.hasToken ? (
                      <div className="admin-token-saved">
                        <span className="admin-hint">Token guardado de forma segura en este equipo.</span>
                        <button type="button" className="lunar-action-btn" disabled={tokenBusy} onClick={() => void removeToken()}>
                          Quitar token
                        </button>
                      </div>
                    ) : (
                      <>
                        <input
                          id="admin-token"
                          type="password"
                          className="admin-input"
                          autoComplete="off"
                          spellCheck={false}
                          placeholder="github_pat_…"
                          value={tokenInput}
                          disabled={tokenBusy || tokenStatus?.canEncrypt === false}
                          onChange={(e) => setTokenInput(e.target.value)}
                        />
                        <button type="button" className="lunar-action-btn" disabled={tokenBusy || !tokenInput.trim()} onClick={() => void saveToken()}>
                          Guardar token
                        </button>
                      </>
                    )}
                    {tokenStatus?.canEncrypt === false && (
                      <span className="admin-hint" role="alert">Este equipo no permite guardar secretos de forma segura, así que no se puede guardar el token.</span>
                    )}
                    {tokenMessage && <span className="admin-hint" role="status">{tokenMessage}</span>}
                    <span className="admin-hint">
                      Usa un token <em>fine-grained</em> limitado al repositorio <code>zzyren/orvianmodpack</code> con el permiso <strong>Contents: Read and write</strong>. Se guarda cifrado y la interfaz no puede volver a leerlo.
                    </span>
                  </div>

                  <div className="admin-form-group">
                    <label htmlFor="admin-min-launcher">Launcher mínimo (opcional)</label>
                    <input
                      id="admin-min-launcher"
                      type="text"
                      className="admin-input"
                      placeholder="Ej: 1.0.5"
                      spellCheck={false}
                      value={minimumLauncher}
                      onChange={(e) => setMinimumLauncher(e.target.value)}
                    />
                    <span className="admin-hint">Déjalo vacío para conservar el valor actual. Los jugadores con un launcher anterior tendrán que actualizarlo antes de jugar esta versión.</span>
                  </div>

                  <div className="admin-form-group">
                    <label>
                      <input type="checkbox" checked={overwrite} onChange={(e) => setOverwrite(e.target.checked)} />{' '}
                      Sobrescribir si esta versión ya está publicada
                    </label>
                    <span className="admin-hint">Solo para corregir una release. Mientras se suben los archivos, los jugadores pueden ver errores temporales.</span>
                  </div>

                  <div className="admin-form-group">
                    <label>Notas de la versión / Changelog</label>
                    <textarea 
                      className="admin-textarea" 
                      rows={3} 
                      placeholder={`- Añadido mod X\n- Corrección de optimización\n- Actualización de configs`}
                      value={changelog}
                      onChange={(e) => setChangelog(e.target.value)}
                    />
                  </div>

                  {busy && (
                    <div className="publish-status-box">
                      <div className="publish-spinner" />
                      <div className="publish-status-text">
                        <strong>Publicando en GitHub...</strong>
                        <span>{publishStep ?? 'Iniciando proceso...'}</span>
                      </div>
                    </div>
                  )}

                  {publishError && (
                    <div className="publish-error-box">
                      <strong>Error al publicar:</strong>
                      <span>{publishError}</span>
                    </div>
                  )}

                  <button 
                    className="publish-submit-btn" 
                    disabled={busy || !mrpackFile || !newVersion.trim() || !tokenStatus?.hasToken}
                    onClick={async () => {
                      if (!mrpackFile || !newVersion.trim() || !tokenStatus?.hasToken) return
                      setError(null)
                      setPublishError(null)
                      setPublishSuccess(null)
                      setPublishStep('Iniciando lectura del archivo...')
                      setBusy(true)

                      try {
                        const res = await window.orvian.publishUpdate({
                          selectionId: mrpackFile.selectionId,
                          version: newVersion.trim(),
                          changelog: changelog.trim(),
                          overwrite,
                          minimumLauncher: minimumLauncher.trim() || undefined
                        })
                        setPublishSuccess(res.releaseUrl)
                        setMessage(`¡Versión ${newVersion} publicada en GitHub!`)
                        refreshStatus()
                      } catch (err) {
                        const errMsg = ipcErrorMessage(err)
                        setPublishError(errMsg)
                        setError(errMsg)
                      } finally {
                        setBusy(false)
                        setPublishStep(null)
                      }
                    }}
                  >
                    <UploadCloud size={18} />
                    {busy ? 'Publicando en GitHub...' : `Publicar ${newVersion ? 'v' + newVersion : 'Actualización'} en GitHub`}
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}
      </main>

      {/* DIÁLOGO PERSONALIZADO: SALIR CON MINECRAFT ABIERTO */}
      <CustomDialog
        isOpen={mcPromptOpen}
        type="danger"
        title="Minecraft en ejecución"
        message="Minecraft aún se está ejecutando en tu sistema."
        detail={'No puedes cerrar el launcher dejando Minecraft abierto en segundo plano.\n\n¿Deseas forzar el cierre de Minecraft y salir de Orvian Launcher?'}
        confirmText="Cerrar Minecraft y Salir"
        cancelText="Cancelar"
        onConfirm={async () => {
          setMcPromptOpen(false)
          await window.orvian.forceQuit()
        }}
        onCancel={() => setMcPromptOpen(false)}
      />

      {/* DIÁLOGO PERSONALIZADO: DEJAR DE FÁBRICA */}
      <CustomDialog
        isOpen={factoryResetDialogOpen}
        type="danger"
        title="¿Restablecer launcher de fábrica?"
        message="Esta acción borrará los datos y la configuración del launcher."
        detail={'• Se cerrará la sesión y cuenta de Microsoft guardada\n• Se borrarán mods personalizados añadidos y configuraciones\n• Se eliminarán archivos locales de Minecraft, modpack y Java\n• Se quitará el token de publicación, si lo hay\n\nSe conservarán tus mundos, capturas, resourcepacks, shaders y opciones del juego.'}
        confirmText="Restablecer de fábrica"
        cancelText="Cancelar"
        onConfirm={async () => {
          setFactoryResetDialogOpen(false)
          await executeFactoryReset()
        }}
        onCancel={() => setFactoryResetDialogOpen(false)}
      />

      {/* AUTO-UPDATER: Notificaciones de actualizacion del launcher */}
      <UpdaterDialog />
    </div>
  )
}
