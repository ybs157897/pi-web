/**
 * Pi Durable 会话投影（projectConversation）测试：把内核的持久 entries + live 文档
 * 投影成前端会话视图（messages/queue/usage/plan/subagents/compaction 等）。
 *
 * 关键契约：
 * - run 归属：steered 输入留在工具轮、final answer 后开启新 run；ask_user_question /
 *   plan-review 的答复（含 live 续接与压缩后"忘记"提问方的情况）跟随提问 run 而非另开 run；
 * - 消息投影：稳定 id（entry:N:M / assistant:task:ts）、slot 标注块位置、redacted thinking
 *   与 system prompt 不外泄、pi.reset 显示"上下文已重置"、压缩检查点显示"已完成上下文压缩"；
 * - live 投影：流式部分输出、运行中工具（含丢弃字节/诊断）、inbox 队列（steer/followUp 模式、
 *   createdAt 来源）、错误消息脱敏（Bearer/api_key 打码）、usage 累加（四桶求和）、
 *   模型/thinkingLevel/cwd 覆盖、已落定条目不与 live 重复；
 * - 附件投影：todos 过滤畸形条目、plan + interactions 状态机（superseded→continued、
 *   cancelled 保留、answered 附答案）、subagents 剔除坏指标行；
 * - 未读判定：最近回复晚于 seenAt 标 unread，运行中的回合永不标 unread。
 */
import { describe, expect, it } from 'vitest'
import type { AssistantMessage, ToolResultMessage, UserMessage } from '@earendil-works/pi-ai'
import type { ConversationView, EntryId, EntryRecord, JsonObject, ModelRef, TaskId } from '@earendil-works/pi-durable'
import type { JsonValue } from '@earendil-works/chord'
import { ROOT_CONVERSATION_ID } from '@earendil-works/pi-durable'
import type { ConversationMetadata } from '../src/server/runtime/index.ts'
import { projectConversation, activeDurationMs, usageTokens } from '../src/server/conversation/projection.ts'

/** 投影目标工作区路径 fixture。 */
const WORKSPACE = '/tmp/pi-projection-workspace'
/** 默认模型引用 fixture。 */
const DEFAULT_MODEL: ModelRef = { provider: 'test-provider', modelId: 'test-model' }

/**
 * 构造会话元数据 fixture（默认已读、置顶、fullAccess）。
 * @param overrides 覆盖字段
 * @returns ConversationMetadata
 */
function metadata(overrides: Partial<ConversationMetadata> = {}): ConversationMetadata {
  return {
    title: 'Projection fixture',
    createdAt: 100,
    updatedAt: 150,
    archived: false,
    pinned: true,
    // 每条 fixture 消息之后都算已读；未读用例显式覆盖该值。
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
 * 构造 usage 统计块。
 * @param input 输入 token
 * @param output 输出 token
 * @param total 费用总额
 * @returns usage 对象（缓存读写字节为 0）
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
 * 构造 assistant 消息 fixture。
 * @param content 内容块数组
 * @param timestamp 时间戳
 * @param stopReason 停止原因，默认 'stop'
 * @returns AssistantMessage
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
 * 把任意值经 JSON 序列化往返，模拟持久化文档中的值形态。
 * @param value 原始值
 * @returns JSON 化后的值
 */
function persistedJson(value: unknown): JsonValue {
  const parsed: JsonValue = JSON.parse(JSON.stringify(value))
  return parsed
}

/**
 * 同 persistedJson，但断言结果为 JSON 对象（用于 docs 条目）。
 * @param value 原始值
 * @returns JsonObject
 */
function persistedObject(value: unknown): JsonObject {
  const parsed = persistedJson(value)
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('Expected a JSON object')
  return parsed
}

/**
 * 构造一条根会话的持久 entry。
 * @param id entry 数字 id
 * @param kind entry 类型（pi-web.user / pi.assistant / pi.tool-result 等）
 * @param model 可选的模型信息
 * @param data 可选的 entry 数据（requestId、callId 等）
 * @returns EntryRecord
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
 * 构造 ConversationView fixture。
 * @param entries 持久 entry 列表
 * @param docs 附加持久文档（pi.live / pi.inbox / pi.usage 等）
 * @returns ConversationView
 */
function view(entries: readonly EntryRecord[], docs: Record<string, JsonObject> = {}): ConversationView {
  return {
    conversation: { id: ROOT_CONVERSATION_ID },
    entries,
    docs,
  }
}

/** 会话投影主测试：run 归属、消息/队列/错误/用量投影。 */
describe('Pi Durable conversation projection', () => {
  // 验证 run 边界：steer 输入（同 taskId）跟随工具轮的 run；final answer 之后的新输入开启新 run
  // （run:start ×4 → run:next）。
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

  it('keeps an answer reply and its live continuation in the run that asked', () => {
    const replyText = JSON.stringify({ kind: 'answer_to_pending_question', callId: 'call-1', questions: [], answers: [] })
    const base = [
      entry(1, 'pi-web.user', [{ role: 'user', content: 'Start', timestamp: 100 }], { requestId: 'start' }),
      // 答复以工具调用 id 关联提问方，因此 ask 调用携带它所应答的同一个 id。
      { ...entry(2, 'pi.assistant', [assistant([{ type: 'toolCall', id: 'call-1', name: 'ask_user_question', arguments: {} }], 150, 'toolUse')]), byTaskId: 20 as TaskId },
    ]
    const live = {
      run: { taskId: 30, inputs: [999] },
      tools: [{ callId: 't1', name: 'bash', status: 'running', taskId: 30 }],
    }
    const continuation = { ...entry(3, 'pi.assistant', [assistant([{ type: 'toolCall', id: 't1', name: 'bash', arguments: { command: 'pwd' } }], 250, 'toolUse')]), byTaskId: 30 as TaskId }

    // ZCode 形态：答复、已落定续接与 live 尾部全部留在提问 run 内，
    // 回答不会在问题行后开启第二个工作块。
    const withReceipt = [
      ...base,
      entry(4, 'pi-web.user-question-reply', [{ role: 'user', content: replyText, timestamp: 200 }], { requestId: 'question-reply:call-1', callId: 'call-1' }),
      continuation,
    ]
    const projected = projectConversation(view(withReceipt, { 'pi.live': persistedObject(live) }), metadata({
      requestReceipts: { 'question-reply:call-1': { fingerprint: 'x', status: 'accepted', submissionId: 999 } },
    }), { workspace: WORKSPACE })
    expect(new Set(projected.messages.map(message => message.runId))).toEqual(new Set(['run:start']))
    expect(projected.messages.find(message => message.role === 'tool' && message.toolCallId === 't1')?.runId).toBe('run:start')

    // 映射以 call id 为键，因此 data 丢失了 requestId 的旧版答复条目仍能关联。
    const legacy = [
      ...base,
      entry(4, 'pi-web.user-question-reply', [{ role: 'user', content: replyText, timestamp: 200 }], { callId: 'call-1' }),
      continuation,
    ]
    const legacyProjected = projectConversation(view(legacy, { 'pi.live': persistedObject(live) }), metadata(), { workspace: WORKSPACE })
    expect(new Set(legacyProjected.messages.map(message => message.runId))).toEqual(new Set(['run:start']))
    expect(legacyProjected.messages.find(message => message.role === 'tool' && message.toolCallId === 't1')?.runId).toBe('run:start')

    // 提问条目消失（压缩后）时 call id 未知：答复开启自己的 run，
    // live 尾部跟随该已落定分支，而不是凭空造出第三个 run。
    const forgotten = [
      entry(1, 'pi-web.user', [{ role: 'user', content: 'Start', timestamp: 100 }], { requestId: 'start' }),
      entry(4, 'pi-web.user-question-reply', [{ role: 'user', content: replyText, timestamp: 200 }], { requestId: 'question-reply:call-1', callId: 'call-1' }),
      continuation,
    ]
    const forgottenProjected = projectConversation(view(forgotten, { 'pi.live': persistedObject(live) }), metadata({
      requestReceipts: { 'question-reply:call-1': { fingerprint: 'x', status: 'accepted', submissionId: 999 } },
    }), { workspace: WORKSPACE })
    expect(new Set(forgottenProjected.messages.map(message => message.runId))).toEqual(new Set(['run:start', 'run:question-reply:call-1']))
    expect(forgottenProjected.messages.find(message => message.role === 'tool' && message.toolCallId === 't1')?.runId).toBe('run:question-reply:call-1')
  })

  // 验证计划评审答复：plan-review-reply 留在提交计划的 run 内，执行计划的消息也在同一 run。
  it('joins a plan-review reply to the run that submitted the plan', () => {
    const reviewReply = JSON.stringify({ kind: 'answer_to_pending_question', callId: 'p1', approved: true, answers: [] })
    const entries = [
      entry(1, 'pi-web.user', [{ role: 'user', content: 'Plan it', timestamp: 100 }], { requestId: 'start' }),
      { ...entry(2, 'pi.assistant', [assistant([{ type: 'toolCall', id: 'p1', name: 'exit_plan_mode', arguments: { plan: '# Plan' } }], 150, 'toolUse')]), byTaskId: 20 as TaskId },
      entry(3, 'pi-web.plan-review-reply', [{ role: 'user', content: reviewReply, timestamp: 200 }], { requestId: 'plan-review-reply:p1', callId: 'p1' }),
      { ...entry(4, 'pi.assistant', [assistant([{ type: 'text', text: 'Executing the approved plan' }], 250)]), byTaskId: 30 as TaskId },
    ]
    const projected = projectConversation(view(entries), metadata(), { workspace: WORKSPACE })
    expect(new Set(projected.messages.map(message => message.runId))).toEqual(new Set(['run:start']))
  })

  // 验证落定消息投影：会话元信息（标题/时间/模型/运行状态）；消息 id 稳定（两次投影一致）；
  // 用户图文消息、redacted thinking 置空、私有推理与 system prompt 不外泄、
  // pi.reset 变"上下文已重置"系统消息、工具结果保留 details/isError。
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
      { type: 'text', text: 'I checked it.', slot: 0 },
      { type: 'thinking', text: '', redacted: true, slot: 1 },
      { type: 'thinking', text: 'Visible reasoning', slot: 2 },
      { type: 'toolCall', id: 'call-1', name: 'bash', arguments: { command: 'pwd' }, slot: 3 },
    ])
    expect(JSON.stringify(first.messages)).not.toContain('private reasoning')
    expect(JSON.stringify(first.messages)).not.toContain('system prompt that must not appear')
    expect(first.messages[2]).toMatchObject({ role: 'tool', toolCallId: 'call-1', toolName: 'bash', details: { exitCode: 0 }, isError: false })
    expect(first.messages[3]).toMatchObject({ role: 'system', blocks: [{ type: 'text', text: '上下文已重置' }] })
    expect(JSON.stringify(first.messages)).not.toContain('long hidden handoff text')
  })

  // 验证 live 投影：pi.agent 覆盖模型/思考级别/cwd；流式 assistant 与运行中工具（输出、诊断、
  // 丢弃字节）；inbox 队列仅收用户条目（write 模式排除）且 createdAt 分别取 queueCreatedAt 与 queuedAt；
  // 错误消息中的密钥脱敏为 [redacted]；usage 累加（模型 + 工具桶）。
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
    expect(result.messages[0]).toMatchObject({ id: 'assistant:77:900', role: 'assistant', streaming: true, timestamp: 900 })
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

  // 验证去重：live 文档中的 assistant（同内容同时间戳）与已完成工具（entry 指向已落定条目）
  // 不产生第二条消息，且没有消息残留 streaming 标记。
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

  // 验证 todos 投影：合法条目直通；content 非字符串/status 缺失/非法 status 的条目剔除；
  // items=null 视为已清空；无 todos 文档时字段整体缺席。
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

  // 验证 plan 与 interactions 投影：plan.active 直通；superseded 评审转为 continued、
  // cancelled 问题保留完整记录（问题列表/时间）、answered 评审携带 detail/标签/反馈与答案；
  // plan 文档缺失时按 inactive 投影而非丢字段。
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
    // superseded 评审读作 continued（不再有人等待）；被取消的问题集保持 cancelled，
    // 其行渲染取消记录。
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
    // 文档缺失读作 inactive，而不是丢弃字段。
    expect(projectConversation(view([]), metadata(), { workspace: WORKSPACE }).plan).toEqual({ active: false })
  })

  // 验证 subagents 投影：合法行直通；tokens 非数字/缺 updatedAt 的坏行剔除；
  // 完全没有子代理文档时字段缺席。
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
    // 完全没有子代理的会话保持字段缺席。
    expect('subagents' in projectConversation(view([]), metadata(), { workspace: WORKSPACE })).toBe(false)
  })

  // 验证用量与时长汇总：usageTokens 把四桶（含 cacheRead/cacheWrite）求和（25）；
  // 无文档 → undefined、空桶 → 0；activeDurationMs 只按 run 内首条 assistant 消息的
  // durationMs 求和（工具行自己的时长不重复计入；无 runId 的消息不计入）。
  it('sums the four usage buckets into one token total and only counts run-level assistant durations', () => {
    const input = view([], {
      'pi.usage': persistedObject({
        models: { 'test-provider/test-model': usage(10, 3, 0.2) },
        tools: { classify: { ...usage(2, 1, 0.05), cacheRead: 4, cacheWrite: 5, totalTokens: 12 } },
      }),
    })
    const projected = projectConversation(input, metadata(), { workspace: WORKSPACE })
    // Usage.totalTokens 每桶已等于 input + output + cacheRead + cacheWrite。
    expect(usageTokens(input.docs['pi.usage'])).toBe(25)
    expect(projected.usage).toEqual({ input: 12, output: 4, totalCost: 0.25 })
    expect(usageTokens(undefined)).toBeUndefined()
    expect(usageTokens({ models: {}, tools: {} })).toBe(0)

    const messages = [
      { id: 'a', role: 'assistant' as const, blocks: [], timestamp: 100, runId: 'run:1', durationMs: 2_000 },
      // 同一 run 内的工具行自带时长；不得重复计入。
      { id: 'b', role: 'tool' as const, blocks: [], timestamp: 110, runId: 'run:1', durationMs: 500 },
      { id: 'c', role: 'assistant' as const, blocks: [], timestamp: 200, runId: 'run:2', durationMs: 1_500 },
      { id: 'd', role: 'assistant' as const, blocks: [], timestamp: 300, durationMs: 9_999 },
    ]
    expect(activeDurationMs(messages)).toBe(3_500)
    expect(activeDurationMs(messages.filter(message => message.role !== 'assistant'))).toBeUndefined()
  })
})

/** 压缩（compaction）状态投影测试。 */
describe('compaction projection', () => {
  // 验证三种状态：运行中任务 + 最近失败并存 → running:true 带 failure；
  // 只有失败 → running:false；无任何压缩文档 → 字段缺席。
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

/** 压缩检查点消息的展示文案测试。 */
describe('compaction checkpoint label', () => {
  // 验证检查点投影：pi.compaction 条目渲染为"已完成上下文压缩"系统消息（systemKind=compaction），
  // 框架式 summary 原文不外泄。
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

/** assistant 内容块的 slot 标注测试。 */
describe('assistant block projection', () => {
  // 验证流式部分块：模型尚未写完的块（空 text）保留；每块带 slot（内容数组下标）。
  it('keeps the blocks the model has not written yet and stamps every block with its slot', () => {
    const partial = assistant([
      { type: 'text', text: '' },
      { type: 'thinking', thinking: 'Working' },
      { type: 'text', text: 'Done' },
    ], 900, 'pending')
    const result = projectConversation(view([], {
      'pi.live': persistedObject({
        run: { taskId: 5, inputs: [1] },
        generation: { attempt: 1, message: persistedJson(partial) },
      }),
    }), metadata(), { workspace: WORKSPACE })

    // slot 是块在模型 content 数组中的位置：Pi 只往数组追加，
    // 因此流式期间 slot 保持为块的恒定身份。
    expect(result.messages[0]?.blocks).toEqual([
      { type: 'text', text: '', slot: 0 },
      { type: 'thinking', text: 'Working', slot: 1 },
      { type: 'text', text: 'Done', slot: 2 },
    ])
  })

  // 验证落定块同样按位置标注 slot（与流式身份一致）。
  it('stamps the settled blocks with the same slots', () => {
    const settled = assistant([
      { type: 'text', text: 'Hello' },
      { type: 'toolCall', id: 'c1', name: 'read', arguments: { path: 'a.txt' } },
    ], 100, 'toolUse')
    const result = projectConversation(view([entry(1, 'pi.assistant', [settled])]), metadata(), { workspace: WORKSPACE })

    expect(result.messages[0]?.blocks).toEqual([
      { type: 'text', text: 'Hello', slot: 0 },
      { type: 'toolCall', id: 'c1', name: 'read', arguments: { path: 'a.txt' }, slot: 1 },
    ])
  })
})

/** assistant 消息 id 恒等性测试（流式 ↔ 落定对齐）。 */
describe('assistant message identity', () => {
  // 验证身份对齐：流式部分消息（assistant:5:900）与其落定后的条目 id 相同——
  // 浏览器以消息 id 作为 transcript 的键，二者必须一致才不会闪现重复。
  it('names the streaming partial and the entry it becomes the same', () => {
    const partial = assistant([{ type: 'text', text: 'Hello' }], 900, 'pending')
    const streaming = projectConversation(view([], {
      'pi.live': persistedObject({
        run: { taskId: 5, inputs: [1] },
        generation: { attempt: 1, message: persistedJson(partial) },
      }),
    }), metadata(), { workspace: WORKSPACE })

    const settled = projectConversation(view([
      { ...entry(9, 'pi.assistant', [assistant([{ type: 'text', text: 'Hello' }], 900)]), byTaskId: 5 as TaskId },
    ]), metadata(), { workspace: WORKSPACE })

    // 浏览器以消息 id 作为 transcript 的键，部分消息与落定条目必须一致：
    // Pi Durable 用写入它的任务标记条目，而该任务正是 live run 携带的任务。
    expect(streaming.messages[0]?.id).toBe('assistant:5:900')
    expect(settled.messages[0]?.id).toBe('assistant:5:900')
  })

  // 验证重试区分：同一任务写出的两条 entry（失败重试 + 最终成功）按请求时间戳区分 id。
  it('separates the two entries a retrying task writes', () => {
    const failed = assistant([{ type: 'text', text: 'Retrying' }], 900, 'error')
    const final = assistant([{ type: 'text', text: 'Done' }], 1200)
    const result = projectConversation(view([
      { ...entry(9, 'pi.assistant', [failed]), byTaskId: 5 as TaskId },
      { ...entry(10, 'pi.assistant', [final]), byTaskId: 5 as TaskId },
    ]), metadata(), { workspace: WORKSPACE })

    // 两条 entry 由同一任务写出，区分依据是请求时间戳。
    expect(result.messages.map(message => message.id)).toEqual(['assistant:5:900', 'assistant:5:1200'])
  })

  // 验证无主条目：调度器故障路径写出的 entry（无 task 归属）保留 entry id 形态。
  it('keeps the entry id for an entry no task wrote', () => {
    const orphan = assistant([{ type: 'text', text: 'Aborted' }], 900, 'aborted')
    const result = projectConversation(view([entry(9, 'pi.assistant', [orphan])]), metadata(), { workspace: WORKSPACE })

    // 调度器故障路径写 entry 时不带任务作用域，因此没有可保持身份的流式对应物。
    expect(result.messages[0]?.id).toBe('entry:9:0')
  })

  // 验证未读判定：回复时间戳晚于 seenAt → unread:true；已读时间戳追平 → 无 unread 字段。
  it('marks a settled reply newer than the last view as unread', () => {
    const entries = [entry(9, 'pi.assistant', [assistant([{ type: 'text', text: 'Done' }], 900)])]
    const unread = projectConversation(view(entries), metadata({ seenAt: 500 }), { workspace: WORKSPACE })
    const read = projectConversation(view(entries), metadata({ seenAt: 900 }), { workspace: WORKSPACE })

    expect(unread.conversation.unread).toBe(true)
    expect(read.conversation.unread).toBeUndefined()
  })

  // 验证运行中豁免：正在流式输出的回合即使晚于 seenAt 也不标 unread（busy:true、无 unread）。
  it('never marks a running turn as unread', () => {
    const partial = assistant([{ type: 'text', text: 'Working' }], 900, 'pending')
    const streaming = projectConversation(view([], {
      'pi.live': persistedObject({
        run: { taskId: 5, inputs: [1] },
        generation: { attempt: 1, message: persistedJson(partial) },
      }),
    }), metadata({ seenAt: 10 }), { workspace: WORKSPACE })

    expect(streaming.conversation.busy).toBe(true)
    expect(streaming.conversation.unread).toBeUndefined()
  })
})
