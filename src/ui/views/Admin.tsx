import { useEffect, useRef, useState } from 'react'
import { CheckCircle2, ExternalLink, FileArchive, UploadCloud } from 'lucide-react'
import type { LauncherState } from '../../shared/launcher-state'
import { Button } from '../components/Button'
import { Field } from '../components/Field'
import { useToast } from '../components/Toast'
import { ipcErrorMessage } from '../ipcError'

const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[A-Za-z0-9.]+)?$/

interface PublishSteps {
  label: string
  done: boolean
  current: boolean
}

const STEP_ORDER = ['Analizando el archivo', 'Creando el borrador', 'Subiendo el modpack', 'Subiendo el manifest', 'Publicando'] as const

/** Position in the checklist for a progress fraction reported by the publisher. */
function stepIndex(progress: number): number {
  if (progress < 0.7) return 0
  if (progress < 0.75) return 1
  if (progress < 0.94) return 2
  if (progress < 0.97) return 3
  return 4
}

export default function Admin({ state }: { state: LauncherState }) {
  const toast = useToast()
  const [file, setFile] = useState<{ selectionId: string; name: string } | null>(null)
  const [version, setVersion] = useState('')
  const [changelog, setChangelog] = useState('')
  const [overwrite, setOverwrite] = useState(false)
  const [minimumLauncher, setMinimumLauncher] = useState('')
  const [tokenInput, setTokenInput] = useState('')
  const [token, setToken] = useState<{ hasToken: boolean; canEncrypt: boolean } | null>(null)
  const [tokenBusy, setTokenBusy] = useState(false)
  const [tokenMessage, setTokenMessage] = useState<string | null>(null)
  const [publishing, setPublishing] = useState(false)
  const [stepDetail, setStepDetail] = useState('')
  const [stepProgress, setStepProgress] = useState(0)
  const [published, setPublished] = useState<string | null>(null)
  const [publishError, setPublishError] = useState<string | null>(null)
  const [versionTouched, setVersionTouched] = useState(false)

  // Older versions kept the publishing token in localStorage. Take it out of there immediately and
  // hand it to the main process (encrypted) the first time this panel opens.
  const legacyToken = useRef('')
  useEffect(() => {
    // In an effect (not during render) so React StrictMode's double invocation cannot lose the value.
    try {
      const legacy = localStorage.getItem('orvian_admin_gh_token')
      if (legacy) {
        legacyToken.current = legacy
        localStorage.removeItem('orvian_admin_gh_token')
      }
    } catch {
      // Storage can be unavailable; there is nothing to migrate then.
    }
    void (async () => {
      try {
        const legacy = legacyToken.current
        legacyToken.current = ''
        // A token that no longer works is simply dropped: it was already removed from localStorage.
        if (legacy) await window.orvian.adminSetToken(legacy).catch(() => undefined)
        setToken(await window.orvian.adminTokenStatus())
      } catch (err) {
        setTokenMessage(ipcErrorMessage(err))
      }
    })()
  }, [])

  useEffect(
    () =>
      window.orvian.onPublishProgress((event) => {
        setStepDetail(event.detail)
        setStepProgress(event.progress)
      }),
    []
  )

  const versionError = versionTouched && version.trim() && !VERSION_PATTERN.test(version.trim()) ? 'Usa el formato 1.2.3 (se admite un sufijo como 1.2.3-beta).' : null
  const minimumError = minimumLauncher.trim() && !/^\d+\.\d+\.\d+/.test(minimumLauncher.trim()) ? 'Usa el formato 1.2.3.' : null
  const canPublish = Boolean(file && VERSION_PATTERN.test(version.trim()) && token?.hasToken && !minimumError && !publishing)

  const pickFile = async (): Promise<void> => {
    try {
      const result = await window.orvian.pickMrpack()
      if (result.canceled || !result.selectionId || !result.fileName) return
      setFile({ selectionId: result.selectionId, name: result.fileName })
      const guess = result.fileName.match(/v?(\d+\.\d+\.\d+(?:-[A-Za-z0-9.]+)?)/)
      if (guess && !version) setVersion(guess[1])
    } catch (err) {
      toast({ kind: 'error', message: ipcErrorMessage(err) })
    }
  }

  const saveToken = async (): Promise<void> => {
    setTokenBusy(true)
    setTokenMessage(null)
    try {
      const result = await window.orvian.adminSetToken(tokenInput.trim())
      setTokenInput('')
      setToken(await window.orvian.adminTokenStatus())
      setTokenMessage(result.verified ? 'Token guardado y verificado.' : 'Token guardado. No se pudo comprobar su acceso (¿sin conexión?).')
    } catch (err) {
      setTokenMessage(ipcErrorMessage(err))
    } finally {
      setTokenBusy(false)
    }
  }

  const removeToken = async (): Promise<void> => {
    setTokenBusy(true)
    setTokenMessage(null)
    try {
      await window.orvian.adminClearToken()
      setToken(await window.orvian.adminTokenStatus())
    } catch (err) {
      setTokenMessage(ipcErrorMessage(err))
    } finally {
      setTokenBusy(false)
    }
  }

  const publish = async (): Promise<void> => {
    if (!file || !canPublish) return
    setPublishing(true)
    setPublishError(null)
    setPublished(null)
    setStepDetail('Analizando el archivo…')
    setStepProgress(0)
    try {
      const result = await window.orvian.publishUpdate({
        selectionId: file.selectionId,
        version: version.trim(),
        changelog: changelog.trim(),
        overwrite,
        minimumLauncher: minimumLauncher.trim() || undefined
      })
      setPublished(result.releaseUrl)
      toast({ kind: 'success', message: `Versión ${version.trim()} publicada.` })
    } catch (err) {
      setPublishError(ipcErrorMessage(err))
    } finally {
      setPublishing(false)
      setStepDetail('')
    }
  }

  const current = stepIndex(stepProgress)
  const steps: PublishSteps[] = STEP_ORDER.map((label, index) => ({ label, done: index < current, current: index === current }))

  return (
    <div className="view view-enter">
      <div className="view-inner">
        <div>
          <h1 className="view-title">Publicar versión</h1>
          <p className="view-lead">Sube una nueva versión del modpack a GitHub (<code translate="no">zzyren/orvianmodpack</code>). Los jugadores la recibirán al abrir el launcher.</p>
        </div>

        {published && (
          <div className="notice notice-success" role="status">
            <CheckCircle2 size={20} strokeWidth={1.75} aria-hidden="true" />
            <div>
              <p><strong>Versión publicada.</strong> Los jugadores recibirán el cambio al abrir el launcher.</p>
              <Button size="sm" variant="ghost" icon={<ExternalLink size={16} strokeWidth={1.75} aria-hidden="true" />} onClick={() => void window.orvian.openExternal(published)}>Abrir la release</Button>
            </div>
          </div>
        )}

        <section className="settings-section" aria-labelledby="admin-file">
          <div className="settings-section-head">
            <h2 id="admin-file" className="settings-section-title">1. Archivo del modpack</h2>
            <p className="settings-section-desc">Exporta la instancia desde Prism Launcher como .zip y selecciónala aquí.</p>
          </div>
          <div className="settings-section-body">
            <button type="button" className="dropzone" onClick={() => void pickFile()}>
              <FileArchive size={28} strokeWidth={1.75} aria-hidden="true" />
              <span className="dropzone-title">{file ? file.name : 'Elegir el .zip de Prism Launcher'}</span>
              <span className="dropzone-sub">{file ? 'Pulsa para elegir otro archivo' : 'Se abrirá el selector de archivos'}</span>
            </button>
          </div>
        </section>

        <section className="settings-section" aria-labelledby="admin-data">
          <div className="settings-section-head">
            <h2 id="admin-data" className="settings-section-title">2. Datos de la versión</h2>
          </div>
          <div className="settings-section-body form-stack">
            <Field label="Versión del modpack" error={versionError} hint={`Versión publicada ahora: ${state.pack.latest ?? 'ninguna'}`}>
              {(props) => (
                <input {...props} className="input" autoComplete="off" spellCheck={false} placeholder="1.0.5" value={version} onChange={(e) => setVersion(e.target.value)} onBlur={() => setVersionTouched(true)} />
              )}
            </Field>

            <Field label="Launcher mínimo (opcional)" error={minimumError} hint="Déjalo vacío para conservar el valor actual. Quien tenga un launcher anterior tendrá que actualizarlo antes de jugar esta versión.">
              {(props) => (
                <input {...props} className="input" autoComplete="off" spellCheck={false} placeholder="1.0.5" value={minimumLauncher} onChange={(e) => setMinimumLauncher(e.target.value)} />
              )}
            </Field>

            <Field label="Cambios de esta versión" hint="Una línea por cambio. Se muestra como texto en las novedades.">
              {(props) => (
                <textarea {...props} className="input textarea" rows={4} placeholder={'Añadido el mod X\nCorregida la optimización de Y'} value={changelog} onChange={(e) => setChangelog(e.target.value)} />
              )}
            </Field>

            <label className="check-row">
              <input type="checkbox" checked={overwrite} onChange={(e) => setOverwrite(e.target.checked)} />
              <span>Sobrescribir si esta versión ya está publicada. Solo para corregir una release: mientras se suben los archivos los jugadores pueden ver errores temporales.</span>
            </label>
          </div>
        </section>

        <section className="settings-section" aria-labelledby="admin-token">
          <div className="settings-section-head">
            <h2 id="admin-token" className="settings-section-title">3. Acceso a GitHub</h2>
            <p className="settings-section-desc">Usa un token <em>fine-grained</em> limitado a <code translate="no">zzyren/orvianmodpack</code> con el permiso <strong>Contents: lectura y escritura</strong>. Se guarda cifrado y la interfaz no puede volver a leerlo.</p>
          </div>
          <div className="settings-section-body form-stack">
            {token?.hasToken ? (
              <div className="token-saved">
                <span>Token guardado de forma segura en este equipo.</span>
                <Button size="sm" variant="secondary" loading={tokenBusy} onClick={() => void removeToken()}>Quitar token</Button>
              </div>
            ) : (
              <>
                <Field label="Token de GitHub" hint={token?.canEncrypt === false ? undefined : 'Empieza por github_pat_'} error={token?.canEncrypt === false ? 'Este equipo no permite guardar secretos de forma segura, así que no se puede guardar el token.' : null}>
                  {(props) => (
                    <input {...props} type="password" className="input" autoComplete="off" spellCheck={false} placeholder="github_pat_…" value={tokenInput} disabled={tokenBusy || token?.canEncrypt === false} onChange={(e) => setTokenInput(e.target.value)} />
                  )}
                </Field>
                <div className="button-row">
                  <Button variant="secondary" loading={tokenBusy} disabled={!tokenInput.trim()} onClick={() => void saveToken()}>Guardar token</Button>
                  <Button variant="ghost" icon={<ExternalLink size={16} strokeWidth={1.75} aria-hidden="true" />} onClick={() => void window.orvian.openExternal('https://github.com/settings/personal-access-tokens/new')}>Crear token en GitHub</Button>
                </div>
              </>
            )}
            <p className="result-note" role="status">{tokenMessage ?? ''}</p>
          </div>
        </section>

        {publishing && (
          <ol className="install-steps" aria-label="Pasos de la publicación">
            {steps.map((step) => (
              <li key={step.label} className={`install-step install-step-${step.done ? 'done' : step.current ? 'current' : 'pending'}`} aria-current={step.current ? 'step' : undefined}>
                <span className="install-step-name">{step.label}</span>
                {step.current && <span className="install-step-meta">{stepDetail}</span>}
              </li>
            ))}
          </ol>
        )}

        {publishError && (
          <div className="notice notice-danger" role="alert">
            <p><strong>No se pudo publicar.</strong> {publishError}</p>
          </div>
        )}

        <div className="button-row">
          <Button variant="primary" size="lg" icon={<UploadCloud size={20} strokeWidth={1.75} aria-hidden="true" />} loading={publishing} disabled={!canPublish} onClick={() => void publish()}>
            {publishing ? 'Publicando…' : `Publicar${version.trim() ? ` v${version.trim()}` : ''}`}
          </Button>
        </div>
      </div>
    </div>
  )
}
