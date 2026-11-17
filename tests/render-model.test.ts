/**
 * 会话渲染模型（render-model / tool-render-model / plan-preview）测试。
 *
 * 关键契约：
 * - buildRenderModel 按用户请求分 run，process（reasoning/tool/content/user）/responses
 *   布局随交互状态变化：提问 pending 时正文留在工作组，答复解决后才晋升、且间隙帧不"复活"；
 *   嵌套工具按 parentToolCallId 挂树；steer 消息保持记录位置；error/cancelled 区分；
 *   redacted thinking 不外泄；未知工具 details 容错回退通用卡；
 * - DSH 卡片选取（命令/读取/编辑/搜索/网络）按 recorded 字段判定；沙箱 HTML 预览 CSP、
 *   资产链接只放行本机 workspace API；
 * - 行级模型：ask_user_question 的问/答配对（含畸形数据丢弃、歧义不配对）、subagent/
 *   codemode/MCP 行标题与实时细节；计划预览取最新/回退 exit_plan_mode/列表新→旧去重；
 * - 会话统计每回合计一次用量、输出速率只按 requestDurationMs 的模型时间；
 * - system 行按 run 归属/时间线插位、稳定 key、恰好渲染一次；
 * - 尾部加载指示器只在会话运行且无阻塞时显示；
 * - 流式布局：slot 作块身份（后写入的块不挤动前面的块）、空块丢弃、工具行 live↔settled 同 key。
 */
import { describe, expect, it } from 'vitest'
import type { ChatMessage, InteractionRequest } from '../src/shared/types.ts'
import {
  buildRenderModel, conversationStats, interactionBlocksTurnLoading, reasoningDisplay, toolActivity, turnChatLoadingVisible,
  visibleTranscriptMessages,
} from '../src/web/render-model.ts'
import { latestPlan, planTitle, sessionPlans } from '../src/web/plan-preview.ts'
import {
  askQuestionRowModel, buildToolRenderModel, codemodeRowModel, lateAnswerOf, subagentRowModel, toolLiveDetail, toolRowTitle,
} from '../src/web/tool-render-model.ts'
import { isInteractionPayloadText } from '../src/web/interaction-payload.ts'
import type { ToolItem } from '../src/web/render-model.ts'
import { safeWorkspaceAssetUrl, sandboxedHtml } from '../src/web/inspector-document.ts'

/** 中文直通翻译器，镜像应用自身的 locale 开关。 */
const zh = (chinese: string): string => chinese

/**
 * 构造用户消息 fixture。
 * @param id 消息 id
 * @param requestId 请求 id
 * @returns ChatMessage（role=user）
 */
function user(id: string, requestId: string): ChatMessage {
  return { id, requestId, role: 'user', blocks: [{ type: 'text', text: `prompt ${id}` }], timestamp: 100 }
}

/**
 * 构造 assistant 消息 fixture。
 * @param id 消息 id
 * @param blocks 内容块
 * @param overrides 覆盖字段（runId/status/streaming 等）
 * @returns ChatMessage（role=assistant）
 */
function assistant(id: string, blocks: ChatMessage['blocks'], overrides: Partial<ChatMessage> = {}): ChatMessage {
  return { id, role: 'assistant', blocks, timestamp: 200, ...overrides }
}

/** 会话渲染模型的主测试（run 分组、布局、交互晋升、行模型、计划预览等）。 */
describe('transcript render model', () => {
  // 验证基础分组：两个用户请求 → 两个 run；run 内 process 顺序 reasoning → tool、
  // 工具结果挂到对应调用、正文进 responses；第二个 run 记录自己的用户消息。
  it('groups each user run and preserves reasoning, tool, and answer order', () => {
    const messages: ChatMessage[] = [
      user('user-1', 'request-1'),
      assistant('assistant-1', [
        { type: 'thinking', text: 'Need to inspect the file' },
        { type: 'toolCall', id: 'call-1', name: 'read', arguments: { path: 'hello.txt' } },
      ], { runId: 'run-1', status: 'completed' }),
      { id: 'tool-1', role: 'tool', blocks: [{ type: 'text', text: 'Hello' }], timestamp: 300,
        runId: 'run-1', toolCallId: 'call-1', toolName: 'read' },
      assistant('assistant-2', [{ type: 'text', text: 'The file says hello.' }], { runId: 'run-1', status: 'completed' }),
      user('user-2', 'request-2'),
      assistant('assistant-3', [{ type: 'text', text: 'Done.' }], { runId: 'run-2', status: 'completed' }),
    ]

    const result = buildRenderModel(messages)

    expect(result.runs).toHaveLength(2)
    expect(result.runs[0]).toMatchObject({ key: 'run:request-1', runId: 'run-1', status: 'completed' })
    expect(result.runs[0]?.process.map(part => part.kind)).toEqual(['reasoning', 'tool'])
    expect(result.runs[0]?.process[1]).toMatchObject({ kind: 'tool', item: { key: 'tool:call-1', result: { id: 'tool-1' } } })
    expect(result.runs[0]?.responses.map(response => response.key)).toEqual(['assistant-2:response'])
    expect(result.runs[1]?.users.map(message => message.id)).toEqual(['user-2'])
  })

  it('demotes the settled answer while a newer generation streams its thinking', () => {
    const base: ChatMessage[] = [
      user('user-1', 'request-1'),
      assistant('assistant-1', [{ type: 'text', text: 'Working on it.' }], { runId: 'run-1', status: 'completed', timestamp: 200 }),
    ]
    // live 回合目前只有 thinking：旧正文必须排在 live reasoning 行之前，
    // transcript 永远不会在已完成的答案上方显示活跃的思考。
    const streaming = buildRenderModel([
      ...base,
      assistant('assistant-2', [{ type: 'thinking', text: 'I will structure the answer next.' }],
        { runId: 'run-1', streaming: true, status: 'running', timestamp: 300 }),
    ])
    const run = streaming.runs[0]!
    expect(run.process.map(part => part.kind)).toEqual(['content', 'reasoning'])
    expect(run.responses).toEqual([])

    // live 回合写出正文后接管答案区；旧正文留在 process。
    const writing = buildRenderModel([
      ...base,
      assistant('assistant-2', [
        { type: 'thinking', text: 'I will structure the answer next.' },
        { type: 'text', text: 'Here is the answer.' },
      ], { runId: 'run-1', streaming: true, status: 'running', timestamp: 300 }),
    ])
    expect(writing.runs[0]!.responses.map(response => response.message.id)).toEqual(['assistant-2'])
    expect(writing.runs[0]!.process.map(part => part.kind)).toEqual(['content', 'reasoning'])
  })

  // 验证答复载荷开启新 run：不渲染用户行（载荷不是真用户输入），后续正文照常晋升。
  it('starts a run at an answer payload but renders no user row for it', () => {
    const replyText = JSON.stringify({ kind: 'answer_to_pending_question', callId: 'call-1', questions: [], answers: [] })
    const messages: ChatMessage[] = [
      user('user-1', 'request-1'),
      assistant('assistant-1', [{ type: 'text', text: 'Before the question' }], { runId: 'run-1', status: 'completed' }),
      { id: 'reply-1', role: 'user', blocks: [{ type: 'text', text: replyText }], timestamp: 250, runId: 'run-2' },
      assistant('assistant-2', [{ type: 'text', text: 'After the answer' }], { runId: 'run-2', status: 'completed' }),
    ]
    const result = buildRenderModel(messages)
    expect(result.runs).toHaveLength(2)
    expect(result.runs[1]?.users).toEqual([])
    expect(result.runs[1]?.process.some(part => part.kind === 'user')).toBe(false)
    expect(result.runs[1]?.responses.map(response => response.key)).toEqual(['assistant-2:response'])
  })

  const questionTurn = (): ChatMessage[] => [
    user('user-1', 'request-1'),
    assistant('assistant-ask', [
      { type: 'thinking', text: 'Asking what to write about.' },
      { type: 'toolCall', id: 'call-1', name: 'ask_user_question', arguments: { questions: [] } },
    ], { runId: 'run-1', status: 'completed' }),
    { id: 'tool-1', role: 'tool', blocks: [{ type: 'text', text: 'The questions are now pending.' }], timestamp: 250,
      runId: 'run-1', toolCallId: 'call-1', toolName: 'ask_user_question', details: { status: 'pending' } },
    assistant('assistant-interim', [{ type: 'text', text: '我问了三个问题，回答后我就写正文。' }], { runId: 'run-1', status: 'completed', timestamp: 300 }),
  ]
  const pendingQuestion: InteractionRequest[] = [
    { id: 'call-1', kind: 'question', status: 'pending', createdAt: 240 },
  ]

  it('keeps the post-question prose in the work group while the question waits', () => {
    const run = buildRenderModel(questionTurn(), pendingQuestion).runs[0]!
    // 回合是暂停而非结束：提前晋升过渡正文会让它在答复恢复 run 的瞬间跳进工作组。
    expect(run.responses).toEqual([])
    expect(run.process.filter(part => part.kind === 'content').map(part => part.kind === 'content' ? part.message.id : '')).toEqual(['assistant-interim'])
    // 流式中的过渡正文同样是 process 内容——永远不进答案槽。
    const streaming = buildRenderModel([
      ...questionTurn(),
      assistant('assistant-interim-live', [{ type: 'text', text: '还在补充说明' }], { runId: 'run-1', streaming: true, status: 'running', timestamp: 310 }),
    ], pendingQuestion).runs[0]!
    expect(streaming.responses).toEqual([])
    expect(streaming.process.filter(part => part.kind === 'content')).toHaveLength(2)
  })

  it('promotes only post-reply content once the interaction resolves, with no gap resurrection', () => {
    const replyText = JSON.stringify({ kind: 'answer_to_pending_question', callId: 'call-1', answers: [] })
    const reply = { id: 'reply-1', role: 'user' as const, blocks: [{ type: 'text' as const, text: replyText }], timestamp: 350, runId: 'run-1' }
    const answered: InteractionRequest[] = [{ id: 'call-1', kind: 'question', status: 'answered', createdAt: 240, answeredAt: 350 }]
    // "已回答"到续写首 token 之间的间隙帧：过渡正文不得在这些帧重新出现在答案区。
    const gap = buildRenderModel([...questionTurn(), reply], answered).runs[0]!
    expect(gap.responses).toEqual([])
    expect(gap.process.filter(part => part.kind === 'content').map(part => part.kind === 'content' ? part.message.id : '')).toEqual(['assistant-interim'])
    // 续写正文接管答案区；过渡正文留在工作组。
    const continued = buildRenderModel([
      ...questionTurn(), reply,
      assistant('assistant-final', [{ type: 'text', text: '好，那就随便聊聊。' }], { runId: 'run-1', status: 'completed', timestamp: 400 }),
    ], answered).runs[0]!
    expect(continued.responses.map(response => response.message.id)).toEqual(['assistant-final'])
    expect(continued.process.filter(part => part.kind === 'content').map(part => part.kind === 'content' ? part.message.id : '')).toEqual(['assistant-interim'])
  })

  it('keeps a pending plan review from promoting the post-plan prose', () => {
    const messages: ChatMessage[] = [
      user('user-1', 'request-1'),
      assistant('assistant-plan', [
        { type: 'text', text: '先说结论。' },
        { type: 'toolCall', id: 'call-plan', name: 'exit_plan_mode', arguments: { plan: '# Plan' } },
      ], { runId: 'run-1', status: 'completed' }),
      { id: 'tool-plan', role: 'tool', blocks: [{ type: 'text', text: 'The plan is now pending review.' }], timestamp: 250,
        runId: 'run-1', toolCallId: 'call-plan', toolName: 'exit_plan_mode', details: { status: 'pending' } },
      assistant('assistant-plan-note', [{ type: 'text', text: '计划已提交，正在等你审阅。' }], { runId: 'run-1', status: 'completed', timestamp: 300 }),
    ]
    const pendingReview: InteractionRequest[] = [{ id: 'call-plan', kind: 'plan-review', status: 'pending', createdAt: 240 }]
    expect(buildRenderModel(messages, pendingReview).runs[0]!.responses).toEqual([])
    // 没有交互记录时晋升规则不变（纯消息调用方）。
    expect(buildRenderModel(messages).runs[0]!.responses.map(response => response.message.id)).toEqual(['assistant-plan-note'])
  })

  // 验证渲染 key 稳定性：live → settled 同 run key、同 process key；工具结果不重复；
  // 落定正文进 responses、时长来自 durationMs。
  it('keeps the streaming process and settled answer on stable render keys without duplicating tool results', () => {
    const pending = user('user-live', 'request-live')
    const assistantLive = assistant('assistant-live', [
      { type: 'thinking', text: 'Checking' },
      { type: 'toolCall', id: 'call-live', name: 'bash', arguments: { command: 'pwd' } },
    ], { runId: 'run-live', streaming: true, status: 'running' })
    const live = buildRenderModel([pending, assistantLive]).runs[0]
    const settled = buildRenderModel([
      pending,
      assistant('assistant-live', [
        { type: 'thinking', text: 'Checking' },
        { type: 'toolCall', id: 'call-live', name: 'bash', arguments: { command: 'pwd' } },
      ], { runId: 'run-live', status: 'completed', durationMs: 1200 }),
      { id: 'tool-live', role: 'tool', blocks: [{ type: 'text', text: '/work' }], timestamp: 300,
        runId: 'run-live', toolCallId: 'call-live', toolName: 'bash' },
      assistant('assistant-final', [{ type: 'text', text: 'The workspace is /work.' }], { runId: 'run-live', status: 'completed' }),
    ]).runs[0]

    expect(settled?.key).toBe(live?.key)
    expect(settled?.process.map(part => part.key)).toEqual(live?.process.map(part => part.key))
    expect(settled?.process.filter(part => part.kind === 'tool')).toHaveLength(1)
    expect(settled?.responses.map(part => part.key)).toEqual(['assistant-final:response'])
    expect(settled?.durationMs).toBe(1200)
  })

  // 回归：毫秒级工具的 durationMs=0 不得把 run 级时长钉成 0（折叠头会显示「已工作 0 秒」）；
  // 全零视为未知，正时长正常取最大。
  it('treats zero message durations as unknown at the run level', () => {
    const onlyZero = buildRenderModel([
      user('user-zero', 'request-zero'),
      assistant('assistant-zero', [{ type: 'toolCall', id: 'call-zero', name: 'bash', arguments: { command: 'true' } }],
        { runId: 'run-zero', status: 'completed' }),
      { id: 'tool-zero', role: 'tool', blocks: [{ type: 'text', text: 'ok' }], timestamp: 250,
        runId: 'run-zero', toolCallId: 'call-zero', toolName: 'bash', durationMs: 0 },
    ]).runs[0]
    expect(onlyZero?.durationMs).toBeUndefined()
    const mixed = buildRenderModel([
      user('user-mixed', 'request-mixed'),
      assistant('assistant-mixed', [{ type: 'text', text: 'done' }], { runId: 'run-mixed', status: 'completed', durationMs: 4000 }),
      { id: 'tool-mixed', role: 'tool', blocks: [{ type: 'text', text: 'ok' }], timestamp: 250,
        runId: 'run-mixed', toolCallId: 'call-x', toolName: 'bash', durationMs: 0 },
    ]).runs[0]
    expect(mixed?.durationMs).toBe(4000)
  })

  // 验证嵌套工具树：子调用（parentToolCallId）挂到父调用条目下，顶层只出现一个工具行。
  it('nests child tool calls under their recorded parent call', () => {
    const result = buildRenderModel([
      user('user-nested', 'request-nested'),
      assistant('assistant-parent', [{ type: 'toolCall', id: 'call-parent', name: 'agent', arguments: {} }], { runId: 'run-nested' }),
      assistant('assistant-child', [{ type: 'toolCall', id: 'call-child', name: 'read', arguments: { path: 'a.txt' } }],
        { runId: 'run-nested', parentToolCallId: 'call-parent' }),
      { id: 'tool-parent', role: 'tool', blocks: [{ type: 'text', text: 'child started' }], timestamp: 250,
        runId: 'run-nested', toolCallId: 'call-parent', toolName: 'agent' },
      { id: 'tool-child', role: 'tool', blocks: [{ type: 'text', text: 'contents' }], timestamp: 300,
        runId: 'run-nested', toolCallId: 'call-child', toolName: 'read', parentToolCallId: 'call-parent' },
      assistant('assistant-final-nested', [{ type: 'text', text: 'Finished.' }], { runId: 'run-nested', status: 'completed' }),
    ])
    const process = result.runs[0]?.process
    const parent = process?.find(part => part.kind === 'tool')
    expect(process?.filter(part => part.kind === 'tool')).toHaveLength(1)
    expect(parent?.kind === 'tool' ? parent.item.children.map(child => child.call?.id) : []).toEqual(['call-child'])
    expect(parent?.kind === 'tool' ? parent.item.children[0]?.result?.id : undefined).toBe('tool-child')
  })

  // 验证 steer 消息位置：同 run 的第二条用户消息按记录顺序排在 process 中（reasoning 之后），
  // 且 run 的 users 列表同时含两条。
  it('keeps a steering message in its recorded position within the active run', () => {
    const result = buildRenderModel([
      { ...user('user-first', 'request-first'), runId: 'run-steer' },
      assistant('assistant-before-steer', [{ type: 'thinking', text: 'Working' }], { runId: 'run-steer', status: 'running' }),
      { ...user('user-steer', 'request-steer'), runId: 'run-steer' },
      assistant('assistant-after-steer', [{ type: 'text', text: 'Updated answer.' }], { runId: 'run-steer', status: 'completed' }),
    ])
    const run = result.runs[0]
    expect(run?.users.map(message => message.id)).toEqual(['user-first', 'user-steer'])
    expect(run?.process.map(part => part.kind)).toEqual(['reasoning', 'user'])
    expect(run?.process[1]).toMatchObject({ kind: 'user', message: { id: 'user-steer' } })
    expect(run?.responses).toHaveLength(1)
  })

  // 验证状态区分：assistant 级 error/cancelled 各自保留；工具级错误（isError）不污染
  // 已恢复的 run（仍为 completed）。
  it('keeps errors and cancellations distinct', () => {
    const error = buildRenderModel([user('user-error', 'request-error'), assistant('assistant-error', [], { status: 'error' })]).runs[0]
    const cancelled = buildRenderModel([user('user-stop', 'request-stop'), assistant('assistant-stop', [], { status: 'cancelled' })]).runs[0]
    const recoveredToolError = buildRenderModel([
      user('user-recovered', 'request-recovered'),
      assistant('assistant-call', [{ type: 'toolCall', id: 'call-error', name: 'read', arguments: { path: 'missing.txt' } }]),
      { id: 'tool-error', role: 'tool', blocks: [{ type: 'text', text: 'File not found' }], timestamp: 250,
        toolCallId: 'call-error', toolName: 'read', isError: true },
      assistant('assistant-recovered', [{ type: 'text', text: 'The file does not exist.' }]),
    ]).runs[0]
    expect(error?.status).toBe('error')
    expect(cancelled?.status).toBe('cancelled')
    expect(recoveredToolError?.status).toBe('completed')
  })

  // 验证 redacted thinking：reasoningDisplay 返回占位摘要 + 空正文，私有推理文本不出现在
  // 任何渲染输出中，公开正文照常进 responses。
  it('does not expose redacted thinking text to the transcript renderer', () => {
    const model = buildRenderModel([assistant('assistant-redacted', [
      { type: 'thinking', text: 'private reasoning must stay hidden', redacted: true },
      { type: 'text', text: 'Public answer.' },
    ], { status: 'completed' })])
    const part = model.runs[0]?.process.find(item => item.kind === 'reasoning')
    expect(part?.kind).toBe('reasoning')
    if (part?.kind !== 'reasoning') throw new Error('Expected a reasoning process item')
    const display = reasoningDisplay(part.text, part.redacted, 'Reasoning is hidden')
    expect(display).toEqual({ summary: 'Reasoning is hidden', text: '' })
    expect(JSON.stringify(display)).not.toContain('private reasoning must stay hidden')
    expect(model.runs[0]?.responses[0]?.blocks).toEqual([{ type: 'text', text: 'Public answer.' }])
  })

  // 验证容错：details 为未知形态（数组）时不抛错，回退通用卡（output=正文、knownPresentation=false）。
  it('tolerates unknown tool details without changing the normal text result', () => {
    const call = { type: 'toolCall' as const, id: 'custom-1', name: 'custom_tool', arguments: { input: 'value' } }
    const message = assistant('assistant-tool', [call], { status: 'completed' })
    const item = {
      key: 'tool:custom-1', message, call, children: [], order: 0,
      result: { id: 'tool-result', role: 'tool', blocks: [{ type: 'text', text: 'custom result' }], timestamp: 300,
        toolCallId: 'custom-1', toolName: 'custom_tool', details: ['unknown', { value: 1 }] } satisfies ChatMessage,
    }

    expect(() => buildToolRenderModel(item, (chinese) => chinese, false)).not.toThrow()
    expect(buildToolRenderModel(item, chinese => chinese, false)).toMatchObject({ output: 'custom result', knownPresentation: false })
  })

  // 验证 DSH 卡片选取：bash → 运行命令（command/output/exitCode）、read → 读取（行列表/总行数）、
  // edit → 编辑（diffs 来自 artifacts）、grep → 搜索匹配、web_search → 网络卡（answer/sources）。
  it('selects DSH command, read, diff, search, and web cards from recorded fields', () => {
    const build = (name: string, args: Record<string, unknown>, result: Partial<ChatMessage>): ReturnType<typeof buildToolRenderModel> => {
      const message = assistant(`call-message:${name}`, [{ type: 'toolCall', id: `call:${name}`, name, arguments: args }])
      const item: ToolItem = {
        key: `tool:call:${name}`,
        message,
        call: { type: 'toolCall', id: `call:${name}`, name, arguments: args },
        result: { id: `result:${name}`, role: 'tool', blocks: [], timestamp: 300, toolCallId: `call:${name}`, toolName: name, ...result },
        children: [],
        order: 0,
      }
      return buildToolRenderModel(item, chinese => chinese, false)
    }

    expect(build('bash', { command: 'pwd' }, { blocks: [{ type: 'text', text: '/workspace' }], details: { exitCode: 0 } }))
      .toMatchObject({ title: '运行命令', command: 'pwd', output: '/workspace', exitCode: 0 })
    expect(build('read', { path: 'a.ts' }, { blocks: [{ type: 'text', text: 'const a = 1' }], details: { lines: [{ number: 4, text: 'const a = 1' }], totalLines: 8 } }))
      .toMatchObject({ title: '读取', read: { lines: [{ number: 4, text: 'const a = 1' }], totalLines: 8 } })
    expect(build('edit', { path: 'a.ts' }, { artifacts: [{ kind: 'edit', path: 'a.ts', before: 'old', after: 'new' }] }))
      .toMatchObject({ title: '编辑', diffs: [{ path: 'a.ts', oldText: 'old', newText: 'new' }] })
    expect(build('grep', { pattern: 'hello' }, { blocks: [{ type: 'text', text: 'a.ts:3:hello world' }] }))
      .toMatchObject({ search: { kind: 'matches', files: [{ path: 'a.ts', matches: [{ lineNumber: 3, line: 'hello world' }] }] } })
    expect(build('web_search', { query: 'pi durable' }, { details: { sources: [{ url: 'https://example.com', title: 'Example' }], answer: 'Found one result.' } }))
      .toMatchObject({ web: { kind: 'search', answer: 'Found one result.', sources: [{ url: 'https://example.com' }] } })
  })

  // 验证沙箱防线：HTML 预览 CSP 禁外联/表单/导航、不给 allow-same-origin；
  // 资产 URL 只放行本机 /api/workspaces/ 路径（外域与 /api/settings 拒绝）。
  it('restricts HTML previews and file asset links to the isolated workspace renderer', () => {
    const preview = sandboxedHtml('<h1>preview</h1><script>window.parent.secret = true</script>')
    expect(preview).toContain("default-src 'none'")
    expect(preview).toContain("connect-src 'none'")
    expect(preview).toContain("form-action 'none'")
    expect(preview).toContain("navigate-to 'none'")
    expect(preview).toContain("script-src 'unsafe-inline'")
    expect(preview).not.toContain('allow-same-origin')
    expect(safeWorkspaceAssetUrl('/api/workspaces/w-1/asset?path=a.pdf', 'http://127.0.0.1:4317/'))
      .toBe('http://127.0.0.1:4317/api/workspaces/w-1/asset?path=a.pdf')
    expect(safeWorkspaceAssetUrl('https://example.com/a.png', 'http://127.0.0.1:4317/')).toBeUndefined()
    expect(safeWorkspaceAssetUrl('/api/settings', 'http://127.0.0.1:4317/')).toBeUndefined()
  })
})

/** 迟到问题答复（lateAnswerOf）的载荷解析测试。 */
describe('late question answers', () => {
  /** JSON 序列化辅助。 */
  const payload = (value: unknown): string => JSON.stringify(value)
  /** 完整答复 fixture：两问两答（含多选与自定义补充）。 */
  const reply = {
    kind: 'answer_to_pending_question',
    callId: 'call-ask',
    questions: [
      { id: 'scope', header: '演示范围', question: '这次问答演示要覆盖哪一层？',
        options: [{ label: '前端交互 (Recommended)', description: '卡片、选项与只读摘要' }, { label: '后端接口' }] },
      { id: 'notes', question: '还有什么补充要求？（可跳过）', multiSelect: true },
    ],
    answers: [
      { id: 'scope', selected: ['前端交互 (Recommended)'] },
      { id: 'notes', selected: ['补充一点', '再补充一点'], custom: '自定义说明' },
    ],
  }

  // 验证完整载荷解析：callId、回显的问题（header/选项/多选）与答案全部保留。
  it('reads a reply payload and keeps every echoed question and answer', () => {
    const data = lateAnswerOf(payload(reply))
    expect(data).not.toBeNull()
    if (data === null) throw new Error('Expected a late answer')
    expect(data.callId).toBe('call-ask')
    expect(data.questions.map(question => question.id)).toEqual(['scope', 'notes'])
    expect(data.questions[0]).toMatchObject({ header: '演示范围', options: [{ label: '前端交互 (Recommended)', description: '卡片、选项与只读摘要' }, { label: '后端接口' }] })
    expect(data.questions[1]?.multiSelect).toBe(true)
    expect(data.answers).toEqual([
      { id: 'scope', selected: ['前端交互 (Recommended)'] },
      { id: 'notes', selected: ['补充一点', '再补充一点'], custom: '自定义说明' },
    ])
  })

  // 验证畸形丢弃：缺 id 的问题、非对象条目、question 非字符串、答案 selected 含非字符串、
  // 缺 id/非对象条目均剔除，其余合法条目保留。
  it('drops malformed question and answer entries without losing the rest', () => {
    const data = lateAnswerOf(payload({
      kind: 'answer_to_pending_question',
      callId: 'call-ask',
      questions: [{ id: 'a', question: 'A' }, { question: 'missing id' }, 'not a record', { id: 'b', question: 7 }],
      answers: [{ id: 'a', selected: ['x', 3] }, { selected: ['y'] }, 'nope'],
    }))
    if (data === null) throw new Error('Expected a late answer')
    expect(data.questions.map(question => question.id)).toEqual(['a'])
    expect(data.answers).toEqual([{ id: 'a', selected: ['x'] }])
  })

  // 验证宽容性：答案选了问题未提供的选项（外部手写）时原样保留，不做白名单过滤。
  it('keeps an option label the question never offered', () => {
    const data = lateAnswerOf(payload({
      kind: 'answer_to_pending_question',
      callId: 'call-ask',
      questions: [{ id: 'a', question: 'A', options: [{ label: '已知' }] }],
      answers: [{ id: 'a', selected: ['手写的外部选项'] }],
    }))
    if (data === null) throw new Error('Expected a late answer')
    expect(data.answers[0]?.selected).toEqual(['手写的外部选项'])
  })

  // 验证载荷识别边界：普通文本、其他 kind、损坏 JSON 均 null；
  // questions/answers 类型错误时按空数组解析（其余字段照常）。
  it('reads only its own payload kind', () => {
    expect(lateAnswerOf('请继续')).toBeNull()
    expect(lateAnswerOf(payload({ kind: 'other', callId: 'call-ask' }))).toBeNull()
    expect(lateAnswerOf('{"kind":"answer_to_pending_question", oops')).toBeNull()
    const bare = '{ "kind": "answer_to_pending_question", "callId": "call-ask", "questions": "nope", "answers": 4, "note": "正文" }'
    const data = lateAnswerOf(bare)
    if (data === null) throw new Error('Expected a late answer')
    expect(data.questions).toEqual([])
    expect(data.answers).toEqual([])
  })
})

/** ask_user_question 工具行的行级模型测试（等待/已问/配对记录）。 */
describe('ask_user_question row model', () => {
  /** 问题参数 fixture：两问（单选 + 开放补充）。 */
  const args = {
    questions: [
      { id: 'scope', header: '演示范围', question: '这次问答演示要覆盖哪一层？', options: [{ label: '前端交互 (Recommended)' }, { label: '后端接口' }] },
      { id: 'notes', question: '还有什么补充要求？（可跳过）' },
    ],
  }
  const reply = lateAnswerOf(JSON.stringify({
    kind: 'answer_to_pending_question',
    callId: 'call-ask',
    questions: args.questions,
    answers: [{ id: 'scope', selected: ['前端交互 (Recommended)'] }, { id: 'notes', selected: [] }],
  }))
  const base = { name: 'ask_user_question', args, details: { status: 'pending', questions: args.questions }, failed: false }

  // 验证等待态：pending/running（含隐式）都渲染单行"正在询问"、无正文记录。
  it('stays one asking line with no body while the question waits', () => {
    expect(askQuestionRowModel(base, zh)).toEqual({ title: '正在询问', summary: '', record: null })
    expect(askQuestionRowModel({ ...base, status: 'pending' }, zh)).toEqual({ title: '正在询问', summary: '', record: null })
    expect(askQuestionRowModel({ ...base, running: true }, zh)).toEqual({ title: '正在询问', summary: '', record: null })
  })

  // 验证落定形态（ZCode 风格）：标题"已询问"、摘要"2 个问题"、记录按问题-答案配对
  // （未答的问题也保留、answers 为空数组）。
  it('settles into ZCode\'s asked line: the question count plus the paired record', () => {
    const model = askQuestionRowModel({ ...base, reply: reply ?? undefined }, zh)
    expect(model).toEqual({
      title: '已询问',
      summary: '2 个问题',
      record: {
        items: [
          { id: 'scope', question: '这次问答演示要覆盖哪一层？', answers: ['前端交互 (Recommended)'] },
          { id: 'notes', question: '还有什么补充要求？（可跳过）', answers: [] },
        ],
      },
    })
  })

  // 验证结果侧答案：details 里自带 answers（旧数据形态）时用它配对，custom 文本并入答案。
  it('answers from the result when the call recorded its own batch', () => {
    const model = askQuestionRowModel({
      ...base,
      details: { status: 'answered', questions: args.questions, answers: [{ id: 'scope', selected: ['后端接口'] }, { id: 'notes', selected: [], custom: '补充' }] },
    }, zh)
    expect(model?.title).toBe('已询问')
    expect(model?.summary).toBe('2 个问题')
    expect(model?.record?.items.map(item => item.answers)).toEqual([['后端接口'], ['补充']])
  })

  // 验证配对歧义兜底：答复的问题集与参数不一致、或答案 id 重复时，只显示计数行不渲染配对记录。
  it('keeps a count line without a record when pairing would be ambiguous', () => {
    const mismatched = askQuestionRowModel({
      ...base,
      reply: lateAnswerOf(JSON.stringify({
        kind: 'answer_to_pending_question',
        callId: 'call-ask',
        questions: [args.questions[0]],
        answers: [{ id: 'scope', selected: ['后端接口'] }],
      })) ?? undefined,
    }, zh)
    expect(mismatched).toEqual({ title: '已询问', summary: '2 个问题', record: null })

    const duplicated = askQuestionRowModel({
      ...base,
      details: { status: 'answered', questions: args.questions, answers: [{ id: 'scope', selected: [] }, { id: 'scope', selected: ['后端接口'] }] },
    }, zh)
    expect(duplicated).toEqual({ title: '已询问', summary: '2 个问题', record: null })
  })

  // 验证无可读问题：参数 question 非字符串且结果无问题时，标题落定但没有摘要与记录。
  it('has no question line when neither the arguments nor the result carry readable questions', () => {
    const model = askQuestionRowModel({
      ...base,
      args: { questions: [{ id: 'scope', question: 7 }] },
      details: { status: 'answered', answers: [{ id: 'scope', selected: ['后端接口'] }] },
    }, zh)
    expect(model).toEqual({ title: '已询问', summary: '', record: null })
  })

  // 验证问题来源回退：参数缺 questions 时从结果 details 读（计数与配对照常）。
  it('reads the questions from the result when the arguments lost them', () => {
    const model = askQuestionRowModel({ ...base, args: {}, reply: reply ?? undefined }, zh)
    expect(model?.record?.items).toHaveLength(2)
    expect(model?.summary).toBe('2 个问题')
  })

  // 验证失败与其他工具：失败时标题仍是"已询问"但摘要为"提问失败"、问题保留答案为空；
  // 非 ask/request_user_input 的工具返回 null；request_user_input 一样按询问行渲染。
  it('names the failure, keeps its questions, and ignores every other tool', () => {
    const failed = askQuestionRowModel({ ...base, failed: true }, zh)
    expect(failed?.title).toBe('已询问')
    expect(failed?.summary).toBe('提问失败')
    expect(failed?.record?.items.map(item => item.answers)).toEqual([[], []])
    expect(askQuestionRowModel({ name: 'bash', args, details: undefined, failed: false }, zh)).toBeNull()
    expect(askQuestionRowModel({ name: 'request_user_input', args, details: { status: 'pending' }, failed: false }, zh))
      .toEqual({ title: '正在询问', summary: '', record: null })
  })

  // 验证终态映射：continued/expired/cancelled 一律"未回答，已自动继续"；answered 显示计数。
  it('treats a settled set without answers as continued, and an answered set as asked', () => {
    for (const status of ['continued', 'expired', 'cancelled'] as const) {
      const model = askQuestionRowModel({ ...base, status }, zh)
      expect(model).toMatchObject({ title: '已询问', summary: '未回答，已自动继续' })
      expect(model?.record?.items.every(item => item.answers.length === 0)).toBe(true)
    }
    expect(askQuestionRowModel({ ...base, status: 'answered' }, zh))
      .toEqual({ title: '已询问', summary: '2 个问题', record: null })
  })
})

/** 交互载荷文本识别（isInteractionPayloadText）测试。 */
describe('interaction payload detection', () => {
  // 验证识别边界：只认运行时序列化的 answer/dismissed 两种 kind 的纯 JSON 文本；
  // 普通消息、其他 kind、夹在正文中的 JSON 都不认。
  it('recognizes only the runtime\'s serialized answer and dismissal payloads', () => {
    expect(isInteractionPayloadText(JSON.stringify({ kind: 'answer_to_pending_question', callId: 'call-ask' }))).toBe(true)
    expect(isInteractionPayloadText(JSON.stringify({ kind: 'dismissed_pending_question', callId: 'call-ask' }))).toBe(true)
    expect(isInteractionPayloadText('普通消息')).toBe(false)
    expect(isInteractionPayloadText('{"kind":"other","callId":"call-ask"}')).toBe(false)
    expect(isInteractionPayloadText('帮我看看 {"kind":"answer_to_pending_question"}')).toBe(false)
  })
})

/** subagent 工具行的行级模型测试。 */
describe('subagent row model', () => {
  // 验证启动回执：标题"子智能体"、摘要含标签与子会话 id、携带 task/label/childId。
  it('renders the started receipt with the label and child conversation', () => {
    const model = subagentRowModel({
      name: 'subagent',
      args: { task: '归纳子智能体一期机制', label: '机制归纳' },
      details: { conversationId: '345', status: 'completed', label: '机制归纳' },
      failed: false,
    }, zh)
    expect(model).toEqual({
      title: '子智能体',
      summary: '已开始子智能体 · 机制归纳 · 345',
      childId: '345',
      label: '机制归纳',
      task: '归纳子智能体一期机制',
    })
  })

  // 验证 live 投影形态：载荷在 details.result 下时同样读出 childId 与 label。
  it('reads the live projection shape, where the payload sits under result', () => {
    expect(subagentRowModel({
      name: 'subagent',
      args: { task: '写春天' },
      details: { status: 'running', result: { conversationId: 'child-a', status: 'running', label: 'spring' } },
      failed: false,
    }, zh)).toMatchObject({ childId: 'child-a', label: 'spring' })
  })

  // 验证缺标签兜底（摘要只含 id）、无 details 失败态兜底、其他工具返回 null。
  it('keeps the child id when the label is missing and ignores every other tool', () => {
    expect(subagentRowModel({
      name: 'subagent',
      args: { task: '复核清单' },
      details: { conversationId: '77', status: 'running' },
      failed: false,
    }, zh)).toMatchObject({ summary: '已开始子智能体 · 77', childId: '77' })
    expect(subagentRowModel({
      name: 'subagent', args: {}, details: undefined, failed: true,
    }, zh)).toMatchObject({ title: '子智能体', summary: '已开始子智能体' })
    expect(subagentRowModel({ name: 'bash', args: {}, details: undefined, failed: false }, zh)).toBeNull()
  })
})

/** codemode 工具行的行级模型测试。 */
describe('codemode row model', () => {
  /** 脚本样本。 */
  const script = "const files = await tools.glob({ pattern: '*.ts' })\nconsole.log(files.length)"

  // 验证完整读取：脚本/输出/嵌套调用列表（id 字符串化、四种状态直通）/fullOutputPath。
  it('reads the script, its nested calls, and the output from the call and result', () => {
    const model = codemodeRowModel({
      name: 'codemode',
      args: { code: script },
      details: {
        calls: [
          { id: 1, name: 'glob', args: '{"pattern":"*.ts"}', status: 'ok', durationMs: 12 },
          { id: 2, name: 'read', args: '{"path":"a.ts"}', status: 'error', durationMs: 3, error: 'File not found' },
          { id: 3, name: 'write', args: '{"path":"b.ts"}', status: 'running' },
          { id: 4, name: 'bash', args: '{"command":"ls"}', status: 'cancelled', durationMs: 1000 },
        ],
        fullOutputPath: '/tmp/pi/codemode/output.txt',
      },
      output: '2 files',
    }, zh)
    expect(model).toEqual({
      title: '代码',
      summary: "const files = await tools.glob({ pattern: '*.ts' })",
      script,
      output: '2 files',
      calls: [
        { id: '1', name: 'glob', args: '{"pattern":"*.ts"}', status: 'ok', durationMs: 12 },
        { id: '2', name: 'read', args: '{"path":"a.ts"}', status: 'error', durationMs: 3, error: 'File not found' },
        { id: '3', name: 'write', args: '{"path":"b.ts"}', status: 'running' },
        { id: '4', name: 'bash', args: '{"command":"ls"}', status: 'cancelled', durationMs: 1000 },
      ],
      fullOutputPath: '/tmp/pi/codemode/output.txt',
    })
  })

  it('falls back to the ordinary tool card without a call list and ignores other tools', () => {
    // 纯调用行尚无结果 details：通用卡保持原始 JSON 可见。
    expect(codemodeRowModel({ name: 'codemode', args: { code: script }, details: undefined, output: '' }, zh)).toBeNull()
    expect(codemodeRowModel({ name: 'codemode', args: { code: script }, details: { calls: 'nope' }, output: '' }, zh)).toBeNull()
    expect(codemodeRowModel({ name: 'bash', args: {}, details: { calls: [] }, output: '' }, zh)).toBeNull()
  })

  // 验证结果侧读取：args 缺 code 时摘要用输出文本；details 为 JSON 字符串时同样解析出调用列表。
  it('reads result-only records and a JSON-string details payload', () => {
    const model = codemodeRowModel({
      name: 'codemode',
      args: {},
      output: 'Script failed after 1.2s',
      details: JSON.stringify({ calls: [{ id: 7, name: 'read', args: { path: 'x' }, status: 'ok' }] }),
    }, zh)
    expect(model).toMatchObject({ title: '代码', summary: 'Script failed after 1.2s', script: '', output: 'Script failed after 1.2s' })
    expect(model?.calls).toEqual([{ id: '7', name: 'read', args: '{"path":"x"}', status: 'ok' }])
    expect(model?.fullOutputPath).toBeUndefined()
  })

  // 验证调用条目校验：缺 name/status、非对象条目、未知 status 全部剔除。
  it('drops call entries without a usable name or status', () => {
    const model = codemodeRowModel({
      name: 'codemode',
      args: { code: 'doSomething()' },
      details: { calls: [{ id: 1, name: 'ok', status: 'ok' }, 'nope', { name: 'missing-status' }, { id: 2, name: 'bad', status: 'mystery' }] },
      output: '',
    }, zh)
    expect(model?.calls).toEqual([{ id: '1', name: 'ok', args: '', status: 'ok' }])
  })

  it('carries the code-mode title, script live detail, and failure text into the generic row model', () => {
    const callItem = (result?: Partial<ChatMessage>): ToolItem => {
      const message = assistant('call-message:codemode', [{ type: 'toolCall', id: 'call:codemode', name: 'codemode', arguments: { code: script } }])
      return {
        key: 'tool:call:codemode',
        message,
        call: { type: 'toolCall', id: 'call:codemode', name: 'codemode', arguments: { code: script } },
        ...(result === undefined ? {} : {
          result: { id: 'result:codemode', role: 'tool' as const, blocks: [], timestamp: 300, toolCallId: 'call:codemode', toolName: 'codemode', ...result },
        }),
        children: [],
        order: 0,
      }
    }
    // 纯调用行还没有 details：通用卡仍以"代码"为标题、脚本首行为摘要。
    expect(buildToolRenderModel(callItem(), zh, false))
      .toMatchObject({ title: '代码', summary: "const files = await tools.glob({ pattern: '*.ts' })" })
    expect(buildToolRenderModel(callItem({ blocks: [{ type: 'text', text: 'Script failed' }], isError: true }), zh, false))
      .toMatchObject({ title: '代码', failed: true, errorText: 'Script failed' })
  })
})

/** MCP 工具行标题与活动分类测试。 */
describe('MCP tool rows', () => {
  // 验证 mcp__server__tool 命名拆解：标题"MCP · <server> · <tool>"、通用图标不变；
  // 其他工具保留 DSH 标题、非 MCP 形态不改写；codemode 与 run_code 同属 code 活动分类。
  it('titles an mcp__server__tool row with the server and native tool', () => {
    const name = 'mcp__github__search_repos'
    const message = assistant('call-message:mcp', [{ type: 'toolCall', id: 'call:mcp', name, arguments: {} }])
    const item: ToolItem = {
      key: 'tool:call:mcp',
      message,
      call: { type: 'toolCall', id: 'call:mcp', name, arguments: {} },
      result: { id: 'result:mcp', role: 'tool', blocks: [{ type: 'text', text: 'found one' }], timestamp: 300, toolCallId: 'call:mcp', toolName: name },
      children: [],
      order: 0,
    }
    expect(toolRowTitle(name, zh)).toBe('MCP · github · search_repos')
    // 行标题保留通用类别图标，仅措辞点名 server 与 tool。
    expect(buildToolRenderModel(item, zh, false))
      .toMatchObject({ title: 'MCP · github · search_repos', summary: 'found one' })
    expect(toolRowTitle('mcp__my_server__read_file', zh)).toBe('MCP · my_server · read_file')
    // 其他工具保留 DSH 标题；非 MCP 形态的名字不改写。
    expect(toolRowTitle('bash', zh)).toBe('运行命令')
    expect(toolRowTitle('codemode', zh)).toBe('代码')
    expect(toolRowTitle('mcp_server', zh)).toBe('工具调用')
    // Pi 的 codemode 与 DSH 的 run_code 同属"code"活动类别。
    expect(toolActivity('codemode')).toBe('code')
    expect(toolActivity('run_code')).toBe('code')
    expect(toolActivity('mcp__github__search_repos')).toBe('tools')
  })

  // 验证实时细节：codemode 取脚本首行、bash 取命令。
  it('shows the code-mode script first line as the live detail', () => {
    expect(toolLiveDetail({ code: 'const a = 1\nconst b = 2' })).toBe('const a = 1')
    expect(toolLiveDetail({ command: 'pwd' })).toBe('pwd')
  })
})

/** 计划预览模型（latestPlan/planTitle/sessionPlans）测试。 */
describe('plan preview model', () => {
  /** 构造 plan-review 交互记录 fixture。 */
  const review = (id: string, detail: string, createdAt: number, status: InteractionRequest['status'] = 'pending'): InteractionRequest =>
    ({ id, kind: 'plan-review', status, detail, approveLabel: '同意执行', createdAt })

  // 验证最新评审选取：跳过 question 类记录、含 superseded（continued）评审，标题取一级标题。
  it('reads the newest plan review, including superseded ones, and its title', () => {
    const interactions: InteractionRequest[] = [
      review('call-a', '# 第一版\n\n步骤一', 10, 'continued'),
      review('call-b', '# 第二版\n\n步骤二', 20),
      { id: 'call-q', kind: 'question', status: 'pending', questions: [], createdAt: 30 },
    ]
    expect(latestPlan(interactions, [])).toEqual({ markdown: '# 第二版\n\n步骤二', title: '第二版', key: 'call-b', pending: true })
  })

  // 验证回退来源：无交互记录时取 transcript 中最后一个 exit_plan_mode 调用（pending=false）。
  it('falls back to the last exit_plan_mode call still in the transcript', () => {
    const messages: ChatMessage[] = [
      assistant('a-1', [{ type: 'toolCall', id: 'call-old', name: 'exit_plan_mode', arguments: { plan: '# 旧计划' } }]),
      assistant('a-2', [{ type: 'toolCall', id: 'call-new', name: 'exit_plan_mode', arguments: { plan: '# 新计划\n\n步骤' } }]),
      assistant('a-3', [{ type: 'text', text: '已提交' }]),
    ]
    expect(latestPlan(undefined, messages)).toEqual({ markdown: '# 新计划\n\n步骤', title: '新计划', key: 'call-new', pending: false })
  })

  // 验证忽略条件：空白计划、bash 等其他工具的 plan 参数、两个来源都缺失 → undefined；
  // 无一级标题的计划保留正文但无 title。
  it('ignores empty plans, other tools, and missing sources', () => {
    expect(latestPlan([review('call-empty', '   ', 10)], [])).toBeUndefined()
    expect(latestPlan([], [assistant('a-1', [{ type: 'toolCall', id: 'call-bash', name: 'bash', arguments: { plan: '# 不是计划' } }])])).toBeUndefined()
    expect(latestPlan(undefined, [])).toBeUndefined()
    expect(latestPlan([review('call-no-heading', '没有标题', 1)], [])).toEqual({ markdown: '没有标题', key: 'call-no-heading', pending: true })
  })

  // 验证标题提取：只认一级标题（忽略前言与二级标题）、空白标题无效。
  it('derives the title from the first level-1 heading only', () => {
    expect(planTitle('前言\n\n# 标题 A\n\n## 小节')).toBe('标题 A')
    expect(planTitle('## 只有二级标题')).toBeUndefined()
    expect(planTitle('#   ')).toBeUndefined()
  })

  // 验证会话计划列表：所有已提交计划按新→旧排列，pending 评审的对应计划带 pending 标记；
  // bash 等非计划调用被忽略。
  it('lists every submitted plan newest first and marks the pending review', () => {
    const messages: ChatMessage[] = [
      assistant('a-1', [{ type: 'toolCall', id: 'call-old', name: 'exit_plan_mode', arguments: { plan: '# 旧计划\n\n第一步' } }], { timestamp: 10 }),
      assistant('a-2', [{ type: 'toolCall', id: 'call-new', name: 'exit_plan_mode', arguments: { plan: '# 新计划\n\n第二步' } }], { timestamp: 30 }),
      assistant('a-3', [{ type: 'toolCall', id: 'call-bash', name: 'bash', arguments: { plan: '# 不是计划' } }], { timestamp: 40 }),
    ]
    const interactions: InteractionRequest[] = [review('call-new', '# 新计划\n\n第二步', 31)]
    expect(sessionPlans(interactions, messages)).toEqual([
      { markdown: '# 新计划\n\n第二步', title: '新计划', key: 'call-new', pending: true },
      { markdown: '# 旧计划\n\n第一步', title: '旧计划', key: 'call-old' },
    ])
  })

  // 验证压缩容忍与去重：计划调用被压缩掉后评审记录独立成条；同一份计划（同 call id）
  // 在评审与 transcript 都出现时只保留一条。
  it('keeps a review whose plan call was compacted away and dedupes the same plan', () => {
    const plans = sessionPlans([review('call-gone', '# 压缩前的计划', 50, 'continued')], [])
    expect(plans).toEqual([{ markdown: '# 压缩前的计划', title: '压缩前的计划', key: 'call-gone' }])
    expect(sessionPlans([review('call-old', '# 同一份', 10, 'continued')], [
      assistant('a-1', [{ type: 'toolCall', id: 'call-old', name: 'exit_plan_mode', arguments: { plan: '# 同一份' } }], { timestamp: 11 }),
    ])).toEqual([{ markdown: '# 同一份', title: '同一份', key: 'call-old' }])
  })
})

/** 会话统计（conversationStats）测试。 */
describe('conversation stats', () => {
  /** 零费用 cost fixture。 */
  const cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }

  // 验证用量汇总：usage 只出现在每回合的末条 assistant 上（每回合计一次）；
  // 四桶求和、contextTokens 取最新回合的 totalTokens；空会话全零。
  it('sums usage once per turn and prices the window from the latest turn', () => {
    const messages: ChatMessage[] = [
      { ...user('user-1', 'request-1'), runId: 'run-1' },
      assistant('assistant-1', [{ type: 'toolCall', id: 'call-1', name: 'bash', arguments: {} }], { runId: 'run-1' }),
      { id: 'tool-1', role: 'tool', blocks: [{ type: 'text', text: 'ok' }], timestamp: 300, runId: 'run-1',
        toolCallId: 'call-1', toolName: 'bash' },
      assistant('assistant-2', [{ type: 'text', text: 'done' }], { runId: 'run-1',
        usage: { input: 100, output: 40, cacheRead: 600, cacheWrite: 20, totalTokens: 760, cost } }),
      { ...user('user-2', 'request-2'), runId: 'run-2' },
      assistant('assistant-3', [{ type: 'text', text: 'again' }], { runId: 'run-2',
        usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost } }),
    ]

    expect(conversationStats(messages)).toEqual({
      runCount: 2,
      stepCount: 4,
      input: 110,
      output: 45,
      cacheRead: 600,
      cacheWrite: 20,
      totalTokens: 775,
      contextTokens: 15,
    })
    expect(conversationStats([])).toMatchObject({ runCount: 0, totalTokens: 0, contextTokens: 0 })
  })

  it('computes output rate from per-request model time only, ignoring messages without one', () => {
    const messages: ChatMessage[] = [
      { ...user('user-1', 'request-1'), runId: 'run-1' },
      // 工具密集回合：run 级 durationMs 覆盖工具耗时，不得进入速率计算。
      assistant('assistant-1', [{ type: 'toolCall', id: 'call-1', name: 'bash', arguments: {} }], { runId: 'run-1', durationMs: 60_000,
        usage: { input: 10, output: 100, cacheRead: 0, cacheWrite: 0, totalTokens: 110, cost } }),
      { id: 'tool-1', role: 'tool', blocks: [{ type: 'text', text: 'ok' }], timestamp: 300, runId: 'run-1',
        toolCallId: 'call-1', toolName: 'bash' },
      assistant('assistant-2', [{ type: 'text', text: 'final' }], { runId: 'run-1', durationMs: 30_000, requestDurationMs: 5_000,
        usage: { input: 10, output: 20, cacheRead: 0, cacheWrite: 0, totalTokens: 30, cost } }),
      { ...user('user-2', 'request-2'), runId: 'run-2' },
      // 缺 requestDurationMs 的旧消息对速率的分子分母都不贡献。
      assistant('assistant-3', [{ type: 'text', text: 'again' }], { runId: 'run-2',
        usage: { input: 5, output: 30, cacheRead: 0, cacheWrite: 0, totalTokens: 35, cost } }),
    ]

    // 5 秒模型时间里产出 20 token；工具密集回合的 100 token 不参与。
    expect(conversationStats(messages)).toMatchObject({ output: 150, tokensPerSecond: 4 })
  })
})


/** 可见消息过滤（visibleTranscriptMessages）测试。 */
describe('visible transcript messages', () => {
  // 验证压缩行可见性：新压缩进行中时旧的"已完成上下文压缩"行隐藏（reset 行保留）；
  // 非压缩运行时原样返回消息数组。
  it('hides completed compaction rows only while a new compaction runs', () => {
    const messages: ChatMessage[] = [
      user('user-1', 'request-1'),
      { id: 'compaction', role: 'system', systemKind: 'compaction', blocks: [{ type: 'text', text: '已完成上下文压缩' }], timestamp: 300 },
      { id: 'reset', role: 'system', systemKind: 'reset', blocks: [{ type: 'text', text: '上下文已重置' }], timestamp: 400 },
    ]
    expect(visibleTranscriptMessages(messages, true).map(message => message.id)).toEqual(['user-1', 'reset'])
    expect(visibleTranscriptMessages(messages, false)).toBe(messages)
  })
})

/** system 行在 transcript 中的归位与时间线测试。 */
describe('system rows in the transcript', () => {
  /** 构造 compaction 系统行 fixture（可带 runId）。 */
  const system = (id: string, timestamp: number, runId?: string): ChatMessage => ({
    id, role: 'system', systemKind: 'compaction', blocks: [{ type: 'text', text: '已完成上下文压缩' }],
    timestamp, ...(runId === undefined ? {} : { runId }),
  })

  /** 构造一个最小回合（用户 + assistant 正文）。 */
  const turn = (id: string, runId: string, text: string, timestamp: number): ChatMessage[] => [
    { ...user(`user-${id}`, `request-${id}`), runId, timestamp },
    assistant(`assistant-${id}`, [{ type: 'text', text }], { runId, status: 'completed', timestamp }),
  ]

  it('files a system row inside the run that recorded it', () => {
    const model = buildRenderModel([...turn('1', 'run-1', '一', 200), system('compaction-1', 300, 'run-1')])

    expect(model.runs[0]?.systemRows.map(row => row.key)).toEqual(['system:compaction-1'])
    expect(model.runs[0]?.systemRows[0]?.message.id).toBe('compaction-1')
    // 行跟随答案，因此 transcript 渲染在回复之下。
    expect(model.runs[0]?.systemRows[0]?.beforeAnswer).toBe(false)
    expect(model.timeline.map(entry => entry.kind)).toEqual(['run'])
  })

  // 验证答案前系统行：出现在答案之前时 beforeAnswer=true（渲染在回复上方）。
  it('keeps a system row that came before the answer above that answer', () => {
    const model = buildRenderModel([
      { ...user('user-1', 'request-1'), runId: 'run-1', timestamp: 100 },
      system('compaction-1', 150, 'run-1'),
      assistant('assistant-1', [{ type: 'text', text: '一' }], { runId: 'run-1', status: 'completed', timestamp: 200 }),
    ])

    expect(model.runs[0]?.systemRows.map(row => row.beforeAnswer)).toEqual([true])
  })

  // 验证无 run 系统行：按自身时间戳落在两个 run 之间的 timeline 上，不进任何 run 的 systemRows。
  it('places a system row without a run between the runs, by its own timestamp', () => {
    const model = buildRenderModel([
      ...turn('1', 'run-1', '一', 200),
      system('compaction-1', 300),
      ...turn('2', 'run-2', '二', 400),
    ])

    expect(model.timeline.map(entry => entry.kind)).toEqual(['run', 'system', 'run'])
    const loose = model.timeline[1]
    expect(loose?.kind === 'system' ? loose.row.message.id : undefined).toBe('compaction-1')
    expect(model.runs[0]?.systemRows).toEqual([])
    expect(model.runs[1]?.systemRows).toEqual([])
  })

  // 验证早于所有 run 的无主系统行：排在 timeline 最前。
  it('keeps a system row without a run before every run when it predates them', () => {
    const model = buildRenderModel([system('reset-1', 10), ...turn('1', 'run-1', '一', 200)])

    expect(model.timeline.map(entry => entry.kind)).toEqual(['system', 'run'])
    expect(model.timeline[0]?.kind === 'system' ? model.timeline[0].row.message.id : undefined).toBe('reset-1')
  })

  // 验证晚于所有 run 的无主系统行：排在 timeline 最后。
  it('keeps a system row without a run after the last run when it follows them', () => {
    const model = buildRenderModel([...turn('1', 'run-1', '一', 200), system('compaction-1', 900)])

    expect(model.timeline.map(entry => entry.kind)).toEqual(['run', 'system'])
  })

  it('keeps a row that replaced earlier history above the content that replaced it', () => {
    // 替换了当前回合之前历史的压缩行位于剩余流的开头，即便其 summary 时间戳更晚。
    const model = buildRenderModel([system('compaction-1', 900), ...turn('1', 'run-1', '一', 200)])

    expect(model.timeline.map(entry => entry.kind)).toEqual(['system', 'run'])
    expect(model.timeline[0]?.kind === 'system' ? model.timeline[0].row.message.id : undefined).toBe('compaction-1')
  })

  // 验证唯一性与稳定性：三个系统行各有唯一 key、恰好渲染一次；同一日志两次构建 timeline 顺序一致。
  it('renders every system row exactly once, with stable keys', () => {
    const messages: ChatMessage[] = [
      ...turn('1', 'run-1', '一', 200),
      system('compaction-1', 300, 'run-1'),
      ...turn('2', 'run-2', '二', 400),
      system('compaction-2', 500),
      system('compaction-3', 500),
    ]
    const model = buildRenderModel(messages)
    const rows = [
      ...model.runs.flatMap(run => run.systemRows.map(row => row.key)),
      ...model.timeline.flatMap(entry => entry.kind === 'system' ? [entry.row.key] : []),
    ]

    expect(rows.sort()).toEqual(['system:compaction-1', 'system:compaction-2', 'system:compaction-3'])
    expect(new Set(rows).size).toBe(rows.length)
    // 同一日志永远产出同一顺序，行不会在两次渲染之间跳位。
    expect(buildRenderModel(messages).timeline.map(entry => entry.kind === 'system' ? entry.row.key : entry.run.key))
      .toEqual(model.timeline.map(entry => entry.kind === 'system' ? entry.row.key : entry.run.key))
  })

  // 验证未知 run 归属：runId 指向不存在的 run 时按无主行处理（timeline 最后）。
  it('files a system row whose run is unknown with the rows that no run owns', () => {
    const model = buildRenderModel([...turn('1', 'run-1', '一', 200), system('compaction-1', 300, 'run-unknown')])

    expect(model.runs[0]?.systemRows).toEqual([])
    expect(model.timeline.map(entry => entry.kind)).toEqual(['run', 'system'])
  })
})

/** transcript 尾部加载指示器（turnChatLoadingVisible/interactionBlocksTurnLoading）测试。 */
describe('transcript tail loading indicator', () => {
  /** 空闲状态基线：未运行、无交互阻塞、无维护任务阻塞。 */
  const idle = {
    isRunning: false,
    blockedByInteraction: false,
    blockedByActiveWork: false,
  }

  it('shows the tail spinner only while the conversation runs', () => {
    expect(turnChatLoadingVisible({ ...idle, isRunning: true })).toBe(true)
    expect(turnChatLoadingVisible(idle)).toBe(false)
    // running 事实来自会话本身，跨多个工具轮持续工作的回合不会让 spinner 闪烁消失。
    expect(turnChatLoadingVisible({ ...idle, isRunning: true, blockedByInteraction: false })).toBe(true)
  })

  // 验证阻塞隐藏：维护任务（压缩）或用户输入排队时 spinner 隐藏。
  it('hides the tail spinner while a maintenance task or a user prompt blocks the turn', () => {
    expect(turnChatLoadingVisible({ ...idle, isRunning: true, blockedByActiveWork: true })).toBe(false)
    expect(turnChatLoadingVisible({ ...idle, isRunning: true, blockedByInteraction: true })).toBe(false)
  })

  // 验证交互阻塞：三类 pending 交互（approval/question/plan-review）都阻塞 spinner；
  // 无交互或空列表不阻塞。
  it('blocks the tail spinner while any pending interaction waits for the user', () => {
    const pending = (kind: InteractionRequest['kind']): InteractionRequest => ({ id: `i-${kind}`, kind, status: 'pending', createdAt: 1 })

    expect(interactionBlocksTurnLoading([pending('approval')])).toBe(true)
    expect(interactionBlocksTurnLoading([pending('question')])).toBe(true)
    expect(interactionBlocksTurnLoading([pending('plan-review')])).toBe(true)
    expect(interactionBlocksTurnLoading(undefined)).toBe(false)
    expect(interactionBlocksTurnLoading([])).toBe(false)
  })

  it('stops blocking once the interaction is settled', () => {
    const settled = (status: InteractionRequest['status']): InteractionRequest => ({ id: 'i-1', kind: 'approval', status, createdAt: 1 })

    // continued 表示权限已授予、模型继续推进。
    expect(interactionBlocksTurnLoading([settled('continued')])).toBe(false)
    expect(interactionBlocksTurnLoading([settled('answered')])).toBe(false)
    expect(interactionBlocksTurnLoading([settled('expired')])).toBe(false)
    expect(interactionBlocksTurnLoading([settled('cancelled')])).toBe(false)
  })
})

/** 流式回合布局（slot 身份、答案区归属）测试。 */
describe('streaming turn layout', () => {
  /** 回合的用户提示 fixture。 */
  const prompt: ChatMessage = { id: 'user-1', role: 'user', blocks: [{ type: 'text', text: 'hi' }], timestamp: 50, runId: 'run-1' }
  /** 构造 live assistant 消息（streaming、running、固定 id）。 */
  const live = (blocks: ChatMessage['blocks']): ChatMessage => ({
    id: 'live-assistant:task-1', role: 'assistant', blocks, timestamp: 100, streaming: true, status: 'running', runId: 'run-1',
  })

  // 验证答案区保持：流式中已写出的正文留在答案区，即使随后出现工具调用也不回流 process
  // （块原地不动，不跳屏也不丢已渲染 Markdown）。
  it('keeps the answer of a streaming turn in the answer area, also once a tool call arrives', () => {
    const beforeTool = buildRenderModel([prompt, live([
      { type: 'thinking', text: 'Checking', slot: 0 },
      { type: 'text', text: 'The file says hello.', slot: 1 },
    ])]).runs[0]
    const afterTool = buildRenderModel([prompt, live([
      { type: 'thinking', text: 'Checking', slot: 0 },
      { type: 'text', text: 'The file says hello.', slot: 1 },
      { type: 'toolCall', id: 'call-1', name: 'read', arguments: { path: 'hello.txt' }, slot: 2 },
    ])]).runs[0]

    expect(beforeTool?.responses.map(response => response.key)).toEqual(['live-assistant:task-1:response'])
    // 工具调用不会把答案送回 process 区：块保持原位，既不跳屏也不丢已渲染的 Markdown。
    expect(afterTool?.responses.map(response => response.key)).toEqual(['live-assistant:task-1:response'])
    expect(afterTool?.responses[0]?.blocks).toEqual(beforeTool?.responses[0]?.blocks)
    expect(afterTool?.process.map(part => part.kind)).toEqual(['reasoning', 'tool'])
  })

  // 验证工具轮落定：回合作为工具轮完成时（stopReason 语义），已写正文回流 process 的 content。
  it('returns the answer to the process area once the turn settles as a tool round', () => {
    const settled = buildRenderModel([prompt, {
      id: 'live-assistant:task-1', role: 'assistant', runId: 'run-1', timestamp: 100, status: 'completed',
      blocks: [
        { type: 'thinking', text: 'Checking', slot: 0 },
        { type: 'text', text: 'The file says hello.', slot: 1 },
        { type: 'toolCall', id: 'call-1', name: 'read', arguments: { path: 'hello.txt' }, slot: 2 },
      ],
    }]).runs[0]

    expect(settled?.responses).toHaveLength(0)
    expect(settled?.process.map(part => part.kind)).toEqual(['reasoning', 'content', 'tool'])
  })

  it('marks only the block the model is still writing as streaming', () => {
    const answered = buildRenderModel([prompt, live([
      { type: 'thinking', text: 'Checking', slot: 0 },
      { type: 'text', text: 'The file says hello.', slot: 1 },
    ])]).runs[0]
    const reasoning = answered?.process.find(part => part.kind === 'reasoning')
    // 答案已跟随思考出现，思考已完成、不得继续闪烁：DSH 以同一尾部为 running。
    expect(reasoning?.kind === 'reasoning' ? reasoning.streaming : undefined).toBe(false)

    const thinking = buildRenderModel([prompt, live([{ type: 'thinking', text: 'Checking', slot: 0 }])]).runs[0]
    const liveReasoning = thinking?.process.find(part => part.kind === 'reasoning')
    expect(liveReasoning?.kind === 'reasoning' ? liveReasoning.streaming : undefined).toBe(true)
  })

  // 验证子代理流：带 parentToolCallId 的流式文本属于 process content（不是 run 的答案区）。
  it('streams the text of a turn that is not the run\'s answer', () => {
    const delegated: ChatMessage = {
      id: 'live-assistant:sub-1', role: 'assistant', parentToolCallId: 'call-1', runId: 'run-1', timestamp: 100,
      streaming: true, status: 'running', blocks: [{ type: 'text', text: 'Working on it', slot: 0 }],
    }
    const run = buildRenderModel([prompt, delegated]).runs[0]
    const content = run?.process.find(part => part.kind === 'content')

    expect(content?.kind === 'content' ? content.streaming : undefined).toBe(true)
    expect(run?.responses).toHaveLength(0)
  })

  // 验证 slot 身份：reasoning 块的 key 以 slot 结尾，后续块开始写入不改变前面的 key；
  // 未写出的空块不进答案区，答案块保留自己的 slot。
  it('keys a block by its slot, so a block that starts later cannot shift the ones before it', () => {
    const unwritten = buildRenderModel([prompt, live([
      { type: 'thinking', text: 'Checking', slot: 0 },
      { type: 'text', text: '', slot: 1 },
    ])]).runs[0]
    const written = buildRenderModel([prompt, live([
      { type: 'thinking', text: 'Checking', slot: 0 },
      { type: 'text', text: 'The file says hello.', slot: 1 },
    ])]).runs[0]

    expect(unwritten?.process.find(part => part.kind === 'reasoning')?.key).toBe('live-assistant:task-1:reasoning:0')
    expect(written?.process.find(part => part.kind === 'reasoning')?.key).toBe('live-assistant:task-1:reasoning:0')
    // 模型还没写的块留在答案区之外，其后的答案块保持被推入时的 slot。
    expect(unwritten?.responses).toHaveLength(0)
    expect(written?.responses[0]?.blocks.map(block => block.slot)).toEqual([1])
  })

  // 验证空块丢弃：落定消息中尚未写出的空 text 块不渲染。
  it('drops the empty blocks the model has not written yet', () => {
    const run = buildRenderModel([prompt, {
      id: 'assistant-1', role: 'assistant', runId: 'run-1', timestamp: 100, status: 'completed',
      blocks: [{ type: 'text', text: '', slot: 0 }, { type: 'text', text: 'Hello', slot: 1 }],
    }]).runs[0]

    expect(run?.responses[0]?.blocks).toEqual([{ type: 'text', text: 'Hello', slot: 1 }])
  })
})

/**
 * 收集模型中所有工具行 key，包括嵌套子调用与分组行。
 * @param model 渲染模型
 * @returns key 列表（按出现顺序）
 */
function toolKeys(model: ReturnType<typeof buildRenderModel>): string[] {
  const keys: string[] = []
  const visit = (item: ToolItem): void => {
    keys.push(item.key)
    for (const child of item.children) visit(child)
  }
  for (const run of model.runs) {
    for (const part of run.process) {
      if (part.kind === 'tool') visit(part.item)
      if (part.kind === 'toolGroup') for (const item of part.items) visit(item)
    }
  }
  return keys
}

/** 工具行身份在 live ↔ settled 边界的一致性测试。 */
describe('tool row identity across the live to settled boundary', () => {
  /** 委派请求的用户消息 fixture。 */
  const user: ChatMessage = { id: 'user-1', requestId: 'request-1', role: 'user', blocks: [{ type: 'text', text: 'delegate' }], timestamp: 100 }
  /** live 工具结果 fixture（streaming、无对应落定条目）。 */
  const liveTool: ChatMessage = {
    id: 'live-tool:call-9', role: 'tool', blocks: [], timestamp: 120, runId: 'run-1',
    toolCallId: 'call-9', toolName: 'subagent', streaming: true, status: 'running',
  }

  // 验证 call id 身份：live 工具行与其落定对应物都用 tool:call-9（浏览器 DOM 复用不闪烁）。
  it('keys a live tool row and its settled pair by the same call id', () => {
    const liveModel = buildRenderModel([user, liveTool])
    expect(toolKeys(liveModel)).toEqual(['tool:call-9'])

    const settled: ChatMessage[] = [
      user,
      { id: 'assistant-1', role: 'assistant', runId: 'run-1', timestamp: 110, status: 'completed',
        blocks: [{ type: 'toolCall', id: 'call-9', name: 'subagent', arguments: { task: 'x' } }] },
      { id: 'tool-9', role: 'tool', blocks: [{ type: 'text', text: 'answer' }], timestamp: 130,
        runId: 'run-1', toolCallId: 'call-9', toolName: 'subagent', status: 'completed' },
    ]
    expect(toolKeys(buildRenderModel(settled))).toEqual(['tool:call-9'])
  })

  // 验证兜底：无 toolCallId 的孤儿结果用消息 id 作 key；同 callId 的重复 live 行只有第一条
  // 拿到 call key，其余退回消息 id key（不产生重复 DOM 身份）。
  it('keeps message-id keys for results without a call id, and falls back on duplicates', () => {
    const orphan: ChatMessage = { id: 'tool-orphan', role: 'tool', blocks: [{ type: 'text', text: 'x' }], timestamp: 120, runId: 'run-1' }
    expect(toolKeys(buildRenderModel([user, orphan]))).toEqual(['tool-result:tool-orphan'])

    const duplicated: ChatMessage[] = [
      user,
      { ...liveTool, id: 'live-a' },
      { ...liveTool, id: 'live-b' },
    ]
    expect(toolKeys(buildRenderModel(duplicated))).toEqual(['tool:call-9', 'tool-result:live-b'])
  })
})
