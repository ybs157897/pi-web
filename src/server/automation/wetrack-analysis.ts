/**
 * Persisted AI analysis for one WeTrack defect.
 *
 * The issues page renders the stored Markdown as the model wrote it, so the record is the
 * model's answer body plus a little metadata — not a structured report. Records live outside
 * the workspace (`<dataDir>/wetrack/analyses/<DTS>.json`) because they are written by one
 * conversation (a manual analysis, a scheduled task) and read by a page that has no
 * conversation of its own.
 */
import { chmod, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type {
  WetrackAnalysisInput,
  WetrackAnalysisAttempt,
  WetrackAnalysisRecord,
  WetrackAnalysisStatus,
  WetrackAnalysisSummary,
} from '../../shared/types.ts'

/** `<DTS>` + digits; the same shape the plugin's tools accept. */
const DEFECT_NUMBER = /^DTS\d{3,16}$/u
const ANALYSIS_STATUSES: readonly WetrackAnalysisStatus[] = ['analyzing', 'analyzed', 'fixed', 'blocked']
const BLOCKED_REASONS = ['budget-exhausted', 'access', 'missing-code', 'contract', 'other'] as const
const MAX_SAVED_ATTEMPTS = 5
const MAX_ATTEMPT_HISTORY_BYTES = 1_000_000

function recentAttempts(items: WetrackAnalysisAttempt[]): WetrackAnalysisAttempt[] {
  const kept: WetrackAnalysisAttempt[] = []
  let bytes = 0
  for (const item of items.slice(-MAX_SAVED_ATTEMPTS).reverse()) {
    const size = Buffer.byteLength(JSON.stringify(item), 'utf8')
    if (kept.length > 0 && bytes + size > MAX_ATTEMPT_HISTORY_BYTES) break
    kept.unshift(item)
    bytes += size
  }
  return kept
}

// All stores in this process share a per-defect queue. Atomic rename alone does not make
// the read/version-check/write sequence atomic when two conversations finish together.
const writes = new Map<string, Promise<void>>()
async function serialize<T>(key: string, action: () => Promise<T>): Promise<T> {
  const previous = writes.get(key) ?? Promise.resolve()
  let release!: () => void
  const next = new Promise<void>(resolve => { release = resolve })
  writes.set(key, next)
  await previous
  try { return await action() } finally {
    release()
    if (writes.get(key) === next) writes.delete(key)
  }
}

/** One answer body, not a transcript: bounded so a runaway reply cannot fill the data directory. */
export const MAX_ANALYSIS_MARKDOWN = 200_000
export const MAX_ANALYSIS_TITLE = 200
export const MAX_ANALYSIS_SUMMARY = 1_000

export function isDefectNumber(value: string): boolean {
  return DEFECT_NUMBER.test(value)
}

export function analysisDir(dataDir: string): string {
  return join(dataDir, 'wetrack', 'analyses')
}

/** `DTS` + digits is the only accepted key, so a record path cannot escape the analyses directory. */
export function analysisPath(dataDir: string, defectNumber: string): string {
  if (!isDefectNumber(defectNumber)) throw new Error(`缺陷编号不合法：${defectNumber}`)
  return join(analysisDir(dataDir), `${defectNumber}.json`)
}

function bounded(value: string | undefined, max: number): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed === '' ? undefined : trimmed.slice(0, max)
}

function statusOf(value: unknown): WetrackAnalysisStatus {
  return typeof value === 'string' && (ANALYSIS_STATUSES as readonly string[]).includes(value)
    ? value as WetrackAnalysisStatus
    : 'analyzed'
}

function attemptOf(value: unknown): WetrackAnalysisAttempt | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const item = value as Record<string, unknown>
  if (typeof item.markdown !== 'string' || item.markdown.trim() === '') return undefined
  return {
    status: statusOf(item.status),
    title: typeof item.title === 'string' ? item.title.slice(0, MAX_ANALYSIS_TITLE) : '',
    summary: typeof item.summary === 'string' ? item.summary.slice(0, MAX_ANALYSIS_SUMMARY) : '',
    markdown: item.markdown,
    updatedAt: typeof item.updatedAt === 'string' ? item.updatedAt : '',
    ...(typeof item.conversationId === 'string' && item.conversationId !== '' ? { conversationId: item.conversationId } : {}),
    ...(typeof item.blockedReason === 'string' && (BLOCKED_REASONS as readonly string[]).includes(item.blockedReason)
      ? { blockedReason: item.blockedReason as NonNullable<WetrackAnalysisInput['blockedReason']> } : {}),
    ...(Number.isSafeInteger(item.baseRevision) && Number(item.baseRevision) >= 0 ? { baseRevision: Number(item.baseRevision) } : {}),
  }
}

/** One record as the browser reads it; unknown fields from an older write are dropped. */
function normalizeRecord(value: unknown): WetrackAnalysisRecord | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  const defectNumber = typeof record.defectNumber === 'string' ? record.defectNumber.trim() : ''
  const markdown = typeof record.markdown === 'string' ? record.markdown : ''
  if (!isDefectNumber(defectNumber) || markdown.trim() === '') return undefined
  return {
    defectNumber,
    status: statusOf(record.status),
    title: typeof record.title === 'string' ? record.title.slice(0, MAX_ANALYSIS_TITLE) : '',
    summary: typeof record.summary === 'string' ? record.summary.slice(0, MAX_ANALYSIS_SUMMARY) : '',
    markdown,
    updatedAt: typeof record.updatedAt === 'string' ? record.updatedAt : '',
    ...(typeof record.conversationId === 'string' && record.conversationId !== ''
      ? { conversationId: record.conversationId }
      : {}),
    ...(Number.isSafeInteger(record.revision) && Number(record.revision) >= 0 ? { revision: Number(record.revision) } : {}),
    ...(attemptOf(record.latestAttempt) === undefined ? {} : { latestAttempt: attemptOf(record.latestAttempt) }),
    ...(Array.isArray(record.attempts) ? { attempts: record.attempts.flatMap((item: unknown) => {
      const attempt = attemptOf(item)
      return attempt === undefined ? [] : [attempt]
    }) } : {}),
  }
}

export function summarizeAnalysis(record: WetrackAnalysisRecord): WetrackAnalysisSummary {
  return {
    defectNumber: record.defectNumber,
    status: record.status,
    title: record.title,
    summary: record.summary,
    updatedAt: record.updatedAt,
  }
}

function nowText(): string {
  const date = new Date()
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

/**
 * Save an attempt with optional optimistic concurrency. A blocked attempt does not replace a
 * previously established conclusion; the latest attempt remains visible alongside it.
 */
export async function writeWetrackAnalysis(
  dataDir: string,
  input: WetrackAnalysisInput,
  options: { conversationId?: string; expectedRevision?: number } = {},
): Promise<WetrackAnalysisRecord> {
  const defectNumber = input.defectNumber.trim()
  const markdown = typeof input.markdown === 'string' ? input.markdown : ''
  if (!isDefectNumber(defectNumber)) throw new Error('defectNumber 必须是 DTS + 数字')
  // The page renders this body verbatim, so it is stored exactly as written; only the emptiness
  // and size checks look at a trimmed copy.
  if (markdown.trim() === '') throw new Error('markdown 不能为空：分析正文就是页面展示的内容')
  if (markdown.length > MAX_ANALYSIS_MARKDOWN) throw new Error(`markdown 超过 ${MAX_ANALYSIS_MARKDOWN} 字符`)

  return serialize(analysisPath(dataDir, defectNumber), async () => {
    const previous = await readWetrackAnalysisStrict(dataDir, defectNumber)
    const revision = previous?.revision ?? 0
    const attempt: WetrackAnalysisAttempt = {
      status: statusOf(input.status),
      title: bounded(input.title, MAX_ANALYSIS_TITLE) ?? `${defectNumber} 分析`,
      summary: bounded(input.summary, MAX_ANALYSIS_SUMMARY) ?? '',
      markdown,
      updatedAt: nowText(),
      ...(options.conversationId === undefined ? {} : { conversationId: options.conversationId }),
      ...(input.blockedReason === undefined ? {} : { blockedReason: input.blockedReason }),
      ...(options.expectedRevision === undefined ? {} : { baseRevision: options.expectedRevision }),
    }
    if (options.expectedRevision !== undefined && options.expectedRevision !== revision) {
      const retained = previous?.attempts ?? (previous?.latestAttempt === undefined ? [] : [previous.latestAttempt])
      if (retained.some(item => item.baseRevision === options.expectedRevision && item.conversationId === attempt.conversationId
        && item.status === attempt.status && item.markdown === attempt.markdown && item.title === attempt.title
        && item.summary === attempt.summary && item.blockedReason === attempt.blockedReason)) return previous!
      throw new Error(`分析记录已更新（期望版本 ${options.expectedRevision}，当前版本 ${revision}）；请重新读取后再判断。`)
    }
    const preserveConclusion = (attempt.status === 'blocked' || attempt.status === 'analyzing') && (previous?.status === 'analyzed' || previous?.status === 'fixed')
    const record: WetrackAnalysisRecord = {
      ...(preserveConclusion ? previous : attempt),
      defectNumber,
      revision: revision + 1,
      latestAttempt: attempt,
      attempts: recentAttempts([...(previous?.attempts ?? []), attempt]),
    }

    const target = analysisPath(dataDir, defectNumber)
    const dir = dirname(target)
    await mkdir(dir, { recursive: true, mode: 0o700 })
    // Temp file + rename: a reader never sees a half-written record.
    const temp = join(dir, `.tmp-${process.pid}-${crypto.randomUUID()}`)
    try {
      await writeFile(temp, JSON.stringify(record, null, 2), { encoding: 'utf8', mode: 0o600, flag: 'wx' })
      await rename(temp, target)
    } catch (error) {
      await rm(temp, { force: true }).catch(() => undefined)
      throw error
    }
    return record
  })
}

/** A corrupt existing record is not a fresh revision zero and must never be overwritten. */
export async function readWetrackAnalysisStrict(dataDir: string, defectNumber: string): Promise<WetrackAnalysisRecord | undefined> {
  let raw: string
  try {
    raw = await readFile(analysisPath(dataDir, defectNumber), 'utf8')
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') return undefined
    throw error
  }
  try {
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('invalid record')
    const version = (parsed as Record<string, unknown>).revision
    if (version !== undefined && (!Number.isSafeInteger(version) || Number(version) < 0)) throw new Error('invalid revision')
    const record = normalizeRecord(parsed)
    if (record !== undefined && record.defectNumber === defectNumber) return record
  } catch {
    // Report malformed JSON below; it is not permission to replace the stored file.
  }
  throw new Error(`${defectNumber} 的既有分析记录损坏，已拒绝覆盖；请先检查记录文件。`)
}

/** One stored analysis, or undefined when this defect was never analyzed. */
export async function readWetrackAnalysis(dataDir: string, defectNumber: string): Promise<WetrackAnalysisRecord | undefined> {
  const value = defectNumber.trim()
  if (!isDefectNumber(value)) return undefined
  try {
    return normalizeRecord(JSON.parse(await readFile(analysisPath(dataDir, value), 'utf8')))
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') return undefined
    // A corrupt record must not break the whole page; the defect simply reads as unanalyzed.
    return undefined
  }
}

/** Summaries for the list badges. Unreadable or foreign files are skipped rather than thrown. */
export async function listWetrackAnalyses(dataDir: string): Promise<WetrackAnalysisSummary[]> {
  let names: string[]
  try {
    names = await readdir(analysisDir(dataDir))
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') return []
    throw error
  }
  const summaries: WetrackAnalysisSummary[] = []
  for (const name of names) {
    if (!name.endsWith('.json')) continue
    const defectNumber = name.slice(0, -'.json'.length)
    const record = await readWetrackAnalysis(dataDir, defectNumber)
    if (record !== undefined) summaries.push(summarizeAnalysis(record))
  }
  return summaries.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
}

/** Drop one record; the page falls back to "尚未分析" immediately after. */
export async function deleteWetrackAnalysis(dataDir: string, defectNumber: string): Promise<boolean> {
  const value = defectNumber.trim()
  if (!isDefectNumber(value)) return false
  const target = analysisPath(dataDir, value)
  try {
    await chmod(target, 0o600).catch(() => undefined)
    await rm(target, { force: true })
    return true
  } catch {
    return false
  }
}
