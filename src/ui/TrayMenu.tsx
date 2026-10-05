import { useState, useEffect } from 'react'
import { Play, X, ExternalLink, FolderOpen, Power, ChevronRight, LogIn, HardDrive, Loader2, Link2, Gamepad2, Shield } from 'lucide-react'
import CustomDialog from './CustomDialog'
import { getPrimaryAction } from '../shared/launcher-state'
import { useLauncherState } from './hooks/useLauncherState'
import './tray.css'

export default function TrayMenu() {
  const state = useLauncherState()
  const [actionError, setActionError] = useState<string | null>(null)
  const [mcPromptOpen, setMcPromptOpen] = useState(false)

  useEffect(() => {
    const unbind = window.orvian.onPromptMcQuit?.(() => setMcPromptOpen(true))
    return () => unbind?.()
  }, [])

  const primary = state ? getPrimaryAction(state) : null
  const phase = state?.phase
  const busy = phase?.kind === 'installing' || phase?.kind === 'repairing' || phase?.kind === 'launching'
  const isPlaying = phase?.kind === 'running'
  const isAuthenticated = state?.account != null
  const errorText = actionError ?? (phase?.kind === 'error' ? phase.error.title : null)

  /** Runs the main button's action; failures that the store does not already show are shown here. */
  const handlePrimary = async () => {
    if (!primary?.enabled) return
    setActionError(null)
    try {
      switch (primary.action) {
        case 'login':
        case 'update-launcher':
          await window.orvian.showMainWindow()
          break
        case 'play':
          await window.orvian.play()
          break
        case 'play-installed':
          await window.orvian.play({ playInstalled: true })
          break
        case 'repair':
          await window.orvian.repair()
          break
        case 'check':
          await window.orvian.checkForUpdates()
          break
        default:
          break
      }
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e))
    }
  }

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
                src={`https://minotar.net/helm/${state?.account?.uuid ?? 'Steve'}/64.png`} 
                alt="Skin" 
                className="tray-skin" 
              />
              <span className={`tray-pulse-dot ${isPlaying ? 'in-game' : 'online'}`} />
            </div>
            <div className="tray-player-info">
              <div className="tray-player-name-row">
                <span className="tray-player-name">{state?.account?.name ?? 'Jugador'}</span>
                {state?.isAdmin && (
                  <span className="tray-admin-badge">
                    <Shield size={10} /> ADMIN
                  </span>
                )}
              </div>
              <span className="tray-player-status">
                {isPlaying ? 'Jugando a Minecraft' : (state?.pack.hasUpdate ? `Actualización v${state.pack.latest}` : (primary?.enabled ? 'Listo para jugar' : (primary?.label ?? '')))}
              </span>
            </div>
            {state?.pack.installed && (
              <div className="tray-pack-pill" title="Versión del modpack">
                <span>v{state.pack.installed}</span>
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
        {errorText && (
          <div className="tray-error-banner">
            <span>{errorText}</span>
          </div>
        )}

        {/* BOTÓN HERO 3D DE JUGAR CON PROGRESO INTEGRADO (CONCORDANCIA TOTAL) */}
        <button 
          className={`tray-launch-btn ${!primary?.enabled ? 'disabled' : ''} ${busy ? 'busy' : ''} ${errorText ? 'has-error' : ''}`}
          onClick={() => void handlePrimary()}
          disabled={!primary?.enabled}
        >
          {(phase?.kind === 'installing' || phase?.kind === 'repairing') && (
            <div className="tray-launch-progress-track">
              <div className="tray-launch-progress-fill" style={{ transform: `scaleX(${phase.progress.fraction})`, animation: 'none', width: '100%', transformOrigin: 'left' }} />
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
            <span className="tray-launch-title">{primary?.label ?? 'Comprobando…'}</span>
          </div>
          <div className="tray-launch-subtitle">
            {primary?.enabled && primary.action === 'play' && !state?.pack.hasUpdate && <Link2 size={11} />}
            <span>{primary?.sublabel}</span>
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
