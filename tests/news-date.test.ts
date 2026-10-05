import { describe, expect, it } from 'vitest'
import { relativeDate } from '../src/ui/components/NewsList'

const NOW = Date.parse('2026-10-05T12:00:00Z')
const ago = (days: number): string => new Date(NOW - days * 86_400_000).toISOString()

describe('relativeDate', () => {
  it.each([
    [ago(0.2), 'hoy'],
    [ago(1), 'ayer'],
    [ago(3), 'hace 3 días'],
    [ago(70), 'hace 2 meses'],
    [ago(800), 'hace 2 años']
  ])('%s → %s', (iso, expected) => expect(relativeDate(iso, NOW)).toBe(expected))

  it('is empty for a missing or invalid date', () => {
    expect(relativeDate(undefined, NOW)).toBe('')
    expect(relativeDate('not a date', NOW)).toBe('')
  })
})
