import { describe, expect, it } from 'vitest'
import { ProgressTracker, type ProgressEvent } from '../electron/game/progress'

function setup(minIntervalMs = 100) {
  const events: ProgressEvent[] = []
  let clock = 0
  const tracker = new ProgressTracker((e) => events.push(e), () => clock, minIntervalMs)
  return { tracker, events, advance: (ms: number) => (clock += ms) }
}

describe('ProgressTracker', () => {
  it('maps each step into its slice of the overall bar and keeps legacy state names', () => {
    const { tracker, events, advance } = setup()
    const slices: Array<[Parameters<typeof tracker.begin>[0], string, number, number]> = [
      ['java', 'java', 0, 0.15],
      ['minecraft', 'minecraft', 0.15, 0.25],
      ['forge', 'forge', 0.25, 0.5],
      ['libraries', 'deps', 0.5, 0.85],
      ['modpack', 'pack', 0.85, 0.97],
      ['finalizing', 'launching', 0.97, 1]
    ]
    for (const [step, state, from, to] of slices) {
      advance(200)
      tracker.begin(step, 'start')
      advance(200)
      tracker.done(step)
      const [begin, end] = events.slice(-2)
      expect(begin).toMatchObject({ state, step, progress: from })
      expect(end.progress).toBe(to)
    }
  })

  it('computes progress inside a step from counts, then from bytes', () => {
    const { tracker, events, advance } = setup()
    tracker.begin('libraries', 'x')
    advance(200)
    tracker.update({ current: 50, total: 100 })
    expect(events.at(-1)!.progress).toBeCloseTo(0.5 + 0.35 * 0.5, 4)
    advance(200)
    tracker.update({ bytesDone: 25, bytesTotal: 100 })
    expect(events.at(-1)!.progress).toBeCloseTo(0.5 + 0.35 * 0.25, 4)
  })

  it('never goes outside the step range, even with bad numbers', () => {
    const { tracker, events, advance } = setup()
    tracker.begin('forge', 'x')
    advance(200)
    tracker.update({ current: 999, total: 10 })
    expect(events.at(-1)!.progress).toBe(0.5)
    advance(200)
    tracker.update({ current: -5, total: 10 })
    expect(events.at(-1)!.progress).toBe(0.25)
  })

  it('throttles updates but never drops a step change', () => {
    const { tracker, events, advance } = setup(100)
    tracker.begin('libraries', 'x')
    for (let i = 0; i < 20; i++) {
      advance(5)
      tracker.update({ current: i, total: 20 })
    }
    expect(events.length).toBeLessThanOrEqual(2)
    tracker.begin('modpack', 'next')
    expect(events.at(-1)).toMatchObject({ step: 'modpack', detail: 'next' })
  })

  it('keeps the position inside the step when an update carries no numbers', () => {
    const { tracker, events, advance } = setup()
    tracker.begin('libraries', 'x')
    advance(200)
    tracker.update({ current: 80, total: 100 })
    const before = events.at(-1)!.progress
    advance(200)
    tracker.update({ detail: 'still going' })
    expect(events.at(-1)).toMatchObject({ detail: 'still going', progress: before })
  })

  it('reports transfer speed from bytes over at least one second', () => {
    const { tracker, events, advance } = setup(0)
    tracker.begin('modpack', 'download')
    tracker.update({ bytesDone: 0, bytesTotal: 10_000_000 })
    advance(2000)
    tracker.update({ bytesDone: 4_000_000, bytesTotal: 10_000_000 })
    expect(events.at(-1)!.bytesPerSecond).toBe(2_000_000)
    tracker.begin('finalizing', 'next')
    expect(events.at(-1)!.bytesPerSecond).toBeUndefined()
  })
})
