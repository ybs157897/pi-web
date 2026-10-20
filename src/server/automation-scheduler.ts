/** Node clamps delays above this value and may fire them almost immediately. */
export const MAX_AUTOMATION_TIMEOUT_MS = 2_147_483_647

export interface AutomationTimerHandle {
  unref?: () => unknown
}

export interface AutomationTimerDriver {
  now(): number
  setTimeout(callback: () => void, delayMs: number): AutomationTimerHandle
  clearTimeout(timer: AutomationTimerHandle): void
}

const nodeTimerDriver: AutomationTimerDriver = {
  now: () => Date.now(),
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: timer => clearTimeout(timer as ReturnType<typeof setTimeout>),
}

interface ScheduledAutomation {
  dueAt: number
  onDue: () => void
  timer?: AutomationTimerHandle
}

/** Schedules automations against absolute due times while respecting Node's timeout limit. */
export class AutomationScheduler {
  readonly #scheduled = new Map<string, ScheduledAutomation>()
  readonly #timerDriver: AutomationTimerDriver
  readonly #maxDelayMs: number
  #closed = false

  constructor(options: { timerDriver?: AutomationTimerDriver; maxDelayMs?: number } = {}) {
    this.#timerDriver = options.timerDriver ?? nodeTimerDriver
    this.#maxDelayMs = options.maxDelayMs ?? MAX_AUTOMATION_TIMEOUT_MS
    if (!Number.isSafeInteger(this.#maxDelayMs) || this.#maxDelayMs < 1 || this.#maxDelayMs > MAX_AUTOMATION_TIMEOUT_MS) {
      throw new RangeError(`maxDelayMs must be between 1 and ${MAX_AUTOMATION_TIMEOUT_MS}`)
    }
  }

  schedule(id: string, dueAt: number, onDue: () => void): void {
    this.cancel(id)
    if (this.#closed) return
    const scheduled: ScheduledAutomation = { dueAt, onDue }
    this.#scheduled.set(id, scheduled)
    this.#arm(id, scheduled)
  }

  cancel(id: string): void {
    const scheduled = this.#scheduled.get(id)
    if (!scheduled) return
    if (scheduled.timer) this.#timerDriver.clearTimeout(scheduled.timer)
    this.#scheduled.delete(id)
  }

  close(): void {
    if (this.#closed) return
    this.#closed = true
    for (const scheduled of this.#scheduled.values()) {
      if (scheduled.timer) this.#timerDriver.clearTimeout(scheduled.timer)
    }
    this.#scheduled.clear()
  }

  #arm(id: string, scheduled: ScheduledAutomation): void {
    const remaining = Math.max(0, Math.ceil(scheduled.dueAt - this.#timerDriver.now()))
    const delay = Math.min(remaining, this.#maxDelayMs)
    const timer = this.#timerDriver.setTimeout(() => {
      if (this.#closed || this.#scheduled.get(id) !== scheduled) return
      scheduled.timer = undefined
      if (this.#timerDriver.now() < scheduled.dueAt) {
        this.#arm(id, scheduled)
        return
      }
      this.#scheduled.delete(id)
      scheduled.onDue()
    }, delay)
    timer.unref?.()
    scheduled.timer = timer
  }
}
