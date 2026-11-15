/** Node 把超过该值的 setTimeout 延迟截断为 1ms（几乎立即触发），调度器必须据此把长等待拆段。 */
export const MAX_AUTOMATION_TIMEOUT_MS = 2_147_483_647

/** 底层定时器句柄；`unref` 可选，调用后定时器不再阻止进程退出。 */
export interface AutomationTimerHandle {
  unref?: () => unknown
}

/** 可注入的定时器驱动抽象，便于测试时用假时钟替换真实的 Date.now/setTimeout。 */
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

/**
 * 按绝对到期时间调度自动化任务，同时遵守 Node 的 setTimeout 时长上限。
 *
 * 日历对齐语义：注册的是绝对时间戳 `dueAt`，而非相对延迟。若距到期超过
 * `maxDelayMs`（Node 上限），定时器只设到上限，触发后检查时钟未到则重新
 * #arm 继续等待——因此跨天/超长等待会被拆成多段，最终仍对齐到 `dueAt`。
 * 游标语义：`#scheduled` 以 id 记录当前待触发的 ScheduledAutomation；回调
 * 触发时校验 Map 中仍是同一对象才执行，保证 schedule/cancel 竞态下旧回调
 * 不会误触发新任务。
 */
export class AutomationScheduler {
  readonly #scheduled = new Map<string, ScheduledAutomation>()
  readonly #timerDriver: AutomationTimerDriver
  readonly #maxDelayMs: number
  #closed = false

  /**
   * @param options.timerDriver 定时器驱动，缺省用 Node 原生实现
   * @param options.maxDelayMs 单段定时器最大延迟，缺省为 MAX_AUTOMATION_TIMEOUT_MS；非法（非安全整数或超出 [1, 上限]）时抛 RangeError
   */
  constructor(options: { timerDriver?: AutomationTimerDriver; maxDelayMs?: number } = {}) {
    this.#timerDriver = options.timerDriver ?? nodeTimerDriver
    this.#maxDelayMs = options.maxDelayMs ?? MAX_AUTOMATION_TIMEOUT_MS
    if (!Number.isSafeInteger(this.#maxDelayMs) || this.#maxDelayMs < 1 || this.#maxDelayMs > MAX_AUTOMATION_TIMEOUT_MS) {
      throw new RangeError(`maxDelayMs must be between 1 and ${MAX_AUTOMATION_TIMEOUT_MS}`)
    }
  }

  /**
   * 功能：以 id 登记一个到期回调；同 id 重复调用会先取消旧任务再登记新任务。
   * @param id 任务唯一标识（通常为自动化 ID）
   * @param dueAt 绝对到期时间戳（毫秒，Date.now 同基准）；早于当前时间则定时器立即触发
   * @param onDue 到期时执行的回调
   * 内部逻辑：调度器已 close 时登记仍进 Map 但不会装定时器，也就永不触发。
   */
  schedule(id: string, dueAt: number, onDue: () => void): void {
    this.cancel(id)
    if (this.#closed) return
    const scheduled: ScheduledAutomation = { dueAt, onDue }
    this.#scheduled.set(id, scheduled)
    this.#arm(id, scheduled)
  }

  /**
   * 功能：取消指定 id 的待触发任务并清掉其底层定时器；id 不存在时为静默 no-op。
   */
  cancel(id: string): void {
    const scheduled = this.#scheduled.get(id)
    if (!scheduled) return
    if (scheduled.timer) this.#timerDriver.clearTimeout(scheduled.timer)
    this.#scheduled.delete(id)
  }

  /**
   * 功能：关闭调度器，清空全部待触发任务与定时器；此后 schedule 的任务不会触发。
   */
  close(): void {
    if (this.#closed) return
    this.#closed = true
    for (const scheduled of this.#scheduled.values()) {
      if (scheduled.timer) this.#timerDriver.clearTimeout(scheduled.timer)
    }
    this.#scheduled.clear()
  }

  /**
   * 功能：为单个任务装上（或续装）底层定时器。
   * @param id 任务标识，用于定时器回调时做身份校验
   * @param scheduled 待触发的任务记录
   * 内部逻辑：剩余等待 = max(0, ceil(dueAt - now))，实际延迟取剩余与 maxDelayMs 的较小值以绕开 Node 上限；
   * 回调触发时先校验调度器未关闭且 Map 中仍是同一对象，时钟未到 dueAt 就重新 #arm 续等，到期才从 Map 移除并执行 onDue；
   * 最后调用 unref 让定时器不阻止进程退出。
   */
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
