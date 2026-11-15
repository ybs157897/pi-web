/**
 * Win32 文件夹对话框的子进程入口：让「本进程」阻塞在模态 `Show` 里，宿主事件
 * 循环保持存活，结果经 IPC 通道回报。用子进程（而非 worker 线程）spawn，原生
 * 故障就被隔离，模态调用永远不会卡死宿主。后台宿主（web GUI server）spawn 的
 * 进程没有前台权限，因此 `runFolderDialog` 在 `Show` 前一刻合成一次 Alt 按键，
 * 对话框随后以前台激活。
 * 协议：阻塞调用前先发 `{kind:'showing',threadId}`（驱动的中止杠杆需要原生
 * 线程 id），然后恰好发 `{kind:'done',path}` 或 `{kind:'error',message}` 之一。
 */

import { loadWin32DialogBindings } from './win32-dialog-bindings.ts'
import { runFolderDialog } from './win32-dialog-logic.ts'

/** 驱动→子进程的载荷：对话框标题（经环境变量传入）。 */
export interface Win32DialogWorkerData { title: string }

/** 回报给驱动的一条通知或结果。 */
export type Win32DialogWorkerMessage =
  | { kind: 'showing'; threadId: number }
  | { kind: 'done'; path: string | null }
  | { kind: 'error'; message: string }

const title = process.env.PI_WEB_DIALOG_TITLE ?? ''
if (title === '') throw new Error('win32-dialog-worker: PI_WEB_DIALOG_TITLE is required')
if (process.send === undefined) throw new Error('win32-dialog-worker must run as a child process with an IPC channel')
// node 内部的 `send` 读取 `this.connected`，所以要绑定接收者。
const send = process.send.bind(process)

/** 发送一条消息；回调里断开 IPC 通道（进程随后随循环排空而退出）。 */
const post = (message: Win32DialogWorkerMessage): void => {
  // 关通道前先冲刷。
  /* v8 ignore next 3 -- disconnect needs a live IPC channel the unit lane must not sever (built-worker.e2e.ts owns the real close path). */
  send(message, () => { if (process.connected) process.disconnect() })
}

// 已落定的驱动（或死掉的父进程）不能留下一个还在屏幕上的孤儿对话框。
/* v8 ignore next 3 -- the handler exits(0), which would kill the unit lane; built-worker.e2e.ts owns the real disconnect lifecycle. */
process.on('disconnect', () => process.exit(0))

// 不用顶层 await：构建出的 worker 以 CJS 发布，CJS 无法携带 TLA。
void (async () => {
  try {
    const bindings = await loadWin32DialogBindings()
    const path = runFolderDialog(bindings, title, (threadId) => {
      post({ kind: 'showing', threadId } satisfies Win32DialogWorkerMessage)
    })
    post({ kind: 'done', path } satisfies Win32DialogWorkerMessage)
  } catch (error: unknown) {
    const message = error instanceof Error ? (error.stack ?? error.message) : String(error)
    post({ kind: 'error', message } satisfies Win32DialogWorkerMessage)
  }
})()
