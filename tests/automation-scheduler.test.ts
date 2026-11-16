import { describe, expect, it } from 'vitest'
import {
  AutomationScheduler,
  MAX_AUTOMATION_TIMEOUT_MS,
  type AutomationTimerDriver,
  type AutomationTimerHandle,
} from '../src/server/automation/scheduler.ts'

/** ManualTimerDriver 产出的定时器句柄：记录到期时刻、回调、取消与 unref 状态，供测试断言。 */
interface ManualTimer extends AutomationTimerHandle {
  id: number
  at: number
  callback: () => void
  cancelled: boolean
  unrefed: boolean
}

/**
 * 手动定时器驱动：以可控的虚拟时钟替代真实 setTimeout/clearTimeout。
 *
 * - `time` 为当前虚拟时间，`delays` 记录每次 setTimeout 请求的延迟，`handles` 记录所有句柄；
 * - `advanceTo(target)` 按到期顺序逐个触发所有到点回调（同时刻按 id 排序），时间不允许倒退。
 */
class ManualTimerDriver implements AutomationTimerDriver {
  time = 0
  readonly delays: number[] = []
  readonly handles: ManualTimer[] = []
  readonly #timers = new Map<number, ManualTimer>()
  #nextId = 0

  /** 返回当前虚拟时间。 */
  now(): number { return this.time }

  /** 注册一个定时器：记录延迟与到期时刻，句柄进入 delays/handles 供断言。 */
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

  /** 取消定时器：标记 cancelled 并从注册表移除，后续 advanceTo 不再触发。 */
  clearTimeout(handle: AutomationTimerHandle): void {
    const timer = handle as ManualTimer
    timer.cancelled = true
    this.#timers.delete(timer.id)
  }

  /** 把虚拟时间推进到 target，按到期顺序触发沿途所有未取消的定时器回调。 */
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

/**
 * AutomationScheduler 调度器测试。
 *
 * 关键契约（全部基于 ManualTimerDriver 的虚拟时钟，不依赖真实时间）：
 * - 超过 MAX_AUTOMATION_TIMEOUT_MS 的绝对到期时间用分段定时器接力等待，且只触发一次；
 * - 同名任务重新 schedule 会取消旧定时器并按新的到期时间触发；cancel 后不再触发；
 * - 旧调度器 close 后其定时器失效，新调度器可按持久化的到期时间恢复同一任务；
 * - 每一段长超时定时器都要 unref，避免挂住进程退出。
 */
/** AutomationScheduler 契约：分段长等待、替换/取消、跨实例恢复与 unref。 */
describe('AutomationScheduler', () => {
  // 30 天 / 一年的超长间隔必须用 ≤ MAX_AUTOMATION_TIMEOUT_MS 的分段定时器接力，恰好到期触发一次且不重复。
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

  // 同名任务重复 schedule 会替换旧定时器（旧到期时刻不触发，新到期时刻触发一次）；显式 cancel 后到期不触发。
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

  // 调度器 close 会关闭旧定时器（同一驱动上新调度器接管后旧任务不再触发）；新调度器按持久化到期时间恢复触发。
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

  // 超长等待的每一段接力定时器都必须 unref，不阻止进程退出（含触发后创建的下一段）。
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
