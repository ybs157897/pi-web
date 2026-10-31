/**
 * WeTrack defect list for the automations page.
 *
 * The same env contract as the `wetrack-defects` plugin serves both: a CLI command
 * (`WETRACK_CLI_JSON` / `WETRACK_SCRIPT` / `WETRACK_CLI`) or an offline fixture
 * (`WETRACK_FIXTURE`). Without either, the route reports "not configured" instead of
 * inventing data — the page then shows how to connect it.
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
/** An analysis document is prose, not a payload: keep it whole up to a sane ceiling. */
const MAX_REPORT_LENGTH = 200_000
const DEFECT_NUMBER = /^DTS\d{3,16}$/u
/** `.bat`/`.cmd` cannot be spawned directly; they need `cmd.exe` and a pre-quoted command line. */
const WINDOWS_BATCH_FILE = /\.(?:bat|cmd)$/iu

/** The regex the routes, the CLI argument and the report file name all share. */
export function isDefectNumber(value: string): boolean {
  return DEFECT_NUMBER.test(value)
}

export interface WetrackReadOptions {
  env?: NodeJS.ProcessEnv
  cwd?: string
  /** Fixture path used when `WETRACK_FIXTURE` is unset (demo instances point at the bundled sample). */
  fixture?: string
  timeoutMs?: number
}

/** True when any CLI or fixture variable is present, so demo instances keep their sample only when idle. */
export function wetrackConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return ['WETRACK_FIXTURE', 'WETRACK_CLI_JSON', 'WETRACK_SCRIPT', 'WETRACK_CLI'].some(name => (env[name] ?? '').trim() !== '')
}

/** The offline sample shipped with the plugin, used by demo instances. */
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

function fileTime(date: Date): string {
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

function nowText(): string {
  return fileTime(new Date())
}

/** `WETRACK_FIXTURE` wins over the demo fallback passed by the runtime. */
function fixtureOf(options: WetrackReadOptions): string | undefined {
  const env = options.env ?? process.env
  const configured = (env.WETRACK_FIXTURE ?? '').trim()
  return configured !== '' ? configured : options.fixture
}

function recordOf(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

function boundedText(value: unknown): string | undefined {
  return typeof value === 'string' ? value.slice(0, MAX_FIELD_LENGTH) : undefined
}

/** rd-cli wraps every reply in `{ success, data }`; wetrack.py and the fixtures stay flat. */
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

/** Keep scalar fields (the list row contract) and drop nested payloads meant for the detail view. */
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

/** `{ pending: { items } }`, `{ pending: [] }`, `{ items: [] }` and bare arrays all occur in the wild. */
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

function normalizeItems(payload: unknown): WetrackDefectItem[] {
  return listItems(unwrapEnvelope(payload)).flatMap(item => {
    const normalized = normalizeItem(item)
    return normalized === undefined ? [] : [normalized]
  })
}

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

/** rd-cli nests WeTrack commands under a `wetrack` namespace; wetrack.py takes the command directly. */
function isRdcli(base: string[], env: NodeJS.ProcessEnv): boolean {
  if ((env.WETRACK_SCRIPT ?? '').trim() !== '') return false
  return /^rd-cli(?:\.(?:exe|cmd|bat))?$/iu.test(basename(base[0] as string))
}

/** The namespace sits right after the program and goes in once: an explicit `wetrack` in the base wins. */
function cliArgs(base: string[], args: string[], env: NodeJS.ProcessEnv): string[] {
  const tail = [...base.slice(1), ...args]
  if (!isRdcli(base, env) || tail.includes('wetrack')) return tail
  return ['wetrack', ...tail]
}

/** `spawn` appends only `.exe` to bare names on Windows, so `.cmd`/`.bat` shims need a PATHEXT lookup of their own. */
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

interface ResolvedCommand {
  /** Process to spawn: the CLI itself, or `cmd.exe` for a batch shim. */
  command: string
  /** Flags that must precede the command line. */
  prefix: string[]
  /** CLI executable, quoted inside a batch command line. */
  program: string
  /** Batch shims take one pre-quoted line that `cmd.exe` must pass through unchanged. */
  verbatim: boolean
}

function resolveCommand(base: string[], env: NodeJS.ProcessEnv): ResolvedCommand {
  const program = findOnPath(base[0] as string, env) ?? (base[0] as string)
  if (!WINDOWS_BATCH_FILE.test(program)) return { command: program, prefix: [], program, verbatim: false }
  const comspec = (env.ComSpec ?? env.COMSPEC ?? '').trim()
  return { command: comspec === '' ? 'cmd.exe' : comspec, prefix: ['/d', '/s', '/c'], program, verbatim: true }
}

/** `/s` strips one outer pair of quotes, so quote the whole line and every argument. */
function batchCommandLine(program: string, args: string[]): string {
  const parts = [program, ...args].map(value => `"${value.replaceAll('"', '\\"')}"`)
  return `"${parts.join(' ')}"`
}

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
      // Business failures arrive as `{ success: false, error }` on stdout with exit 1/3,
      // usage errors as plain text on stderr, so stdout is parsed before the exit code is trusted.
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

function emptyList(notice?: string): WetrackDefectList {
  return { configured: false, source: 'pending', generatedAt: nowText(), count: 0, items: [], ...(notice === undefined ? {} : { notice }) }
}

/** Read the current user's pending defects, or the fixture standing in for them. */
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

/** rd-cli takes `--defect-number`, wetrack.py a positional argument. */
function detailArgs(defectNumber: string, env: NodeJS.ProcessEnv): string[] {
  return isRdcli(commandBase(env), env)
    ? ['detail', '--defect-number', defectNumber, '--json']
    : ['detail', defectNumber, '--json']
}

/** One defect for the reading page: the CLI's `detail` payload, or `details[number]` in the fixture. */
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

/** Where analysis documents live: `WETRACK_REPORT_DIR`, else `<数据目录>/wetrack-reports`. */
export function wetrackReportDir(env: NodeJS.ProcessEnv = process.env, dataDir?: string): string {
  const configured = (env.WETRACK_REPORT_DIR ?? '').trim()
  return configured !== '' ? resolve(configured) : join(dataDir ?? piWebHome(env), 'wetrack-reports')
}

/** The operator's markdown analysis for one defect, when the file exists. */
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
