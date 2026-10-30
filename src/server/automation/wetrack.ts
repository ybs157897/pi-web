/**
 * WeTrack defect list for the automations page.
 *
 * The same env contract as the `wetrack-defects` plugin serves both: a CLI command
 * (`WETRACK_CLI_JSON` / `WETRACK_SCRIPT` / `WETRACK_CLI`) or an offline fixture
 * (`WETRACK_FIXTURE`). Without either, the route reports "not configured" instead of
 * inventing data — the page then shows how to connect it.
 */
import { spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { WetrackDefectItem, WetrackDefectList } from '../../shared/types.ts'

const CLI_TIMEOUT_MS = 45_000
const MAX_FIELD_LENGTH = 8_000

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
  '3. WETRACK_CLI：单个可执行文件（路径不要含空格，含空格请用 WETRACK_CLI_JSON）',
  '4. WETRACK_FIXTURE：本地 JSON 夹具路径（仅用于离线演示）',
].join('\n')

function nowText(): string {
  const date = new Date()
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

function recordOf(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

function boundedText(value: unknown): string | undefined {
  return typeof value === 'string' ? value.slice(0, MAX_FIELD_LENGTH) : undefined
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
  return listItems(payload).flatMap(item => {
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
    const child = spawn(base[0] as string, [...base.slice(1), ...args], {
      cwd: options.cwd,
      env: options.env,
      windowsHide: true,
      shell: process.platform === 'win32',
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
      if (code !== 0) {
        finish(new Error((stderr.trim() || stdout.trim() || `WeTrack CLI 退出码 ${code}`).slice(0, 4_000)))
        return
      }
      try { finish(null, parseJsonOutput(stdout)) } catch (error) {
        finish(new Error(`WeTrack CLI 没有返回合法 JSON：${error instanceof Error ? error.message : String(error)}`))
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
  const fixture = (env.WETRACK_FIXTURE ?? '').trim() !== '' ? (env.WETRACK_FIXTURE as string).trim() : options.fixture

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
