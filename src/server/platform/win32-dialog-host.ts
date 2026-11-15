/**
 * 移植自 DSH 0.2.1-rc.2（MIT，见 vendor/DSH-LICENSE）。
 * Win32 对话框驱动的真实进程半边：spawn 对话框子进程（源码或构建产物两种形态）
 * 并关闭对话线程的窗口。本模块在任何平台都能加载（native-picker.ts 的 import 链
 * 是静态的）；仅 win32 的是 koffi——在 bindings 的函数内部动态导入。驱动的逻辑
 * 用这个表面的假实现测试。
 */

import { spawn, type StdioOptions } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import type { Win32DialogWorkerData } from './win32-dialog-worker.ts'

/**
 * 功能：spawn 对话框子进程。已构建的消费方在纯 node 下启动本模块旁的打包 CJS
 * 入口；未构建（源码）消费方先引导 tsx，对应 dsh CLI 的源码启动方式。子进程自己
 * 会把对话框带到前台：`runFolderDialog` 在 `Show` 之前合成一次 Alt 按键——后台
 * 宿主 spawn 子进程时这一点很关键。
 * @param data 子进程载荷（对话框标题）
 * @returns 已 spawn 的子进程
 */
export function spawnDialogWorker(data: Win32DialogWorkerData): ReturnType<typeof spawn> {
  const env = { ...process.env, PI_WEB_DIALOG_TITLE: data.title }
  const stdio: StdioOptions = ['ignore', 'inherit', 'inherit', 'ipc']
  // pi-web 的服务端始终从 TypeScript 运行（dev 与 start 都走 tsx），
  // 所以子进程同样引导 tsx，而不是加载构建好的 CJS worker。
  return spawn(process.execPath, ['--import', import.meta.resolve('tsx/esm'), fileURLToPath(new URL('./win32-dialog-worker.ts', import.meta.url))], { env, stdio, windowsHide: true })
}

export { closeThreadWindows } from './win32-dialog-bindings.ts'
