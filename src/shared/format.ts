const NBSP = ' '

/** "34 MB", "1,1 GB": Spanish decimal comma and a non-breaking space so the unit never wraps. */
export function formatBytes(bytes: number, locale = 'es'): string {
  if (!Number.isFinite(bytes) || bytes < 0) return `0${NBSP}B`
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit++
  }
  const digits = unit === 0 || value >= 100 ? 0 : 1
  return `${new Intl.NumberFormat(locale, { maximumFractionDigits: digits, minimumFractionDigits: 0 }).format(value)}${NBSP}${units[unit]}`
}

/** "8,4 MB/s" */
export function formatSpeed(bytesPerSecond: number, locale = 'es'): string {
  return `${formatBytes(bytesPerSecond, locale)}/s`
}

/** "1:05" or "1:02:03" for elapsed play time. */
export function formatDuration(totalSeconds: number): string {
  const seconds = Math.max(0, Math.floor(totalSeconds))
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = seconds % 60
  const pad = (n: number): string => String(n).padStart(2, '0')
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`
}
