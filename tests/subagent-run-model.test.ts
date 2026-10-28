import { describe, expect, it } from 'vitest'
import type { ChatMessage, ContentBlock, SubagentSummary } from '../src/shared/types.ts'
import type { ProcessPart, ToolItem } from '../src/web/render-model.ts'
import {
  formatSubagentSeconds, groupSubagentRuns, subagentColorIndex, subagentEntryDurationMs, subagentRunEntries,
  subagentRunHeadline, type SubagentRunEntry, type SubagentRunGroup, type SubagentRunStatus,
} from '../src/web/subagent-run-model.ts'

/** Chinese-only translator, mirroring the app's own locale switch. */
const t = (chinese: string): string => chinese

function callBlock(id: string, name: string, args: Record<string, unknown> = {}): Extract<ContentBlock, { type: 'toolCall' }> {
  return { type: 'toolCall', id, name, arguments: args }
}

function toolMessage(id: string, fields: Partial<ChatMessage> = {}): ChatMessage {
  return { id, role: 'tool', blocks: [{ type: 'text', text: '' }], timestamp: 0, ...fields }
}

/** One root tool part carrying a settled assistant call block, with optional projection result. */
function toolPart(key: string, name: string, options: {
  args?: Record<string, unknown>
  result?: ChatMessage
  children?: ToolItem[]
  order?: number
} = {}): ProcessPart {
  return {
    kind: 'tool',
    key,
    order: options.order ?? 0,
    item: {
      key,
      message: { id: `${key}:msg`, role: 'assistant', blocks: [callBlock(`${key}:call`, name, options.args ?? {})], timestamp: 0 },
      call: callBlock(`${key}:call`, name, options.args ?? {}),
      ...(options.result === undefined ? {} : { result: options.result }),
      children: options.children ?? [],
      order: options.order ?? 0,
    },
  }
}

/** A settled top-level `subagent` call whose details name its child conversation. */
function settledSubagent(key: string, childId: string, label: string, failed = false): ProcessPart {
  return toolPart(key, 'subagent', {
    args: { label, task: `do ${label}` },
    result: toolMessage(`${key}:result`, {
      toolCallId: `${key}:call`,
      toolName: 'subagent',
      status: failed ? 'error' : 'completed',
      isError: failed,
      details: { conversationId: childId, status: failed ? 'failed' : 'completed', label },
    }),
  })
}

/** A live top-level `subagent` call: the projection nests the payload under `result`. */
function liveSubagent(key: string, childId: string, label: string): ProcessPart {
  return toolPart(key, 'subagent', {
    args: { label },
    result: toolMessage(`${key}:result`, {
      toolCallId: `${key}:call`,
      toolName: 'subagent',
      status: 'running',
      streaming: true,
      details: { status: 'running', result: { conversationId: childId, status: 'running', label } },
    }),
  })
}

/** A codemode part whose script made `count` nested subagent calls, still live. */
function liveCodemode(key: string, children: ToolItem[]): ProcessPart {
  return toolPart(key, 'codemode', {
    args: { code: 'const a = await tools.subagent(...)' },
    children,
  })
}

function nestedCallItem(key: string, id: string, label: string): ToolItem {
  const message = toolMessage(id, {
    toolCallId: id,
    toolName: 'subagent',
    status: 'running',
    parentToolCallId: 'codemode:call',
    details: { status: 'running', parentCallId: 'codemode:call', arguments: { label, task: `do ${label}` } },
  })
  return { key, message, result: message, children: [], order: 1 }
}

/** A settled codemode part whose `details.calls` hold the script's nested calls. */
function settledCodemode(key: string, calls: Array<{ id: string; name: string; args: string; status: string }>): ProcessPart {
  return toolPart(key, 'codemode', {
    args: { code: 'const a = await tools.subagent(...)' },
    result: toolMessage(`${key}:result`, {
      toolCallId: `${key}:call`,
      toolName: 'codemode',
      status: 'completed',
      details: { calls },
    }),
  })
}

function summary(id: string, label: string, overrides: Partial<SubagentSummary> = {}): SubagentSummary {
  return { id, label, title: label, status: 'inactive', answer: '', createdAt: 0, updatedAt: 0, ...overrides }
}

const isStrip = (part: ProcessPart | SubagentRunGroup): part is SubagentRunGroup => part.kind === 'subagentRun'

describe('subagent run model', () => {
  it('folds three consecutive top-level subagent calls into one strip with matching child ids', () => {
    const parts = [
      settledSubagent('a', 'child-1', 'essay-1'),
      settledSubagent('b', 'child-2', 'essay-2'),
      settledSubagent('c', 'child-3', 'essay-3'),
    ]
    const summaries = [summary('child-1', 'essay-1'), summary('child-2', 'essay-2'), summary('child-3', 'essay-3')]
    const grouped = groupSubagentRuns(parts, t, false, summaries)
    expect(grouped).toHaveLength(1)
    const strip = grouped[0]
    expect(isStrip(strip) && strip.source).toBe('calls')
    expect(isStrip(strip) && strip.items.map(item => item.childId)).toEqual(['child-1', 'child-2', 'child-3'])
    expect(isStrip(strip) && strip.items.map(item => item.label)).toEqual(['essay-1', 'essay-2', 'essay-3'])
  })

  it('keeps a single top-level subagent call as its original tool part', () => {
    const parts = [settledSubagent('a', 'child-1', 'essay-1')]
    const grouped = groupSubagentRuns(parts, t, false, [summary('child-1', 'essay-1')])
    expect(grouped).toHaveLength(1)
    expect(grouped[0]).toHaveProperty('kind', 'tool')
    expect(grouped[0]).toHaveProperty('key', 'a')
  })

  it('does not join two top-level calls across an interleaved bash row', () => {
    const bash = toolPart('b', 'bash', { args: { command: 'ls' }, result: toolMessage('b:result', { toolCallId: 'b:call', toolName: 'bash', status: 'completed' }) })
    const parts = [settledSubagent('a', 'child-1', 'essay-1'), bash, settledSubagent('c', 'child-2', 'essay-2')]
    const summaries = [summary('child-1', 'essay-1'), summary('child-2', 'essay-2')]
    const grouped = groupSubagentRuns(parts, t, false, summaries)
    expect(grouped.map(part => part.kind)).toEqual(['tool', 'tool', 'tool'])
    expect(grouped.map(part => part.key)).toEqual(['a', 'b', 'c'])
  })

  it('shows childless pending top-level calls as creating', () => {
    const parts = [
      toolPart('a', 'subagent', { args: { label: 'fresh-task' } }),
      toolPart('b', 'subagent', { args: { label: 'fresh-2' } }),
    ]
    const summaries = [summary('child-1', 'other-delegation')]
    const grouped = groupSubagentRuns(parts, t, true, summaries)
    const strip = grouped[0]
    expect(isStrip(strip) && strip.items[0]?.pending).toBe(true)
    expect(isStrip(strip) && strip.items[0]?.childId).toBeUndefined()
    const entries = isStrip(strip) ? subagentRunEntries(strip, summaries, t) : []
    expect(entries).toHaveLength(2)
    expect(entries.every(entry => entry.status === 'creating')).toBe(true)
    expect(entries.every(entry => entry.childId === undefined)).toBe(true)
  })

  it('reads the live projection whose details nest the payload under result', () => {
    const parts = [liveSubagent('a', 'child-9', 'city'), liveSubagent('b', 'child-8', 'spring')]
    const summaries = [summary('child-9', 'city', { status: 'running' }), summary('child-8', 'spring', { status: 'running' })]
    const grouped = groupSubagentRuns(parts, t, true, summaries)
    const strip = grouped[0]
    expect(isStrip(strip) && strip.items[0]?.childId).toBe('child-9')
    expect(isStrip(strip) && strip.items[0]?.label).toBe('city')
    const entries = isStrip(strip) ? subagentRunEntries(strip, summaries, t) : []
    expect(entries[0]?.status).toBe('running')
    expect(entries[0]?.colorIndex).toBe(0)
    expect(entries[1]?.colorIndex).toBe(1)
  })

  it('lifts codemode live nested subagent calls into a strip before the script card', () => {
    const codemode = liveCodemode('cm', [
      nestedCallItem('n1', 'nested-1', 'essay-1'),
      nestedCallItem('n2', 'nested-2', 'essay-2'),
    ])
    const parts = [codemode]
    const summaries = [summary('child-1', 'essay-1'), summary('child-2', 'essay-2')]
    const grouped = groupSubagentRuns(parts, t, true, summaries)
    expect(grouped).toHaveLength(2)
    expect(grouped[0]).toHaveProperty('kind', 'subagentRun')
    expect(grouped[1]).toHaveProperty('kind', 'tool')
    const strip = grouped[0]
    expect(isStrip(strip) && strip.source).toBe('codemode')
    expect(isStrip(strip) && strip.items.map(item => item.childId)).toEqual(['child-1', 'child-2'])
    expect(isStrip(strip) && strip.items.map(item => item.label)).toEqual(['essay-1', 'essay-2'])
  })

  it('extracts codemode settled calls from details.calls with ok to done and error to failed', () => {
    const codemode = settledCodemode('cm', [
      { id: '1', name: 'subagent', args: JSON.stringify({ label: 'essay-1' }), status: 'ok' },
      { id: '2', name: 'subagent', args: JSON.stringify({ label: 'essay-2' }), status: 'error' },
      { id: '3', name: 'bash', args: '{}', status: 'ok' },
    ])
    const summaries = [summary('child-1', 'essay-1'), summary('child-2', 'essay-2')]
    const grouped = groupSubagentRuns([codemode], t, false, summaries)
    expect(grouped).toHaveLength(2)
    const strip = grouped[0]
    expect(isStrip(strip) && strip.items).toHaveLength(2)
    const entries = isStrip(strip) ? subagentRunEntries(strip, summaries, t) : []
    expect(entries.map(entry => entry.status)).toEqual(['done', 'failed'])
    expect(entries.map(entry => entry.childId)).toEqual(['child-1', 'child-2'])
  })

  it('recovers label and task from a truncated codemode args prefix', () => {
    const truncated = '{"label":"essay-1","task":"write a long essay about spring'
    const codemode = settledCodemode('cm', [{ id: '1', name: 'subagent', args: truncated, status: 'ok' }])
    const summaries = [summary('child-1', 'essay-1'), summary('child-0', 'unrelated')]
    const grouped = groupSubagentRuns([codemode], t, false, summaries)
    const strip = grouped[0]
    expect(isStrip(strip) && strip.items[0]?.label).toBe('essay-1')
    expect(isStrip(strip) && strip.items[0]?.task).toBe('write a long essay about spring')
    const entries = isStrip(strip) ? subagentRunEntries(strip, summaries, t) : []
    expect(entries[0]?.childId).toBe('child-1')
  })

  it('prefix-matches a label truncated before its child was renamed or capped', () => {
    // The details carry no conversation id, so only the label can match.
    const parts = [
      settledSubagent('a', '', 'write-a-long-essay-repo'),
      settledSubagent('b', 'child-2', 'essay-2'),
    ]
    const summaries = [summary('child-1', 'write-a-long-essay-report'), summary('child-2', 'essay-2')]
    const grouped = groupSubagentRuns(parts, t, false, summaries)
    const strip = grouped[0]
    expect(isStrip(strip) && strip.items[0]?.childId).toBe('child-1')
    const entries = isStrip(strip) ? subagentRunEntries(strip, summaries, t) : []
    expect(entries[0]?.childId).toBe('child-1')
    expect(entries[0]?.status).toBe('done')
  })

  it('falls back to the newest unmatched children for settled calls with unknown labels', () => {
    // Empty conversation ids keep the calls childless, so only the fallback can match.
    const parts = [settledSubagent('a', '', 'zzz-1'), settledSubagent('b', '', 'zzz-2')]
    const summaries = [
      summary('child-old', 'oldest'),
      summary('child-2', 'essay-2'),
      summary('child-3', 'essay-3'),
    ]
    const grouped = groupSubagentRuns(parts, t, false, summaries)
    const strip = grouped[0]
    const entries = isStrip(strip) ? subagentRunEntries(strip, summaries, t) : []
    // Two finished delegations map onto the two newest children, in tail order.
    expect(entries.map(entry => entry.childId)).toEqual(['child-2', 'child-3'])
    expect(entries.every(entry => entry.status === 'done')).toBe(true)
  })

  it('never lets a creating call claim an existing child conversation', () => {
    const parts = [
      toolPart('a', 'subagent', { args: { label: 'brand-new' } }),
      settledSubagent('b', 'child-2', 'essay-2'),
    ]
    const summaries = [summary('child-1', 'essay-1'), summary('child-2', 'essay-2')]
    const grouped = groupSubagentRuns(parts, t, true, summaries)
    const strip = grouped[0]
    const entries = isStrip(strip) ? subagentRunEntries(strip, summaries, t) : []
    expect(entries).toHaveLength(2)
    expect(entries[0]?.status).toBe('creating')
    expect(entries[0]?.childId).toBeUndefined()
    expect(entries[1]?.childId).toBe('child-2')
    expect(entries[1]?.status).toBe('done')
  })

  it('titles the strip for creating, running, done, and failed groups', () => {
    const entry = (status: SubagentRunStatus, key?: string): SubagentRunEntry => ({ key: key ?? status, label: 'x', status, colorIndex: 0 })
    expect(subagentRunHeadline([entry('creating'), entry('done', 'd')], t))
      .toEqual({ tone: 'creating', title: '正在创建子智能体', count: '1/2 结束' })
    expect(subagentRunHeadline([entry('running'), entry('done', 'd')], t))
      .toEqual({ tone: 'running', title: '子智能体运行中', count: '1/2 结束' })
    expect(subagentRunHeadline([entry('done'), entry('done', 'd2')], t))
      .toEqual({ tone: 'done', title: '2 个子智能体已完成', count: '' })
    expect(subagentRunHeadline([entry('done'), entry('failed', 'f')], t))
      .toEqual({ tone: 'failed', title: '1 个已完成 · 1 个失败', count: '' })
  })

  it('advances a running entrys duration from metricsAt and keeps a settled one fixed', () => {
    expect(subagentEntryDurationMs({ key: 'a', label: 'x', status: 'running', durationMs: 1_000, metricsAt: 10_000, colorIndex: 0 }, 12_500)).toBe(3_500)
    expect(subagentEntryDurationMs({ key: 'a', label: 'x', status: 'running', durationMs: 1_000, metricsAt: 10_000, colorIndex: 0 }, 9_000)).toBe(1_000)
    expect(subagentEntryDurationMs({ key: 'a', label: 'x', status: 'done', durationMs: 1_000, metricsAt: 10_000, colorIndex: 0 }, 99_000)).toBe(1_000)
    expect(subagentEntryDurationMs({ key: 'a', label: 'x', status: 'running', colorIndex: 0 }, 12_500)).toBeUndefined()
    expect(formatSubagentSeconds(42_500)).toBe('42秒')
    expect(formatSubagentSeconds(185_000)).toBe('3分05秒')
    expect(formatSubagentSeconds(0)).toBe('0秒')
  })

  it('colors entries by their index in the parent list and hashes unmatched ones', () => {
    const summaries = [0, 1, 2, 3, 4, 5, 6].map(index => summary(`child-${index}`, `label-${index}`))
    expect(subagentColorIndex('child-3', summaries)).toBe(3)
    expect(subagentColorIndex('child-6', summaries)).toBe(0)
    expect(subagentColorIndex('child-0', summaries)).toBe(0)
    // An id outside the list hashes into the same six slots, deterministically.
    const hashed = subagentColorIndex('unmatched-child')
    expect(hashed).toBe(subagentColorIndex('unmatched-child'))
    expect(hashed).toBeGreaterThanOrEqual(0)
    expect(hashed).toBeLessThan(6)
  })
})
