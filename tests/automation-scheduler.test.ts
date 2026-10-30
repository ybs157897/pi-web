import { describe, expect, it } from 'vitest'
import {
  AutomationScheduler,
  MAX_AUTOMATION_TIMEOUT_MS,
  type AutomationTimerDriver,
  type AutomationTimerHandle,
} from '../src/server/automation/scheduler.ts'

interface ManualTimer extends AutomationTimerHandle {
  id: number
  at: number
  callback: () => void
  cancelled: boolean
  unrefed: boolean
}

class ManualTimerDriver implements AutomationTimerDriver {
  time = 0
  readonly delays: number[] = []
  readonly handles: ManualTimer[] = []
  readonly #timers = new Map<number, ManualTimer>()
  #nextId = 0

  now(): number { return this.time }

  setTimeout(callback: () => void, delayMs: number): ManualTimer {
    this.delays.push(delayMs)
    const timer: ManualTimer = {
      id: ++this.#nextId,
      at: this.time + delayMs,
      callback,
      cancelled: false,
      unrefed: false,
      unref() { this.unrefed = true },
    }
    this.#timers.set(timer.id, timer)
    this.handles.push(timer)
    return timer
  }

  clearTimeout(handle: AutomationTimerHandle): void {
    const timer = handle as ManualTimer
    timer.cancelled = true
    this.#timers.delete(timer.id)
  }

  advanceTo(target: number): void {
    if (target < this.time) throw new RangeError('manual time cannot move backwards')
    while (true) {
      const next = [...this.#timers.values()]
        .filter(timer => !timer.cancelled && timer.at <= target)
        .sort((left, right) => left.at - right.at || left.id - right.id)[0]
      if (!next) break
      this.#timers.delete(next.id)
      this.time = next.at
      next.callback()
    }
    this.time = target
  }
}

describe('AutomationScheduler', () => {
  it.each([
    { label: '30 days', intervalMs: 30 * 24 * 60 * 60 * 1000 },
    { label: 'one year', intervalMs: 365 * 24 * 60 * 60 * 1000 },
  ])('waits until the absolute due time for $label and fires only once', ({ intervalMs }) => {
    const timers = new ManualTimerDriver()
    const scheduler = new AutomationScheduler({ timerDriver: timers })
    const dueAt = timers.now() + intervalMs
    let runs = 0

    scheduler.schedule('long-task', dueAt, () => { runs += 1 })

    expect(timers.delays[0]).toBe(MAX_AUTOMATION_TIMEOUT_MS)
    expect(timers.delays.every(delay => delay <= MAX_AUTOMATION_TIMEOUT_MS)).toBe(true)
    timers.advanceTo(dueAt - 1)
    expect(runs).toBe(0)
    expect(timers.delays.length).toBeGreaterThan(1)
    timers.advanceTo(dueAt)
    expect(runs).toBe(1)
    timers.advanceTo(dueAt + intervalMs)
    expect(runs).toBe(1)
    expect(timers.delays.length).toBeGreaterThan(1)
  })

  it('cancels replaced and removed schedules, and honors the replacement due time', () => {
    const timers = new ManualTimerDriver()
    const scheduler = new AutomationScheduler({ timerDriver: timers })
    let oldRuns = 0
    let newRuns = 0
    let cancelledRuns = 0

    scheduler.schedule('task', 10_000, () => { oldRuns += 1 })
    timers.advanceTo(4_000)
    scheduler.schedule('task', 20_000, () => { newRuns += 1 })
    timers.advanceTo(10_000)
    expect(oldRuns).toBe(0)
    expect(newRuns).toBe(0)
    timers.advanceTo(20_000)
    expect(newRuns).toBe(1)

    scheduler.schedule('cancelled-task', 30_000, () => { cancelledRuns += 1 })
    scheduler.cancel('cancelled-task')
    timers.advanceTo(30_000)
    expect(cancelledRuns).toBe(0)
  })

  it('closes old timers and restores a persisted due time in a new scheduler', () => {
    const timers = new ManualTimerDriver()
    const persistedDueAt = 10_000
    let oldRuns = 0
    const oldScheduler = new AutomationScheduler({ timerDriver: timers })
    oldScheduler.schedule('restored-task', persistedDueAt, () => { oldRuns += 1 })
    oldScheduler.close()

    timers.advanceTo(3_000)
    expect(oldRuns).toBe(0)
    let restoredRuns = 0
    const restoredScheduler = new AutomationScheduler({ timerDriver: timers })
    restoredScheduler.schedule('restored-task', persistedDueAt, () => { restoredRuns += 1 })
    timers.advanceTo(persistedDueAt - 1)
    expect(restoredRuns).toBe(0)
    timers.advanceTo(persistedDueAt)
    expect(restoredRuns).toBe(1)
    restoredScheduler.close()
  })

  it('unrefs each long-timeout segment', () => {
    const timers = new ManualTimerDriver()
    const scheduler = new AutomationScheduler({ timerDriver: timers })
    scheduler.schedule('unref-check', MAX_AUTOMATION_TIMEOUT_MS + 100, () => undefined)
    const first = timers.delays[0]
    expect(first).toBe(MAX_AUTOMATION_TIMEOUT_MS)
    timers.advanceTo(first)
    expect(timers.delays).toHaveLength(2)
    expect(timers.handles.every(timer => timer.unrefed)).toBe(true)
    scheduler.close()
  })
})
