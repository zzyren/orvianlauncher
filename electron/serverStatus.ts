import { createConnection } from 'node:net'
import type { ServerStatus } from '../src/shared/launcher-state'

/** Minecraft "Server List Ping" (Java Edition 1.7+): enough of the protocol to read player counts. */

/** Protocol number of 1.20.1; servers answer status requests whatever number is sent. */
const PROTOCOL_VERSION = 763
const MAX_PACKET_BYTES = 1_048_576

export function encodeVarInt(input: number): Buffer {
  const bytes: number[] = []
  let value = input >>> 0
  do {
    let byte = value & 0x7f
    value >>>= 7
    if (value !== 0) byte |= 0x80
    bytes.push(byte)
  } while (value !== 0)
  return Buffer.from(bytes)
}

/** Reads a VarInt at `offset`; null when the buffer ends before it is complete. */
export function decodeVarInt(buffer: Buffer, offset = 0): { value: number; size: number } | null {
  let value = 0
  for (let i = 0; i < 5; i++) {
    if (offset + i >= buffer.length) return null
    const byte = buffer[offset + i]
    value |= (byte & 0x7f) << (7 * i)
    if ((byte & 0x80) === 0) return { value, size: i + 1 }
  }
  throw new Error('VarInt demasiado largo')
}

const frame = (payload: Buffer): Buffer => Buffer.concat([encodeVarInt(payload.length), payload])

export function buildHandshake(host: string, port: number): Buffer {
  const hostBytes = Buffer.from(host, 'utf8')
  const portBytes = Buffer.alloc(2)
  portBytes.writeUInt16BE(port)
  return frame(Buffer.concat([encodeVarInt(0x00), encodeVarInt(PROTOCOL_VERSION), encodeVarInt(hostBytes.length), hostBytes, portBytes, encodeVarInt(1)]))
}

export const STATUS_REQUEST = frame(encodeVarInt(0x00))

/** The JSON of a complete status response, or null while more bytes are still needed. */
export function parseStatusResponse(buffer: Buffer): unknown | null {
  const length = decodeVarInt(buffer, 0)
  if (!length) return null
  if (length.value < 1 || length.value > MAX_PACKET_BYTES) throw new Error('Tamaño de paquete no válido')
  if (buffer.length < length.size + length.value) return null
  const packet = buffer.subarray(length.size, length.size + length.value)
  const id = decodeVarInt(packet, 0)
  if (!id || id.value !== 0x00) throw new Error('Respuesta inesperada del servidor')
  const textLength = decodeVarInt(packet, id.size)
  if (!textLength || textLength.value < 0 || id.size + textLength.size + textLength.value > packet.length) throw new Error('Respuesta incompleta')
  const start = id.size + textLength.size
  return JSON.parse(packet.subarray(start, start + textLength.value).toString('utf8'))
}

/** Chat components arrive as a string or a tree of `{text, extra}`; keep the text, drop formatting codes. */
export function flattenChat(description: unknown): string {
  const walk = (node: unknown): string => {
    if (typeof node === 'string') return node
    if (Array.isArray(node)) return node.map(walk).join('')
    if (node && typeof node === 'object') {
      const component = node as { text?: unknown; extra?: unknown }
      return `${typeof component.text === 'string' ? component.text : ''}${component.extra ? walk(component.extra) : ''}`
    }
    return ''
  }
  return walk(description).replace(/§[0-9a-fk-or]/gi, '').replace(/\s+/g, ' ').trim()
}

interface RawStatus {
  version?: { name?: unknown; protocol?: unknown }
  players?: { online?: unknown; max?: unknown }
  description?: unknown
}

export function interpretStatus(address: string, raw: unknown, latencyMs: number, checkedAt: number): ServerStatus {
  const status = (raw ?? {}) as RawStatus
  const versionName = typeof status.version?.name === 'string' ? status.version.name : undefined
  const protocol = typeof status.version?.protocol === 'number' ? status.version.protocol : undefined
  const motd = flattenChat(status.description)
  // Hosting proxies (e.g. exaroton) answer for a stopped server with a fake status that flags itself
  // as offline through a negative protocol or an "Offline" version label.
  const hostedAsOffline = (protocol !== undefined && protocol < 0) || (versionName !== undefined && /offline/i.test(versionName))
  if (hostedAsOffline) return { address, state: 'offline', motd: motd || undefined, checkedAt }
  const online = Number(status.players?.online)
  const max = Number(status.players?.max)
  return {
    address,
    state: 'online',
    players: Number.isFinite(online) && Number.isFinite(max) ? { online, max } : undefined,
    latencyMs,
    motd: motd || undefined,
    version: versionName,
    checkedAt
  }
}

export interface PingOptions {
  host: string
  port: number
  timeoutMs?: number
  now?: () => number
}

/** Never throws: any failure (refused, timeout, garbage) is simply an offline server. */
export function pingServer(options: PingOptions): Promise<ServerStatus> {
  const { host, port, timeoutMs = 3000, now = Date.now } = options
  const address = port === 25565 ? host : `${host}:${port}`
  return new Promise((resolve) => {
    let settled = false
    let received = Buffer.alloc(0)
    let sentAt = 0
    const socket = createConnection({ host, port })

    const finish = (status: ServerStatus): void => {
      if (settled) return
      settled = true
      socket.destroy()
      resolve(status)
    }
    const offline = (): void => finish({ address, state: 'offline', checkedAt: now() })

    socket.setTimeout(timeoutMs, offline)
    socket.on('error', offline)
    socket.on('close', offline)
    socket.on('connect', () => {
      socket.write(Buffer.concat([buildHandshake(host, port), STATUS_REQUEST]))
      sentAt = now()
    })
    socket.on('data', (chunk) => {
      received = Buffer.concat([received, chunk])
      try {
        const raw = parseStatusResponse(received)
        if (raw !== null) finish(interpretStatus(address, raw, Math.max(0, now() - sentAt), now()))
      } catch {
        offline()
      }
    })
  })
}

export interface MonitorDeps {
  getTarget: () => { host: string; port: number }
  /** True while someone can see the result (a visible window) and the game is not running. */
  isActive: () => boolean
  onStatus: (status: ServerStatus) => void
  ping?: typeof pingServer
  intervalMs?: number
}

/** Checks the server once a minute while it matters, and on demand. */
export class ServerMonitor {
  private timer: NodeJS.Timeout | null = null
  private hasAnswer = false

  constructor(private readonly deps: MonitorDeps) {}

  start(): void {
    this.stop()
    this.timer = setInterval(() => {
      if (this.deps.isActive()) void this.refresh()
    }, this.deps.intervalMs ?? 60_000)
    this.timer.unref?.()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  async refresh(): Promise<void> {
    const target = this.deps.getTarget()
    const address = target.port === 25565 ? target.host : `${target.host}:${target.port}`
    // Show "checking" only until the first answer, so a routine refresh does not flicker the card.
    if (!this.hasAnswer) this.deps.onStatus({ address, state: 'checking' })
    const status = await (this.deps.ping ?? pingServer)({ host: target.host, port: target.port })
    this.hasAnswer = true
    this.deps.onStatus(status)
  }
}
