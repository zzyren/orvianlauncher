import { useEffect, useState, useRef, useCallback } from 'react'
import { Download, RefreshCw, X, ArrowUpCircle, CheckCircle2, AlertTriangle } from 'lucide-react'

// Los tipos vienen del preload a traves de types.d.ts
type UpdaterEventType = 
  | { type: 'checking' }
  | { type: 'not-available'; currentVersion: string }
  | { type: 'available'; currentVersion: string; newVersion: string; releaseNotes?: string }
  | { type: 'downloading'; percent: number; bytesPerSecond: number; transferred: number; total: number }
  | { type: 'downloaded'; newVersion: string }
  | { type: 'error'; message: string }

type DialogState =
  | 'hidden'
  | 'available'
  | 'downloading'
  | 'downloaded'
  | 'error'

interface UpdaterInfo {
  currentVersion: string
  newVersion: string
  percent: number
  bytesPerSecond: number
  errorMessage: string
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B/s`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB/s`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB/s`
}

export default function UpdaterDialog() {
  const [dialogState, setDialogState] = useState<DialogState>('hidden')
  const [info, setInfo] = useState<UpdaterInfo>({
    currentVersion: '',
    newVersion: '',
    percent: 0,
    bytesPerSecond: 0,
    errorMessage: ''
  })

  // Usamos refs para evitar stale closures en el listener registrado una sola vez
  const dismissedRef = useRef(false)
  const isDownloadingRef = useRef(false)
  const dialogStateRef = useRef<DialogState>('hidden')

  // Mantener dialogStateRef sincronizado con dialogState
  useEffect(() => {
    dialogStateRef.current = dialogState
  }, [dialogState])

  useEffect(() => {
    // Solo en la ventana principal, no en el tray
    if (window.location.hash === '#tray') return
    if (!window.orvian?.onUpdaterEvent) return

    // ── Registrar el listener UNA SOLA VEZ en el mount ──────────────────────
    // Usamos refs para leer el estado actual sin re-registrar el listener
    const handler = (event: UpdaterEventType) => {
      switch (event.type) {
        case 'checking':
          // Silencioso — no mostramos nada al comprobar
          break

        case 'available':
          // Leer dismissed desde la ref para evitar stale closure
          if (!dismissedRef.current) {
            setInfo(prev => ({
              ...prev,
              currentVersion: event.currentVersion,
              newVersion: event.newVersion
            }))
            setDialogState('available')
            dialogStateRef.current = 'available'
          }
          break

        case 'downloading':
          isDownloadingRef.current = true
          setInfo(prev => ({
            ...prev,
            percent: event.percent,
            bytesPerSecond: event.bytesPerSecond
          }))
          setDialogState('downloading')
          dialogStateRef.current = 'downloading'
          break

        case 'downloaded':
          isDownloadingRef.current = false
          setInfo(prev => ({ ...prev, newVersion: event.newVersion }))
          setDialogState('downloaded')
          dialogStateRef.current = 'downloaded'
          break

        case 'not-available':
          // Silencioso si ya estamos en la ultima version
          // Solo ocultar si no estamos en medio de una descarga o ya descargado
          if (dialogStateRef.current !== 'downloading' && dialogStateRef.current !== 'downloaded') {
            setDialogState('hidden')
            dialogStateRef.current = 'hidden'
          }
          break

        case 'error':
          // Solo mostrar el error si se produjo durante una descarga activa
          if (isDownloadingRef.current || dialogStateRef.current === 'downloading') {
            isDownloadingRef.current = false
            setInfo(prev => ({ ...prev, errorMessage: event.message }))
            setDialogState('error')
            dialogStateRef.current = 'error'
          }
          // Si el error ocurre durante la comprobacion silenciosa, ignorarlo
          break
      }
    }

    const unsub = window.orvian.onUpdaterEvent(handler)

    return () => {
      unsub?.()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []) // <── Sin dependencias: listener registrado UNA SOLA VEZ

  const handleDownload = useCallback(async () => {
    setDialogState('downloading')
    dialogStateRef.current = 'downloading'
    isDownloadingRef.current = true
    try {
      await window.orvian.updaterDownload()
    } catch {
      isDownloadingRef.current = false
      setDialogState('error')
      dialogStateRef.current = 'error'
      setInfo(prev => ({ ...prev, errorMessage: 'Error al iniciar la descarga' }))
    }
  }, [])

  const handleInstall = useCallback(() => {
    window.orvian.updaterInstall()
  }, [])

  const handleLater = useCallback(() => {
    dismissedRef.current = true
    setDialogState('hidden')
    dialogStateRef.current = 'hidden'
  }, [])

  const handleDismissError = useCallback(() => {
    setDialogState('hidden')
    dialogStateRef.current = 'hidden'
  }, [])

  const handleRetry = useCallback(async () => {
    setDialogState('hidden')
    dialogStateRef.current = 'hidden'
    isDownloadingRef.current = false
    // Pequeño delay para que el usuario vea que algo cambió
    await new Promise(r => setTimeout(r, 300))
    await handleDownload()
  }, [handleDownload])

  if (dialogState === 'hidden') return null

  return (
    <div className="updater-backdrop">
      <div className="updater-modal">
        {/* Cabecera */}
        <div className="updater-header">
          <div className="updater-icon-wrap">
            {dialogState === 'available' && <ArrowUpCircle size={22} className="updater-icon available" />}
            {dialogState === 'downloading' && <Download size={22} className="updater-icon downloading" />}
            {dialogState === 'downloaded' && <CheckCircle2 size={22} className="updater-icon downloaded" />}
            {dialogState === 'error' && <AlertTriangle size={22} className="updater-icon error" />}
          </div>
          <div className="updater-header-text">
            {dialogState === 'available' && <span>Nueva versión del Launcher disponible</span>}
            {dialogState === 'downloading' && <span>Descargando actualización del Launcher...</span>}
            {dialogState === 'downloaded' && <span>Actualización del Launcher lista</span>}
            {dialogState === 'error' && <span>Error al descargar</span>}
          </div>
          {(dialogState === 'available' || dialogState === 'error') && (
            <button className="updater-close-btn" onClick={dialogState === 'error' ? handleDismissError : handleLater} title="Cerrar">
              <X size={14} />
            </button>
          )}
        </div>

        {/* Cuerpo */}
        <div className="updater-body">
          {dialogState === 'available' && (
            <>
              <div className="updater-version-row">
                <div className="updater-version-box">
                  <span className="updater-version-label">Versión actual</span>
                  <span className="updater-version-value">v{info.currentVersion}</span>
                </div>
                <div className="updater-version-arrow">→</div>
                <div className="updater-version-box new">
                  <span className="updater-version-label">Nueva versión</span>
                  <span className="updater-version-value new">v{info.newVersion}</span>
                </div>
              </div>
              <p className="updater-desc">
                Hay una nueva versión de Orvian Launcher disponible. Puedes actualizarla ahora o más tarde.
              </p>
            </>
          )}

          {dialogState === 'downloading' && (
            <>
              <div className="updater-progress-wrap">
                <div className="updater-progress-track">
                  <div
                    className="updater-progress-fill"
                    style={{ width: `${info.percent}%` }}
                  />
                </div>
                <div className="updater-progress-meta">
                  <span className="updater-progress-percent">{info.percent}%</span>
                  {info.bytesPerSecond > 0 && (
                    <span className="updater-progress-speed">{formatBytes(info.bytesPerSecond)}</span>
                  )}
                </div>
              </div>
              <p className="updater-desc muted">La descarga continuará en segundo plano. No cierres el launcher.</p>
            </>
          )}

          {dialogState === 'downloaded' && (
            <p className="updater-desc">
              La actualización <strong>v{info.newVersion}</strong> se ha descargado correctamente.
              Al reiniciar se instalará automáticamente.
            </p>
          )}

          {dialogState === 'error' && (
            <p className="updater-desc error-text">
              {info.errorMessage || 'No se pudo descargar la actualización. La versión actual sigue funcionando con normalidad.'}
            </p>
          )}
        </div>

        {/* Acciones */}
        <div className="updater-actions">
          {dialogState === 'available' && (
            <>
              <button className="updater-btn secondary" onClick={handleLater}>
                Más tarde
              </button>
              <button className="updater-btn primary" onClick={handleDownload}>
                <Download size={15} /> Actualizar
              </button>
            </>
          )}

          {dialogState === 'downloaded' && (
            <>
              <button className="updater-btn secondary" onClick={handleLater}>
                Ahora no
              </button>
              <button className="updater-btn primary" onClick={handleInstall}>
                <RefreshCw size={15} /> Reiniciar y actualizar
              </button>
            </>
          )}

          {dialogState === 'error' && (
            <>
              <button className="updater-btn secondary" onClick={handleDismissError}>
                Cerrar
              </button>
              <button className="updater-btn primary" onClick={handleRetry}>
                <RefreshCw size={15} /> Reintentar
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
