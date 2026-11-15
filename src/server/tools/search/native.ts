import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { makeExcerpt, type SearchMatch } from './format.ts'

/** 一次搜索的结果：成功完成，或为何无法运行（二进制缺失 / 运行失败）。 */
export type NativeSearchOutcome =
  | { kind: 'ok'; matches: SearchMatch[]; scannedFiles: number; truncated: boolean }
  | { kind: 'unavailable'; reason: string }
  | { kind: 'failed'; reason: string }

/** 单次 ripgrep 进程的超时毫秒数。 */
const DEFAULT_RG_TIMEOUT_MS = 30_000
/** stdout 累计字节上限（超出即截断并提前收尾）。 */
const MAX_RG_STDOUT_BYTES = 8 * 1_024 * 1_024
/** stderr 累计字节上限（只用于错误信息）。 */
const MAX_RG_STDERR_BYTES = 64 * 1_024
/** 单行列出的最大列数（超长的行由 ripgrep 自行截断）。 */
const MAX_COLUMNS = 500
/** 与 JavaScript walker 相同的单文件上限，防止一个生成的大文件主导整个搜索。 */
const MAX_FILE_BYTES = '512K'
/** ripgrep 遍历时排除的目录。 */
const OMITTED_DIRECTORIES = ['.git', '.svn', '.hg', '.bzr', '.jj', '.sl', 'node_modules', '.data'] as const
/** ripgrep 排除敏感凭据文件的 glob 规则。 */
const PRIVATE_GLOBS = [
  '!**/{credentials,secrets,tokens,private-key}*.{json,yaml,yml,toml,txt}',
  '!**/id_rsa',
  '!**/id_ed25519',
  '!**/*.{pem,key,p12,pfx,keystore}',
] as const
/** 视为敏感凭据的文件扩展名（结果过滤兜底用）。 */
const PRIVATE_FILE_EXTENSIONS = new Set(['.pem', '.key', '.p12', '.pfx', '.keystore'])
/** 视为敏感凭据的文件名模式（结果过滤兜底用）。 */
const PRIVATE_FILE_NAME = /^(?:(?:credentials?|secrets?|tokens?|private[-_]?key)\.(?:json|ya?ml|toml|txt)|id_rsa|id_ed25519)$/i

/** 解析结果缓存：null 表示尚未解析过。 */
let resolvedRipgrep: string | undefined | null = null
/** 测试强制指定的可执行文件。 */
let forcedRipgrep: string | undefined
/** 是否处于测试强制模式。 */
let hasForcedRipgrep = false

/**
 * 功能：解析原生 ripgrep 可执行文件（只解析一次，带缓存）。
 * 内部逻辑：优先测试强制值；其次 `PI_WEB_RG_PATH` 显式覆盖；再次 `@vscode/ripgrep`
 * 附带的二进制；最后回落 PATH 中的 `rg`。
 * @returns 可执行文件路径或命令名；均不可用时 undefined。
 */
export async function resolveRipgrep(): Promise<string | undefined> {
  if (hasForcedRipgrep) return forcedRipgrep
  if (resolvedRipgrep !== null) return resolvedRipgrep

  const explicit = process.env.PI_WEB_RG_PATH?.trim()
  if (explicit && existsSync(explicit)) {
    resolvedRipgrep = explicit
    return explicit
  }

  try {
    // 用非字面量说明符，避免 TypeScript 强制要求这个可选包的类型。
    const specifier = '@vscode/ripgrep'
    const loaded = await import(specifier) as { rgPath?: string; default?: { rgPath?: string } }
    const bundled = loaded.rgPath ?? loaded.default?.rgPath
    if (bundled && existsSync(bundled)) {
      resolvedRipgrep = bundled
      return bundled
    }
  } catch {
    // 可选包不存在；PATH 里的 rg 仍值得一试。
  }

  resolvedRipgrep = 'rg'
  return resolvedRipgrep
}

/** 清空 ripgrep 解析缓存与测试强制值，供测试隔离。 */
export function resetRipgrepResolverForTests(): void {
  resolvedRipgrep = null
  forcedRipgrep = undefined
  hasForcedRipgrep = false
}

/** 测试中强制指定搜索可执行文件（undefined 表示不可用）。 */
export function setRipgrepForTests(command: string | undefined): void {
  forcedRipgrep = command
  hasForcedRipgrep = true
  resolvedRipgrep = null
}

/** 判断路径最后一段是否属于敏感凭据文件。 */
function isPrivatePath(path: string): boolean {
  const name = path.split('/').pop() ?? ''
  const lower = name.toLowerCase()
  const extension = lower.slice(lower.lastIndexOf('.'))
  return PRIVATE_FILE_NAME.test(name) || PRIVATE_FILE_EXTENSIONS.has(extension)
}

/**
 * 功能：把 ripgrep 输出的路径转成 workspace 相对路径。
 * 内部逻辑：越出 root 或命中敏感文件时返回 undefined（该条结果被丢弃）。
 * @param root workspace 根。
 * @param path ripgrep 报告的路径（绝对或相对）。
 * @returns 规范化（正斜杠）的相对路径，或 undefined。
 */
function toWorkspacePath(root: string, path: string): string | undefined {
  const absolute = isAbsolute(path) ? path : resolve(root, path)
  const local = relative(root, absolute)
  if (local === '' || local === '..' || local.startsWith(`..${sep}`) || isAbsolute(local)) return undefined
  const normalized = local.split(sep).join('/')
  return isPrivatePath(normalized) ? undefined : normalized
}

/**
 * 功能：构造 ripgrep 命令行参数。
 * 内部逻辑：固定开启 JSON 输出与统计、列数/文件大小上限；逐一排除 OMITTED_DIRECTORIES
 * 与敏感 glob；大小写与 include 按需追加。
 * @param input 搜索输入。
 * @returns 完整参数数组。
 */
function buildArgs(input: {
  pattern: string
  searchPath: string
  include?: string
  caseSensitive: boolean
}): string[] {
  const args = [
    '--no-config',
    '--color', 'never',
    '--no-heading',
    '--with-filename',
    '--line-number',
    '--max-columns', String(MAX_COLUMNS),
    '--max-filesize', MAX_FILE_BYTES,
    '--json',
    '--stats',
  ]

  for (const directory of OMITTED_DIRECTORIES) {
    args.push('--glob', `!${directory}`, '--glob', `!**/${directory}/**`)
  }
  for (const glob of PRIVATE_GLOBS) args.push('--glob', glob)

  if (!input.caseSensitive) args.push('--ignore-case')
  if (input.include) args.push('--glob', input.include)
  args.push('--', input.pattern, input.searchPath)
  return args
}

/** 终止 ripgrep 进程树：Windows 用 taskkill /F /T，其余 SIGKILL；进程可能已退出，失败静默。 */
function killChild(child: ChildProcess | undefined): void {
  const pid = child?.pid
  if (pid === undefined) return
  if (process.platform === 'win32') {
    try {
      const killer = spawn('taskkill', ['/F', '/T', '/PID', String(pid)], { stdio: 'ignore', windowsHide: true })
      killer.on('error', () => undefined)
    } catch {
      // 进程可能已经退出。
    }
    return
  }
  try {
    child?.kill('SIGKILL')
  } catch {
    // 进程可能已经退出。
  }
}

/** ripgrep --json 输出中我们关心的事件形状（match/summary）。 */
interface RipgrepEvent {
  type?: string
  data?: {
    path?: { text?: string }
    line_number?: number
    lines?: { text?: string }
    submatches?: Array<{ start?: number }>
    stats?: { searches?: number }
  }
}

/**
 * 功能：解析 ripgrep 的 JSON 行 stdout。
 * 内部逻辑：summary 事件取 searches 计数；match 事件转成 SearchMatch——路径越出
 * workspace 或命中敏感文件时丢弃；命中字节偏移经 UTF-8 重解码换算成字符偏移；达到
 * maxResults 后继续读完，让 summary 仍能报告搜索过的文件数，同时标记 truncated。
 * @param stdout ripgrep 的完整 stdout。
 * @param root workspace 根。
 * @param maxResults 结果数上限。
 * @returns 命中列表、扫描文件数与截断标记。
 */
function parseStdout(
  stdout: string,
  root: string,
  maxResults: number,
): { matches: SearchMatch[]; scannedFiles: number; truncated: boolean } {
  const matches: SearchMatch[] = []
  let scannedFiles = 0
  let truncated = false

  for (const line of stdout.split('\n')) {
    if (line.trim() === '') continue
    let event: RipgrepEvent
    try {
      event = JSON.parse(line) as RipgrepEvent
    } catch {
      continue
    }

    if (event.type === 'summary') {
      const searches = event.data?.stats?.searches
      if (typeof searches === 'number') scannedFiles = searches
      continue
    }
    if (event.type !== 'match') continue

    const path = event.data?.path?.text
    const lineNumber = event.data?.line_number
    const lineText = event.data?.lines?.text
    if (typeof path !== 'string' || typeof lineNumber !== 'number' || typeof lineText !== 'string') continue
    const workspacePath = toWorkspacePath(root, path)
    if (workspacePath === undefined) continue

    const text = lineText.replace(/\r?\n$/, '')
    const byteStart = event.data?.submatches?.[0]?.start
    const matchIndex = typeof byteStart === 'number'
      ? Buffer.from(text, 'utf8').subarray(0, byteStart).toString('utf8').length
      : 0
    if (matches.length >= maxResults) {
      // 继续读取，让 summary 仍能报告搜索过的文件数。
      truncated = true
      continue
    }
    matches.push({ path: workspacePath, line: lineNumber, excerpt: makeExcerpt(text, matchIndex) })
  }

  if (scannedFiles === 0) scannedFiles = new Set(matches.map(match => match.path)).size
  return { matches, scannedFiles, truncated }
}

/**
 * 功能：在工作区上运行原生 ripgrep 正则搜索。
 * 输入校验/边界：二进制缺失返回 unavailable；已中止返回 failed；进程超时
 * DEFAULT_RG_TIMEOUT_MS、stdout 超 MAX_RG_STDOUT_BYTES（截断收尾）、退出码非 0/1
 * 均返回 failed 并带原因。调用方保留 JavaScript walker 作为二进制缺失、Rust 正则
 * 不支持或运行失败时的回退。
 * @param input root/searchPath/pattern/include/大小写/maxResults/abort 信号。
 * @returns NativeSearchOutcome 三种结果之一。
 */
export async function searchWithRipgrep(input: {
  root: string
  searchPath: string
  pattern: string
  include?: string
  caseSensitive: boolean
  maxResults: number
  signal?: AbortSignal
}): Promise<NativeSearchOutcome> {
  const command = await resolveRipgrep()
  if (command === undefined) return { kind: 'unavailable', reason: 'no ripgrep binary was found' }
  if (input.signal?.aborted) return { kind: 'failed', reason: 'aborted' }

  const args = buildArgs(input)

  return await new Promise<NativeSearchOutcome>((settle) => {
    let settled = false
    let truncated = false
    let stdout = ''
    let stderr = ''
    let child: ChildProcess | undefined
    let timer: NodeJS.Timeout | undefined

    const finish = (outcome: NativeSearchOutcome) => {
      if (settled) return
      settled = true
      if (timer !== undefined) clearTimeout(timer)
      input.signal?.removeEventListener('abort', onAbort)
      settle(outcome)
    }

    const onAbort = () => {
      killChild(child)
      finish({ kind: 'failed', reason: 'aborted' })
    }

    let spawned: ChildProcess
    try {
      spawned = spawn(command, args, {
        cwd: input.root,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      })
    } catch (error) {
      finish({ kind: 'failed', reason: error instanceof Error ? error.message : String(error) })
      return
    }
    child = spawned

    timer = setTimeout(() => {
      killChild(spawned)
      finish({ kind: 'failed', reason: `ripgrep did not finish within ${DEFAULT_RG_TIMEOUT_MS / 1_000}s` })
    }, DEFAULT_RG_TIMEOUT_MS)
    input.signal?.addEventListener('abort', onAbort, { once: true })

    spawned.stdout?.on('data', (chunk: Buffer) => {
      if (settled) return
      if (stdout.length + chunk.length > MAX_RG_STDOUT_BYTES) {
        truncated = true
        killChild(spawned)
        finish({ kind: 'ok', ...parseStdout(stdout, input.root, input.maxResults), truncated: true })
        return
      }
      stdout += chunk.toString('utf8')
    })

    spawned.stderr?.on('data', (chunk: Buffer) => {
      if (stderr.length < MAX_RG_STDERR_BYTES) stderr += chunk.toString('utf8')
    })

    spawned.on('error', (error) => {
      const code = (error as NodeJS.ErrnoException).code
      finish(code === 'ENOENT'
        ? { kind: 'unavailable', reason: `ripgrep is not installed at ${command}` }
        : { kind: 'failed', reason: error.message })
    })

    spawned.on('close', (code) => {
      if (settled) return
      if (code === 0 || code === 1) {
        const parsed = parseStdout(stdout, input.root, input.maxResults)
        finish({ kind: 'ok', ...parsed, truncated: parsed.truncated || truncated })
        return
      }
      finish({
        kind: 'failed',
        reason: `ripgrep exited with code ${String(code)}${stderr.trim() === '' ? '' : `: ${stderr.trim().slice(0, 500)}`}`,
      })
    })
  })
}
