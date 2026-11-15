/**
 * 自动化页面所需的 WeTrack 缺陷清单。
 *
 * 与 `wetrack-defects` 插件共用同一套环境变量契约：CLI 命令
 * （`WETRACK_CLI_JSON` / `WETRACK_SCRIPT` / `WETRACK_CLI`）或离线夹具
 * （`WETRACK_FIXTURE`）。两者都没有时，路由返回「未配置」而不是编造数据——
 * 页面据此展示接入指引。
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import { basename, delimiter, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type {
  WetrackDefectDetail, WetrackDefectFields, WetrackDefectItem, WetrackDefectList, WetrackDefectReport,
} from '../../shared/types.ts'
import { piWebHome } from '../state/home.ts'

const CLI_TIMEOUT_MS = 45_000
const MAX_FIELD_LENGTH = 8_000
/** 分析文档是散文而非载荷：在合理上限内保持完整。 */
const MAX_REPORT_LENGTH = 200_000
const DEFECT_NUMBER = /^DTS\d{3,16}$/u
/** `.bat`/`.cmd` 无法直接 spawn；需要 `cmd.exe` 和预先加好引号的整条命令行。 */
const WINDOWS_BATCH_FILE = /\.(?:bat|cmd)$/iu

/** 路由、CLI 参数与报告文件名共用的缺陷编号校验正则。 */
export function isDefectNumber(value: string): boolean {
  return DEFECT_NUMBER.test(value)
}

/** 读取缺陷数据的可选覆写：env、工作目录、夹具路径与超时，便于测试注入。 */
export interface WetrackReadOptions {
  env?: NodeJS.ProcessEnv
  cwd?: string
  /** `WETRACK_FIXTURE` 未设置时使用的夹具路径（demo 实例指向随包样例）。 */
  fixture?: string
  timeoutMs?: number
}

/** 是否配置了任一 CLI 或夹具变量；demo 实例只有在其空闲时才保留样例数据。 */
export function wetrackConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return ['WETRACK_FIXTURE', 'WETRACK_CLI_JSON', 'WETRACK_SCRIPT', 'WETRACK_CLI'].some(name => (env[name] ?? '').trim() !== '')
}

/** 随插件发布的离线样例夹具，供 demo 实例使用。 */
export function builtinFixturePath(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), '../../../plugins/wetrack-defects/fixtures/demo.json')
}

const CONFIG_HINT = [
  '未配置 WeTrack CLI 或夹具，暂时无法读取问题清单。给服务进程设置以下任一变量后重启：',
  '1. WETRACK_CLI_JSON：JSON 数组，例如 ["python","C:\\\\tools\\\\wetrack.py"]',
  '2. WETRACK_SCRIPT：wetrack.py 的绝对路径（可选 WETRACK_PYTHON，默认 python）',
  '3. WETRACK_CLI：单个可执行文件或完整路径（例如 rd-cli，按 PATH/PATHEXT 查找）',
  '4. WETRACK_FIXTURE：本地 JSON 夹具路径（仅用于离线演示）',
].join('\n')

/** 本地时间格式化：`YYYY-MM-DD HH:mm:ss`（文件 mtime 与生成时间共用）。 */
function fileTime(date: Date): string {
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

/** 当前时间的展示文本（fileTime 的无参版本）。 */
function nowText(): string {
  return fileTime(new Date())
}

/** 夹具路径：`WETRACK_FIXTURE` 优先于运行时传入的 demo 回退路径。 */
function fixtureOf(options: WetrackReadOptions): string | undefined {
  const env = options.env ?? process.env
  const configured = (env.WETRACK_FIXTURE ?? '').trim()
  return configured !== '' ? configured : options.fixture
}

/** 收敛为普通对象（非 null、非数组的 object），否则 undefined。 */
function recordOf(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

/** 字符串字段截断到 MAX_FIELD_LENGTH；非字符串返回 undefined。 */
function boundedText(value: unknown): string | undefined {
  return typeof value === 'string' ? value.slice(0, MAX_FIELD_LENGTH) : undefined
}

/** rd-cli 把每个回复包在 `{ success, data }` 里；wetrack.py 与夹具保持扁平结构。 */
function unwrapEnvelope(payload: unknown): unknown {
  const record = recordOf(payload)
  if (record === undefined || !('success' in record)) return payload
  if (record.success === false) {
    const failure = recordOf(record.error)
    const code = boundedText(failure?.code)
    const message = boundedText(failure?.message) ?? boundedText(record.message)
    const hint = boundedText(failure?.recover_hint)
    const head = [code, message].filter(part => part !== undefined && part !== '').join('：') || '未给出原因'
    throw new Error(`WeTrack CLI 返回失败：${head}${hint === undefined || hint === '' ? '' : `（${hint}）`}`)
  }
  return 'data' in record ? record.data : payload
}

/** 只保留标量字段（列表行契约），丢弃面向详情视图的嵌套载荷。 */
function normalizeItem(value: unknown): WetrackDefectItem | undefined {
  const record = recordOf(value)
  if (record === undefined) return undefined
  const defectNumber = boundedText(record.defectNumber)?.trim()
  if (defectNumber === undefined || defectNumber === '') return undefined
  const item: WetrackDefectItem = { defectNumber }
  for (const [field, raw] of Object.entries(record)) {
    if (field === 'defectNumber') continue
    if (typeof raw === 'string') item[field] = raw.slice(0, MAX_FIELD_LENGTH)
    else if (typeof raw === 'number' || typeof raw === 'boolean') item[field] = raw
  }
  if (item.simpleDesc === undefined) item.simpleDesc = ''
  return item
}

/** 兼容多种野生清单形状：`{ pending: { items } }`、`{ pending: [] }`、`{ items: [] }` 与裸数组都出现过。 */
function listItems(payload: unknown): unknown[] {
  if (Array.isArray(payload)) return payload
  const record = recordOf(payload)
  if (record === undefined) return []
  const pending = record.pending
  if (Array.isArray(pending)) return pending
  const pendingRecord = recordOf(pending)
  if (pendingRecord !== undefined && Array.isArray(pendingRecord.items)) return pendingRecord.items
  if (Array.isArray(record.items)) return record.items
  return []
}

/** 解包信封后提取清单条目并逐个归一化，跳过没有编号的条目。 */
function normalizeItems(payload: unknown): WetrackDefectItem[] {
  return listItems(unwrapEnvelope(payload)).flatMap(item => {
    const normalized = normalizeItem(item)
    return normalized === undefined ? [] : [normalized]
  })
}

/**
 * 功能：按环境变量优先级解析 CLI 启动命令。
 * 内部逻辑：WETRACK_CLI_JSON（JSON 字符串数组，非法即抛错）→ WETRACK_SCRIPT
 * （python 解释器 + 脚本路径，解释器可由 WETRACK_PYTHON 覆写，默认 python）→
 * WETRACK_CLI（单个可执行文件）→ 兜底 'rd-cli'。
 */
function commandBase(env: NodeJS.ProcessEnv): string[] {
  const json = (env.WETRACK_CLI_JSON ?? '').trim()
  if (json !== '') {
    let parsed: unknown
    try { parsed = JSON.parse(json) } catch { throw new Error('WETRACK_CLI_JSON 不是合法 JSON 数组') }
    if (!Array.isArray(parsed) || parsed.length === 0 || parsed.some(item => typeof item !== 'string' || item === '')) {
      throw new Error('WETRACK_CLI_JSON 必须是非空字符串数组')
    }
    return parsed as string[]
  }
  const script = (env.WETRACK_SCRIPT ?? '').trim()
  if (script !== '') return [(env.WETRACK_PYTHON ?? '').trim() || 'python', script]
  const cli = (env.WETRACK_CLI ?? '').trim()
  if (cli !== '') return [cli]
  return ['rd-cli']
}

/** rd-cli 把 WeTrack 命令挂在 `wetrack` 命名空间下；wetrack.py 直接接收命令。 */
function isRdcli(base: string[], env: NodeJS.ProcessEnv): boolean {
  if ((env.WETRACK_SCRIPT ?? '').trim() !== '') return false
  return /^rd-cli(?:\.(?:exe|cmd|bat))?$/iu.test(basename(base[0] as string))
}

/** rd-cli 命名空间紧跟程序名且只加一次；命令里已显式带 `wetrack` 时不重复。 */
function cliArgs(base: string[], args: string[], env: NodeJS.ProcessEnv): string[] {
  const tail = [...base.slice(1), ...args]
  if (!isRdcli(base, env) || tail.includes('wetrack')) return tail
  return ['wetrack', ...tail]
}

/** Windows 上 `spawn` 只给裸名补 `.exe`，因此 `.cmd`/`.bat` 垫片要按 PATHEXT 自行查找完整路径。 */
function findOnPath(program: string, env: NodeJS.ProcessEnv): string | undefined {
  if (process.platform !== 'win32') return undefined
  if (program === '' || /[\\/]/u.test(program) || /\.[^.\\/]+$/u.test(program)) return undefined
  const searchPath = env.PATH ?? env.Path ?? env.path ?? ''
  const extensions = (env.PATHEXT ?? env.Pathext ?? '.EXE;.CMD;.BAT;.COM').split(';').filter(extension => extension !== '')
  for (const directory of searchPath.split(delimiter)) {
    if (directory === '') continue
    for (const extension of extensions) {
      const candidate = join(directory, `${program}${extension}`)
      if (existsSync(candidate)) return candidate
    }
  }
  return undefined
}

/** spawn 参数的解析结果。 */
interface ResolvedCommand {
  /** 要 spawn 的进程：CLI 本体，或批处理垫片对应的 `cmd.exe`。 */
  command: string
  /** 必须置于命令行之前的标志（cmd.exe 的 /d /s /c）。 */
  prefix: string[]
  /** CLI 可执行文件；批处理场景会被整体加引号塞进命令行。 */
  program: string
  /** 批处理垫片只收一条预先加好引号的整行，`cmd.exe` 必须原样透传。 */
  verbatim: boolean
}

/**
 * 功能：把命令基座解析为可 spawn 的形式。
 * 内部逻辑：非 .bat/.cmd 直接返回本体；批处理垫片改用 ComSpec（缺省 cmd.exe）
 * 加 `/d /s /c` 前缀，并标记 verbatim 让参数按整行透传。
 */
function resolveCommand(base: string[], env: NodeJS.ProcessEnv): ResolvedCommand {
  const program = findOnPath(base[0] as string, env) ?? (base[0] as string)
  if (!WINDOWS_BATCH_FILE.test(program)) return { command: program, prefix: [], program, verbatim: false }
  const comspec = (env.ComSpec ?? env.COMSPEC ?? '').trim()
  return { command: comspec === '' ? 'cmd.exe' : comspec, prefix: ['/d', '/s', '/c'], program, verbatim: true }
}

/** `/s` 会剥掉最外层一对引号，所以整行和每个参数都要各自加引号。 */
function batchCommandLine(program: string, args: string[]): string {
  const parts = [program, ...args].map(value => `"${value.replaceAll('"', '\\"')}"`)
  return `"${parts.join(' ')}"`
}

/** 解析 CLI 的 JSON 输出；输出非纯 JSON 时定位首个 `{`/`[` 到最后一个配对括号，提取其中间段再解析。 */
function parseJsonOutput(text: string): unknown {
  const trimmed = text.trim()
  if (trimmed === '') throw new Error('WeTrack CLI 输出为空')
  try { return JSON.parse(trimmed) } catch { /* fall through to the first JSON value */ }
  const objectStart = trimmed.indexOf('{')
  const arrayStart = trimmed.indexOf('[')
  const start = objectStart < 0 ? arrayStart : arrayStart < 0 ? objectStart : Math.min(objectStart, arrayStart)
  if (start < 0) throw new Error('WeTrack CLI 没有返回 JSON')
  const end = trimmed[start] === '{' ? trimmed.lastIndexOf('}') : trimmed.lastIndexOf(']')
  if (end <= start) throw new Error('WeTrack CLI 返回的 JSON 不完整')
  return JSON.parse(trimmed.slice(start, end + 1))
}

/**
 * 功能：spawn CLI 子进程并等待其输出，超时即杀进程报错。
 * @returns 解析后的 JSON 载荷（已解包信封）
 * 内部逻辑：批处理垫片走 cmd.exe 整行透传；stdout 为空/非 JSON 按不同错误抛出；
 * 关闭时先解析 stdout——业务失败（`{ success: false }` 信封）与用法错误（stderr
 * 纯文本）都要覆盖，退出码非 0 且 stdout 不可解析时优先报 stderr；ENOENT 映射为
 * 配置指引错误（带 code: 'ENOENT'）。
 */
function runCli(base: string[], args: string[], options: { env: NodeJS.ProcessEnv; cwd: string; timeoutMs: number }): Promise<unknown> {
  return new Promise((resolveRun, rejectRun) => {
    const resolved = resolveCommand(base, options.env)
    const argv = cliArgs(base, args, options.env)
    const spawnArgs = resolved.verbatim
      ? [...resolved.prefix, batchCommandLine(resolved.program, argv)]
      : [...resolved.prefix, ...argv]
    const child = spawn(resolved.command, spawnArgs, {
      cwd: options.cwd,
      env: options.env,
      windowsHide: true,
      windowsVerbatimArguments: resolved.verbatim,
    })
    let stdout = ''
    let stderr = ''
    let settled = false
    const finish = (error: Error | null, value?: unknown): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (error === null) resolveRun(value)
      else rejectRun(error)
    }
    const timer = setTimeout(() => {
      child.kill()
      finish(new Error(`WeTrack CLI 超过 ${Math.round(options.timeoutMs / 1000)} 秒未返回`))
    }, options.timeoutMs)
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => { stdout += chunk })
    child.stderr.on('data', (chunk: string) => { stderr += chunk })
    child.on('error', (error: NodeJS.ErrnoException) => {
      finish(error.code === 'ENOENT' ? Object.assign(new Error(CONFIG_HINT), { code: 'ENOENT' }) : error)
    })
    child.on('close', code => {
      // 业务失败以 `{ success: false, error }` 出现在 stdout（退出码 1/3），用法错误是
      // stderr 上的纯文本，所以先解析 stdout 再看退出码。
      let payload: unknown
      try { payload = parseJsonOutput(stdout) } catch (error) {
        if (code !== 0) {
          finish(new Error((stderr.trim() || `WeTrack CLI 退出码 ${code}`).slice(0, 4_000)))
          return
        }
        finish(new Error(`WeTrack CLI 没有返回合法 JSON：${error instanceof Error ? error.message : String(error)}`))
        return
      }
      try {
        const value = unwrapEnvelope(payload)
        if (code === 0) {
          finish(null, value)
          return
        }
        finish(new Error((stderr.trim() || `WeTrack CLI 退出码 ${code}`).slice(0, 4_000)))
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)))
      }
    })
  })
}

/** 构造一条「未配置」的空清单，可附带指引文案。 */
function emptyList(notice?: string): WetrackDefectList {
  return { configured: false, source: 'pending', generatedAt: nowText(), count: 0, items: [], ...(notice === undefined ? {} : { notice }) }
}

/**
 * 功能：读取当前用户的待处理缺陷，或其替身夹具。
 * @returns 清单结果，source 标明来自 fixture 还是 CLI pending
 * 内部逻辑：配置了夹具则读文件并归一化；否则调用 CLI `pending --json`；
 * CLI 不存在（ENOENT）时返回带配置指引的空清单，其余错误原样抛出。
 */
export async function readWetrackDefects(options: WetrackReadOptions = {}): Promise<WetrackDefectList> {
  const env = options.env ?? process.env
  const cwd = options.cwd ?? process.cwd()
  const timeoutMs = options.timeoutMs ?? CLI_TIMEOUT_MS
  const fixture = fixtureOf(options)

  if (fixture !== undefined) {
    const path = resolve(cwd, fixture)
    const payload: unknown = JSON.parse(await readFile(path, 'utf8'))
    const items = normalizeItems(payload)
    return { configured: true, source: 'fixture', generatedAt: nowText(), count: items.length, items }
  }

  try {
    const payload = await runCli(commandBase(env), ['pending', '--json'], { env, cwd, timeoutMs })
    const items = normalizeItems(payload)
    return { configured: true, source: 'pending', generatedAt: nowText(), count: items.length, items }
  } catch (error) {
    if (error instanceof Error && (error as NodeJS.ErrnoException).code === 'ENOENT') return emptyList(CONFIG_HINT)
    throw error
  }
}

/** 详情命令参数：rd-cli 用 `--defect-number`，wetrack.py 用位置参数。 */
function detailArgs(defectNumber: string, env: NodeJS.ProcessEnv): string[] {
  return isRdcli(commandBase(env), env)
    ? ['detail', '--defect-number', defectNumber, '--json']
    : ['detail', defectNumber, '--json']
}

/**
 * 功能：读取单个缺陷详情供阅读页展示。
 * @returns 详情结果；夹具来源取 `details[编号]`（其次 `detail`），CLI 来源取 `detail` 载荷
 * 内部逻辑：缺陷编号先校验；夹具缺该缺陷时报错；CLI 不存在（ENOENT）时返回
 * configured: false 加配置指引，其余错误原样抛出。
 */
export async function readWetrackDefect(defectNumber: string, options: WetrackReadOptions = {}): Promise<WetrackDefectDetail> {
  if (!isDefectNumber(defectNumber)) throw new Error('缺陷编号必须是 DTS + 数字')
  const env = options.env ?? process.env
  const cwd = options.cwd ?? process.cwd()
  const fixture = fixtureOf(options)

  if (fixture !== undefined) {
    const path = resolve(cwd, fixture)
    const payload: unknown = JSON.parse(await readFile(path, 'utf8'))
    const record = recordOf(payload)
    const details = recordOf(record?.details)
    const candidates = [
      recordOf(details?.[defectNumber]),
      recordOf(record?.detail),
    ]
    const found = candidates.find(candidate => candidate !== undefined && candidate.defectNumber === defectNumber)
    if (found === undefined) throw new Error(`夹具中没有 ${defectNumber} 的详情`)
    return { configured: true, generatedAt: nowText(), defect: found as unknown as WetrackDefectFields }
  }

  try {
    const payload = await runCli(commandBase(env), detailArgs(defectNumber, env), { env, cwd, timeoutMs: options.timeoutMs ?? CLI_TIMEOUT_MS })
    const defect = recordOf(payload)
    if (defect === undefined) throw new Error('WeTrack CLI 没有返回缺陷详情')
    return { configured: true, generatedAt: nowText(), defect: defect as unknown as WetrackDefectFields }
  } catch (error) {
    if (error instanceof Error && (error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { configured: false, generatedAt: nowText(), notice: CONFIG_HINT }
    }
    throw error
  }
}

/** 分析文档目录：优先 `WETRACK_REPORT_DIR`，否则 `<数据目录>/wetrack-reports`。 */
export function wetrackReportDir(env: NodeJS.ProcessEnv = process.env, dataDir?: string): string {
  const configured = (env.WETRACK_REPORT_DIR ?? '').trim()
  return configured !== '' ? resolve(configured) : join(dataDir ?? piWebHome(env), 'wetrack-reports')
}

/**
 * 功能：读取运营者为单个缺陷手写的 markdown 分析文档。
 * @returns available: true 时带目录、文件名、正文（截断到 MAX_REPORT_LENGTH）与 mtime；文件不存在返回 available: false
 */
export async function readWetrackReport(
  defectNumber: string,
  options: { env?: NodeJS.ProcessEnv; dataDir?: string } = {},
): Promise<WetrackDefectReport> {
  if (!isDefectNumber(defectNumber)) throw new Error('缺陷编号必须是 DTS + 数字')
  const directory = wetrackReportDir(options.env ?? process.env, options.dataDir)
  const file = `${defectNumber}.md`
  const path = join(directory, file)
  try {
    const stats = await stat(path)
    const markdown = await readFile(path, 'utf8')
    return { available: true, directory, file, markdown: markdown.slice(0, MAX_REPORT_LENGTH), updatedAt: fileTime(stats.mtime) }
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') {
      return { available: false, directory, file }
    }
    throw error
  }
}
