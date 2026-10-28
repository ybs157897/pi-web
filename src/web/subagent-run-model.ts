import type { SubagentSummary } from '../shared/types.ts'
import type { ProcessPart, ToolItem } from './render-model.ts'
import type { Translate } from './render-labels.ts'
import { buildToolRenderModel, subagentRowModel } from './tool-render-model.ts'

/** Chip palette size; colors cycle by the child's position in the parent's subagent list. */
export const SUBAGENT_COLOR_COUNT = 6

/** One chip's state: `creating` means the delegation has not matched a child conversation yet. */
export type SubagentRunStatus = 'creating' | 'running' | 'done' | 'failed'

/** One delegation the strip can show, read from a `subagent` call or a nested codemode call. */
export interface SubagentCallItem {
  readonly key: string
  readonly childId?: string
  readonly label?: string
  readonly task?: string
  readonly failed: boolean
  readonly pending: boolean
}

/** A folded run of subagent calls rendered as one inline strip instead of tool rows. */
export interface SubagentRunGroup {
  readonly kind: 'subagentRun'
  readonly key: string
  readonly order: number
  /** `calls` folds consecutive top-level `subagent` rows; `codemode` lifts nested calls. */
  readonly source: 'calls' | 'codemode'
  readonly items: readonly SubagentCallItem[]
}

/** The transcript body after folding: ordinary process parts plus subagent strips. */
export type TranscriptPart = ProcessPart | SubagentRunGroup

/**
 * Fold subagent work into inline strips. Consecutive top-level `subagent` rows fold only
 * when there are two or more — a single call keeps the accepted single-row `ToolCard`. A
 * `codemode` call folds even one nested call, because `ToolCard` already hides those rows
 * and without a strip they would vanish entirely.
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
    // A single top-level delegation keeps the accepted single-row ToolCard; the strip
    // starts at two. The original part is flushed back directly — indices into the
    // source array are unreliable once toolGroup reorders parts.
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
          // The strip leads, so the script card follows its own subagents.
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

/** One strip chip: label, resolved state, metrics, and its stable palette slot. */
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
 * Join a strip's calls with the parent's `SubagentSummary` projection. A settled call
 * whose label no longer matches any child falls back to the newest unmatched summaries —
 * finished delegations are the latest children the parent created — while a call still
 * being created never claims a child, so a chip can never open the wrong conversation.
 */
export function subagentRunEntries(
  group: SubagentRunGroup,
  summaries: readonly SubagentSummary[] | undefined,
  t: Translate,
): SubagentRunEntry[] {
  const taken = new Set(group.items.flatMap(item => item.childId === undefined ? [] : [item.childId]))
  const unmatched = group.items.filter(item => item.childId === undefined && !item.pending).length
  // Finished delegations are usually the newest children; take them in tail order.
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

/** Tone and caption of a strip: who is still working and how much has settled. */
export interface SubagentRunHeadline {
  readonly tone: SubagentRunStatus
  readonly title: string
  readonly count: string
}

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
 * A running child's elapsed time: the sampled `durationMs` advanced by the time since
 * `metricsAt`, mirroring `StatusPanel`'s tick. A settled child keeps its sampled total.
 */
export function subagentEntryDurationMs(entry: SubagentRunEntry, now: number): number | undefined {
  if (entry.durationMs === undefined) return undefined
  if (entry.status !== 'running' || entry.metricsAt === undefined) return entry.durationMs
  return entry.durationMs + Math.max(0, now - entry.metricsAt)
}

/** Compact elapsed time in the app's wording: 42秒, 3分05秒. */
export function formatSubagentSeconds(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1_000))
  return total < 60 ? `${total}秒` : `${Math.floor(total / 60)}分${String(total % 60).padStart(2, '0')}秒`
}

/**
 * The palette slot for one child: its index in the parent's subagent list modulo six is
 * stable across turns; a delegation that has not matched a child yet hashes its id
 * (falling back to the label or key) into the same six slots.
 */
export function subagentColorIndex(id: string, summaries?: readonly SubagentSummary[]): number {
  const index = summaries?.findIndex(row => row.id === id) ?? -1
  if (index >= 0) return index % SUBAGENT_COLOR_COUNT
  let hash = 0
  for (let at = 0; at < id.length; at += 1) hash = (hash * 31 + id.charCodeAt(at)) >>> 0
  return hash % SUBAGENT_COLOR_COUNT
}

/* ---------- Call extraction ---------- */

/** Read one top-level `subagent` call into a strip item, reusing the tool row model. */
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
 * Read the `subagent` calls a `codemode` script made. While the script runs they are the
 * live nested tool messages under it; once it settles only `details.calls` remains, whose
 * `args` are a truncated JSON string the field-prefix reader below can still decode.
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
 * Parse a nested call's arguments. Settled projections serialize them to JSON but cut the
 * string to a character budget (ending in `…`), so a failed `JSON.parse` falls back to
 * reading the `label` and `task` fields straight out of the raw prefix.
 */
function parseArgsOrPrefix(value: unknown): Record<string, unknown> {
  if (typeof value !== 'string') return recordOf(value) ?? {}
  try { return recordOf(JSON.parse(value)) ?? {} } catch { /* The projection truncated the JSON; read the prefix. */ }
  const label = rawStringField(value, 'label')
  const task = rawStringField(value, 'task')
  return {
    ...(label === undefined ? {} : { label }),
    ...(task === undefined ? {} : { task }),
  }
}

/** Read one string field out of a truncated JSON prefix, honoring escapes. */
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

/** Matches the server's `normalizeLabel`: the explicit label, else the task's first line, capped at 60 characters. */
function labelFromArgs(args: Readonly<Record<string, unknown>>): string | undefined {
  const explicit = typeof args.label === 'string' ? args.label.trim() : ''
  const raw = explicit === '' ? taskFromArgs(args)?.split('\n').find(line => line.trim() !== '')?.trim() ?? '' : explicit
  return raw === '' ? undefined : raw.length > 60 ? `${raw.slice(0, 59)}…` : raw
}

/**
 * Match a delegation label to a child conversation: exact first, then a prefix match in
 * either direction — a label truncated at 60 characters or normalized differently still
 * finds its child. Repeated labels take the first match.
 */
function matchChildId(label: string | undefined, summaries?: readonly SubagentSummary[]): string | undefined {
  if (label === undefined) return undefined
  const exact = summaries?.find(row => row.label === label)
  if (exact !== undefined) return exact.id
  return summaries?.find(row => row.label.startsWith(label) || label.startsWith(row.label))?.id
}
