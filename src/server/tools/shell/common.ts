import { lstat, realpath } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { RuntimeError } from '../../runtime-errors.ts'

/** 未传 timeout 时的命令超时上限（秒），防止前台启动的服务器/监听进程把调用永远占住。 */
export const DEFAULT_COMMAND_TIMEOUT_SECONDS = 300

/**
 * 功能：解析命令超时秒数。
 * @param seconds 调用方传入的超时秒数；undefined 时回落到 DEFAULT_COMMAND_TIMEOUT_SECONDS。
 * @returns 实际生效的超时秒数。
 */
export function commandTimeout(seconds: number | undefined): number {
  return seconds ?? DEFAULT_COMMAND_TIMEOUT_SECONDS
}

/** POSIX 单引号安全包裹：仅转义单引号本身（`'` → `'\''`），防注入。 */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

/** PowerShell 单引号安全包裹：仅把单引号双写（`''`），防注入。 */
export function powershellQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`
}

/**
 * 功能：解析单次调用的工作目录，并确保始终落在绑定的 workspace 内。
 * 输入校验：未传直接用 cwd；传了但非字符串/空白/含 NUL 字节抛 INVALID_INPUT；
 * 路径不存在抛 NOT_FOUND；解析后越出 workspace 抛 FORBIDDEN；不是目录抛 INVALID_INPUT。
 * 内部逻辑：先 realpath 解析符号链接，再用 relative 判定是否越界（`..` 开头或为绝对路径）。
 * @param cwd 工作区根目录（沙箱边界）。
 * @param value 调用参数中的 workdir，可为绝对或相对路径；相对路径以 cwd 为基准。
 * @returns realpath 解析后的、保证在 workspace 内的目录绝对路径。
 */
export async function resolveWorkdir(cwd: string, value: unknown, project?: string): Promise<string> {
  if (value === undefined) return cwd
  if (typeof value !== 'string' || value.trim() === '' || value.includes('\u0000')) {
    throw new RuntimeError('INVALID_INPUT', 'workdir must be a non-empty path inside the workspace.')
  }
  let root: string
  let target: string
  try {
    root = await realpath(cwd)
    target = await realpath(isAbsolute(value) ? value : resolve(root, value))
  } catch {
    throw new RuntimeError('NOT_FOUND', 'workdir does not exist or is unavailable.')
  }
  const allowedRoots = project === undefined ? [root] : [root, project]
  const inside = allowedRoots.some(directory => {
    const rel = relative(directory, target)
    return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
  })
  if (!inside) {
    throw new RuntimeError('FORBIDDEN', 'workdir must stay inside the workspace.')
  }
  const info = await lstat(target)
  if (!info.isDirectory()) throw new RuntimeError('INVALID_INPUT', 'workdir must be a workspace directory.')
  return target
}

/** 退出码 1 表示"无匹配"而非失败的命令集合。 */
const NO_MATCH_COMMANDS = new Set(['grep', 'egrep', 'fgrep', 'rg', 'findstr'])

/**
 * 功能：把命令按 shell 分隔符（`||`、`&&`、`|`、`;`、换行）拆成子命令片段。
 * @param command 完整命令文本。
 * @returns 去除空白后的非空子命令片段数组。
 */
function commandSegments(command: string): string[] {
  return command
    .split(/\|\||&&|[|;\n\r]/)
    .map(segment => segment.trim())
    .filter(segment => segment !== '')
}

/**
 * 功能：从单个子命令片段中提取命令名。
 * 内部逻辑：按引号词/裸词分词；跳过 PowerShell 的调用操作符 `&`；取首词后去引号，
 * 取路径最后一段并小写、去 `.exe` 后缀；空串返回 undefined。
 * @param segment 单个子命令片段。
 * @returns 规范化的小写命令名；无法识别时 undefined。
 */
function commandName(segment: string): string | undefined {
  const tokens = segment.match(/"[^"]*"|'[^']*'|\S+/g) ?? []
  let index = 0
  // PowerShell 的调用操作符 `&` 不是命令本身，跳过它。
  while (tokens[index] === '&') index += 1
  const raw = tokens[index]
  if (raw === undefined) return undefined
  const unquoted = raw.replace(/^["']|["']$/g, '')
  const name = unquoted.split(/[\\/]/).pop()?.toLowerCase().replace(/\.exe$/, '')
  return name === '' ? undefined : name
}

/**
 * 功能：判断单个子命令片段是否属于"退出码 1 = 无匹配"的搜索命令。
 * 内部逻辑：命令名在 NO_MATCH_COMMANDS 中直接成立；`git grep` 子命令同样成立。
 * @param segment 单个子命令片段。
 * @returns 属于无匹配语义的搜索命令时 true。
 */
function segmentIsNoMatch(segment: string): boolean {
  const name = commandName(segment)
  if (name === undefined) return false
  if (NO_MATCH_COMMANDS.has(name)) return true
  if (name === 'git') {
    const tokens = segment.match(/"[^"]*"|'[^']*'|\S+/g) ?? []
    const subcommand = tokens
      .slice(1)
      .map(token => token.replace(/^["']|["']$/g, '').toLowerCase())
      .find(token => !token.startsWith('-'))
    return subcommand === 'grep'
  }
  return false
}

/**
 * 功能：判断整条命令是否包含"无匹配搜索"语义（用于把退出码 1 的搜索归为成功）。
 * @param command 完整命令文本。
 * @returns 任一子命令片段命中无匹配语义时 true。
 */
export function isNoMatchCommand(command: string): boolean {
  return commandSegments(command).some(segmentIsNoMatch)
}

/** shell 工具结果的最小结构形状，供 withNoMatchSuccess 做泛型约束与判定。 */
interface ShellResultShape {
  isError?: boolean
  structuredOutput?: unknown
  output?: readonly { type: string; text?: string }[]
  diagnostics?: readonly { code?: string }[]
}

/**
 * 功能：把 `grep`/`rg`/`findstr` 类搜索命令的退出码 1 从失败改写为成功的"无匹配"结果。
 * 内部逻辑：仅当结果已标记 isError、structuredOutput.exitCode === 1 且命令确属无匹配
 * 搜索时改写；移除 exit_code 诊断并追加 info 级 no_matches 诊断。其余失败保持原样，
 * 退出码诊断照常保留。
 * @param result shell 工具的原始执行结果。
 * @param command 触发该结果的完整命令文本。
 * @returns 改写后（或原样）的结果，保持输入的泛型类型。
 */
export function withNoMatchSuccess<T extends ShellResultShape>(result: T, command: string): T {
  if (result.isError !== true) return result
  const structured = result.structuredOutput
  if (typeof structured !== 'object' || structured === null) return result
  if ((structured as { exitCode?: unknown }).exitCode !== 1) return result
  if (!isNoMatchCommand(command)) return result

  return {
    ...result,
    isError: false,
    diagnostics: [
      ...(result.diagnostics ?? []).filter(diagnostic => diagnostic.code !== 'exit_code'),
      { severity: 'info' as const, code: 'no_matches', message: 'No matches found.' },
    ],
  } as T
}
