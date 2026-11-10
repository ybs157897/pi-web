import { describe, expect, it } from 'vitest'
import type { AssistantMessage, ToolResultMessage, UserMessage } from '@earendil-works/pi-ai'
import type { ConversationView, EntryId, EntryRecord, JsonObject } from '@earendil-works/pi-durable'
import { ROOT_CONVERSATION_ID } from '@earendil-works/pi-durable'
import type { ConversationMetadata } from '../src/server/runtime/index.ts'
import { projectConversation } from '../src/server/conversation/projection.ts'
import { scriptedResponse } from '../src/server/model/demo.ts'

const WORKSPACE = '/tmp/pi-subagent-settlement-workspace'

function metadata(overrides: Partial<ConversationMetadata> = {}): ConversationMetadata {
  return {
    title: 'Subagent settlement fixture',
    createdAt: 100,
    updatedAt: 150,
    archived: false,
    pinned: false,
    seenAt: 1_000,
    titleSource: 'user',
    queueCreatedAt: {},
    requestReceipts: {},
    workspaceId: null,
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

describe('background subagent settlement projection', () => {
  it('projects a settlement entry as a quiet system row inside the run it triggers, never a user bubble', () => {
    const entries = [
      entry(1, 'pi-web.user', [{ role: 'user', content: 'Start the background research', timestamp: 100 }], { requestId: 'start' }),
      entry(2, 'pi.assistant', [assistant([{ type: 'toolCall', id: 'c1', name: 'subagent', arguments: { task: '调研', run_in_background: true } }], 150, 'toolUse')]),
      entry(3, 'pi-web.subagent-settlement', [
        { role: 'user', content: '[subagent-settlement]\n后台子智能体「后台机制归纳」已完成，结论如下。', timestamp: 200 },
      ], { label: '后台机制归纳', conversationId: 'child-1', status: 'completed' }),
      entry(4, 'pi.assistant', [assistant([{ type: 'text', text: '后台子智能体已完成。' }], 250)]),
    ]
    const result = projectConversation(view(entries), metadata(), { workspace: WORKSPACE })

    // The settlement input itself is carried by the host row, not by a user bubble.
    expect(JSON.stringify(result.messages)).not.toContain('[subagent-settlement]')
    expect(result.messages).toContainEqual(expect.objectContaining({
      role: 'system',
      blocks: [{ type: 'text', text: '后台子智能体「后台机制归纳」已完成' }],
    }))
    // No host systemKind: the row keeps the plain system shape the transcript renders by text.
    const row = result.messages.find(message => message.role === 'system')
    expect(row?.systemKind).toBeUndefined()
    // Without a request id in the entry data the run falls back to the entry id, and the
    // answer the settlement triggered shares that run.
    expect(row?.runId).toBe('run:3')
    expect(result.messages.find(message => message.role === 'assistant' && message.timestamp === 250)?.runId).toBe('run:3')
  })

  it('words a failed settlement as a failure', () => {
    const result = projectConversation(view([
      entry(7, 'pi-web.subagent-settlement', [
        { role: 'user', content: '[subagent-settlement]\n后台子智能体「后台机制归纳」失败。', timestamp: 200 },
      ], { label: '后台机制归纳', conversationId: 'child-1', status: 'failed' }),
    ]), metadata(), { workspace: WORKSPACE })
    expect(result.messages).toContainEqual(expect.objectContaining({
      role: 'system',
      blocks: [{ type: 'text', text: '后台子智能体「后台机制归纳」失败' }],
    }))
  })

  it('leaves an entry a foreign writer left without a label as an ordinary user message', () => {
    const result = projectConversation(view([
      entry(7, 'pi-web.subagent-settlement', [
        { role: 'user', content: '[subagent-settlement]\n缺少 label 的结算。', timestamp: 200 },
      ], { conversationId: 'child-1', status: 'completed' }),
    ]), metadata(), { workspace: WORKSPACE })
    expect(result.messages[0]).toMatchObject({ role: 'user' })
    expect(result.messages.some(message => message.role === 'system')).toBe(false)
  })

  it('keeps a queued settlement out of the conversation queue while ordinary items remain', () => {
    const result = projectConversation(view([], {
      'pi.inbox': {
        items: [
          { id: 22, mode: 'steer', content: 'Use this update' },
          { id: 31, mode: 'followUp', content: '[subagent-settlement]\n后台子智能体「后台机制归纳」已完成', entry: { kind: 'pi-web.subagent-settlement', data: { label: '后台机制归纳', conversationId: 'child-1', status: 'completed' } } },
          { id: 23, mode: 'followUp', content: 'Run tests later' },
        ],
      } as unknown as JsonObject,
    }), metadata(), { workspace: WORKSPACE })
    expect(result.queue).toEqual([
      { id: '22', text: 'Use this update', mode: 'steer', createdAt: 100 },
      { id: '23', text: 'Run tests later', mode: 'followUp', createdAt: 100 },
    ])
  })
})

describe('demo subagent background script', () => {
  type ScriptedResponse = typeof scriptedResponse
  type ResponseContext = Parameters<ScriptedResponse>[0]
  const responseState: Parameters<ScriptedResponse>[2] = { callCount: 0, deferredFetchCount: 0, cancelledDeferred: [] }
  const responseModel = {} as Parameters<ScriptedResponse>[3]
  const respond = (messages: ResponseContext['messages']): ReturnType<ScriptedResponse> =>
    scriptedResponse({ messages } as ResponseContext, undefined, responseState, responseModel)

  const user = (text: string, timestamp: number): UserMessage => ({ role: 'user', content: text, timestamp })
  const toolResult = (toolCallId: string, text: string, timestamp: number): ToolResultMessage => ({
    role: 'toolResult',
    toolCallId,
    toolName: 'subagent',
    content: [{ type: 'text', text }],
    isError: false,
    timestamp,
  })
  const textOf = (message: AssistantMessage): string =>
    message.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')

  it('submits a background delegation for [subagent-bg] and closes the turn once the spawn receipt lands', async () => {
    const first = await respond([user('[subagent-bg] 后台调研一下子智能体机制。', 100)])
    expect(first.stopReason).toBe('toolUse')
    const call = first.content.find(block => block.type === 'toolCall')
    expect(call).toMatchObject({ name: 'subagent', arguments: { label: '后台机制归纳', run_in_background: true } })
    expect(call !== undefined && call.type === 'toolCall' && typeof call.arguments.task === 'string' && call.arguments.task.startsWith('[subagent-child]')).toBe(true)

    // The spawn receipt arrives inside the same turn: the script stops instead of waiting.
    const second = await respond([
      user('[subagent-bg] 后台调研一下子智能体机制。', 100),
      assistant([{ type: 'toolCall', id: 'c1', name: 'subagent', arguments: {} }], 150, 'toolUse'),
      toolResult('c1', '已转后台运行', 200),
    ])
    expect(second.stopReason).toBe('stop')
    expect(textOf(second)).toContain('后台')
  })

  it('answers a [subagent-child] task with the child answer instead of delegating again', async () => {
    const response = await respond([user('[subagent-child] 后台调研任务：总结 demo 会话继承语义。', 100)])
    expect(response.stopReason).toBe('stop')
    expect(response.content.some(block => block.type === 'toolCall')).toBe(false)
    expect(textOf(response)).toContain('子会话')
  })

  it('summarizes the settlement turn instead of delegating again, even though the body quotes the child', async () => {
    const settlement = [
      '[subagent-settlement]',
      '后台子智能体「后台机制归纳」已完成：',
      '',
      '子智能体一期机制小结：子会话由 `subagent({ task, label })` 创建，继承父会话的组合。',
    ].join('\n')
    const response = await respond([
      user('[subagent-bg] 后台调研一下子智能体机制。', 100),
      assistant([{ type: 'text', text: '已把调研任务交给后台子智能体。' }], 150),
      user(settlement, 200),
    ])
    expect(response.stopReason).toBe('stop')
    expect(response.content.some(block => block.type === 'toolCall')).toBe(false)
    expect(textOf(response)).toContain('结算')
    expect(textOf(response)).toContain('后台机制归纳')
  })
})
