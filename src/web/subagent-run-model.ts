import type { SubagentSummary } from '../shared/types.ts'
import type { ProcessPart, ToolItem } from './render-model.ts'
import type { Translate } from './render-labels.ts'
import { buildToolRenderModel, subagentRowModel } from './tool-render-model.ts'

/** 子智能体 chip 的调色板大小；颜色按它在父会话子列表中的序号循环取用。 */
export const SUBAGENT_COLOR_COUNT = 6

/** 单个 chip 的状态：`creating` 表示这次委派还没匹配到子会话。 */
export type SubagentRunStatus = 'creating' | 'running' | 'done' | 'failed'

/** 条带可展示的一次委派，读自顶层 `subagent` 调用或嵌套的 codemode 调用。 */
export interface SubagentCallItem {
  readonly key: string
  readonly childId?: string
  readonly label?: string
  readonly task?: string
  readonly failed: boolean
  readonly pending: boolean
}

/** 折叠后的一组子智能体调用，渲染成一条内联条带而不是一行行工具卡片。 */
export interface SubagentRunGroup {
  readonly kind: 'subagentRun'
  readonly key: string
  readonly order: number
  /** `calls` 折叠连续的顶层 `subagent` 行；`codemode` 提升嵌套调用。 */
  readonly source: 'calls' | 'codemode'
  readonly items: readonly SubagentCallItem[]
}

/** 折叠后的转录正文：普通过程部件 + 子智能体条带。 */
export type TranscriptPart = ProcessPart | SubagentRunGroup

/**
 * 功能：把子智能体工作折叠成内联条带。
 * @param parts 过程部件序列
 * @param t 双语标签函数
 * @param runRunning 父 run 是否仍在运行（影响 chip 状态）
 * @param summaries 父会话的子智能体投影列表
 * @returns 折叠后的 TranscriptPart 序列
 * 内部逻辑：连续顶层 `subagent` 行 ≥ 2 行才成条带，单个调用保留已定的单行 `ToolCard`；`codemode` 调用即使只有一个嵌套调用也折叠——`ToolCard` 本就隐藏那些行，没有条带它们会凭空消失；条带先于脚本卡片输出（order 微调）。
 */
export function groupSubagentRuns(
  parts: readonly ProcessPart[],
  t: Translate,
  runRunning: boolean,
  summaries?: readonly SubagentSummary[],
): readonly TranscriptPart[] {
  const grouped: TranscriptPart[] = []
  let current: {
    kind: 'subagentRun'; key: string; order: number; source: 'calls'
    items: SubagentCallItem[]; original: ProcessPart
  } | undefined
  const flush = (): void => {
    if (current === undefined) return
    // 单个顶层委派保留已定的单行 ToolCard；条带从两行开始。原始部件直接
    // 回填——toolGroup 重排后源数组下标不再可靠。
    if (current.items.length >= 2) {
      grouped.push({
        kind: 'subagentRun', key: current.key, order: current.order,
        source: 'calls', items: current.items,
      })
    } else {
      grouped.push(current.original)
    }
    current = undefined
  }
  for (const part of parts) {
    if (part.kind === 'tool') {
      const name = (part.item.call?.name ?? part.item.result?.toolName)?.toLocaleLowerCase()
      if (name === 'subagent') {
        const call = topLevelSubagentCall(part.item, t, runRunning, summaries)
        if (call !== undefined) {
          if (current === undefined) {
            current = {
              kind: 'subagentRun', key: `subagent-run:${part.key}`, order: part.order,
              source: 'calls', items: [], original: part,
            }
          }
          current.items.push(call)
          continue
        }
      }
      if (name === 'codemode') {
        flush()
        const nested = nestedSubagentCalls(part.item, t, runRunning, summaries)
        if (nested.length > 0) {
          // 条带在前，脚本卡片跟着自己的子智能体走。
          grouped.push({ kind: 'subagentRun', key: `subagent-run:${part.key}:codemode`, order: part.order - 0.0005, source: 'codemode', items: nested })
          grouped.push(part)
          continue
        }
      }
    }
    flush()
    grouped.push(part)
  }
  flush()
  return grouped
}

/** 条带上的一个 chip：标签、解析后的状态、指标，及其稳定的调色板槽位。 */
export interface SubagentRunEntry {
  readonly key: string
  readonly childId?: string
  readonly label: string
  readonly task?: string
  readonly status: SubagentRunStatus
  readonly tokens?: number
  readonly durationMs?: number
  readonly metricsAt?: number
  readonly colorIndex: number
}

/**
 * 功能：把条带里的调用与父会话的 `SubagentSummary` 投影拼成 chip 条目。
 * @param group 子智能体条带
 * @param summaries 父会话的子智能体列表（可 undefined）
 * @param t 双语标签函数
 * @returns 带状态/指标/颜色的 chip 条目
 * 内部逻辑：已落定但标签不再匹配任何子会话的调用，回退取「最新且未被占用」的 summaries（已完成委派通常是父会话最新的孩子），按尾部顺序分配；仍在 creating 的调用绝不认领子会话，chip 不可能打开错误的会话。
 */
export function subagentRunEntries(
  group: SubagentRunGroup,
  summaries: readonly SubagentSummary[] | undefined,
  t: Translate,
): SubagentRunEntry[] {
  const taken = new Set(group.items.flatMap(item => item.childId === undefined ? [] : [item.childId]))
  const unmatched = group.items.filter(item => item.childId === undefined && !item.pending).length
  // 已完成的委派通常是最新的孩子；按尾部顺序取用。
  const spare = unmatched === 0 ? []
    : (summaries ?? []).filter(row => !taken.has(row.id)).slice(-unmatched)
  return group.items.map(item => {
    const childId = item.childId ?? (item.pending ? undefined : spare.shift()?.id)
    const row = childId === undefined ? undefined : summaries?.find(candidate => candidate.id === childId)
    const status: SubagentRunStatus = item.failed ? 'failed'
      : childId === undefined && item.pending ? 'creating'
        : item.pending || row?.status === 'running' ? 'running'
          : 'done'
    return {
      key: item.key,
      ...(childId === undefined ? {} : { childId }),
      label: row?.label || item.label || t('子智能体', 'Subagent'),
      ...(item.task === undefined ? {} : { task: item.task }),
      status,
      ...(row?.tokens === undefined ? {} : { tokens: row.tokens }),
      ...(row?.durationMs === undefined ? {} : { durationMs: row.durationMs }),
      ...(row?.metricsAt === undefined ? {} : { metricsAt: row.metricsAt }),
      colorIndex: subagentColorIndex(childId ?? item.label ?? item.key, summaries),
    }
  })
}

/** 条带的基调与标题：谁还在工作、多少已落定。 */
export interface SubagentRunHeadline {
  readonly tone: SubagentRunStatus
  readonly title: string
  readonly count: string
}

/**
 * 功能：推导条带头部文案：有创建中显示「正在创建」，有运行中显示「运行中」，否则按失败/完成汇总。
 * @param entries chip 条目
 * @param t 双语标签函数
 * @returns tone + 双语标题 + 结束计数
 */
export function subagentRunHeadline(entries: readonly SubagentRunEntry[], t: Translate): SubagentRunHeadline {
  const total = entries.length
  const creating = entries.filter(entry => entry.status === 'creating').length
  const running = entries.filter(entry => entry.status === 'running').length
  const failed = entries.filter(entry => entry.status === 'failed').length
  const done = total - creating - running - failed
  if (creating > 0 && running === 0) return { tone: 'creating', title: t('正在创建子智能体', 'Creating subagents'), count: t(`${done + failed}/${total} 结束`, `${done + failed}/${total} settled`) }
  if (running > 0) return { tone: 'running', title: t('子智能体运行中', 'Subagents running'), count: t(`${done + failed}/${total} 结束`, `${done + failed}/${total} settled`) }
  if (failed > 0) return { tone: 'failed', title: t(`${done} 个已完成 · ${failed} 个失败`, `${done} finished · ${failed} failed`), count: '' }
  return { tone: 'done', title: t(`${total} 个子智能体已完成`, `${total} subagents finished`), count: '' }
}

/**
 * 功能：计算一个子智能体的耗时：运行中的取采样值 `durationMs` 加上 `metricsAt` 之后的墙钟推进
 * （对齐 `StatusPanel` 的 tick），已落定的直接用采样总值。
 * @param entry chip 条目
 * @param now 当前时刻
 * @returns 耗时毫秒；无采样值返回 undefined
 */
export function subagentEntryDurationMs(entry: SubagentRunEntry, now: number): number | undefined {
  if (entry.durationMs === undefined) return undefined
  if (entry.status !== 'running' || entry.metricsAt === undefined) return entry.durationMs
  return entry.durationMs + Math.max(0, now - entry.metricsAt)
}

/**
 * 功能：紧凑的耗时文案（应用统一措辞）：42秒、3分05秒。
 * @param ms 耗时毫秒
 */
export function formatSubagentSeconds(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1_000))
  return total < 60 ? `${total}秒` : `${Math.floor(total / 60)}分${String(total % 60).padStart(2, '0')}秒`
}

/**
 * 功能：取一个孩子的调色板槽位：在父会话子列表中的序号对六取模，跨回合稳定；
 * 尚未匹配到孩子的委派对其 id（回退 label/key）做哈希，落到同样六个槽位。
 */
export function subagentColorIndex(id: string, summaries?: readonly SubagentSummary[]): number {
  const index = summaries?.findIndex(row => row.id === id) ?? -1
  if (index >= 0) return index % SUBAGENT_COLOR_COUNT
  let hash = 0
  for (let at = 0; at < id.length; at += 1) hash = (hash * 31 + id.charCodeAt(at)) >>> 0
  return hash % SUBAGENT_COLOR_COUNT
}

/* ---------- Call extraction ---------- */

/**
 * 功能：把一个顶层 `subagent` 调用读成条带条目（复用工具行模型）。
 * @returns 条目；label/task/childId 尽量从工具行模型或参数推断
 */
function topLevelSubagentCall(
  item: ToolItem,
  t: Translate,
  runRunning: boolean,
  summaries?: readonly SubagentSummary[],
): SubagentCallItem {
  const model = buildToolRenderModel(item, t, runRunning)
  const row = subagentRowModel({ name: model.name, args: model.args, details: model.details, failed: model.failed }, t)
  const label = row?.label ?? labelFromArgs(model.args)
  const task = row?.task ?? taskFromArgs(model.args)
  const childId = row?.childId ?? matchChildId(label, summaries)
  return {
    key: item.key,
    ...(childId === undefined ? {} : { childId }),
    ...(label === undefined ? {} : { label }),
    ...(task === undefined ? {} : { task }),
    failed: model.failed,
    pending: model.running,
  }
}

/**
 * 功能：读取一个 `codemode` 脚本发起的 `subagent` 调用。脚本运行中时它们是其下层的
 * 实时嵌套工具消息；落定后只剩 `details.calls`，其 `args` 是被截断的 JSON 字符串，
 * 由下方的字段前缀读取器兜底解码。
 */
function nestedSubagentCalls(
  item: ToolItem,
  t: Translate,
  runRunning: boolean,
  summaries?: readonly SubagentSummary[],
): SubagentCallItem[] {
  const live = item.children.flatMap(child => {
    if ((child.result?.toolName ?? child.message.toolName)?.toLocaleLowerCase() !== 'subagent') return []
    const details = recordOf(child.result?.details)
    const args = recordOf(details?.arguments) ?? {}
    const label = labelFromArgs(args)
    const task = taskFromArgs(args)
    const childId = matchChildId(label, summaries)
    return [{
      key: `nested:${item.key}:${child.result?.toolCallId ?? child.key}`,
      ...(childId === undefined ? {} : { childId }),
      ...(label === undefined ? {} : { label }),
      ...(task === undefined ? {} : { task }),
      failed: child.result?.isError === true || recordOf(details?.summary)?.isError === true,
      pending: child.result?.status === 'running' || child.result?.streaming === true,
    }]
  })
  if (live.length > 0) return live

  const model = buildToolRenderModel(item, t, runRunning)
  const details = recordOf(model.details)
  const nested = details?.calls
  const nestedResult = recordOf(details?.result)?.calls
  const values = Array.isArray(nested) ? nested : Array.isArray(nestedResult) ? nestedResult : []
  return values.flatMap((value, index) => {
    const call = recordOf(value)
    if (call === undefined || typeof call.name !== 'string' || call.name.toLocaleLowerCase() !== 'subagent') return []
    const args = parseArgsOrPrefix(call.args)
    const label = labelFromArgs(args)
    const task = taskFromArgs(args)
    const childId = matchChildId(label, summaries)
    const status = typeof call.status === 'string' ? call.status.toLocaleLowerCase() : ''
    return [{
      key: `nested:${item.key}:${String(call.id ?? index)}`,
      ...(childId === undefined ? {} : { childId }),
      ...(label === undefined ? {} : { label }),
      ...(task === undefined ? {} : { task }),
      failed: status === 'error',
      pending: status === 'running' || status === 'pending',
    }]
  })
}

/**
 * 功能：解析嵌套调用的参数。落定投影把参数序列化成 JSON 但按字符预算截断（以 `…` 结尾），
 * `JSON.parse` 失败时回退到从原始前缀直接读 `label` 与 `task` 字段。
 */
function parseArgsOrPrefix(value: unknown): Record<string, unknown> {
  if (typeof value !== 'string') return recordOf(value) ?? {}
  try { return recordOf(JSON.parse(value)) ?? {} } catch { /* 投影截断了 JSON；读取前缀。 */ }
  const label = rawStringField(value, 'label')
  const task = rawStringField(value, 'task')
  return {
    ...(label === undefined ? {} : { label }),
    ...(task === undefined ? {} : { task }),
  }
}

/**
 * 功能：从截断的 JSON 前缀中读一个字符串字段，正确处理转义。
 * @returns 字段值；字段不存在或为空返回 undefined
 */
function rawStringField(raw: string, key: 'label' | 'task'): string | undefined {
  const marker = `"${key}"`
  const at = raw.indexOf(marker)
  if (at < 0) return undefined
  let index = at + marker.length
  while (raw[index] === ' ' || raw[index] === ':') index += 1
  if (raw[index] !== '"') return undefined
  index += 1
  let value = ''
  while (index < raw.length) {
    const char = raw[index]
    if (char === '\\') {
      const next = raw[index + 1]
      if (next === undefined) break
      value += next === 'n' ? '\n' : next === 't' ? '\t' : next === 'r' ? '\r' : next
      index += 2
      continue
    }
    if (char === '"') return value
    value += char
    index += 1
  }
  return value === '' ? undefined : value
}

/* ---------- Field readers ---------- */

function recordOf(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined
}

function taskFromArgs(args: Readonly<Record<string, unknown>>): string | undefined {
  const task = typeof args.task === 'string' ? args.task.trim() : ''
  return task === '' ? undefined : task
}

/** 与服务端 `normalizeLabel` 一致：显式 label 优先，否则取 task 首个非空行，60 字符封顶。 */
function labelFromArgs(args: Readonly<Record<string, unknown>>): string | undefined {
  const explicit = typeof args.label === 'string' ? args.label.trim() : ''
  const raw = explicit === '' ? taskFromArgs(args)?.split('\n').find(line => line.trim() !== '')?.trim() ?? '' : explicit
  return raw === '' ? undefined : raw.length > 60 ? `${raw.slice(0, 59)}…` : raw
}

/**
 * 功能：把委派标签匹配到子会话：先精确匹配，再双向前缀匹配——被截到 60 字符或
 * 归一化方式不同的标签也能找到自己的孩子。重复标签取第一个匹配。
 */
function matchChildId(label: string | undefined, summaries?: readonly SubagentSummary[]): string | undefined {
  if (label === undefined) return undefined
  const exact = summaries?.find(row => row.label === label)
  if (exact !== undefined) return exact.id
  return summaries?.find(row => row.label.startsWith(label) || label.startsWith(row.label))?.id
}
