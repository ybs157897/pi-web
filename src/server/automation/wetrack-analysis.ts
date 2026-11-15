/**
 * 单个 WeTrack 缺陷的 AI 分析持久化。
 *
 * 问题清单页面按模型原样渲染存储的 Markdown，因此记录就是「模型回答正文 + 少量
 * 元数据」，不是结构化报告。记录存在工作区之外（`<dataDir>/wetrack/analyses/<DTS>.json`），
 * 因为写入方是某个会话（手动分析或定时任务），而读取方是一个自身没有会话的页面。
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

/** `<DTS>` + 数字；与插件工具接受的形状一致。 */
const DEFECT_NUMBER = /^DTS\d{3,16}$/u
const ANALYSIS_STATUSES: readonly WetrackAnalysisStatus[] = ['analyzing', 'analyzed', 'fixed', 'blocked']
const BLOCKED_REASONS = ['budget-exhausted', 'access', 'missing-code', 'contract', 'other'] as const
const MAX_SAVED_ATTEMPTS = 5
const MAX_ATTEMPT_HISTORY_BYTES = 1_000_000

/**
 * 功能：截取最近若干次尝试作为历史，同时受条数（MAX_SAVED_ATTEMPTS）与总字节
 * （MAX_ATTEMPT_HISTORY_BYTES）双重上限约束。
 * 内部逻辑：从最新往旧遍历；首条始终保留（哪怕超限），之后累计超字节即截断；
 * 返回顺序为旧→新。
 */
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

// 本进程内所有存储共用一份按缺陷编号的写入队列。仅有原子 rename 不足以让
// 「读→版本校验→写」在两个会话同时结束时保持原子。
const writes = new Map<string, Promise<void>>()
/** 串行执行器：同一 key 的动作依次排队执行，用于保护单缺陷的读改写序列。 */
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

/** 单次回答正文上限（不是会话转录）：限定大小，防止失控的长回复填满数据目录。 */
export const MAX_ANALYSIS_MARKDOWN = 200_000
/** 分析标题的最大长度。 */
export const MAX_ANALYSIS_TITLE = 200
/** 分析摘要的最大长度。 */
export const MAX_ANALYSIS_SUMMARY = 1_000

/** 判断字符串是否为合法缺陷编号（DTS + 3~16 位数字）。 */
export function isDefectNumber(value: string): boolean {
  return DEFECT_NUMBER.test(value)
}

/** 分析记录的存放目录：`<dataDir>/wetrack/analyses`。 */
export function analysisDir(dataDir: string): string {
  return join(dataDir, 'wetrack', 'analyses')
}

/** `DTS` + 数字是唯一接受的键，记录路径因此不可能逃出 analyses 目录。 */
export function analysisPath(dataDir: string, defectNumber: string): string {
  if (!isDefectNumber(defectNumber)) throw new Error(`缺陷编号不合法：${defectNumber}`)
  return join(analysisDir(dataDir), `${defectNumber}.json`)
}

/** 去首尾空白后按上限截断；非字符串或空白串返回 undefined。 */
function bounded(value: string | undefined, max: number): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed === '' ? undefined : trimmed.slice(0, max)
}

/** 归一化状态值：不在已知状态集合内时回退为 'analyzed'。 */
function statusOf(value: unknown): WetrackAnalysisStatus {
  return typeof value === 'string' && (ANALYSIS_STATUSES as readonly string[]).includes(value)
    ? value as WetrackAnalysisStatus
    : 'analyzed'
}

/** 把未知值归一化为一次尝试记录；markdown 缺失或为空则视为无效返回 undefined。 */
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

/** 归一化单条记录供浏览器读取；旧版本写入的未知字段直接丢弃。 */
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

/** 从完整记录裁出列表页徽标所需的摘要字段（编号、状态、标题、摘要、更新时间）。 */
export function summarizeAnalysis(record: WetrackAnalysisRecord): WetrackAnalysisSummary {
  return {
    defectNumber: record.defectNumber,
    status: record.status,
    title: record.title,
    summary: record.summary,
    updatedAt: record.updatedAt,
  }
}

/** 当前本地时间，格式 `YYYY-MM-DD HH:mm:ss`，作为记录的 updatedAt 展示。 */
function nowText(): string {
  const date = new Date()
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

/**
 * 功能：保存一次分析尝试，支持可选的乐观并发校验；blocked 尝试不会替换已有的
 * 确定性结论（analyzed/fixed），最近尝试仍并列可见。
 * @param dataDir 服务端数据目录
 * @param input 本次尝试内容：缺陷编号、状态、标题、摘要、markdown 正文、可选 blockedReason
 * @param options.conversationId 发起该尝试的会话 ID（溯源用）
 * @param options.expectedRevision 乐观锁：期望的既有记录版本号
 * @returns 保存后的完整记录（revision 递增 1）
 * 内部逻辑：同缺陷的写经 serialize 串行；markdown 只做空与非空校验、原样存储
 * （页面按原文渲染）；expectedRevision 与当前不符时，若磁盘上已存在完全相同的
 * 尝试则幂等返回，否则抛版本冲突错误；尝试历史按 recentAttempts 双限截断；
 * 落盘走临时文件 + rename 原子替换，失败清理临时文件。
 */
export async function writeWetrackAnalysis(
  dataDir: string,
  input: WetrackAnalysisInput,
  options: { conversationId?: string; expectedRevision?: number } = {},
): Promise<WetrackAnalysisRecord> {
  const defectNumber = input.defectNumber.trim()
  const markdown = typeof input.markdown === 'string' ? input.markdown : ''
  if (!isDefectNumber(defectNumber)) throw new Error('defectNumber 必须是 DTS + 数字')
  // 页面按原样渲染正文，因此逐字存储；只有空与非空检查使用去空白副本。
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
    // 临时文件 + rename：读者永远不会看到写了一半的记录。
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

/**
 * 功能：严格读取分析记录，供写入前做基线校验。
 * @returns 校验通过的记录；文件不存在（ENOENT）返回 undefined
 * 内部逻辑：文件存在但 JSON 损坏、结构非法或缺陷编号不匹配时抛错——损坏记录
 * 不能当作「版本 0 的新记录」被覆盖。
 */
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
    // 在下方统一报 JSON 损坏错误；它不是替换既有文件的许可。
  }
  throw new Error(`${defectNumber} 的既有分析记录损坏，已拒绝覆盖；请先检查记录文件。`)
}

/** 读取一条已存储的分析；该缺陷从未分析过或记录损坏时返回 undefined（供页面展示）。 */
export async function readWetrackAnalysis(dataDir: string, defectNumber: string): Promise<WetrackAnalysisRecord | undefined> {
  const value = defectNumber.trim()
  if (!isDefectNumber(value)) return undefined
  try {
    return normalizeRecord(JSON.parse(await readFile(analysisPath(dataDir, value), 'utf8')))
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') return undefined
    // 损坏的记录不能拖垮整个页面；该缺陷按未分析展示。
    return undefined
  }
}

/** 列出全部分析摘要（供列表页徽标）。无法读取或非本域的文件被跳过而不是抛错。 */
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

/** 删除一条分析记录；成功返回 true。删除前先收紧权限到 0o600 再 rm，失败返回 false（页面随即回退为「尚未分析」）。 */
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
