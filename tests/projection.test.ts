import { describe, expect, it } from 'vitest'
import type { AssistantMessage, ToolResultMessage, UserMessage } from '@earendil-works/pi-ai'
import type { ConversationView, EntryId, EntryRecord, JsonObject, ModelRef, TaskId } from '@earendil-works/pi-durable'
import type { JsonValue } from '@earendil-works/chord'
import { ROOT_CONVERSATION_ID } from '@earendil-works/pi-durable'
import type { ConversationMetadata } from '../src/server/runtime.ts'
import { projectConversation, activeDurationMs, usageTokens } from '../src/server/projection.ts'

const WORKSPACE = '/tmp/pi-projection-workspace'
const DEFAULT_MODEL: ModelRef = { provider: 'test-provider', modelId: 'test-model' }

function metadata(overrides: Partial<ConversationMetadata> = {}): ConversationMetadata {
  return {
    title: 'Projection fixture',
    createdAt: 100,
    updatedAt: 150,
    archived: false,
    pinned: true,
    titleSource: 'user',
    queueCreatedAt: {},
    requestReceipts: {},
    workspaceId: null,
    presetId: null,
    accessMode: 'fullAccess',
    feedback: {},
    queueEdits: {},
    ...overrides,
  }
}

function usage(input: number, output: number, total: number) {
  return {
    input,
    output,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: input + output,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total },
  }
}

function assistant(content: AssistantMessage['content'], timestamp: number, stopReason: AssistantMessage['stopReason'] = 'stop'): AssistantMessage {
  return {
    role: 'assistant',
    content,
    api: 'openai-completions',
    provider: 'test-provider',
    model: 'test-model',
    usage: usage(10, 5, 0.25),
    timestamp,
    stopReason,
  }
}

function persistedJson(value: unknown): JsonValue {
  const parsed: JsonValue = JSON.parse(JSON.stringify(value))
  return parsed
}

function persistedObject(value: unknown): JsonObject {
  const parsed = persistedJson(value)
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('Expected a JSON object')
  return parsed
}

function entry(id: number, kind: string, model?: EntryRecord['model'], data?: EntryRecord['data']): EntryRecord {
  return {
    id: id as EntryId,
    conversationId: ROOT_CONVERSATION_ID,
    kind,
    ...(model === undefined ? {} : { model }),
    ...(data === undefined ? {} : { data }),
  }
}

function view(entries: readonly EntryRecord[], docs: Record<string, JsonObject> = {}): ConversationView {
  return {
    conversation: { id: ROOT_CONVERSATION_ID },
    entries,
    docs,
  }
}

describe('Pi Durable conversation projection', () => {
  it('keeps steered input in its tool round and starts a new run after a final answer', () => {
    const taskId = 20 as TaskId
    const entries = [
      entry(1, 'pi-web.user', [{ role: 'user', content: 'Start', timestamp: 100 }], { requestId: 'start' }),
      { ...entry(2, 'pi.assistant', [assistant([{ type: 'toolCall', id: 'c1', name: 'read', arguments: {} }], 150, 'toolUse')]), byTaskId: taskId },
      { ...entry(3, 'pi-web.user', [{ role: 'user', content: 'Also check this', timestamp: 200 }], { requestId: 'steer' }), byTaskId: taskId },
      { ...entry(4, 'pi.assistant', [assistant([{ type: 'text', text: 'Done' }], 250)]), byTaskId: 21 as TaskId },
      { ...entry(5, 'pi-web.user', [{ role: 'user', content: 'Next', timestamp: 300 }], { requestId: 'next' }), byTaskId: 21 as TaskId },
    ]
    const projected = projectConversation(view(entries), metadata(), { workspace: WORKSPACE })
    expect(projected.messages.map(message => message.runId)).toEqual(['run:start', 'run:start', 'run:start', 'run:start', 'run:next'])
  })

  it('projects settled user, assistant and tool messages with stable ids and hides system prompts and redacted thinking', () => {
    const user: UserMessage = { role: 'user', content: [
      { type: 'text', text: 'Check this image' },
      { type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' },
    ], timestamp: 200 }
    const answer = assistant([
      { type: 'text', text: 'I checked it.' },
      { type: 'thinking', thinking: 'private reasoning', redacted: true },
      { type: 'thinking', thinking: 'Visible reasoning' },
      { type: 'toolCall', id: 'call-1', name: 'bash', arguments: { command: 'pwd' } },
    ], 300, 'toolUse')
    const toolResult: ToolResultMessage = {
      role: 'toolResult',
      toolCallId: 'call-1',
      toolName: 'bash',
      content: [{ type: 'text', text: '/work' }],
      details: { exitCode: 0 },
      isError: false,
      timestamp: 350,
    }
    const entries = [
      entry(1, 'pi-web.user', [user], { requestId: 'request-123' }),
      entry(2, 'pi.assistant', [answer]),
      entry(3, 'pi.tool-result', [toolResult]),
      entry(4, 'pi.system', [{ role: 'system', content: 'system prompt that must not appear', timestamp: 400 }]),
      entry(5, 'pi.reset', [{ role: 'user', content: 'long hidden handoff text', timestamp: 500 }]),
    ] satisfies EntryRecord[]
    const input = view(entries)

    const first = projectConversation(input, metadata(), { workspace: WORKSPACE, defaultModel: DEFAULT_MODEL })
    const second = projectConversation(input, metadata(), { workspace: WORKSPACE, defaultModel: DEFAULT_MODEL })

    expect(first.conversation).toEqual({
      id: String(ROOT_CONVERSATION_ID),
      title: 'Projection fixture',
      createdAt: 100,
      updatedAt: 500,
      archived: false,
      pinned: true,
      busy: false,
      model: DEFAULT_MODEL,
      thinkingLevel: 'medium',
      cwd: WORKSPACE,
      accessMode: 'fullAccess',
      runId: 'run:request-123',
      runStartedAt: 200,
      durationMs: 100,
      status: 'completed',
    })
    expect(first.messages.map(message => [message.id, message.timestamp])).toEqual(second.messages.map(message => [message.id, message.timestamp]))
    expect(first.messages).toHaveLength(4)
    expect(first.messages[0]).toMatchObject({
      id: `entry:1:0`,
      entryId: '1',
      requestId: 'request-123',
      role: 'user',
      timestamp: 200,
      blocks: [
        { type: 'text', text: 'Check this image' },
        { type: 'image', url: 'data:image/png;base64,aGVsbG8=', mimeType: 'image/png' },
      ],
    })
    expect(first.messages[1]?.blocks).toEqual([
      { type: 'text', text: 'I checked it.' },
      { type: 'thinking', text: '', redacted: true },
      { type: 'thinking', text: 'Visible reasoning' },
      { type: 'toolCall', id: 'call-1', name: 'bash', arguments: { command: 'pwd' } },
    ])
    expect(JSON.stringify(first.messages)).not.toContain('private reasoning')
    expect(JSON.stringify(first.messages)).not.toContain('system prompt that must not appear')
    expect(first.messages[2]).toMatchObject({ role: 'tool', toolCallId: 'call-1', toolName: 'bash', details: { exitCode: 0 }, isError: false })
    expect(first.messages[3]).toMatchObject({ role: 'system', blocks: [{ type: 'text', text: '上下文已重置' }] })
    expect(JSON.stringify(first.messages)).not.toContain('long hidden handoff text')
  })

  it('projects live partial output, tool progress, inbox state, errors and accumulated usage', () => {
    const partial = assistant([{ type: 'text', text: 'Still writing' }], 900, 'pending')
    const docs: Record<string, JsonObject> = {
      'pi.agent': persistedObject({ model: { provider: 'current-provider', modelId: 'current-model' }, thinkingLevel: 'high', cwd: '/work/current' }),
      'pi.live': persistedObject({
        run: { taskId: 77, inputs: [22] },
        generation: { attempt: 2, message: persistedJson(partial), retry: { at: 950, error: 'Provider auth failed: Authorization: Bearer sk-live-secret-123456789 api_key=private-api-key-123456' } },
        tools: [{
          callId: 'call-live',
          name: 'bash',
          status: 'running',
          taskId: 88,
          output: 'stdout so far',
          details: { phase: 'command' },
          diagnostics: [{ severity: 'warn', message: 'Output was truncated' }],
          droppedBytes: 8,
          droppedLines: 1,
        }],
      }),
      'pi.inbox': persistedObject({
        items: [
          { id: 22, mode: 'steer', content: [{ type: 'text', text: 'Use this update' }] },
          { id: 23, mode: 'followUp', content: 'Run tests later' },
          { id: 24, mode: 'write', entry: { kind: 'app.note', data: 'not a user queue item' } },
        ],
      }),
      'pi.usage': persistedObject({
        models: { 'test-provider/test-model': usage(10, 3, 0.2) },
        tools: { classify: usage(2, 1, 0.05) },
      }),
    }
    const input = view([], docs)
    const result = projectConversation(input, metadata({
      updatedAt: 700,
      queueCreatedAt: { '22': 600 },
    }), { workspace: WORKSPACE, defaultModel: DEFAULT_MODEL, queuedAt: { '23': 650 } })

    expect(result.conversation).toMatchObject({
      busy: true,
      model: { provider: 'current-provider', modelId: 'current-model' },
      thinkingLevel: 'high',
      cwd: '/work/current',
      updatedAt: 900,
    })
    expect(result.messages).toHaveLength(2)
    expect(result.messages[0]).toMatchObject({ id: 'live-assistant:77', role: 'assistant', streaming: true, timestamp: 900 })
    expect(result.messages[1]).toMatchObject({
      id: 'live-tool:call-live',
      role: 'tool',
      streaming: true,
      toolCallId: 'call-live',
      toolName: 'bash',
      blocks: [{ type: 'text', text: 'stdout so far' }],
      details: { status: 'running', droppedBytes: 8, droppedLines: 1 },
    })
    expect(result.queue).toEqual([
      { id: '22', text: 'Use this update', mode: 'steer', createdAt: 600 },
      { id: '23', text: 'Run tests later', mode: 'followUp', createdAt: 650 },
    ])
    expect(result.error).toBe('Provider auth failed: Authorization: [redacted] api_key=[redacted]')
    expect(JSON.stringify(result)).not.toContain('sk-live-secret-123456789')
    expect(JSON.stringify(result)).not.toContain('private-api-key-123456')
    expect(result.usage).toEqual({ input: 12, output: 4, totalCost: 0.25 })
  })

  it('does not duplicate a live assistant or tool result already present in settled entries', () => {
    const response = assistant([{ type: 'text', text: 'Complete' }], 1_000)
    const settledTool: ToolResultMessage = {
      role: 'toolResult',
      toolCallId: 'call-done',
      toolName: 'read',
      content: [{ type: 'text', text: 'file contents' }],
      isError: false,
      timestamp: 1_010,
    }
    const input = view([
      entry(10, 'pi.assistant', [response]),
      entry(11, 'pi.tool-result', [settledTool]),
    ], {
      'pi.live': persistedObject({
        run: { taskId: 90, inputs: [44] },
        generation: { attempt: 1, message: persistedJson(assistant([{ type: 'text', text: 'Complete' }], 1_000, 'pending')) },
        tools: [{ callId: 'call-done', name: 'read', status: 'done', entry: 11, taskId: 91, output: 'file contents' }],
      }),
    })

    const result = projectConversation(input, metadata(), { workspace: WORKSPACE })
    expect(result.messages.filter(message => message.role === 'assistant')).toHaveLength(1)
    expect(result.messages.filter(message => message.toolCallId === 'call-done')).toHaveLength(1)
    expect(result.messages.some(message => message.streaming)).toBe(false)
  })

  it('projects the todo document and drops malformed entries', () => {
    const items = [
      { content: 'Wire the todo panel', status: 'completed' },
      { content: 'Add interaction protocol', status: 'in_progress' },
      { content: 'Ship goal bar', status: 'pending' },
    ]
    const withTodos = projectConversation(view([]), metadata(), { workspace: WORKSPACE, todos: { items, updatedAt: 12 } })
    expect(withTodos.todos).toEqual(items)
    const withMalformed = projectConversation(view([]), metadata(), {
      workspace: WORKSPACE,
      todos: { items: [...items, { content: 7, status: 'pending' }, { content: 'no status' }, { content: 'bad status', status: 'done' }], updatedAt: 13 },
    })
    expect(withMalformed.todos).toEqual(items)
    const cleared = projectConversation(view([]), metadata(), { workspace: WORKSPACE, todos: { items: null, updatedAt: 14 } })
    expect(cleared.todos).toBeNull()
    const absent = projectConversation(view([]), metadata(), { workspace: WORKSPACE })
    expect('todos' in absent).toBe(false)
  })

  it('projects plan mode and the plan reviews stored next to the question calls', () => {
    const interactions = {
      'call-plan': {
        kind: 'plan-review',
        detail: '# 迁移计划\n\n1. 调研',
        approveLabel: '同意执行',
        askedAt: 40,
        status: 'answered',
        approved: false,
        feedback: '补上回滚说明',
        answers: [{ id: 'plan-review', selected: ['要求修改'] }],
        answeredAt: 45,
      },
      'call-question': { questions: [{ id: 'scope', question: 'Which scope?' }], askedAt: 30, status: 'pending' },
      'call-dismissed': { questions: [{ id: 'scope', question: 'Which scope?' }], askedAt: 32, status: 'cancelled', cancelledAt: 34 },
      'call-old-plan': { kind: 'plan-review', detail: '# 旧计划', approveLabel: '同意执行', askedAt: 20, status: 'superseded' },
      'call-broken': { kind: 'plan-review', approveLabel: '同意执行', askedAt: 50 },
    }
    const active = projectConversation(view([]), metadata(), { workspace: WORKSPACE, plan: { active: true, updatedAt: 12 }, interactions })
    expect(active.plan).toEqual({ active: true })
    // A superseded review reads as `continued`: nobody is waiting on it any more, and a
    // dismissed question set stays `cancelled` so its row renders the dismissal record.
    expect(active.interactions?.map(interaction => [interaction.id, interaction.kind, interaction.status]))
      .toEqual([['call-old-plan', 'plan-review', 'continued'], ['call-question', 'question', 'pending'],
        ['call-dismissed', 'question', 'cancelled'], ['call-plan', 'plan-review', 'answered']])
    expect(active.interactions?.find(interaction => interaction.id === 'call-dismissed')).toMatchObject({
      questions: [{ id: 'scope', question: 'Which scope?' }],
      createdAt: 32,
    })
    expect(active.interactions?.[3]).toMatchObject({
      detail: '# 迁移计划\n\n1. 调研',
      approveLabel: '同意执行',
      approved: false,
      feedback: '补上回滚说明',
      createdAt: 40,
      answeredAt: 45,
      answer: { answers: [{ id: 'plan-review', selected: ['要求修改'] }] },
    })

    const inactive = projectConversation(view([]), metadata(), { workspace: WORKSPACE, plan: { active: false, updatedAt: 13 } })
    expect(inactive.plan).toEqual({ active: false })
    // A missing document reads as inactive instead of dropping the field.
    expect(projectConversation(view([]), metadata(), { workspace: WORKSPACE }).plan).toEqual({ active: false })
  })

  it('projects subagent token totals and active duration, and drops malformed metric rows', () => {
    const rows = [
      { id: '17', label: '调研', title: '调研', status: 'running', answer: '进行中', tokens: 12_345, durationMs: 65_000, metricsAt: 1_000, createdAt: 10, updatedAt: 20 },
      { id: '18', label: '实现', title: '实现', status: 'inactive', answer: '完成', tokens: 0, durationMs: 0, createdAt: 11, updatedAt: 21 },
      { id: '19', label: '无指标', title: '无指标', status: 'inactive', answer: '', createdAt: 12, updatedAt: 22 },
      { id: '20', label: '坏指标', title: '坏指标', status: 'inactive', answer: '', tokens: 'many', durationMs: null, metricsAt: 'now', createdAt: 13, updatedAt: 23 },
      { id: '21', label: '缺时间', status: 'inactive', answer: '' },
    ]
    const projected = projectConversation(view([]), metadata(), { workspace: WORKSPACE, subagents: rows })
    expect(projected.subagents).toEqual([
      { id: '17', label: '调研', title: '调研', status: 'running', answer: '进行中', tokens: 12_345, durationMs: 65_000, metricsAt: 1_000, createdAt: 10, updatedAt: 20 },
      { id: '18', label: '实现', title: '实现', status: 'inactive', answer: '完成', tokens: 0, durationMs: 0, createdAt: 11, updatedAt: 21 },
      { id: '19', label: '无指标', title: '无指标', status: 'inactive', answer: '', createdAt: 12, updatedAt: 22 },
      { id: '20', label: '坏指标', title: '坏指标', status: 'inactive', answer: '', createdAt: 13, updatedAt: 23 },
    ])
    // A row without children at all keeps the field absent.
    expect('subagents' in projectConversation(view([]), metadata(), { workspace: WORKSPACE })).toBe(false)
  })

  it('sums the four usage buckets into one token total and only counts run-level assistant durations', () => {
    const input = view([], {
      'pi.usage': persistedObject({
        models: { 'test-provider/test-model': usage(10, 3, 0.2) },
        tools: { classify: { ...usage(2, 1, 0.05), cacheRead: 4, cacheWrite: 5, totalTokens: 12 } },
      }),
    })
    const projected = projectConversation(input, metadata(), { workspace: WORKSPACE })
    // `Usage.totalTokens` already equals input + output + cacheRead + cacheWrite per bucket.
    expect(usageTokens(input.docs['pi.usage'])).toBe(25)
    expect(projected.usage).toEqual({ input: 12, output: 4, totalCost: 0.25 })
    expect(usageTokens(undefined)).toBeUndefined()
    expect(usageTokens({ models: {}, tools: {} })).toBe(0)

    const messages = [
      { id: 'a', role: 'assistant' as const, blocks: [], timestamp: 100, runId: 'run:1', durationMs: 2_000 },
      // A tool row inside the same run carries its own duration; it must not be added twice.
      { id: 'b', role: 'tool' as const, blocks: [], timestamp: 110, runId: 'run:1', durationMs: 500 },
      { id: 'c', role: 'assistant' as const, blocks: [], timestamp: 200, runId: 'run:2', durationMs: 1_500 },
      { id: 'd', role: 'assistant' as const, blocks: [], timestamp: 300, durationMs: 9_999 },
    ]
    expect(activeDurationMs(messages)).toBe(3_500)
    expect(activeDurationMs(messages.filter(message => message.role !== 'assistant'))).toBeUndefined()
  })
})

describe('compaction projection', () => {
  it('exposes running tasks, the newest failure and absence', () => {
    const running = projectConversation(view([], {
      'pi.live': persistedObject({
        compactions: [{ taskId: 5, reason: 'manual', blocking: false, attempt: 1 }],
        compactionFailure: { taskId: 4, reason: 'threshold', error: 'Provider down' },
      }),
    }), metadata(), { workspace: WORKSPACE })
    expect(running.compaction).toEqual({ running: true, reason: 'manual', blocking: false, attempt: 1, failure: 'Provider down' })

    const failed = projectConversation(view([], {
      'pi.live': persistedObject({ compactionFailure: { taskId: 4, reason: 'threshold', error: 'Provider down' } }),
    }), metadata(), { workspace: WORKSPACE })
    expect(failed.compaction).toEqual({ running: false, failure: 'Provider down' })

    expect('compaction' in projectConversation(view([]), metadata(), { workspace: WORKSPACE })).toBe(false)
  })
})

describe('compaction checkpoint label', () => {
  it('renders the completed compaction status instead of the framed summary', () => {
    const checkpoint: UserMessage = {
      role: 'user',
      content: 'The conversation history before this point was compacted into the following summary:\n\n<summary>\n...\n</summary>',
      timestamp: 100,
    }
    const result = projectConversation(view([entry(1, 'pi.compaction', [checkpoint], { reason: 'manual' })]), metadata(), { workspace: WORKSPACE })
    expect(result.messages).toContainEqual(expect.objectContaining({
      role: 'system',
      systemKind: 'compaction',
      blocks: [{ type: 'text', text: '已完成上下文压缩' }],
    }))
    expect(JSON.stringify(result.messages)).not.toContain('conversation history before this point')
  })
})
