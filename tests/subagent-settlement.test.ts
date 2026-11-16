import { describe, expect, it } from 'vitest'
import type { AssistantMessage, ToolResultMessage, UserMessage } from '@earendil-works/pi-ai'
import type { ConversationView, EntryId, EntryRecord, JsonObject } from '@earendil-works/pi-durable'
import { ROOT_CONVERSATION_ID } from '@earendil-works/pi-durable'
import type { ConversationMetadata } from '../src/server/runtime/index.ts'
import { projectConversation } from '../src/server/conversation/projection.ts'
import { scriptedResponse } from '../src/server/model/demo.ts'

/**
 * 后台子智能体结算的投影（projection）契约测试：结算条目如何呈现在会话中——
 * 静默系统行（绝不渲染为用户气泡）、失败措辞、外来写入的容错、排队条目的隔离，
 * 以及 demo 脚本对后台委派/子任务/结算回合的响应行为。
 */
const WORKSPACE = '/tmp/pi-subagent-settlement-workspace'

/**
 * 构造会话元数据 fixture。
 * @param overrides 覆盖默认字段的属性
 * @returns fullAccess、无 workspace 的基准元数据
 */
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

/**
 * 构造 token 用量样本。
 * @returns totalTokens 为 input+output、成本总额为 total 的用量对象
 */
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

/**
 * 构造助手消息 fixture。
 * @param stopReason 停止原因，默认 'stop'（工具调用轮次传 'toolUse'）
 */
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

/**
 * 构造会话条目记录 fixture。
 * @param id 条目 id（同时决定运行分组）
 * @param kind 条目类型（pi-web.user / pi.assistant / pi-web.subagent-settlement）
 * @param model 可选的模型载荷
 * @param data 可选的类型相关载荷（如 settlement 的 label/status）
 */
function entry(id: number, kind: string, model?: EntryRecord['model'], data?: EntryRecord['data']): EntryRecord {
  return {
    id: id as EntryId,
    conversationId: ROOT_CONVERSATION_ID,
    kind,
    ...(model === undefined ? {} : { model }),
    ...(data === undefined ? {} : { data }),
  }
}

/**
 * 组装会话视图 fixture。
 * @param entries 按顺序排列的条目
 * @param docs 文档载荷（如 pi.inbox 排队项）
 */
function view(entries: readonly EntryRecord[], docs: Record<string, JsonObject> = {}): ConversationView {
  return {
    conversation: { id: ROOT_CONVERSATION_ID },
    entries,
    docs,
  }
}

describe('background subagent settlement projection', () => {
  // 呈现契约：结算条目投影为静默系统行，归入它触发的那个运行（runId 一致），
  // 原始 [subagent-settlement] 输入文本不得以用户气泡形式出现。
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

    // 结算输入本身由宿主行承载，而不是用户气泡。
    expect(JSON.stringify(result.messages)).not.toContain('[subagent-settlement]')
    expect(result.messages).toContainEqual(expect.objectContaining({
      role: 'system',
      blocks: [{ type: 'text', text: '后台子智能体「后台机制归纳」已完成' }],
    }))
    // 不带宿主 systemKind：该行保持纯 system 形状，由转录按文本渲染。
    const row = result.messages.find(message => message.role === 'system')
    expect(row?.systemKind).toBeUndefined()
    // 条目数据里没有 requestId 时运行回退到条目 id，结算触发的回答共享该运行。
    expect(row?.runId).toBe('run:3')
    expect(result.messages.find(message => message.role === 'assistant' && message.timestamp === 250)?.runId).toBe('run:3')
  })

  // 失败措辞：status=failed 的结算行用「失败」而非「已完成」。
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

  // 容错：外来写入者（其他版本/插件）留下的缺 label 条目退化为普通用户消息，
  // 不冒充系统行。
  it('leaves an entry a foreign writer left without a label as an ordinary user message', () => {
    const result = projectConversation(view([
      entry(7, 'pi-web.subagent-settlement', [
        { role: 'user', content: '[subagent-settlement]\n缺少 label 的结算。', timestamp: 200 },
      ], { conversationId: 'child-1', status: 'completed' }),
    ]), metadata(), { workspace: WORKSPACE })
    expect(result.messages[0]).toMatchObject({ role: 'user' })
    expect(result.messages.some(message => message.role === 'system')).toBe(false)
  })

  // 队列隔离：排队中的结算条目不进入面向用户的会话队列，普通 steer/followUp 项保持原位。
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

  /** 构造用户消息 fixture。 */
  const user = (text: string, timestamp: number): UserMessage => ({ role: 'user', content: text, timestamp })
  /** 构造 subagent 工具结果消息 fixture。 */
  const toolResult = (toolCallId: string, text: string, timestamp: number): ToolResultMessage => ({
    role: 'toolResult',
    toolCallId,
    toolName: 'subagent',
    content: [{ type: 'text', text }],
    isError: false,
    timestamp,
  })
  /** 拼接助手消息的全部文本块。 */
  const textOf = (message: AssistantMessage): string =>
    message.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')

  // demo 脚本行为：[subagent-bg] 触发后台委派（run_in_background=true、
  // 任务带 [subagent-child] 前缀）；spawn 回执（已转后台运行）在当轮到达后立即收轮，
  // 不等待子任务完成。
  it('submits a background delegation for [subagent-bg] and closes the turn once the spawn receipt lands', async () => {
    const first = await respond([user('[subagent-bg] 后台调研一下子智能体机制。', 100)])
    expect(first.stopReason).toBe('toolUse')
    const call = first.content.find(block => block.type === 'toolCall')
    expect(call).toMatchObject({ name: 'subagent', arguments: { label: '后台机制归纳', run_in_background: true } })
    expect(call !== undefined && call.type === 'toolCall' && typeof call.arguments.task === 'string' && call.arguments.task.startsWith('[subagent-child]')).toBe(true)

    // spawn 回执在当轮内到达：脚本直接收轮而不是原地等待。
    const second = await respond([
      user('[subagent-bg] 后台调研一下子智能体机制。', 100),
      assistant([{ type: 'toolCall', id: 'c1', name: 'subagent', arguments: {} }], 150, 'toolUse'),
      toolResult('c1', '已转后台运行', 200),
    ])
    expect(second.stopReason).toBe('stop')
    expect(textOf(second)).toContain('后台')
  })

  // [subagent-child] 任务在子会话内执行：直接给出子任务答复，不得再次委派。
  it('answers a [subagent-child] task with the child answer instead of delegating again', async () => {
    const response = await respond([user('[subagent-child] 后台调研任务：总结 demo 会话继承语义。', 100)])
    expect(response.stopReason).toBe('stop')
    expect(response.content.some(block => block.type === 'toolCall')).toBe(false)
    expect(textOf(response)).toContain('子会话')
  })

  // 结算回合防递归：即使结算正文引用了子会话的结论，demo 模型也要归纳结算
  // 而不是再次委派——正文含「子会话」字样不得误触发 [subagent-child] 分支。
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
