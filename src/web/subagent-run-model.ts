import type { SubagentSummary } from '../shared/types.ts'
import type { ProcessPart, ToolItem } from './render-model.ts'
import type { Translate } from './render-labels.ts'
import { buildToolRenderModel, subagentRowModel } from './tool-render-model.ts'

/** Palette size shared with `SubagentRunStrip.module.css`; colors repeat past six children. */
export const SUBAGENT_COLOR_COUNT = 6

export type SubagentRunStatus = 'creating' | 'running' | 'done' | 'failed'

/** One delegated call inside a strip: the identity the call recorded plus its outcome. */
export interface SubagentCallItem {
  readonly key: string
  /** Absent while the child conversation has not been matched yet (the call is still starting). */
  readonly childId?: string
  readonly label?: string
  readonly task?: string
  /** The tool result is an error. */
  readonly failed: boolean
  /** The call is still in flight, so the chip reads as creating/running before its child row arrives. */
  readonly pending: boolean
}

/** The consecutive `subagent` calls of one turn, rendered as one single-line strip. */
export interface SubagentRunGroup {
  readonly kind: 'subagentRun'
  readonly key: string
  readonly order: number
  readonly items: readonly SubagentCallItem[]
}

/** A transcript part with the subagent runs folded into strips. */
export type TranscriptPart = ProcessPart | SubagentRunGroup

/**
 * Fold consecutive `subagent` calls into one group. A call without a child conversation yet
 * still joins: DSH's live projection records the call before `api.details` names the child,
 * and the user asked to see "creating" from the first frame rather than a generic tool row.
 *
 * A `codemode` call that delegated through `tools.subagent(...)` contributes its nested calls
 * as a group in front of the script card; the card then hides those nested rows.
 */
export function groupSubagentRuns(
  parts: readonly ProcessPart[],
  t: Translate,
  runRunning: boolean,
  summaries?: readonly SubagentSummary[],
): readonly TranscriptPart[] {
  const grouped: TranscriptPart[] = []
  let current: { kind: 'subagentRun'; key: string; order: number; items: SubagentCallItem[] } | undefined
  for (const part of parts) {
    if (part.kind === 'tool') {
      const name = toolNameOf(part.item)
      if (name === 'subagent') {
        const call = subagentCallOf(part.item, t, runRunning, summaries)
        if (call !== undefined) {
          if (current === undefined) {
            current = { kind: 'subagentRun', key: `subagent-run:${part.key}`, order: part.order, items: [] }
            grouped.push(current)
          }
          current.items.push(call)
          continue
        }
      }
      if (name === 'codemode') {
        const nested = nestedSubagentCalls(part.item, t, runRunning, summaries)
        if (nested.length > 0) {
          current = undefined
          grouped.push({
            kind: 'subagentRun',
            key: `subagent-run:${part.key}:codemode`,
            order: part.order - 0.0005,
            items: nested,
          })
          grouped.push(part)
          continue
        }
      }
    }
    current = undefined
    grouped.push(part)
  }
  return grouped
}

function toolNameOf(item: ToolItem): string | undefined {
  return (item.call?.name ?? item.result?.toolName)?.toLocaleLowerCase()
}

function subagentCallOf(
  item: ToolItem,
  t: Translate,
  runRunning: boolean,
  summaries: readonly SubagentSummary[] | undefined,
): SubagentCallItem | undefined {
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
 * The `subagent` calls a code-mode script made. Live nested tool messages are preferred because
 * they carry the running state; once the script settles, the result's `details.calls` list is
 * the only record left. The nested payload has no child conversation id, so the child row is
 * matched by the label the script passed (the same label the server stored on the child).
 */
function nestedSubagentCalls(
  item: ToolItem,
  t: Translate,
  runRunning: boolean,
  summaries: readonly SubagentSummary[] | undefined,
): readonly SubagentCallItem[] {
  const live = item.children.flatMap(child => {
    if ((child.result?.toolName ?? child.message.toolName)?.toLocaleLowerCase() !== 'subagent') return []
    const details = recordOf(child.result?.details)
    const args = recordOf(details?.arguments) ?? {}
    const summary = recordOf(details?.summary)
    const label = labelFromArgs(args)
    const task = taskFromArgs(args)
    const childId = matchChildId(label, summaries)
    return [{
      key: `nested:${item.key}:${child.result?.toolCallId ?? child.key}`,
      ...(childId === undefined ? {} : { childId }),
      ...(label === undefined ? {} : { label }),
      ...(task === undefined ? {} : { task }),
      failed: child.result?.isError === true || summary?.isError === true,
      pending: child.result?.status === 'running' || child.result?.streaming === true,
    }]
  })
  if (live.length > 0) return live

  const model = buildToolRenderModel(item, t, runRunning)
  const details = recordOf(model.details)
  const values = Array.isArray(details?.calls) ? details.calls
    : Array.isArray(recordOf(details?.result)?.calls) ? recordOf(details?.result)?.calls as unknown[] : []
  return values.flatMap((value, index) => {
    const call = recordOf(value)
    if (call === undefined || typeof call.name !== 'string' || call.name.toLocaleLowerCase() !== 'subagent') return []
    // The projection truncates long nested arguments, so the JSON may not parse; read the
    // label/task fields out of the raw prefix instead.
    const args = parseArgs(call.args)
    const label = labelFromArgs(Object.keys(args).length > 0 ? args : rawArgs(call.args))
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

function recordOf(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

function parseArgs(value: unknown): Record<string, unknown> {
  if (typeof value !== 'string') return recordOf(value) ?? {}
  try { return recordOf(JSON.parse(value)) ?? {} } catch { return {} }
}

/** Recover `label`/`task` from a truncated JSON argument string without parsing it. */
function rawArgs(value: unknown): Record<string, unknown> {
  if (typeof value !== 'string') return {}
  const label = rawStringField(value, 'label')
  const task = rawStringField(value, 'task')
  return {
    ...(label === undefined ? {} : { label }),
    ...(task === undefined ? {} : { task }),
  }
}

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

function taskFromArgs(args: Readonly<Record<string, unknown>>): string | undefined {
  const task = typeof args.task === 'string' ? args.task.trim() : ''
  return task === '' ? undefined : task
}

/** Mirror the server's label rule: explicit label, else the first task line, capped at 60 characters. */
function labelFromArgs(args: Readonly<Record<string, unknown>>): string | undefined {
  const explicit = typeof args.label === 'string' ? args.label.trim() : ''
  const raw = explicit === '' ? taskFromArgs(args)?.split('\n').find(line => line.trim() !== '')?.trim() ?? '' : explicit
  return raw === '' ? undefined : raw.length > 60 ? `${raw.slice(0, 59)}…` : raw
}

function matchChildId(label: string | undefined, summaries: readonly SubagentSummary[] | undefined): string | undefined {
  if (label === undefined) return undefined
  const exact = summaries?.find(row => row.label === label)
  if (exact !== undefined) return exact.id
  // A truncated/whitespace-normalized label can differ by its tail; accept a unique prefix match.
  return summaries?.find(row => row.label.startsWith(label) || label.startsWith(row.label))?.id
}

/** One chip: the call's identity joined with the child's live row. */
export interface SubagentRunEntry {
  readonly key: string
  readonly childId?: string
  readonly label: string
  readonly task?: string
  readonly status: SubagentRunStatus
  readonly tokens?: number
  readonly durationMs?: number
  /** Server sample time, so a running chip can advance its duration between polls. */
  readonly metricsAt?: number
  /** Index into the strip's six-hue palette. */
  readonly colorIndex: number
}

export interface SubagentRunHeadline {
  readonly tone: SubagentRunStatus
  readonly title: string
  readonly count: string
}

/**
 * Join each grouped call with its child's projected row. The child row owns the live status
 * and metrics; the call owns the failure and the fact that it is still starting, so a strip
 * reads "creating" from the first frame and settles without waiting for the first child list.
 */
export function subagentRunEntries(
  group: SubagentRunGroup,
  summaries: readonly SubagentSummary[] | undefined,
  t: Translate,
): readonly SubagentRunEntry[] {
  // A code-mode script's nested calls only carry a label, and old projections or renamed
  // labels can leave a completed call unmatched. Assign the remaining children by order so
  // a finished chip stays clickable instead of silently disabling its child session.
  const taken = new Set(group.items.flatMap(item => item.childId === undefined ? [] : [item.childId]))
  const unmatched = group.items.filter(item => item.childId === undefined && !item.pending).length
  // A finished delegation is almost always the newest set of children in the list; take the tail.
  const spare = unmatched === 0
    ? []
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

/**
 * A child keeps its hue across every strip it appears in: the parent's child list fixes the
 * order, and a call that has not resolved its child yet falls back to a hash of its identity.
 */
export function subagentColorIndex(childId: string, summaries: readonly SubagentSummary[] | undefined): number {
  const index = summaries?.findIndex(row => row.id === childId) ?? -1
  if (index >= 0) return index % SUBAGENT_COLOR_COUNT
  let hash = 0
  for (let at = 0; at < childId.length; at += 1) hash = (hash * 31 + childId.charCodeAt(at)) >>> 0
  return hash % SUBAGENT_COLOR_COUNT
}

/** The strip's leading line: what the group is doing now, and how much of it has settled. */
export function subagentRunHeadline(entries: readonly SubagentRunEntry[], t: Translate): SubagentRunHeadline {
  const total = entries.length
  const creating = entries.filter(entry => entry.status === 'creating').length
  const running = entries.filter(entry => entry.status === 'running').length
  const failed = entries.filter(entry => entry.status === 'failed').length
  const done = total - creating - running - failed
  if (creating > 0 && running === 0) {
    return {
      tone: 'creating',
      title: t('正在创建子智能体', 'Creating subagents'),
      count: t(`${done + failed}/${total} 结束`, `${done + failed}/${total} settled`),
    }
  }
  if (running > 0) {
    return {
      tone: 'running',
      title: t('子智能体运行中', 'Subagents running'),
      count: t(`${done + failed}/${total} 结束`, `${done + failed}/${total} settled`),
    }
  }
  if (failed > 0) {
    return {
      tone: 'failed',
      title: t(`${done} 个已完成 · ${failed} 个失败`, `${done} finished · ${failed} failed`),
      count: '',
    }
  }
  return {
    tone: 'done',
    title: t(`${total} 个子智能体已完成`, `${total} subagents finished`),
    count: '',
  }
}

/** A running chip's duration: the sampled total advanced by the clock, as the header panel does. */
export function subagentEntryDurationMs(entry: SubagentRunEntry, now: number): number | undefined {
  if (entry.durationMs === undefined) return undefined
  if (entry.status !== 'running' || entry.metricsAt === undefined) return entry.durationMs
  return entry.durationMs + Math.max(0, now - entry.metricsAt)
}

/** Compact chip duration: seconds below a minute, then minutes and seconds. */
export function formatSubagentSeconds(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1_000))
  if (total < 60) return `${total}秒`
  return `${Math.floor(total / 60)}分${String(total % 60).padStart(2, '0')}秒`
}
