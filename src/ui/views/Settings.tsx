import { useEffect, useRef, useState, type ReactNode } from 'react'
import { FolderOpen, HardDrive, LogIn, LogOut, Power, RefreshCw, Trash2, Wrench, ClipboardCopy } from 'lucide-react'
import type { LauncherState } from '../../shared/launcher-state'
import { formatBytes } from '../../shared/format'
import { Button } from '../components/Button'
import { ConfirmDialog } from '../components/Dialog'
import { Field } from '../components/Field'
import { useToast } from '../components/Toast'
import { useAsyncAction } from '../hooks/useAsyncAction'
import { useLauncherActions } from '../hooks/useLauncherActions'
import { ipcErrorMessage } from '../ipcError'

function Section({ title, description, children }: { title: string; description?: ReactNode; children: ReactNode }) {
  const id = `section-${title.toLowerCase().replace(/[^a-z]+/g, '-')}`
  return (
    <section className="settings-section" aria-labelledby={id}>
      <div className="settings-section-head">
        <h2 id={id} className="settings-section-title">{title}</h2>
        {description && <p className="settings-section-desc">{description}</p>}
      </div>
      <div className="settings-section-body">{children}</div>
    </section>
  )
}

export default function Settings({ state }: { state: LauncherState }) {
  const idle = !['installing', 'repairing', 'launching', 'running', 'signing-in', 'booting'].includes(state.phase.kind)
  return (
    <div className="view view-enter">
      <div className="view-inner">
        <h1 className="view-title">Ajustes</h1>
        <MemorySection state={state} />
        <ModpackSection state={state} idle={idle} />
        <AccountSection state={state} idle={idle} />
        <DiagnosticsSection />
        <AdvancedSection idle={idle} />
      </div>
    </div>
  )
}

// ─── Memory ──────────────────────────────────────────────────────────────────

function MemorySection({ state }: { state: LauncherState }) {
  const { ramGb, ramMin, ramMax } = state.settings
  const [value, setValue] = useState(ramGb)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const timer = useRef<number | null>(null)
  const dirty = useRef(false)

  // Follow the main process unless the player is in the middle of a change
  useEffect(() => {
    if (!dirty.current) setValue(ramGb)
  }, [ramGb])

  useEffect(() => () => {
    if (timer.current) window.clearTimeout(timer.current)
  }, [])

  const change = (next: number): void => {
    setValue(next)
    setSaved(false)
    setError(null)
    dirty.current = true
    if (timer.current) window.clearTimeout(timer.current)
    // Saved shortly after the last change, so keyboard users (one step per key press) are covered too
    timer.current = window.setTimeout(() => {
      window.orvian
        .setRam(next)
        .then(() => setSaved(true))
        .catch((err: unknown) => setError(ipcErrorMessage(err)))
        .finally(() => {
          dirty.current = false
        })
    }, 300)
  }

  return (
    <Section title="Memoria" description="Memoria máxima para Minecraft. 6 GB suele ser suficiente; más no siempre es mejor.">
      <Field label="Memoria RAM" error={error} hint={`Entre ${ramMin} y ${ramMax} GB según la memoria de este equipo.`}>
        {(props) => (
          <div className="ram-control">
            <input {...props} type="range" className="slider" min={ramMin} max={ramMax} step={1} value={value} onChange={(e) => change(Number(e.target.value))} aria-valuetext={`${value} gigabytes`} />
            <output className="ram-value" htmlFor={props.id}>{value} GB</output>
          </div>
        )}
      </Field>
      <p className="saved-note" role="status">{saved ? 'Guardado.' : ''}</p>
    </Section>
  )
}

// ─── Modpack ─────────────────────────────────────────────────────────────────

function ModpackSection({ state, idle }: { state: LauncherState; idle: boolean }) {
  const toast = useToast()
  const check = useAsyncAction()
  const repair = useAsyncAction()
  const [result, setResult] = useState<string | null>(null)
  const [pending, setPending] = useState<string[]>([])
  const [restoreOpen, setRestoreOpen] = useState(false)

  const loadPending = (): void => {
    window.orvian.pendingConfigs().then((value) => setPending(value.files)).catch(() => setPending([]))
  }
  useEffect(loadPending, [state.pack.installed])

  const description = state.pack.installed
    ? `Versión instalada v${state.pack.installed}${state.pack.latest ? ` · última v${state.pack.latest}` : ''}`
    : 'Todavía no hay un modpack instalado.'

  return (
    <Section title="Modpack" description={description}>
      <div className="button-row">
        <Button
          icon={<RefreshCw size={16} strokeWidth={1.75} aria-hidden="true" />}
          loading={check.pending}
          disabled={!idle}
          onClick={() => void check.run(async () => {
            const response = await window.orvian.checkForUpdates()
            setResult(response.message + (response.hasUpdate && response.downloadBytes ? ` (${formatBytes(response.downloadBytes)})` : ''))
          })}
        >
          Buscar actualizaciones
        </Button>
        <Button
          icon={<Wrench size={16} strokeWidth={1.75} aria-hidden="true" />}
          loading={repair.pending}
          disabled={!idle || state.account === null}
          onClick={() => void repair.run(async () => {
            const response = await window.orvian.repair()
            if (response.ok) toast({ kind: 'success', message: response.message })
          }, { silent: true })}
        >
          Reparar ahora
        </Button>
      </div>
      <p className="result-note" role="status">{result ?? ''}</p>

      {pending.length > 0 && (
        <div className="notice notice-info">
          <p>
            Hay {pending.length} {pending.length === 1 ? 'configuración nueva del pack que no se aplicó' : 'configuraciones nuevas del pack que no se aplicaron'} porque las habías modificado.
          </p>
          <details>
            <summary>Ver archivos</summary>
            <ul className="file-list selectable">{pending.map((file) => <li key={file}><code>{file}</code></li>)}</ul>
          </details>
          <div className="button-row">
            <Button size="sm" variant="secondary" disabled={!idle} onClick={() => setRestoreOpen(true)}>Restaurar valores del pack</Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={!idle}
              onClick={() => void window.orvian.discardPendingConfigs().then(loadPending).catch((err: unknown) => toast({ kind: 'error', message: ipcErrorMessage(err) }))}
            >
              Mantener los míos
            </Button>
          </div>
        </div>
      )}

      <ConfirmDialog
        open={restoreOpen}
        destructive
        title="¿Restaurar los valores del pack?"
        description="Tus cambios en estos archivos de configuración se sustituirán por los del modpack. No se puede deshacer."
        confirmLabel="Restaurar"
        onCancel={() => setRestoreOpen(false)}
        onConfirm={() => {
          setRestoreOpen(false)
          window.orvian
            .restorePendingConfigs()
            .then((response) => {
              toast({ kind: 'success', message: `${response.restored} configuraciones restauradas.` })
              loadPending()
            })
            .catch((err: unknown) => toast({ kind: 'error', message: ipcErrorMessage(err) }))
        }}
      >
        <ul className="file-list selectable">{pending.slice(0, 8).map((file) => <li key={file}><code>{file}</code></li>)}{pending.length > 8 && <li>y {pending.length - 8} más</li>}</ul>
      </ConfirmDialog>
    </Section>
  )
}

// ─── Account ─────────────────────────────────────────────────────────────────

function AccountSection({ state, idle }: { state: LauncherState; idle: boolean }) {
  const { perform } = useLauncherActions()
  const toast = useToast()
  const logout = useAsyncAction()
  const signedIn = state.account !== null

  return (
    <Section title="Cuenta" description={signedIn ? <>Conectado como <strong translate="no">{state.account?.name}</strong>.</> : 'Inicia sesión para verificar tu licencia de Minecraft Java.'}>
      {signedIn ? (
        <Button
          variant="danger"
          icon={<LogOut size={16} strokeWidth={1.75} aria-hidden="true" />}
          loading={logout.pending}
          disabled={!idle}
          onClick={() => void logout.run(async () => {
            await window.orvian.logout()
            toast({ kind: 'info', message: 'Sesión cerrada.' })
          })}
        >
          Cerrar sesión
        </Button>
      ) : (
        <Button variant="primary" icon={<LogIn size={16} strokeWidth={1.75} aria-hidden="true" />} disabled={!idle} onClick={() => void perform('login')}>
          Iniciar sesión
        </Button>
      )}
    </Section>
  )
}

// ─── Diagnostics ─────────────────────────────────────────────────────────────

function DiagnosticsSection() {
  const toast = useToast()
  return (
    <Section title="Diagnóstico" description="Si algo falla, copia el diagnóstico y envíalo a quien administra el servidor. No contiene contraseñas ni tu nombre de usuario de Windows.">
      <div className="button-row">
        <Button
          icon={<ClipboardCopy size={16} strokeWidth={1.75} aria-hidden="true" />}
          onClick={() => void window.orvian.copyDiagnostics().then(() => toast({ kind: 'success', message: 'Diagnóstico copiado al portapapeles.' })).catch((err: unknown) => toast({ kind: 'error', message: ipcErrorMessage(err) }))}
        >
          Copiar diagnóstico
        </Button>
        <Button icon={<HardDrive size={16} strokeWidth={1.75} aria-hidden="true" />} onClick={() => void window.orvian.openFolder('logs')}>Ver registros</Button>
        <Button icon={<FolderOpen size={16} strokeWidth={1.75} aria-hidden="true" />} onClick={() => void window.orvian.openFolder('game')}>Abrir la carpeta del juego</Button>
      </div>
    </Section>
  )
}

// ─── Advanced ────────────────────────────────────────────────────────────────

function AdvancedSection({ idle }: { idle: boolean }) {
  const toast = useToast()
  const [resetOpen, setResetOpen] = useState(false)
  const [deleteWorlds, setDeleteWorlds] = useState(false)
  const [resetting, setResetting] = useState(false)
  const [quitOpen, setQuitOpen] = useState(false)

  const quit = (): void => {
    window.orvian
      .isMinecraftRunning()
      .then((running) => (running ? setQuitOpen(true) : window.orvian.quitApp()))
      .catch((err: unknown) => toast({ kind: 'error', message: ipcErrorMessage(err) }))
  }

  const reset = async (): Promise<void> => {
    setResetting(true)
    try {
      // Keep nothing of the old session in the window's own storage either
      localStorage.clear()
      sessionStorage.clear()
      const result = await window.orvian.resetInstallation({ deleteWorlds })
      setResetOpen(false)
      toast({ kind: result.ok ? 'success' : 'error', message: result.message })
    } catch (err) {
      toast({ kind: 'error', message: ipcErrorMessage(err) })
    } finally {
      setResetting(false)
      setDeleteWorlds(false)
    }
  }

  return (
    <Section title="Avanzado">
      <div className="button-row">
        <Button variant="danger" icon={<Trash2 size={16} strokeWidth={1.75} aria-hidden="true" />} disabled={!idle} onClick={() => setResetOpen(true)}>Restablecer el launcher</Button>
        <Button icon={<Power size={16} strokeWidth={1.75} aria-hidden="true" />} onClick={quit}>Salir del launcher</Button>
      </div>

      <ConfirmDialog
        open={resetOpen}
        destructive
        busy={resetting}
        title="¿Restablecer el launcher?"
        confirmLabel="Restablecer"
        requireText={deleteWorlds ? 'RESTABLECER' : undefined}
        onCancel={() => {
          setResetOpen(false)
          setDeleteWorlds(false)
        }}
        onConfirm={() => void reset()}
        description="Se cerrará tu sesión y se borrarán Java, los archivos de Minecraft, el modpack, los mods que hayas añadido y los datos del launcher."
      >
        <p className="dialog-meta">Se conservan tus mundos, capturas, resourcepacks, shaders y las opciones del juego.</p>
        <label className="check-row">
          <input type="checkbox" checked={deleteWorlds} onChange={(e) => setDeleteWorlds(e.target.checked)} />
          <span>Borrar también mis mundos, capturas y opciones del juego. No se puede deshacer.</span>
        </label>
      </ConfirmDialog>

      <ConfirmDialog
        open={quitOpen}
        destructive
        title="Minecraft sigue abierto"
        description="No se puede cerrar el launcher dejando Minecraft abierto. ¿Quieres cerrar Minecraft y salir? Se perderá lo que no se haya guardado."
        confirmLabel="Cerrar Minecraft y salir"
        onCancel={() => setQuitOpen(false)}
        onConfirm={() => {
          setQuitOpen(false)
          void window.orvian.forceQuit()
        }}
      />
    </Section>
  )
}
