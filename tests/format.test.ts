import { describe, expect, it } from 'vitest'
import { formatBytes, formatDuration, formatSpeed } from '../src/shared/format'

describe('formatBytes', () => {
  it.each([
    [0, '0 B'],
    [512, '512 B'],
    [1024, '1 KB'],
    [1536, '1,5 KB'],
    [34 * 1024 * 1024, '34 MB'],
    [8.4 * 1024 * 1024, '8,4 MB'],
    [366010881, '349 MB'],
    [1.1 * 1024 ** 3, '1,1 GB'],
    [5 * 1024 ** 4, '5 TB']
  ])('%d -> %s', (bytes, expected) => expect(formatBytes(bytes)).toBe(expected))

  it('never wraps between number and unit and tolerates bad input', () => {
    expect(formatBytes(2048)).toContain(' ')
    expect(formatBytes(-1)).toBe('0 B')
    expect(formatBytes(Number.NaN)).toBe('0 B')
  })
})

describe('formatSpeed / formatDuration', () => {
  it('formats speed with a per-second unit', () => expect(formatSpeed(8.4 * 1024 * 1024)).toBe('8,4 MB/s'))
  it.each([[0, '0:00'], [5, '0:05'], [65, '1:05'], [3723, '1:02:03'], [-4, '0:00'], [59.9, '0:59']])('%d s -> %s', (s, out) => expect(formatDuration(s)).toBe(out))
})
