import { spawnSync } from 'node:child_process'
import { lstat, realpath } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import type { Context } from '@earendil-works/chord/context'
import { FileError, err, type ExecutionEnv, type Result, type ShellExecOptions, type ShellExecResult } from '@earendil-works/pi-durable/env'
import { NodeExecutionEnv } from '@earendil-works/pi-durable/env/node'
import type { AccessMode } from '../shared/types.ts'
import { RuntimeError } from './runtime-errors.ts'

const SANDBOX_EXEC = '/usr/bin/sandbox-exec'

function within(root: string, target: string): boolean {
  const path = relative(root, target)
  return path === '' || (path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path))
}

function profile(root: string): string {
  return [
    '(version 1)',
    '(deny default)',
    '(allow process*)',
    '(allow sysctl-read)',
    '(allow file-read*)',
    `(allow file-write* (subpath ${JSON.stringify(root)}))`,
  ].join('\n')
}

/** Detects support by running the same macOS sandbox profile used for workspaceWrite commands. */
export async function workspaceWriteSupported(workspace: string): Promise<boolean> {
  if (process.platform !== 'darwin') return false
  try {
    const root = await realpath(workspace)
    const result = spawnSync(SANDBOX_EXEC, ['-p', profile(root), '/usr/bin/true'], { encoding: 'utf8', timeout: 3000 })
    return result.error === undefined && result.status === 0
  } catch {
    return false
  }
}

class WorkspaceWriteExecutionEnv extends NodeExecutionEnv {
  #root: string
  #profile: string

  constructor(cwd: string) {
    super({ cwd })
    this.#root = resolve(cwd)
    this.#profile = profile(this.#root)
  }

  override async exec(command: string | readonly string[], options: ShellExecOptions | undefined, context: Context): Promise<Result<ShellExecResult, import('@earendil-works/pi-durable/env').ExecutionError>> {
    const wrapped = typeof command === 'string'
      ? [SANDBOX_EXEC, '-p', this.#profile, '--', '/bin/bash', '-c', command]
      : [SANDBOX_EXEC, '-p', this.#profile, '--', ...command]
    return super.exec(wrapped, options, context)
  }

  override async writeFile(path: string, content: string | Uint8Array, context: Context): Promise<Result<void, FileError>> {
    const denied = await this.writeDenied(path, context)
    return denied ?? super.writeFile(path, content, context)
  }

  override async appendFile(path: string, content: string | Uint8Array, context: Context): Promise<Result<void, FileError>> {
    const denied = await this.writeDenied(path, context)
    return denied ?? super.appendFile(path, content, context)
  }

  override async truncateFile(path: string, size: number, context: Context): Promise<Result<void, FileError>> {
    const denied = await this.writeDenied(path, context)
    return denied ?? super.truncateFile(path, size, context)
  }

  override async renameFile(sourcePath: string, destinationPath: string, context: Context): Promise<Result<void, FileError>> {
    const sourceDenied = await this.writeDenied(sourcePath, context)
    if (sourceDenied) return sourceDenied
    const destinationDenied = await this.writeDenied(destinationPath, context)
    return destinationDenied ?? super.renameFile(sourcePath, destinationPath, context)
  }

  override async createDir(path: string, options: { recursive?: boolean } | undefined, context: Context): Promise<Result<void, FileError>> {
    const denied = await this.writeDenied(path, context)
    return denied ?? super.createDir(path, options, context)
  }

  override async remove(path: string, options: { recursive?: boolean; force?: boolean } | undefined, context: Context): Promise<Result<void, FileError>> {
    const denied = await this.writeDenied(path, context)
    return denied ?? super.remove(path, options, context)
  }

  private async writeDenied(path: string, context: Context): Promise<Result<never, FileError> | undefined> {
    const absolute = await this.absolutePath(path, context)
    if (!absolute.ok) return err(absolute.error)
    const candidate = resolve(absolute.value)
    if (!within(this.#root, candidate)) return err(new FileError('permission_denied', 'workspaceWrite allows changes only inside the selected workspace', candidate))
    const pathParts = relative(this.#root, candidate).split(sep).filter(Boolean)
    let current = this.#root
    for (const part of pathParts) {
      current = resolve(current, part)
      try {
        const item = await lstat(current)
        if (item.isSymbolicLink()) return err(new FileError('permission_denied', 'workspaceWrite does not follow symbolic links', current))
        const canonical = await realpath(current)
        if (!within(this.#root, canonical)) return err(new FileError('permission_denied', 'workspaceWrite allows changes only inside the selected workspace', current))
      } catch (error) {
        if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') break
        return err(new FileError('unknown', error instanceof Error ? error.message : 'Cannot inspect workspace path', current))
      }
    }
    return undefined
  }
}

/** Creates the execution environment selected for a conversation. */
export async function createExecutionEnv(cwd: string, mode: AccessMode): Promise<ExecutionEnv> {
  const canonical = await realpath(cwd).catch(() => {
    throw new RuntimeError('NOT_FOUND', '会话工作目录不可用')
  })
  if (mode === 'workspaceWrite') {
    if (!await workspaceWriteSupported(canonical)) throw new RuntimeError('UNSUPPORTED', '当前系统无法启用工作区写入沙盒')
    return new WorkspaceWriteExecutionEnv(canonical)
  }
  return new NodeExecutionEnv({ cwd: canonical })
}
