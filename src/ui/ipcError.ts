/** Electron prefixes errors thrown by IPC handlers; show only the part written for the user. */
export function ipcErrorMessage(err: unknown, fallback = 'Ha ocurrido un error inesperado.'): string {
  const raw = err instanceof Error ? err.message : typeof err === 'string' ? err : ''
  const cleaned = raw.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '').trim()
  return cleaned || fallback
}
