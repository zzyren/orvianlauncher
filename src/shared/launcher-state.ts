import type { OrvianErrorPayload } from './errors'
import { compareVersions } from './manifest'
import { formatBytes } from './format'

/** The launcher's whole observable state. The main process owns it; windows only render it. */

export type InstallStep = 'java' | 'minecraft' | 'forge' | 'libraries' | 'modpack' | 'finalizing'

export const INSTALL_STEPS: readonly InstallStep[] = ['java', 'minecraft', 'forge', 'libraries', 'modpack', 'finalizing']

export interface InstallProgress {
  step: InstallStep
  detail: string
  /** Overall progress from 0 to 1. */
  fraction: number
  current?: number
  total?: number
  bytesDone?: number
  bytesTotal?: number
  bytesPerSecond?: number
}

export type RetryKind = 'play' | 'repair' | 'check' | 'login'

export type LauncherPhase =
  | { kind: 'booting' }
  | { kind: 'signed-out' }
  | { kind: 'signing-in' }
  | { kind: 'session-expired' }
  | { kind: 'checking' }
  | { kind: 'not-installed' }
  | { kind: 'update-available' }
  | { kind: 'ready' }
  | { kind: 'offline-ready' }
  | { kind: 'offline-unavailable' }
  | { kind: 'launcher-update-required'; required: string }
  | { kind: 'installing'; progress: InstallProgress }
  | { kind: 'repairing'; progress: InstallProgress }
  | { kind: 'launching' }
  | { kind: 'running'; startedAt: number }
  | { kind: 'crashed'; exitCode: number | null; summary: string; reportPath?: string }
  | { kind: 'error'; error: OrvianErrorPayload; retry: RetryKind }

export interface PhaseFacts {
  booted: boolean
  hasAccount: boolean
  signingIn: boolean
  sessionExpired: boolean
  checking: boolean
  manifest: { version: string; minimumLauncher: string; source: 'network' | 'cache' } | null
  installedVersion: string | null
  appVersion: string
  activity: { kind: 'installing' | 'repairing'; progress: InstallProgress } | { kind: 'launching' } | { kind: 'running'; startedAt: number } | null
  crash: { exitCode: number | null; summary: string; reportPath?: string } | null
  error: { error: OrvianErrorPayload; retry: RetryKind } | null
}

/** An update exists only when the published version is newer than the installed one. */
export function isNewer(latest: string | null, installed: string | null): boolean {
  return Boolean(latest && installed && compareVersions(latest, installed) > 0)
}

/**
 * Which screen state the launcher is in. Evaluated top to bottom: work in progress wins over
 * everything, then sign-in problems, then what the player can do with the installed pack.
 */
export function derivePhase(f: PhaseFacts): LauncherPhase {
  if (!f.booted) return { kind: 'booting' }
  if (f.activity?.kind === 'installing' || f.activity?.kind === 'repairing') return { kind: f.activity.kind, progress: f.activity.progress }
  if (f.activity?.kind === 'launching') return { kind: 'launching' }
  if (f.activity?.kind === 'running') return { kind: 'running', startedAt: f.activity.startedAt }
  if (f.signingIn) return { kind: 'signing-in' }
  if (f.error) return { kind: 'error', error: f.error.error, retry: f.error.retry }
  if (!f.hasAccount) return { kind: f.sessionExpired ? 'session-expired' : 'signed-out' }
  if (f.crash) return { kind: 'crashed', ...f.crash }
  if (f.manifest && compareVersions(f.appVersion, f.manifest.minimumLauncher) < 0) return { kind: 'launcher-update-required', required: f.manifest.minimumLauncher }
  if (!f.manifest) {
    if (f.checking) return { kind: 'checking' }
    return { kind: f.installedVersion ? 'offline-ready' : 'offline-unavailable' }
  }
  // The pack information is the last saved copy: the network could not be reached.
  if (f.manifest.source === 'cache') return { kind: f.installedVersion ? 'offline-ready' : 'offline-unavailable' }
  if (!f.installedVersion) return { kind: 'not-installed' }
  return { kind: isNewer(f.manifest.version, f.installedVersion) ? 'update-available' : 'ready' }
}

export interface ServerStatus {
  address: string
  state: 'unknown' | 'checking' | 'online' | 'offline'
  players?: { online: number; max: number }
  latencyMs?: number
  /** Plain text: formatting codes are removed. */
  motd?: string
  version?: string
  checkedAt?: number
}

export interface NewsItem {
  version: string
  publishedAt?: string
  notes: string[]
}

export type UpdaterStatus = 'idle' | 'checking' | 'available' | 'downloading' | 'downloaded' | 'error'

export interface UpdaterState {
  status: UpdaterStatus
  currentVersion: string
  newVersion?: string
  percent?: number
  bytesPerSecond?: number
  message?: string
}

export interface LauncherState {
  phase: LauncherPhase
  appVersion: string
  account: { name: string; uuid: string } | null
  isAdmin: boolean
  pack: {
    installed: string | null
    latest: string | null
    hasUpdate: boolean
    /** True when the information is the last saved copy because GitHub could not be reached. */
    offline: boolean
    downloadBytes?: number
    changelog: string[]
  }
  settings: { ramGb: number; ramMin: number; ramMax: number }
  server: ServerStatus
  news: NewsItem[]
  launcherUpdate: UpdaterState
}

export type PrimaryActionId = 'play' | 'play-installed' | 'login' | 'cancel-login' | 'check' | 'update-launcher' | 'repair' | 'force-quit' | 'none'

export interface PrimaryAction {
  label: string
  sublabel: string
  enabled: boolean
  action: PrimaryActionId
  /** Extra action shown next to the main one (cancel, retry, force close). */
  secondary?: { label: string; action: PrimaryActionId }
}

const NBSP = ' '
const percent = (fraction: number): string => `${Math.round(Math.min(1, Math.max(0, fraction)) * 100)}${NBSP}%`

/** Text and behaviour of the one big button, shared by the main window and the tray menu. */
export function getPrimaryAction(state: Pick<LauncherState, 'phase' | 'pack'>): PrimaryAction {
  const { phase, pack } = state
  const size = pack.downloadBytes ? ` · ${formatBytes(pack.downloadBytes)}` : ''
  switch (phase.kind) {
    case 'booting':
    case 'checking':
      return { label: 'Comprobando…', sublabel: '', enabled: false, action: 'none' }
    case 'signed-out':
      return { label: 'Iniciar sesión', sublabel: 'Necesitas una cuenta de Minecraft Java', enabled: true, action: 'login' }
    case 'signing-in':
      return { label: 'Iniciando sesión…', sublabel: 'Completa el acceso en la ventana de Microsoft', enabled: false, action: 'none', secondary: { label: 'Cancelar', action: 'cancel-login' } }
    case 'session-expired':
      return { label: 'Volver a iniciar sesión', sublabel: 'Tu sesión ha caducado', enabled: true, action: 'login' }
    case 'not-installed':
      return { label: 'Instalar', sublabel: `Primera instalación${size}`, enabled: true, action: 'play' }
    case 'update-available':
      return { label: 'Actualizar y jugar', sublabel: `v${pack.installed} → v${pack.latest}${size}`, enabled: true, action: 'play' }
    case 'ready':
      return { label: 'Jugar', sublabel: `Orvian v${pack.installed}`, enabled: true, action: 'play' }
    case 'offline-ready':
      return { label: 'Jugar sin conexión', sublabel: `Usarás la versión instalada v${pack.installed}`, enabled: true, action: 'play-installed' }
    case 'offline-unavailable':
      return { label: 'Sin conexión', sublabel: 'Conéctate para instalar Orvian', enabled: false, action: 'none', secondary: { label: 'Reintentar', action: 'check' } }
    case 'launcher-update-required':
      return { label: 'Actualizar launcher', sublabel: `Esta versión requiere Orvian Launcher ${phase.required} o superior`, enabled: true, action: 'update-launcher' }
    case 'installing':
      return { label: `Instalando… ${percent(phase.progress.fraction)}`, sublabel: phase.progress.detail, enabled: false, action: 'none' }
    case 'repairing':
      return { label: `Reparando… ${percent(phase.progress.fraction)}`, sublabel: phase.progress.detail, enabled: false, action: 'none' }
    case 'launching':
      return { label: 'Abriendo Minecraft…', sublabel: '', enabled: false, action: 'none' }
    case 'running':
      return { label: 'Jugando', sublabel: 'Minecraft está en ejecución', enabled: false, action: 'none', secondary: { label: 'Forzar cierre', action: 'force-quit' } }
    case 'crashed':
      return { label: 'Jugar', sublabel: 'Minecraft se cerró inesperadamente', enabled: true, action: 'play' }
    case 'error':
      return { label: 'Reintentar', sublabel: phase.error.title, enabled: true, action: phase.retry === 'login' ? 'login' : phase.retry === 'repair' ? 'repair' : phase.retry === 'check' ? 'check' : 'play' }
  }
}
