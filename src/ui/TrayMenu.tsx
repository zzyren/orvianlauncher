import { useState, useEffect } from 'react'
import { Play, X, ExternalLink, FolderOpen, Power, ChevronRight, LogIn, HardDrive, Loader2, Link2, Gamepad2, Shield } from 'lucide-react'
import CustomDialog from './CustomDialog'
import './tray.css'

export default function TrayMenu() {
  const [status, setStatus] = useState<any>(null)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [mcPromptOpen, setMcPromptOpen] = useState(false)

  const refreshStatus = async () => {
    try {
      const s = await window.orvian.getStatus()
      setStatus(s)
    } catch (e) {
      console.error('Failed to get status', e)
    }
  }

  useEffect(() => {
    void refreshStatus()
    const interval = setInterval(refreshStatus, 2000)

    const unbindStatus = window.orvian.onStatusUpdate?.((s: any) => {
      setStatus(s)
    })

    const unbindProgress = window.orvian.onProgress?.((event: any) => {
      if (event.state !== 'playing' && event.state !== 'done' && event.state !== 'error' && event.state !== 'idle') {
        setMessage(event.detail)
        setBusy(true)
      } else {
        setBusy(false)
      }
      if (event.state === 'playing' || event.state === 'error' || event.state === 'done') {
        void refreshStatus()
      }
    })

    const unbindMcPrompt = window.orvian.onPromptMcQuit?.(() => {
      setMcPromptOpen(true)
    })

    return () => {
      clearInterval(interval)
      unbindStatus?.()
      unbindProgress?.()
      unbindMcPrompt?.()
    }
  }, [])

  const run = async (action: () => Promise<any>, startMsg: string) => {
    if (busy) return
    setBusy(true)
    setError(null)
    setMessage(startMsg)
    try {
      await action()
      setMessage('')
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
      await refreshStatus()
    }
  }

  const handlePlay = () => {
    if (!status?.authenticated) {
      window.orvian.showMainWindow()
      return
    }
    void run(() => window.orvian.play(), 'Preparando Java 17...')
  }

  const isPlaying = Boolean(status?.isPlaying)
  const isAuthenticated = Boolean(status?.authenticated)
  const isReady = Boolean(status?.ready)

  return (
    <div className="tray-menu-container">
      {/* HEADER DE MARCA (CONCORDANCIA CON TOPBAR PRINCIPAL) */}
      <div className="tray-header">
        <div className="tray-brand">
          <img src="./logo.png" alt="Orvian" className="tray-logo" />
          <div className="tray-brand-text">
            <span className="tray-title">Orvian</span>
            <span className="tray-badge">QUICK MENU</span>
          </div>
        </div>
        <button 
          className="tray-close-btn" 
          title="Cerrar menú rápido" 
          onClick={() => window.orvian.hideTrayWindow()}
        >
          <X size={16} strokeWidth={2.5} />
        </button>
      </div>

      {/* CUERPO DEL MENÚ */}
      <div className="tray-content">
        {/* TARJETA DE JUGADOR O LOGIN */}
        {isAuthenticated ? (
          <div className="tray-player-card">
            <div className="tray-avatar-wrapper">
              <img 
                src={`https://minotar.net/helm/${status?.playerUuid ?? 'Steve'}/64.png`} 
                alt="Skin" 
                className="tray-skin" 
              />
              <span className={`tray-pulse-dot ${isPlaying ? 'in-game' : 'online'}`} />
            </div>
            <div className="tray-player-info">
              <div className="tray-player-name-row">
                <span className="tray-player-name">{status?.playerName ?? 'Jugador'}</span>
                {status?.isAdmin && (
                  <span className="tray-admin-badge">
                    <Shield size={10} /> ADMIN
                  </span>
                )}
              </div>
              <span className="tray-player-status">
                {isPlaying ? '🎮 Jugando a Minecraft' : (status?.hasUpdate ? `⚠ Actualización v${status.packVersion}` : '● Listo para jugar')}
              </span>
            </div>
            {status?.packVersion && (
              <div className="tray-pack-pill" title="Versión del modpack">
                <span>v{status.packVersion}</span>
              </div>
            )}
          </div>
        ) : (
          <div 
            className="tray-auth-card" 
            onClick={() => window.orvian.showMainWindow()}
            title="Abrir launcher para iniciar sesión"
          >
            <div className="tray-auth-icon-box">
              <LogIn size={18} />
            </div>
            <div className="tray-auth-text">
              <span className="tray-auth-title">Iniciar sesión con Microsoft</span>
              <span className="tray-auth-sub">Haz clic para abrir el launcher y conectar tu cuenta</span>
            </div>
          </div>
        )}

        {/* ERROR SI OCURRIÓ */}
        {error && (
          <div className="tray-error-banner">
            <span>⚠ {error}</span>
          </div>
        )}

        {/* BOTÓN HERO 3D DE JUGAR CON PROGRESO INTEGRADO (CONCORDANCIA TOTAL) */}
        <button 
          className={`tray-launch-btn ${(!isReady && isAuthenticated) || busy || isPlaying ? 'disabled' : ''} ${busy ? 'busy' : ''} ${error ? 'has-error' : ''}`}
          onClick={handlePlay}
          disabled={busy || isPlaying}
        >
          {busy && (
            <div className="tray-launch-progress-track">
              <div className="tray-launch-progress-fill" />
            </div>
          )}
          <div className="tray-launch-main">
            {busy ? (
              <Loader2 size={20} className="tray-spinner" />
            ) : isPlaying ? (
              <Gamepad2 size={20} />
            ) : (
              <Play size={20} className="play-icon" />
            )}
            <span className="tray-launch-title">
              {busy ? 'PREPARANDO...' : (isPlaying ? 'JUGANDO...' : (error ? 'REINTENTAR' : (status?.hasUpdate ? 'ACTUALIZAR' : 'JUGAR')))}
            </span>
          </div>
          <div className="tray-launch-subtitle">
            {busy ? (
              <span>{message || 'Preparando...'}</span>
            ) : isPlaying ? (
              <span>MINECRAFT EN EJECUCIÓN</span>
            ) : status?.hasUpdate ? (
              <span>NUEVA VERSIÓN v{status.packVersion}</span>
            ) : isReady ? (
              <>
                <Link2 size={11} />
                <span>LISTO PARA JUGAR</span>
              </>
            ) : !isAuthenticated ? (
              <span>INICIA SESIÓN PARA JUGAR</span>
            ) : (
              <span>CONFIGURANDO</span>
            )}
          </div>
        </button>

        {/* BOTÓN DESTACADO: ABRIR LAUNCHER COMPLETO */}
        <button 
          className="tray-open-main-btn"
          onClick={() => window.orvian.showMainWindow()}
          title="Abrir la ventana completa del Launcher"
        >
          <div className="open-main-left">
            <div className="open-main-icon-box">
              <ExternalLink size={16} />
            </div>
            <div className="open-main-text">
              <span className="open-main-title">Abrir Launcher Completo</span>
              <span className="open-main-sub">Gestión de mods, ajustes y biblioteca</span>
            </div>
          </div>
          <ChevronRight size={16} className="open-main-arrow" />
        </button>
      </div>

      {/* FOOTER CON ACCIONES RÁPIDAS */}
      <div className="tray-footer">
        <button 
          className="tray-footer-action" 
          onClick={() => void window.orvian.openFolder('mods')}
          title="Abrir carpeta de mods instalados"
        >
          <FolderOpen size={13} />
          <span>Carpeta Mods</span>
        </button>
        <button 
          className="tray-footer-action" 
          onClick={() => void window.orvian.openFolder('logs')}
          title="Ver registros de ejecución"
        >
          <HardDrive size={13} />
          <span>Registros</span>
        </button>
        <button 
          className="tray-footer-action quit" 
          onClick={async () => {
            try {
              const isRunning = isPlaying || (await window.orvian.isMinecraftRunning())
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
          <Power size={13} />
          <span>Salir</span>
        </button>
      </div>

      {/* DIÁLOGO PERSONALIZADO PARA CERRAR LAUNCHER CON MC ABIERTO */}
      <CustomDialog
        isOpen={mcPromptOpen}
        compact={true}
        type="danger"
        title="Minecraft en ejecución"
        message="Minecraft aún se está ejecutando."
        detail="No puedes cerrar el launcher dejando Minecraft abierto. ¿Deseas forzar el cierre de Minecraft y salir de Orvian?"
        confirmText="Cerrar Minecraft y Salir"
        cancelText="Cancelar"
        onConfirm={async () => {
          setMcPromptOpen(false)
          await window.orvian.forceQuit()
        }}
        onCancel={() => setMcPromptOpen(false)}
      />
    </div>
  )
}
