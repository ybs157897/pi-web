/**
 * 移植自 DSH 0.2.1-rc.2（MIT，见 vendor/DSH-LICENSE）。
 * Win32 文件夹对话框的主线程驱动：spawn 对话框子进程（它阻塞在模态 `Show` 里），
 * 把其消息协议映射为 Promise，并通过向对话线程的窗口投递 `WM_CLOSE` 来处理中止，
 * 直到子进程回报。真实进程/窗口表面可注入，因此每条驱动路径在任何平台都可测。
 */

import { closeThreadWindows as hostCloseThreadWindows, spawnDialogWorker } from './win32-dialog-host.ts'
import type { Win32DialogWorkerData, Win32DialogWorkerMessage } from './win32-dialog-worker.ts'

/** 驱动所驱使的子进程表面（由 `node:child_process` 满足）。 */
export interface Win32DialogWorkerLike {
  /**
   * 订阅子进程事件。
   * @param event - `message`、`error` 或 `exit`。
   * @param listener - 事件消费者。
   */
  on(event: 'message', listener: (message: Win32DialogWorkerMessage) => void): unknown
  on(event: 'error', listener: (error: Error) => void): unknown
  on(event: 'exit', listener: (code: number) => void): unknown
  /**
   * 强制停止子进程；`WM_CLOSE` 永远送不到时的最后手段
   * （例如对话框窗口从未创建）。
   * @returns 是否送达了 kill 信号。
   */
  kill(): boolean
  /**
   * 释放事件循环引用。选择落定后调用一次，卡在原生模态调用里的
   * 子进程就不会阻止进程退出。
   */
  unref?(): void
}

/** 可注入的进程表面，驱动测试据此确定性地运行。 */
export interface Win32DialogInternals {
  /** 替换真实子进程 spawn（`win32-dialog-host.ts`）。 */
  spawnWorker?: (data: Win32DialogWorkerData) => Win32DialogWorkerLike
  /** 替换真实 `WM_CLOSE` 投递（`win32-dialog-host.ts`）。 */
  closeThreadWindows?: (threadId: number) => Promise<void>
  /** 中止处理节拍覆写，测试不必等真实时间。 */
  closeRetryMs?: number
}

/** 中止等待 worker 退出期间 `WM_CLOSE` 的重投节拍。 */
const CLOSE_RETRY_MS = 150
/** 强杀 worker 前中止处理的最大尝试次数。 */
const CLOSE_MAX_ATTEMPTS = 20

/** worker→驱动 的封闭联合若出现未处理成员就大声失败。 */
/* v8 ignore start -- closed-union backstop; unreachable without a TypeScript contract violation */
function assertNever(value: never): never {
  throw new TypeError(`unknown win32 dialog worker message kind: ${String(value)}`)
}
/* v8 ignore stop */

/**
 * 功能：在事件循环之外打开现代 Win32 文件夹选择器。
 * @param signal - 调用方生命周期；abort 会关闭对话框并 reject。
 * @param internals - worker/窗口钩子，供确定性测试注入。
 * @returns 所选路径；用户取消返回 null。
 * 内部逻辑：abort 后按节拍向对话线程投递 `WM_CLOSE`，超过 CLOSE_MAX_ATTEMPTS 仍
 * 无响应就 kill 子进程并 reject；done 消息在 aborted 时也按 abort 处理；error 与
 * 提前 exit 都收敛为 reject；落定时清掉定时器、解除监听并 unref。
 */
export async function pickWin32Directory(
  signal: AbortSignal,
  title: string,
  internals: Win32DialogInternals = {},
): Promise<string | null> {
  if (signal.aborted) throw new Error('native directory picker aborted')
  const spawnWorker = internals.spawnWorker ?? spawnDialogWorker
  const closeWindows = internals.closeThreadWindows ?? hostCloseThreadWindows
  const closeRetryMs = internals.closeRetryMs ?? CLOSE_RETRY_MS

  const worker: Win32DialogWorkerLike = spawnWorker({ title })
  let dialogThreadId: number | undefined
  let closeTimer: NodeJS.Timeout | undefined
  let settled = false

  return await new Promise<string | null>((resolve, reject) => {
    const settle = (outcome: () => void): void => {
      if (settled) return
      settled = true
      if (closeTimer !== undefined) clearInterval(closeTimer)
      signal.removeEventListener('abort', onAbort)
      worker.unref?.()
      outcome()
    }

    const postClose = (): void => {
      // `showing` 之前没有窗口可关；下面的预算照常运转，从不回报的子进程
      // 不能让选择悬空。被拒绝的关闭尝试（EnumThreadWindows/PostMessageW
      // 拒绝）直接丢弃：间隔会重试，kill 是兜底。
      if (dialogThreadId !== undefined) void closeWindows(dialogThreadId).catch(() => undefined)
    }

    // 唯一调用方：只注册一次的 abort 监听器，无需重入保护。
    const serviceAbort = (): void => {
      let attempts = 0
      // `showing` 通知先于阻塞的 `Show`，第一个 WM_CLOSE 可能撞上窗口创建；
      // 反复投递直到子进程回报，最后手段是强杀。预算无条件——`showing` 之前
      // 的中止（子进程卡在 koffi 或 COM 初始化）也以 kill 收场，不留悬空 Promise。
      closeTimer = setInterval(() => {
        attempts += 1
        if (attempts > CLOSE_MAX_ATTEMPTS) {
          settle(() => {
            worker.kill()
            reject(new Error('native directory picker aborted (dialog unresponsive; worker killed)'))
          })
          return
        }
        postClose()
      }, closeRetryMs)
      postClose()
    }

    const onAbort = (): void => {
      serviceAbort()
    }
    signal.addEventListener('abort', onAbort, { once: true })

    worker.on('message', (message: Win32DialogWorkerMessage) => {
      switch (message.kind) {
        case 'showing':
          dialogThreadId = message.threadId
          // 抢在这条通知之前的 abort 现在有窗口可打了。
          if (signal.aborted) postClose()
          return
        case 'done':
          settle(() => {
            if (signal.aborted) reject(new Error('native directory picker aborted'))
            else resolve(message.path)
          })
          return
        case 'error':
          settle(() => {
            reject(new Error(`win32 folder dialog failed: ${message.message}`))
          })
          return
        /* v8 ignore next 2 -- closed worker-owned union; a fourth kind becomes a compile error */
        default:
          assertNever(message)
      }
    })
    worker.on('error', (error: Error) => {
      settle(() => {
        reject(error)
      })
    })
    worker.on('exit', () => {
      settle(() => {
        reject(new Error('win32 folder dialog worker exited before reporting a result'))
      })
    })
  })
}
