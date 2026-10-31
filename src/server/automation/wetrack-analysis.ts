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
  WetrackAnalysisRecord,
  WetrackAnalysisStatus,
  WetrackAnalysisSummary,
} from '../../shared/types.ts'

/** `<DTS>` + digits; the same shape the plugin's tools accept. */
const DEFECT_NUMBER = /^DTS\d{3,16}$/u
const ANALYSIS_STATUSES: readonly WetrackAnalysisStatus[] = ['analyzing', 'analyzed', 'fixed', 'blocked']

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
 * Write one analysis record. The body is replaced wholesale, so a second analysis of the same
 * defect supersedes the first instead of appending to it.
 */
export async function writeWetrackAnalysis(
  dataDir: string,
  input: WetrackAnalysisInput,
  options: { conversationId?: string } = {},
): Promise<WetrackAnalysisRecord> {
  const defectNumber = input.defectNumber.trim()
  const markdown = typeof input.markdown === 'string' ? input.markdown : ''
  if (!isDefectNumber(defectNumber)) throw new Error('defectNumber 必须是 DTS + 数字')
  // The page renders this body verbatim, so it is stored exactly as written; only the emptiness
  // and size checks look at a trimmed copy.
  if (markdown.trim() === '') throw new Error('markdown 不能为空：分析正文就是页面展示的内容')
  if (markdown.length > MAX_ANALYSIS_MARKDOWN) throw new Error(`markdown 超过 ${MAX_ANALYSIS_MARKDOWN} 字符`)

  const record: WetrackAnalysisRecord = {
    defectNumber,
    status: statusOf(input.status),
    title: bounded(input.title, MAX_ANALYSIS_TITLE) ?? `${defectNumber} 分析`,
    summary: bounded(input.summary, MAX_ANALYSIS_SUMMARY) ?? '',
    markdown,
    updatedAt: nowText(),
    ...(options.conversationId === undefined ? {} : { conversationId: options.conversationId }),
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
