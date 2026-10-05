import { createServer, type Server, type Socket } from 'node:net'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildHandshake, decodeVarInt, encodeVarInt, flattenChat, interpretStatus, parseStatusResponse, pingServer, ServerMonitor, STATUS_REQUEST } from '../electron/serverStatus'

const response = (json: unknown): Buffer => {
  const text = Buffer.from(JSON.stringify(json), 'utf8')
  const payload = Buffer.concat([encodeVarInt(0), encodeVarInt(text.length), text])
  return Buffer.concat([encodeVarInt(payload.length), payload])
}

describe('VarInt', () => {
  it.each([[0, [0x00]], [1, [0x01]], [127, [0x7f]], [128, [0x80, 0x01]], [255, [0xff, 0x01]], [25565, [0xdd, 0xc7, 0x01]], [2097151, [0xff, 0xff, 0x7f]]])('encodes %d', (value, bytes) => {
    expect([...encodeVarInt(value)]).toEqual(bytes)
    expect(decodeVarInt(Buffer.from(bytes))).toEqual({ value, size: bytes.length })
  })
  it('reports an incomplete value as null and rejects an endless one', () => {
    expect(decodeVarInt(Buffer.from([0x80]))).toBeNull()
    expect(decodeVarInt(Buffer.alloc(0))).toBeNull()
    expect(() => decodeVarInt(Buffer.from([0x80, 0x80, 0x80, 0x80, 0x80, 0x80]))).toThrow()
  })
  it('decodes at an offset', () => expect(decodeVarInt(Buffer.from([0xff, 0xdd, 0xc7, 0x01]), 1)).toEqual({ value: 25565, size: 3 }))
})

describe('buildHandshake', () => {
  it('encodes protocol, host, port and the status intent', () => {
    const packet = buildHandshake('mc.example.test', 25570)
    const length = decodeVarInt(packet, 0)!
    const body = packet.subarray(length.size)
    expect(body.length).toBe(length.value)
    expect(body[0]).toBe(0x00)
    const protocol = decodeVarInt(body, 1)!
    expect(protocol.value).toBe(763)
    const hostLength = decodeVarInt(body, 1 + protocol.size)!
    const hostStart = 1 + protocol.size + hostLength.size
    expect(body.subarray(hostStart, hostStart + hostLength.value).toString()).toBe('mc.example.test')
    expect(body.readUInt16BE(hostStart + hostLength.value)).toBe(25570)
    expect(body.at(-1)).toBe(1)
  })
  it('the status request is a one byte packet', () => expect([...STATUS_REQUEST]).toEqual([0x01, 0x00]))
})

describe('parseStatusResponse', () => {
  it('returns the JSON once the packet is complete, null before', () => {
    const full = response({ players: { online: 1, max: 2 } })
    expect(parseStatusResponse(full.subarray(0, full.length - 3))).toBeNull()
    expect(parseStatusResponse(full.subarray(0, 1))).toBeNull()
    expect(parseStatusResponse(full)).toEqual({ players: { online: 1, max: 2 } })
  })
  it('rejects oversized, wrong-type and malformed packets', () => {
    expect(() => parseStatusResponse(encodeVarInt(5_000_000))).toThrow()
    expect(() => parseStatusResponse(Buffer.concat([encodeVarInt(2), Buffer.from([0x05, 0x00])]))).toThrow()
    expect(() => parseStatusResponse(Buffer.concat([encodeVarInt(4), Buffer.from([0x00, 0x09, 0x41, 0x42])]))).toThrow()
    const garbageJson = Buffer.concat([encodeVarInt(0), encodeVarInt(4), Buffer.from('nope')])
    expect(() => parseStatusResponse(Buffer.concat([encodeVarInt(garbageJson.length), garbageJson]))).toThrow()
  })
})

describe('flattenChat', () => {
  it.each([
    ['plain', 'plain'],
    ['§6§lOrvian§r §7survival', 'Orvian survival'],
    [{ text: 'Hola ', extra: [{ text: 'mundo', color: 'red' }, ' !'] }, 'Hola mundo !'],
    [[{ text: 'A' }, { text: 'B' }], 'AB'],
    ['  lots   of\n space ', 'lots of space'],
    [null, ''],
    [42, '']
  ])('%j -> %j', (input, expected) => expect(flattenChat(input)).toBe(expected))
})

describe('interpretStatus', () => {
  const raw = { version: { name: 'Forge 1.20.1', protocol: 763 }, players: { online: 7, max: 20 }, description: '§aBienvenido' }
  it('reads an online server', () => {
    expect(interpretStatus('mc.test', raw, 42, 1000)).toEqual({ address: 'mc.test', state: 'online', players: { online: 7, max: 20 }, latencyMs: 42, motd: 'Bienvenido', version: 'Forge 1.20.1', checkedAt: 1000 })
  })
  it.each([[{ name: '● Offline', protocol: -1 }], [{ name: 'Offline', protocol: 763 }], [{ name: 'x', protocol: -1 }]])('treats a hosting proxy placeholder %j as offline', (version) => {
    expect(interpretStatus('mc.test', { ...raw, version }, 1, 1).state).toBe('offline')
  })
  it('tolerates missing fields', () => {
    expect(interpretStatus('mc.test', {}, 5, 9)).toMatchObject({ state: 'online', players: undefined, motd: undefined })
    expect(interpretStatus('mc.test', null, 5, 9).state).toBe('online')
  })
})

describe('pingServer against a real socket', () => {
  let server: Server | null = null
  afterEach(async () => {
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()))
    server = null
  })

  const listen = async (onConnection: (socket: Socket, received: Buffer[]) => void) => {
    server = createServer((socket) => {
      const received: Buffer[] = []
      socket.on('data', (d) => { received.push(d); onConnection(socket, received) })
      socket.on('error', () => undefined)
    })
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve))
    return (server.address() as AddressInfo).port
  }

  it('reads a normal server and sends a valid handshake', async () => {
    let handshake: Buffer | null = null
    const port = await listen((socket, received) => {
      handshake = Buffer.concat(received)
      socket.write(response({ version: { name: '1.20.1', protocol: 763 }, players: { online: 3, max: 10 }, description: { text: 'Hi' } }))
    })
    const status = await pingServer({ host: '127.0.0.1', port })
    expect(status).toMatchObject({ state: 'online', players: { online: 3, max: 10 }, motd: 'Hi', version: '1.20.1' })
    expect(status.latencyMs).toBeGreaterThanOrEqual(0)
    expect(status.address).toBe(`127.0.0.1:${port}`)
    expect(handshake!.subarray(-2).equals(STATUS_REQUEST)).toBe(true)
  })

  it('assembles a response that arrives in small pieces', async () => {
    const port = await listen((socket) => {
      const data = response({ version: { name: 'x', protocol: 763 }, players: { online: 1, max: 1 }, description: 'chunked' })
      let offset = 0
      const timer = setInterval(() => {
        socket.write(data.subarray(offset, offset + 7))
        offset += 7
        if (offset >= data.length) clearInterval(timer)
      }, 5)
    })
    expect(await pingServer({ host: '127.0.0.1', port })).toMatchObject({ state: 'online', motd: 'chunked' })
  })

  it('reports a hosting proxy placeholder as offline', async () => {
    const port = await listen((socket) => socket.write(response({ version: { name: '● Offline', protocol: -1 }, players: { online: 0, max: 0 }, description: 'Server offline' })))
    expect((await pingServer({ host: '127.0.0.1', port })).state).toBe('offline')
  })

  it('treats a refused connection as offline, quickly', async () => {
    const probe = createServer()
    await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve))
    const { port } = probe.address() as AddressInfo
    await new Promise<void>((resolve) => probe.close(() => resolve()))
    const started = Date.now()
    expect((await pingServer({ host: '127.0.0.1', port, timeoutMs: 2000 })).state).toBe('offline')
    expect(Date.now() - started).toBeLessThan(1500)
  })

  it('gives up on a server that accepts but never answers', async () => {
    const port = await listen(() => undefined)
    const started = Date.now()
    expect((await pingServer({ host: '127.0.0.1', port, timeoutMs: 150 })).state).toBe('offline')
    expect(Date.now() - started).toBeLessThan(1500)
  })

  it.each([
    ['garbage', () => Buffer.from('HTTP/1.1 400 Bad Request\r\n\r\n')],
    ['an absurd length', () => encodeVarInt(900_000_000)],
    ['a closed connection', () => Buffer.alloc(0)]
  ])('treats %s as offline', async (_label, reply) => {
    const port = await listen((socket) => { const data = reply(); if (data.length) socket.write(data); else socket.end() })
    expect((await pingServer({ host: '127.0.0.1', port, timeoutMs: 500 })).state).toBe('offline')
  })
})

describe('ServerMonitor', () => {
  const ok = { address: 'mc.test', state: 'online' as const }
  const setup = (active = true) => {
    const seen: string[] = []
    const ping = vi.fn(async () => ok)
    const monitor = new ServerMonitor({ getTarget: () => ({ host: 'mc.test', port: 25565 }), isActive: () => active, onStatus: (s) => void seen.push(s.state), ping, intervalMs: 1000 })
    return { monitor, ping, seen, setActive: (v: boolean) => (active = v) }
  }

  it('shows "checking" only before the first answer', async () => {
    const { monitor, seen } = setup()
    await monitor.refresh()
    await monitor.refresh()
    expect(seen).toEqual(['checking', 'online', 'online'])
  })

  it('checks on its interval only while active, and stops when asked', async () => {
    vi.useFakeTimers()
    const { monitor, ping, setActive } = setup(true)
    monitor.start()
    await vi.advanceTimersByTimeAsync(1000)
    expect(ping).toHaveBeenCalledTimes(1)
    setActive(false)
    await vi.advanceTimersByTimeAsync(3000)
    expect(ping).toHaveBeenCalledTimes(1)
    setActive(true)
    await vi.advanceTimersByTimeAsync(1000)
    expect(ping).toHaveBeenCalledTimes(2)
    monitor.stop()
    await vi.advanceTimersByTimeAsync(5000)
    expect(ping).toHaveBeenCalledTimes(2)
    vi.useRealTimers()
  })
})
