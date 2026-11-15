import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { realpath } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { Context } from '@earendil-works/chord/context'
import type { ToolExecutionApi, ToolExecutionResult } from '@earendil-works/pi-durable'
import { createBashTool } from '@earendil-works/pi-durable/tools'
import iconv from 'iconv-lite'
import { localShellSpawn } from '../../conversation/execution-env.ts'
import { RuntimeError } from '../../runtime-errors.ts'
import { commandTimeout, resolveWorkdir, shellQuote, withNoMatchSuccess } from './common.ts'
import { runShellCommand } from './runner.ts'

/** Pi 内置 bash 工具的原始定义，非本地环境时委托执行用。 */
const baseBash = createBashTool()

/** 允许出现在搜索命令前的包装器命令集合，逐层剥离后看真实命令。 */
const WRAPPERS = new Set(['sudo', 'doas', 'command', 'env', 'time', 'nice', 'nohup', 'stdbuf', 'exec', 'xargs'])
/** grep 递归标志匹配：短选项含 r/R、或 `--recursive` / `--dereference-recursive`。 */
const RECURSIVE_FLAG = /^(?:-[A-Za-z]*[rR][A-Za-z]*|--recursive|--dereference-recursive)$/

/**
 * 功能：把命令中所有单引号/双引号包裹的字符串替换为空格。
 * 内部逻辑：避免把引号内的文本误当作命令片段参与拦截判定。
 * @param command 原始命令文本。
 * @returns 去除引号内容后的文本。
 */
function stripQuoted(command: string): string {
  return command.replace(/'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"/g, ' ')
}

/**
 * 功能：把命令按 shell 分隔符（`||`、`&&`、`|`、`;`、换行）拆成子命令片段（引号内容已剔除）。
 * @param command 原始命令文本。
 * @returns 非空子命令片段数组。
 */
function commandSegments(command: string): string[] {
  return stripQuoted(command)
    .split(/\|\||&&|[|;\n\r]/)
    .map(segment => segment.trim())
    .filter(segment => segment !== '')
}

/**
 * 功能：从单个 token 提取命令名：取路径最后一段并小写。
 * @param token 待解析的词元。
 * @returns 小写命令名；无法识别时 undefined。
 */
function commandName(token: string): string | undefined {
  const name = token.split(/[\\/]/).pop()?.toLowerCase()
  return name === undefined || name === '' ? undefined : name
}

/**
 * 功能：拦截 shell 内的递归检索命令——递归 `grep`/`rg` 会绕过 grep 工具的工作区边界、
 * 输出上限和密钥文件过滤；`find -exec grep` 与 `find | xargs grep` 是同类批量检索路径。
 * 内部逻辑：逐段剥离 WRAPPERS 包装器；`xargs` 之后接搜索命令、rg/rgrep 直接命中、
 * grep/egrep/fgrep 带递归标志或 `-d recurse`、find 的 -exec 内层接 grep 均判为拦截。
 * 引号里提到的搜索命令（如 `echo` 输出）不算命令。
 * @param command 完整命令文本。
 * @returns 命中拦截规则时 true。
 */
export function isBlockedShellSearch(command: string): boolean {
  for (const segment of commandSegments(command)) {
    const tokens = segment.split(/\s+/).filter(token => token !== '')
    let index = 0
    let viaXargs = false
    while (index < tokens.length) {
      const wrapper = commandName(tokens[index]!)
      if (wrapper === undefined || !WRAPPERS.has(wrapper)) break
      if (wrapper === 'xargs') viaXargs = true
      index += 1
      while (index < tokens.length && tokens[index]!.startsWith('-')) index += 1
    }

    const name = index < tokens.length ? commandName(tokens[index]!) : undefined
    if (name === undefined) continue
    const isSearch = name === 'grep' || name === 'egrep' || name === 'fgrep' || name === 'rg' || name === 'rgrep'
    if (viaXargs && isSearch) return true
    if (name === 'rg' || name === 'rgrep') return true
    if (name === 'grep' || name === 'egrep' || name === 'fgrep') {
      const args = tokens.slice(index + 1)
      if (args.some(arg => RECURSIVE_FLAG.test(arg))) return true
      if (args.some((arg, position) => arg === '-d' && args[position + 1] === 'recurse')) return true
    }
    if (name === 'find') {
      const execIndex = tokens.findIndex(token => token === '-exec' || token === '-execdir')
      if (execIndex >= 0) {
        const inner = tokens.slice(execIndex + 1).map(commandName)
        if (inner.some(token => token === 'grep' || token === 'egrep' || token === 'fgrep' || token === 'rg')) return true
      }
    }
  }
  return false
}

/**
 * 功能：解析 bash 工具使用的 shell 可执行路径。
 * 内部逻辑：优先 `/bin/bash`；不存在时回退 SHELL 环境变量指定的用户 shell（须存在）；
 * 最后回落 `/bin/sh`。
 * @returns shell 的绝对/可解析路径。
 */
export function resolvePosixShell(): string {
  if (existsSync('/bin/bash')) return '/bin/bash'
  const configured = process.env.SHELL?.trim()
  if (configured && existsSync(configured)) return configured
  return '/bin/sh'
}

/**
 * 功能：构造子进程环境变量，并解析旧编码回退目标。
 * 内部逻辑：POSIX 输出通常为 UTF-8，但 macOS GUI/远程主机可能继承 C/POSIX locale（使
 * `ls`/`wc` 把非 ASCII 替换成 `??`），用户 locale 也可能指定其他字符集；继承的 LANG/
 * LC_CTYPE/LC_ALL 不可用时改设 UTF-8 fallback（macOS 用 en_US.UTF-8，其余 C.UTF-8），
 * 强制 Python 走 UTF-8；若最终 locale 的 codeset 非 UTF-8 且 iconv 支持，则返回该
 * codeset 供 LegacyAwareDecoder 做解码回退。
 * @returns env 为注入后的环境变量；legacyEncoding 为旧编码名或 null。
 */
export function resolvePosixEnv(): { env: NodeJS.ProcessEnv; legacyEncoding: string | null } {
  const env: NodeJS.ProcessEnv = { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' }
  const fallback = process.platform === 'darwin' ? 'en_US.UTF-8' : 'C.UTF-8'
  const unusable = (value: string | undefined): boolean =>
    value === undefined || value.trim() === '' || /^(?:C|POSIX)$/i.test(value.trim())

  if (unusable(env.LANG)) env.LANG = fallback
  if (unusable(env.LC_CTYPE)) env.LC_CTYPE = fallback
  if (env.LC_ALL !== undefined && unusable(env.LC_ALL)) env.LC_ALL = fallback

  const locale = env.LC_ALL ?? env.LC_CTYPE ?? env.LANG ?? ''
  const codeset = /\.([^@]+)$/.exec(locale)?.[1]?.trim()
  const legacyEncoding = codeset !== undefined && !/utf-?8/i.test(codeset) && iconv.encodingExists(codeset)
    ? codeset
    : null
  return { env, legacyEncoding }
}

/**
 * 功能：终止 POSIX 命令的整个进程树。
 * 内部逻辑：runner 以 detached 方式启动子进程，子进程是进程组长，故先对负 pid（整组）
 * 发 SIGKILL；失败（进程可能已不存在）再尝试直接 kill 单个进程，仍失败则静默忽略。
 * @param child 由 runner 启动的子进程，可能为 undefined。
 */
export function killPosixTree(child: ChildProcess | undefined): void {
  const pid = child?.pid
  if (pid === undefined) return
  try {
    // runner 以 detached 方式启动，子进程是进程组组长。
    process.kill(-pid, 'SIGKILL')
  } catch {
    try {
      child?.kill('SIGKILL')
    } catch {
      // 进程可能已经退出。
    }
  }
}

/**
 * 功能：执行 POSIX bash 工具。
 * 输入校验：拦截递归 shell 检索（FORBIDDEN）；会话无工作区抛 UNSUPPORTED；timeout 必须为
 * 正数（INVALID_INPUT）。
 * 边界/权限：workdir 经 resolveWorkdir 限制在工作区内；前台调用保持工作区写沙箱，长命令
 * 让渡到后台时沿用同一沙箱化调用。非本地环境委托 Pi 平台 bash 工具（必要时拼 cd 前缀），
 * 本地环境走 runShellCommand（含编码回退、让渡、进程树终止）。
 * @param args 调用参数：command、workdir、timeout、yieldTimeMs。
 * @param api 工具执行 API（输出流、环境信息等）。
 * @param context 执行上下文。
 * @returns shell 工具的标准执行结果。
 */
export async function executePosixBash(
  args: { command: string; workdir?: string; timeout?: number; yieldTimeMs?: number },
  api: ToolExecutionApi,
  context: Context,
): Promise<ToolExecutionResult> {
  if (isBlockedShellSearch(args.command)) {
    throw new RuntimeError(
      'FORBIDDEN',
      'Blocked: recursive grep/rg in the shell bypasses the grep tool workspace policy, output limits, and secret-file filtering. Use the grep tool instead, for example grep({ pattern, path, include }).',
    )
  }

  const cwd = api.env?.cwd
  if (typeof cwd !== 'string' || cwd.trim() === '') {
    throw new RuntimeError('UNSUPPORTED', 'This conversation has no workspace directory.')
  }
  const timeoutSeconds = commandTimeout(args.timeout)
  if (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0) {
    throw new RuntimeError('INVALID_INPUT', 'timeout must be a positive number of seconds.')
  }

  const root = await realpath(cwd).catch(() => resolve(cwd))
  const workdir = await resolveWorkdir(root, args.workdir)

  if (api.env === undefined || api.env.id !== 'node:local') {
    const command = workdir === root ? args.command : `cd -- ${shellQuote(workdir)} && ${args.command}`
    const result = await baseBash.execute({ command, timeout: timeoutSeconds }, api, context)
    return withNoMatchSuccess(result, args.command)
  }

  const { env, legacyEncoding } = resolvePosixEnv()
  const spawnSpec = localShellSpawn(api.env, args.command, resolvePosixShell())
  return await runShellCommand({
    command: args.command,
    program: spawnSpec.file,
    args: spawnSpec.args,
    cwd: workdir,
    env,
    legacyEncoding,
    timeoutSeconds,
    yieldTimeMs: args.yieldTimeMs,
    kill: killPosixTree,
    api,
    context,
  })
}
