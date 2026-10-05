/** Turns per-step progress into one overall fraction with real counts and transfer speed. */

import type { InstallStep } from '../../src/shared/launcher-state'

export type { InstallStep }

/** Share of the overall bar each step covers. Heavy downloads get the widest slices. */
const STEP_RANGE: Record<InstallStep, readonly [number, number]> = {
  java: [0, 0.15],
  minecraft: [0.15, 0.25],
  forge: [0.25, 0.5],
  libraries: [0.5, 0.85],
  modpack: [0.85, 0.97],
  finalizing: [0.97, 1]
}

/** Event names the current renderer already understands. */
const STEP_STATE: Record<InstallStep, string> = {
  java: 'java',
  minecraft: 'minecraft',
  forge: 'forge',
  libraries: 'deps',
  modpack: 'pack',
  finalizing: 'launching'
}

export interface StepUpdate {
  detail?: string
  current?: number
  total?: number
  bytesDone?: number
  bytesTotal?: number
}

export interface ProgressEvent {
  state: string
  /** Overall progress from 0 to 1. */
  progress: number
  detail: string
  step?: InstallStep
  current?: number
  total?: number
  bytesDone?: number
  bytesTotal?: number
  bytesPerSecond?: number
}

export interface InstallReporter {
  begin(step: InstallStep, detail: string): void
  update(update: StepUpdate): void
  done(step: InstallStep): void
}

export class ProgressTracker implements InstallReporter {
  private step: InstallStep = 'java'
  private detail = ''
  private lastEmit = 0
  private lastEmitted: ProgressEvent | null = null
  private speedSample: { at: number; bytes: number } | null = null
  private bytesPerSecond: number | undefined

  constructor(
    private readonly emit: (event: ProgressEvent) => void,
    private readonly now: () => number = Date.now,
    private readonly minIntervalMs = 100
  ) {}

  begin(step: InstallStep, detail: string): void {
    this.step = step
    this.detail = detail
    this.speedSample = null
    this.bytesPerSecond = undefined
    this.send({ detail }, true)
  }

  update(update: StepUpdate): void {
    if (update.detail !== undefined) this.detail = update.detail
    if (update.bytesDone !== undefined) this.sampleSpeed(update.bytesDone)
    this.send(update, false)
  }

  done(step: InstallStep): void {
    this.step = step
    this.send({ current: 1, total: 1 }, true, 1)
  }

  private sampleSpeed(bytes: number): void {
    const at = this.now()
    if (!this.speedSample) {
      this.speedSample = { at, bytes }
      return
    }
    const elapsed = at - this.speedSample.at
    if (elapsed >= 1000) {
      this.bytesPerSecond = Math.max(0, Math.round(((bytes - this.speedSample.bytes) * 1000) / elapsed))
      this.speedSample = { at, bytes }
    }
  }

  private send(update: StepUpdate, force: boolean, forcedFraction?: number): void {
    const at = this.now()
    if (!force && at - this.lastEmit < this.minIntervalMs) return
    const [from, to] = STEP_RANGE[this.step]
    let within = forcedFraction ?? 0
    if (forcedFraction === undefined) {
      if (update.total && update.current !== undefined) within = update.current / update.total
      else if (update.bytesTotal && update.bytesDone !== undefined) within = update.bytesDone / update.bytesTotal
      else if (this.lastEmitted?.step === this.step) within = (this.lastEmitted.progress - from) / (to - from)
    }
    within = Math.min(1, Math.max(0, within))
    const event: ProgressEvent = {
      state: STEP_STATE[this.step],
      progress: Number((from + (to - from) * within).toFixed(4)),
      detail: this.detail,
      step: this.step,
      current: update.current,
      total: update.total,
      bytesDone: update.bytesDone,
      bytesTotal: update.bytesTotal,
      bytesPerSecond: this.bytesPerSecond
    }
    this.lastEmit = at
    this.lastEmitted = event
    this.emit(event)
  }
}
