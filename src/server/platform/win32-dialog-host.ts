/**
 * Ported from DSH 0.2.1-rc.2 (MIT, see vendor/DSH-LICENSE).
 * Real-process half of the Win32 dialog driver: spawn the dialog child
 * process (source or built plane) and close a dialog thread's windows. The
 * module itself loads everywhere (the import chain from native-picker.ts is
 * static); what stays win32-only is koffi, imported dynamically inside the
 * bindings' functions. The driver's logic is tested against fakes of this
 * surface instead.
 */

import { spawn, type StdioOptions } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import type { Win32DialogWorkerData } from './win32-dialog-worker.ts'

/**
 * Spawn the dialog child process. Built consumers launch the bundled CJS
 * entry next to this module under plain node; unbuilt (source) consumers
 * bootstrap tsx first, mirroring the dsh CLI's source launch. The child
 * opens its dialog as foreground on its own: `runFolderDialog` synthesizes
 * an Alt press before `Show`, which matters when a background host spawned
 * the child.
 * @param data - the child payload (dialog title).
 * @returns the spawned child process.
 */
export function spawnDialogWorker(data: Win32DialogWorkerData): ReturnType<typeof spawn> {
  const env = { ...process.env, PI_WEB_DIALOG_TITLE: data.title }
  const stdio: StdioOptions = ['ignore', 'inherit', 'inherit', 'ipc']
  // pi-web always runs its server from TypeScript (dev and start both use tsx),
  // so the child bootstraps tsx too instead of loading a built CJS worker.
  return spawn(process.execPath, ['--import', import.meta.resolve('tsx/esm'), fileURLToPath(new URL('./win32-dialog-worker.ts', import.meta.url))], { env, stdio, windowsHide: true })
}

export { closeThreadWindows } from './win32-dialog-bindings.ts'
