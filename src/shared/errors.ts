import { redactSecrets } from './redact'

export type OrvianErrorCode =
  | 'NETWORK_OFFLINE'
  | 'OFFLINE_NOT_INSTALLED'
  | 'DOWNLOAD_FAILED'
  | 'HASH_MISMATCH'
  | 'DOWNLOAD_UNVERIFIABLE'
  | 'DISK_FULL'
  | 'PERMISSION'
  | 'JAVA_INSTALL_FAILED'
  | 'FORGE_INSTALL_FAILED'
  | 'LIBRARIES_MISSING'
  | 'PACK_ARCHIVE_MISSING'
  | 'UPDATE_INTERRUPTED'
  | 'MANIFEST_INVALID'
  | 'LAUNCHER_TOO_OLD'
  | 'AUTH_CANCELLED'
  | 'AUTH_NO_XBOX'
  | 'AUTH_CHILD'
  | 'AUTH_REGION'
  | 'AUTH_NO_GAME'
  | 'AUTH_EXPIRED'
  | 'GAME_ALREADY_RUNNING'
  | 'GAME_CRASHED'
  | 'INVALID_ARGUMENT'
  | 'FORBIDDEN'
  | 'BUSY'
  | 'UNKNOWN'

export type ErrorActionId =
  | 'retry'
  | 'repair'
  | 'copy-diagnostics'
  | 'open-logs'
  | 'open-folder'
  | 'login'
  | 'play-offline'
  | 'update-launcher'
  | 'view-crash'
  | 'open-url'
  | 'dismiss'

export interface ErrorAction {
  id: ErrorActionId
  label: string
  /** Only for `open-url`; always https. */
  url?: string
}

export type ErrorDetails = Record<string, string | number | boolean | undefined>

/** Serializable error description shown to the user (structured-clone safe). */
export interface OrvianErrorPayload {
  code: OrvianErrorCode
  title: string
  body: string
  actions: ErrorAction[]
  details: ErrorDetails
  /** Redacted original message, shown folded away and included in diagnostics. */
  technical?: string
}

const ACTION_LABELS: Record<Exclude<ErrorActionId, 'open-url'>, string> = {
  retry: 'Reintentar',
  repair: 'Reparar ahora',
  'copy-diagnostics': 'Copiar diagnóstico',
  'open-logs': 'Ver registro',
  'open-folder': 'Abrir carpeta',
  login: 'Iniciar sesión',
  'play-offline': 'Jugar sin conexión',
  'update-launcher': 'Actualizar launcher',
  'view-crash': 'Ver informe',
  dismiss: 'Cerrar'
}

interface CatalogEntry {
  title: string
  body: string
  actions: ErrorActionId[]
  url?: string
}

/** `{name|fallback}` placeholders are filled from the error details. */
const CATALOG: Record<OrvianErrorCode, CatalogEntry> = {
  NETWORK_OFFLINE: {
    title: 'Sin conexión',
    body: 'Comprueba tu conexión a Internet. Si ya tienes Orvian instalado puedes jugar sin conexión.',
    actions: ['retry', 'play-offline']
  },
  OFFLINE_NOT_INSTALLED: {
    title: 'Orvian no está instalado',
    body: 'Necesitas conexión a Internet para instalar el modpack la primera vez. Conéctate y vuelve a intentarlo.',
    actions: ['retry']
  },
  DOWNLOAD_FAILED: {
    title: 'No se pudo descargar {file|el archivo}',
    body: 'El servidor no respondió como se esperaba. Vuelve a intentarlo en unos minutos.',
    actions: ['retry', 'copy-diagnostics']
  },
  HASH_MISMATCH: {
    title: 'Archivo dañado',
    body: '{file|El archivo} no coincide con la versión oficial. Lo descargaremos de nuevo al reparar.',
    actions: ['repair', 'copy-diagnostics']
  },
  DOWNLOAD_UNVERIFIABLE: {
    title: 'No se puede verificar {file|la descarga}',
    body: 'El servicio no publica una firma para comprobar el archivo, así que por seguridad no se instalará.',
    actions: ['dismiss']
  },
  DISK_FULL: {
    title: 'Espacio insuficiente',
    body: 'No queda espacio libre en {drive|el disco}. Libera espacio y vuelve a intentarlo.',
    actions: ['open-folder', 'retry']
  },
  PERMISSION: {
    title: 'No se pudo escribir en la carpeta del juego',
    body: 'Cierra Minecraft y otros programas que usen la carpeta (por ejemplo, el antivirus) y vuelve a intentarlo.',
    actions: ['retry', 'open-folder']
  },
  JAVA_INSTALL_FAILED: {
    title: 'No se pudo instalar Java',
    body: 'Orvian necesita Java 17 y la instalación ha fallado. Vuelve a intentarlo; si persiste, copia el diagnóstico.',
    actions: ['retry', 'copy-diagnostics']
  },
  FORGE_INSTALL_FAILED: {
    title: 'No se pudo instalar Forge',
    body: 'El instalador de Forge terminó con un error. Vuelve a intentarlo; los detalles están en el registro.',
    actions: ['retry', 'open-logs']
  },
  LIBRARIES_MISSING: {
    title: 'Faltan {n|varios} archivos del juego',
    body: 'No se pudieron descargar todas las librerías de Minecraft. Repara la instalación para volver a obtenerlas.',
    actions: ['repair', 'copy-diagnostics']
  },
  PACK_ARCHIVE_MISSING: {
    title: 'La versión {v|nueva} aún no está disponible',
    body: 'El administrador la está publicando. Prueba de nuevo en unos minutos.',
    actions: ['retry']
  },
  UPDATE_INTERRUPTED: {
    title: 'La actualización no terminó',
    body: 'Se interrumpió una actualización del modpack y algunos archivos pueden estar a medias. Conéctate para completarla o repara la instalación.',
    actions: ['retry', 'repair']
  },
  MANIFEST_INVALID: {
    title: 'Datos del modpack no válidos',
    body: 'El manifiesto publicado no es correcto. Avisa al administrador y copia el diagnóstico.',
    actions: ['copy-diagnostics', 'retry']
  },
  LAUNCHER_TOO_OLD: {
    title: 'Actualiza el launcher',
    body: 'Esta versión del modpack necesita una versión más reciente de Orvian Launcher.',
    actions: ['update-launcher']
  },
  AUTH_CANCELLED: {
    title: 'Inicio de sesión cancelado',
    body: 'Cerraste la ventana de Microsoft antes de terminar.',
    actions: ['login', 'dismiss']
  },
  AUTH_NO_XBOX: {
    title: 'Tu cuenta no tiene perfil de Xbox',
    body: 'Crea un perfil de Xbox iniciando sesión en minecraft.net con esta cuenta y vuelve a intentarlo.',
    actions: ['open-url', 'login'],
    url: 'https://www.minecraft.net/login'
  },
  AUTH_CHILD: {
    title: 'La cuenta es de un menor',
    body: 'Microsoft exige que un adulto añada esta cuenta a un grupo familiar antes de poder jugar.',
    actions: ['open-url', 'login'],
    url: 'https://account.microsoft.com/family'
  },
  AUTH_REGION: {
    title: 'Xbox Live no está disponible para esta cuenta',
    body: 'Microsoft no ofrece Xbox Live en la región de la cuenta o requiere verificación de edad.',
    actions: ['login']
  },
  AUTH_NO_GAME: {
    title: 'Esta cuenta no tiene Minecraft Java',
    body: 'No encontramos una licencia de Minecraft Java Edition. Inicia sesión con otra cuenta.',
    actions: ['login']
  },
  AUTH_EXPIRED: {
    title: 'Tu sesión ha caducado',
    body: 'Vuelve a iniciar sesión para continuar.',
    actions: ['login']
  },
  GAME_ALREADY_RUNNING: {
    title: 'Minecraft ya está abierto',
    body: 'Ciérralo antes de iniciar otra partida desde el launcher.',
    actions: ['dismiss']
  },
  GAME_CRASHED: {
    title: 'Minecraft se cerró inesperadamente',
    body: '{summary|Revisa el informe para ver qué ocurrió.}',
    actions: ['view-crash', 'repair', 'copy-diagnostics']
  },
  INVALID_ARGUMENT: {
    title: 'Solicitud no válida',
    body: 'La petición tenía datos incorrectos. Si se repite, copia el diagnóstico.',
    actions: ['copy-diagnostics']
  },
  FORBIDDEN: {
    title: 'Acción no permitida',
    body: 'No tienes permiso para realizar esta acción.',
    actions: ['dismiss']
  },
  BUSY: {
    title: 'El launcher está ocupado',
    body: 'Hay otra operación en curso. Espera a que termine.',
    actions: ['dismiss']
  },
  UNKNOWN: {
    title: 'Algo ha fallado',
    body: 'Ocurrió un error inesperado. Vuelve a intentarlo; si se repite, copia el diagnóstico.',
    actions: ['retry', 'copy-diagnostics']
  }
}

function fill(template: string, details: ErrorDetails): string {
  return template.replace(/\{(\w+)(?:\|([^}]*))?\}/g, (_m, key: string, fallback?: string) => {
    const value = details[key]
    return value === undefined || value === '' ? (fallback ?? '') : String(value)
  })
}

export function describeError(code: OrvianErrorCode, details: ErrorDetails = {}): Pick<OrvianErrorPayload, 'title' | 'body' | 'actions'> {
  const entry = CATALOG[code]
  const actions: ErrorAction[] = entry.actions.map((id) =>
    id === 'open-url' ? { id, label: 'Abrir página', url: entry.url } : { id, label: ACTION_LABELS[id] }
  )
  return { title: fill(entry.title, details), body: fill(entry.body, details), actions }
}

export class OrvianError extends Error {
  readonly code: OrvianErrorCode
  readonly details: ErrorDetails

  constructor(code: OrvianErrorCode, details: ErrorDetails = {}, options: { cause?: unknown; message?: string } = {}) {
    super(options.message ?? describeError(code, details).title, options.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'OrvianError'
    this.code = code
    this.details = details
  }
}

const NETWORK_CODES = new Set([
  'ENOTFOUND', 'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EAI_AGAIN', 'ENETUNREACH', 'EHOSTUNREACH', 'ENETDOWN',
  'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_SOCKET', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT'
])

function codeOf(err: unknown): string | undefined {
  if (typeof err !== 'object' || err === null) return undefined
  const direct = (err as { code?: unknown }).code
  if (typeof direct === 'string') return direct
  const cause = (err as { cause?: unknown }).cause
  return cause === undefined ? undefined : codeOf(cause)
}

export function messageOf(err: unknown): string {
  if (err instanceof Error) return err.message
  return typeof err === 'string' ? err : String(err)
}

/** Maps Node/network failures to a catalog code; anything unrecognised becomes UNKNOWN. */
export function fromNodeError(err: unknown, details: ErrorDetails = {}): OrvianError {
  if (err instanceof OrvianError) return err
  const code = codeOf(err)
  const message = messageOf(err)
  if (code === 'ENOSPC') return new OrvianError('DISK_FULL', details, { cause: err, message })
  if (code === 'EPERM' || code === 'EACCES' || code === 'EBUSY' || code === 'EROFS') {
    return new OrvianError('PERMISSION', details, { cause: err, message })
  }
  if (code && NETWORK_CODES.has(code)) return new OrvianError('NETWORK_OFFLINE', details, { cause: err, message })
  if (err instanceof TypeError && message === 'fetch failed') return new OrvianError('NETWORK_OFFLINE', details, { cause: err, message })
  if (err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError')) {
    return new OrvianError('DOWNLOAD_FAILED', { ...details, reason: 'timeout' }, { cause: err, message })
  }
  return new OrvianError('UNKNOWN', details, { cause: err, message })
}

export function toPayload(err: unknown): OrvianErrorPayload {
  const error = fromNodeError(err)
  return {
    code: error.code,
    ...describeError(error.code, error.details),
    details: error.details,
    technical: redactSecrets(error.message).slice(0, 2000)
  }
}

/**
 * One-line text for places that still show plain strings. Unrecognised errors keep their
 * original message so existing, already-localised errors are not replaced by a generic one.
 */
export function userMessage(err: unknown): string {
  const error = fromNodeError(err)
  if (error.code === 'UNKNOWN') return messageOf(err)
  const { title, body } = describeError(error.code, error.details)
  return `${title}. ${body}`
}
