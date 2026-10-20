import { describe, expect, it } from 'vitest'
import type { ChatMessage, SubagentSummary } from '../src/shared/types.ts'
import { buildRenderModel, type ProcessPart } from '../src/web/render-model.ts'
import {
  formatSubagentSeconds, groupSubagentRuns, subagentColorIndex, subagentEntryDurationMs,
  subagentRunEntries, subagentRunHeadline, type SubagentRunGroup,
} from '../src/web/subagent-run-model.ts'

/** Chinese-only translator, mirroring the app's own locale switch. */
const zh = (chinese: string): string => chinese

function user(id: string): ChatMessage {
  return { id, requestId: `request:${id}`, role: 'user', blocks: [{ type: 'text', text: '开 5 个子 agent' }], timestamp: 100 }
}

function assistant(id: string, calls: Array<{ id: string; name: string; task?: string }>, runId = 'run-1'): ChatMessage {
  return {
    id,
    role: 'assistant',
    runId,
    timestamp: 200,
    blocks: calls.map(call => ({
      type: 'toolCall' as const,
      id: call.id,
      name: call.name,
      arguments: call.task === undefined ? {} : { task: call.task },
    })),
  }
}

function codemodeCall(id: string, callId: string, runId = 'run-1'): ChatMessage {
  return {
    id,
    role: 'assistant',
    runId,
    timestamp: 200,
    blocks: [{ type: 'toolCall', id: callId, name: 'codemode', arguments: { code: 'await Promise.all(tasks.map(t => tools.subagent(t)))' } }],
  }
}

/** A settled tool result: the extension's details payload lands on `message.details` directly. */
function result(id: string, toolCallId: string, details: unknown, options: { isError?: boolean; name?: string; runId?: string } = {}): ChatMessage {
  return {
    id,
    role: 'tool',
    runId: options.runId ?? 'run-1',
    timestamp: 300,
    toolCallId,
    toolName: options.name ?? 'subagent',
    details,
    blocks: [{ type: 'text', text: '' }],
    status: options.isError === true ? 'error' : 'completed',
    ...(options.isError === true ? { isError: true } : {}),
  }
}

/** A live tool message: the projection nests the payload under `result` while the call runs. */
function liveResult(id: string, toolCallId: string, resultPayload: unknown, runId = 'run-1'): ChatMessage {
  return {
    id,
    role: 'tool',
    runId,
    timestamp: 300,
    toolCallId,
    toolName: 'subagent',
    status: 'running',
    streaming: true,
    blocks: [],
    details: { status: 'running', result: resultPayload },
  }
}

/** One nested call inside a running `codemode` script. */
function liveNested(id: string, toolCallId: string, label: string, task: string): ChatMessage {
  return {
    id,
    role: 'tool',
    runId: 'run-1',
    timestamp: 300,
    toolCallId,
    parentToolCallId: 'call-code',
    toolName: 'subagent',
    status: 'running',
    streaming: true,
    blocks: [],
    details: { status: 'running', parentCallId: 'call-code', arguments: { label, task } },
  }
}

function summary(overrides: Partial<SubagentSummary> & Pick<SubagentSummary, 'id' | 'label'>): SubagentSummary {
  return {
    title: overrides.label,
    status: 'inactive',
    answer: '',
    createdAt: 1,
    updatedAt: 2,
    ...overrides,
  }
}

const SUMMARIES: SubagentSummary[] = [
  summary({ id: 'child-a', label: 'spring', status: 'running', tokens: 7_900, durationMs: 41_000, metricsAt: 1_000 }),
  summary({ id: 'child-b', label: 'city', answer: '城市清晨', tokens: 46_700, durationMs: 31_000 }),
  summary({ id: 'child-c', label: 'essay-1', status: 'running', tokens: 1_200 }),
  summary({ id: 'child-d', label: 'essay-2', tokens: 3_400 }),
]

function processOf(messages: readonly ChatMessage[]): readonly ProcessPart[] {
  const run = buildRenderModel(messages).runs[0]
  if (run === undefined) throw new Error('expected one run')
  return run.process
}

function groupsOf(messages: readonly ChatMessage[], summaries?: readonly SubagentSummary[]): SubagentRunGroup[] {
  return groupSubagentRuns(processOf(messages), zh, true, summaries)
    .filter((part): part is SubagentRunGroup => part.kind === 'subagentRun')
}

describe('subagent run grouping', () => {
  it('folds consecutive subagent calls and leaves other tools between them', () => {
    const messages: ChatMessage[] = [
      user('user-1'),
      assistant('assistant-1', [
        { id: 'call-a', name: 'subagent', task: '写春天' },
        { id: 'call-b', name: 'subagent', task: '写城市' },
        { id: 'call-bash', name: 'bash' },
        { id: 'call-c', name: 'subagent', task: '写书' },
      ]),
      result('tool-a', 'call-a', { conversationId: 'child-a', label: 'spring' }),
      result('tool-b', 'call-b', { conversationId: 'child-b', label: 'city' }),
      { id: 'tool-bash', role: 'tool', runId: 'run-1', timestamp: 300, toolCallId: 'call-bash', toolName: 'bash', blocks: [{ type: 'text', text: 'ok' }] },
      result('tool-c', 'call-c', { conversationId: 'child-c', label: 'book' }),
    ]

    const parts = groupSubagentRuns(processOf(messages), zh, false)

    expect(parts.map(part => part.kind)).toEqual(['subagentRun', 'tool', 'subagentRun'])
    expect((parts[0] as SubagentRunGroup).items.map(item => item.childId)).toEqual(['child-a', 'child-b'])
    expect((parts[2] as SubagentRunGroup).items.map(item => item.childId)).toEqual(['child-c'])
  })

  it('groups calls that are still starting, before their child conversation is named', () => {
    const messages: ChatMessage[] = [
      user('user-1'),
      assistant('assistant-1', [
        { id: 'call-a', name: 'subagent', task: '写春天' },
        { id: 'call-b', name: 'subagent', task: '写城市' },
      ]),
    ]

    const group = groupsOf(messages)[0]
    expect(group?.items).toHaveLength(2)
    expect(group?.items[0]).toMatchObject({ pending: true, label: '写春天' })
    expect(group?.items[0]?.childId).toBeUndefined()
  })

  it('attaches a call that is still running through the live projection shape', () => {
    const messages: ChatMessage[] = [
      user('user-1'),
      assistant('assistant-1', [{ id: 'call-a', name: 'subagent', task: '写春天' }]),
      liveResult('live-tool:call-a', 'call-a', { conversationId: 'child-a', status: 'running', label: 'spring' }),
    ]

    const group = groupsOf(messages, SUMMARIES)[0]
    expect(group?.items[0]).toMatchObject({ childId: 'child-a', label: 'spring', pending: true, failed: false })
  })

  it('lifts a code-mode script\'s live nested subagent calls in front of the script card', () => {
    const messages: ChatMessage[] = [
      user('user-1'),
      codemodeCall('assistant-code', 'call-code'),
      liveNested('live-nested-1', 'nested-1', 'essay-1', '写春天'),
      liveNested('live-nested-2', 'nested-2', 'essay-2', '写城市'),
    ]

    const parts = groupSubagentRuns(processOf(messages), zh, true, SUMMARIES)
    const group = parts[0] as SubagentRunGroup

    expect(parts.map(part => part.kind)).toEqual(['subagentRun', 'tool'])
    expect(group.items.map(item => item.childId)).toEqual(['child-c', 'child-d'])
    expect(group.items.map(item => item.label)).toEqual(['essay-1', 'essay-2'])
  })

  it('lifts a settled code-mode script\'s nested subagent calls from details.calls', () => {
    const messages: ChatMessage[] = [
      user('user-1'),
      codemodeCall('assistant-code', 'call-code'),
      result('tool-code', 'call-code', {
        calls: [
          { id: 1, name: 'subagent', args: JSON.stringify({ label: 'essay-1', task: '写春天' }), status: 'ok', durationMs: 1_000 },
          { id: 2, name: 'subagent', args: JSON.stringify({ label: 'essay-2', task: '写城市' }), status: 'error', error: 'timeout' },
          { id: 3, name: 'bash', args: '{"command":"pwd"}', status: 'ok' },
        ],
      }, { name: 'codemode' }),
    ]

    const parts = groupSubagentRuns(processOf(messages), zh, false, SUMMARIES)
    const group = parts[0] as SubagentRunGroup
    const entries = subagentRunEntries(group, SUMMARIES, zh)

    expect(parts.map(part => part.kind)).toEqual(['subagentRun', 'tool'])
    expect(group.items.map(item => item.childId)).toEqual(['child-c', 'child-d'])
    expect(entries.map(entry => entry.status)).toEqual(['running', 'failed'])
  })
})

describe('subagent run entries', () => {
  const group: SubagentRunGroup = {
    kind: 'subagentRun',
    key: 'subagent-run:tool:call-a',
    order: 1,
    items: [
      { key: 'tool:call-a', label: 'spring', task: '写春天', failed: false, pending: true },
      { key: 'tool:call-b', childId: 'child-b', label: 'city', failed: false, pending: false },
      { key: 'tool:call-c', childId: 'child-c', failed: false, pending: false },
    ],
  }

  it('reads an unstarted call as creating, a live child as running, and a settled one as done', () => {
    const entries = subagentRunEntries(group, SUMMARIES, zh)
    expect(entries[0]).toMatchObject({ label: 'spring', status: 'creating', colorIndex: subagentColorIndex('spring', SUMMARIES) })
    expect(entries[1]).toMatchObject({ label: 'city', status: 'done', tokens: 46_700, colorIndex: 1 })
    expect(entries[2]).toMatchObject({ label: 'essay-1', status: 'running', tokens: 1_200, colorIndex: 2 })
  })

  it('marks an error result as failed', () => {
    const errored: SubagentRunGroup = {
      ...group,
      items: [{ key: 'tool:call-c', childId: 'child-c', failed: true, pending: false }],
    }
    expect(subagentRunEntries(errored, SUMMARIES, zh)[0]?.status).toBe('failed')
  })

  it('matches a child whose recorded label differs only by a truncated tail', () => {
    const renamed: SubagentRunGroup = {
      ...group,
      items: [{ key: 'tool:call-c', label: '长标题的字', failed: false, pending: false }],
    }
    const summaries = [summary({ id: 'child-long', label: '长标题的字段被截断…' })]
    expect(subagentRunEntries(renamed, summaries, zh)[0]).toMatchObject({ childId: 'child-long', status: 'done' })
  })

  it('assigns the remaining child by order so a finished chip stays clickable', () => {
    const renamed: SubagentRunGroup = {
      ...group,
      items: [{ key: 'tool:call-c', label: 'renamed', failed: false, pending: false }],
    }
    const summaries = [summary({ id: 'child-old', label: 'earlier' }), summary({ id: 'child-new', label: 'renamed-on-child' })]
    expect(subagentRunEntries(renamed, summaries, zh)[0]).toMatchObject({ childId: 'child-new', status: 'done' })
  })

  it('does not attach a child to a call that is still creating', () => {
    const creating: SubagentRunGroup = {
      ...group,
      items: [{ key: 'tool:call-c', label: 'renamed', failed: false, pending: true }],
    }
    const entries = subagentRunEntries(creating, [summary({ id: 'child-old', label: 'earlier' })], zh)
    expect(entries[0]?.childId).toBeUndefined()
    expect(entries[0]?.status).toBe('creating')
  })

  it('keeps a child hue from the parent order and hashes the rest', () => {
    const summaries: SubagentSummary[] = [
      summary({ id: 'child-a', label: 'a' }),
      summary({ id: 'child-b', label: 'b' }),
      summary({ id: 'child-c', label: 'c' }),
      summary({ id: 'child-d', label: 'd' }),
      summary({ id: 'child-e', label: 'e' }),
    ]

    expect(summaries.map(row => subagentColorIndex(row.id, summaries))).toEqual([0, 1, 2, 3, 4])
    expect(subagentColorIndex('orphan', undefined)).toBe(subagentColorIndex('orphan', undefined))
    expect(subagentColorIndex('orphan', undefined)).toBeLessThan(6)
  })
})

describe('subagent run headline', () => {
  const entry = (status: 'creating' | 'running' | 'done' | 'failed') => ({ key: status, childId: status, label: status, status, colorIndex: 0 })

  it('announces creation before any child starts running', () => {
    expect(subagentRunHeadline([entry('creating'), entry('creating')], zh)).toEqual({ tone: 'creating', title: '正在创建子智能体', count: '0/2 结束' })
  })

  it('counts settled children while any still runs', () => {
    expect(subagentRunHeadline([entry('running'), entry('done')], zh)).toEqual({ tone: 'running', title: '子智能体运行中', count: '1/2 结束' })
  })

  it('names failures once everything settled', () => {
    expect(subagentRunHeadline([entry('done'), entry('failed')], zh)).toEqual({ tone: 'failed', title: '1 个已完成 · 1 个失败', count: '' })
    expect(subagentRunHeadline([entry('done'), entry('done')], zh)).toEqual({ tone: 'done', title: '2 个子智能体已完成', count: '' })
  })
})

describe('subagent run metrics', () => {
  it('advances a running duration by the clock and leaves settled durations alone', () => {
    const running = { key: 'a', childId: 'a', label: 'a', status: 'running' as const, durationMs: 10_000, metricsAt: 1_000, colorIndex: 0 }
    const done = { ...running, status: 'done' as const }
    expect(subagentEntryDurationMs(running, 6_000)).toBe(15_000)
    expect(subagentEntryDurationMs(done, 6_000)).toBe(10_000)
    expect(subagentEntryDurationMs({ ...running, metricsAt: undefined }, 6_000)).toBe(10_000)
  })

  it('formats compact durations', () => {
    expect(formatSubagentSeconds(41_000)).toBe('41秒')
    expect(formatSubagentSeconds(65_000)).toBe('1分05秒')
  })
})
