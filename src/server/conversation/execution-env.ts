import { spawnSync } from 'node:child_process'
import { lstat, realpath } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { Context } from '@earendil-works/chord/context'
import { FileError, err, type ExecutionEnv, type Result, type ShellExecOptions, type ShellExecResult } from '@earendil-works/pi-durable/env'
import { NodeExecutionEnv } from '@earendil-works/pi-durable/env/node'
import type { AccessMode } from '../../shared/types.ts'
import { RuntimeError } from '../runtime-errors.ts'

/** macOS 内置沙盒执行器的固定路径。 */
const SANDBOX_EXEC = '/usr/bin/sandbox-exec'
const workbenchProjects = new WeakMap<ExecutionEnv, { project: string; writeRoots?: readonly string[] }>()

/** 工作台在独立目录运行，项目读取和交付仍以原工作区为根。 */
export function workbenchProject(env: ExecutionEnv | undefined): string | undefined {
  return env === undefined ? undefined : workbenchProjects.get(env)?.project
}

/** Pi 文件工具以原项目为 cwd，沿用会话的写入根和检查顺序。 */
export function workbenchFileEnv(env: ExecutionEnv | undefined): NodeExecutionEnv | undefined {
  const workspace = env === undefined ? undefined : workbenchProjects.get(env)
  if (workspace === undefined) return undefined
  return workspace.writeRoots === undefined
    ? new NodeExecutionEnv({ cwd: workspace.project })
    : new WorkspaceWriteExecutionEnv(workspace.project, workspace.writeRoots)
}

/**
 * 功能：判断 target 是否位于 root 之内（含相等），做词法相对路径判断。
 * @param root 允许写入的根目录（已 resolve）。
 * @param target 待检查路径（已 resolve）。
 * @returns true 在根内或与根相同；false 在根外。
 */
function within(root: string, target: string): boolean {
  const path = relative(root, target)
  return path === '' || (path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path))
}

/**
 * 功能：把一个尾部可能尚不存在的写入根规范化为真实路径。
 * 内部逻辑：macOS 的 `/var/...` 数据目录实际经符号链接抵达；若拿词法根与规范化的子路径比较，
 * 会拒绝记忆目录下合法的嵌套写入。逐级向上找最近存在的祖先 realpath，再把缺失的尾段拼回去。
 * @param path 原始写入根。
 * @returns 规范化后的根；整条都不存在时回落为 resolve(path)。
 */
async function canonicalRoot(path: string): Promise<string> {
  const missing: string[] = []
  let current = resolve(path)
  for (;;) {
    try {
      return join(await realpath(current), ...missing.reverse())
    } catch {
      const parent = dirname(current)
      if (parent === current) return resolve(path)
      missing.push(basename(current))
      current = parent
    }
  }
}

/**
 * 功能：生成 macOS seatbelt 沙盒 profile 文本：默认全拒，放行进程、sysctl-read、全量读，
 * 并为每个允许写入的根授予 file-write*。
 * @param roots 允许写入的目录列表。
 * @returns profile 字符串，交由 sandbox-exec -p 使用。
 */
function profile(roots: readonly string[]): string {
  return [
    '(version 1)',
    '(deny default)',
    '(allow process*)',
    '(allow sysctl-read)',
    '(allow file-read*)',
    ...roots.map(root => `(allow file-write* (subpath ${JSON.stringify(root)}))`),
  ].join('\n')
}

/**
 * 功能：探测当前系统是否支持 workspaceWrite 沙盒。
 * @param workspace 工作区路径。
 * @returns true 表示可用沙盒执行器跑通探测命令。
 * 内部逻辑：非 darwin 直接 false；用与 workspaceWrite 命令相同的 profile 同步跑 `/usr/bin/true`，
 * 3 秒超时，无错误且退出码 0 即支持；任何异常一律视为不支持。
 */
export async function workspaceWriteSupported(workspace: string): Promise<boolean> {
  if (process.platform !== 'darwin') return false
  try {
    const root = await realpath(workspace)
    const result = spawnSync(SANDBOX_EXEC, ['-p', profile([root]), '/usr/bin/true'], { encoding: 'utf8', timeout: 3000 })
    return result.error === undefined && result.status === 0
  } catch {
    return false
  }
}

/** 后台 shell 启动描述：可执行文件与参数（可能是沙盒包裹，也可能是裸 shell）。 */
export interface LocalShellSpawn {
  file: string
  args: string[]
}

/**
 * workspaceWrite 模式的执行环境：所有命令经 macOS seatbelt 沙盒包裹，写文件操作先用
 * JavaScript 侧检查拒掉根外/符号链接逃逸，再交给底层实现。
 */
class WorkspaceWriteExecutionEnv extends NodeExecutionEnv {
  #roots: readonly string[]
  #profile: string

  /**
   * 功能：构建沙盒执行环境。
   * @param cwd 默认工作目录。
   * @param writeRoots 允许写入的有序目录列表；重复根会被去重。
   */
  constructor(cwd: string, writeRoots: readonly string[]) {
    super({ cwd })
    this.#roots = [...new Set(writeRoots.map(root => resolve(root)))]
    this.#profile = profile(this.#roots)
  }

  /** 与前台工具一致的沙盒化启动形态，供脱离终端的后台运行使用。 */
  sandboxSpawn(command: string): LocalShellSpawn {
    return { file: SANDBOX_EXEC, args: ['-p', this.#profile, '--', '/bin/bash', '-c', command] }
  }

  /**
   * 功能：在沙盒内执行 shell 命令（exec 的覆写）。
   * @param command 字符串命令经 /bin/bash -c 包裹；数组命令直接逐段沙盒化。
   * @returns 底层执行结果（Result 包裹）。
   */
  override async exec(command: string | readonly string[], options: ShellExecOptions | undefined, context: Context): Promise<Result<ShellExecResult, import('@earendil-works/pi-durable/env').ExecutionError>> {
    const wrapped = typeof command === 'string'
      ? [SANDBOX_EXEC, '-p', this.#profile, '--', '/bin/bash', '-c', command]
      : [SANDBOX_EXEC, '-p', this.#profile, '--', ...command]
    return super.exec(wrapped, options, context)
  }

  /** 写入前先过 writeDenied 检查，被拒则直接返回错误，否则走底层实现。 */
  override async writeFile(path: string, content: string | Uint8Array, context: Context): Promise<Result<void, FileError>> {
    const denied = await this.writeDenied(path, context)
    return denied ?? super.writeFile(path, content, context)
  }

  /** 追加写入前先过 writeDenied 检查，被拒则直接返回错误，否则走底层实现。 */
  override async appendFile(path: string, content: string | Uint8Array, context: Context): Promise<Result<void, FileError>> {
    const denied = await this.writeDenied(path, context)
    return denied ?? super.appendFile(path, content, context)
  }

  /** 截断前先过 writeDenied 检查，被拒则直接返回错误，否则走底层实现。 */
  override async truncateFile(path: string, size: number, context: Context): Promise<Result<void, FileError>> {
    const denied = await this.writeDenied(path, context)
    return denied ?? super.truncateFile(path, size, context)
  }

  /** 重命名要求源与目标都通过 writeDenied 检查；任一被拒即返回对应错误。 */
  override async renameFile(sourcePath: string, destinationPath: string, context: Context): Promise<Result<void, FileError>> {
    const sourceDenied = await this.writeDenied(sourcePath, context)
    if (sourceDenied) return sourceDenied
    const destinationDenied = await this.writeDenied(destinationPath, context)
    return destinationDenied ?? super.renameFile(sourcePath, destinationPath, context)
  }

  /** 建目录前先过 writeDenied 检查，被拒则直接返回错误，否则走底层实现。 */
  override async createDir(path: string, options: { recursive?: boolean } | undefined, context: Context): Promise<Result<void, FileError>> {
    const denied = await this.writeDenied(path, context)
    return denied ?? super.createDir(path, options, context)
  }

  /** 删除前先过 writeDenied 检查，被拒则直接返回错误，否则走底层实现。 */
  override async remove(path: string, options: { recursive?: boolean; force?: boolean } | undefined, context: Context): Promise<Result<void, FileError>> {
    const denied = await this.writeDenied(path, context)
    return denied ?? super.remove(path, options, context)
  }

  /**
   * 功能：JavaScript 侧的写权限检查——根外路径、符号链接逃逸一律拒绝。
   * @param path 待写入的目标路径。
   * @param context 执行上下文（用于把相对路径转绝对路径）。
   * @returns 被拒时返回 permission_denied/unknown 的 FileError；放行时返回 undefined。
   * 内部逻辑：逐级 lstat 中间路径，发现符号链接即拒绝（workspaceWrite 不跟随符号链接）；
   * 每级 realpath 必须仍落在规范化根内；中间段不存在（ENOENT）时停止逐级检查放行。
   */
  private async writeDenied(path: string, context: Context): Promise<Result<never, FileError> | undefined> {
    const absolute = await this.absolutePath(path, context)
    if (!absolute.ok) return err(absolute.error)
    const candidate = resolve(absolute.value)
    const root = this.#roots.find(item => within(item, candidate))
    if (root === undefined) return err(new FileError('permission_denied', 'workspaceWrite allows changes only inside the selected workspace or its memory directory', candidate))
    const resolvedRoot = await canonicalRoot(root)
    const pathParts = relative(root, candidate).split(sep).filter(Boolean)
    let current = root
    for (const part of pathParts) {
      current = resolve(current, part)
      try {
        const item = await lstat(current)
        if (item.isSymbolicLink()) return err(new FileError('permission_denied', 'workspaceWrite does not follow symbolic links', current))
        const canonical = await realpath(current)
        if (!within(resolvedRoot, canonical)) return err(new FileError('permission_denied', 'workspaceWrite allows changes only inside the selected workspace or its memory directory', current))
      } catch (error) {
        if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') break
        return err(new FileError('unknown', error instanceof Error ? error.message : 'Cannot inspect workspace path', current))
      }
    }
    return undefined
  }
}

/**
 * 功能：为脱离终端的后台 shell 选择启动方式，存在 macOS 写沙盒时保持沙盒包裹。
 * @param env 当前会话的执行环境。
 * @param command 待执行的 shell 命令字符串。
 * @param fallbackShell 非沙盒环境下使用的 shell 路径。
 * @returns LocalShellSpawn：沙盒环境用 sandboxSpawn；否则 `{ file: fallbackShell, args: ['-c', command] }`。
 */
export function localShellSpawn(env: ExecutionEnv, command: string, fallbackShell: string): LocalShellSpawn {
  return env instanceof WorkspaceWriteExecutionEnv
    ? env.sandboxSpawn(command)
    : { file: fallbackShell, args: ['-c', command] }
}

/**
 * 功能：按会话选择的访问模式创建执行环境。
 * @param cwd 会话工作目录；realpath 失败时抛 NOT_FOUND。
 * @param mode 访问模式（readOnly/workspaceWrite/fullAccess）。
 * @param extraWriteRoots workspaceWrite 模式下的额外写入根。
 * @param project 工作台子会话的原项目目录。
 * @returns 对应模式的 ExecutionEnv。
 * 内部逻辑：先规范化 cwd（不可用即抛错）；workspaceWrite 模式下沙盒不受支持则抛 UNSUPPORTED，
 * 否则返回 WorkspaceWriteExecutionEnv；其余模式返回无沙盒的 NodeExecutionEnv。
 */
export async function createExecutionEnv(cwd: string, mode: AccessMode, extraWriteRoots: readonly string[] = [], project?: string): Promise<ExecutionEnv> {
  const canonical = await realpath(cwd).catch(() => {
    throw new RuntimeError('NOT_FOUND', '会话工作目录不可用')
  })
  const deliveryRoot = project === undefined ? undefined : await realpath(project)
  const writeRoots = mode === 'workspaceWrite'
    ? [canonical, ...(deliveryRoot === undefined ? [] : [deliveryRoot]), ...extraWriteRoots]
    : undefined
  let env: ExecutionEnv
  if (writeRoots !== undefined) {
    if (!await workspaceWriteSupported(canonical)) throw new RuntimeError('UNSUPPORTED', '当前系统无法启用工作区写入沙盒')
    env = new WorkspaceWriteExecutionEnv(canonical, writeRoots)
  } else {
    env = new NodeExecutionEnv({ cwd: canonical })
  }
  if (deliveryRoot !== undefined) workbenchProjects.set(env, { project: deliveryRoot, writeRoots })
  return env
}
