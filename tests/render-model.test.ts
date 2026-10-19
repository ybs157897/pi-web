import { describe, expect, it } from 'vitest'
import type { ChatMessage, InteractionRequest } from '../src/shared/types.ts'
import { buildRenderModel, conversationStats, reasoningDisplay } from '../src/web/render-model.ts'
import { latestPlan, planTitle } from '../src/web/plan-preview.ts'
import {
  askQuestionRowModel, buildToolRenderModel, dismissedQuestionOf, lateAnswerClipboardText, lateAnswerOf, lateAnswerRows, lateAnswerSummary, lateAnswerValues,
  subagentRowModel,
} from '../src/web/tool-render-model.ts'
import type { ToolItem } from '../src/web/render-model.ts'
import { safeWorkspaceAssetUrl, sandboxedHtml } from '../src/web/inspector-document.ts'

/** Chinese-only translator, mirroring the app's own locale switch. */
const zh = (chinese: string): string => chinese

function user(id: string, requestId: string): ChatMessage {
  return { id, requestId, role: 'user', blocks: [{ type: 'text', text: `prompt ${id}` }], timestamp: 100 }
}

function assistant(id: string, blocks: ChatMessage['blocks'], overrides: Partial<ChatMessage> = {}): ChatMessage {
  return { id, role: 'assistant', blocks, timestamp: 200, ...overrides }
}

describe('transcript render model', () => {
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

describe('late question answers', () => {
  const payload = (value: unknown): string => JSON.stringify(value)
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

  it('reads a reply payload, pairs every question, and summarizes the values', () => {
    const data = lateAnswerOf(payload(reply))
    expect(data).not.toBeNull()
    if (data === null) throw new Error('Expected a late answer')
    expect(data.callId).toBe('call-ask')
    expect(data.questions.map(question => question.id)).toEqual(['scope', 'notes'])
    expect(data.questions[0]).toMatchObject({ header: '演示范围', options: [{ label: '前端交互 (Recommended)', description: '卡片、选项与只读摘要' }, { label: '后端接口' }] })
    expect(data.questions[1]?.multiSelect).toBe(true)
    // Values keep DSH's display order: chosen labels first, then a non-blank custom answer.
    expect(lateAnswerValues(data, 'scope')).toEqual(['前端交互 (Recommended)'])
    expect(lateAnswerValues(data, 'notes')).toEqual(['补充一点', '再补充一点', '自定义说明'])
    expect(lateAnswerRows(data).map(row => row.answers)).toEqual([['前端交互 (Recommended)'], ['补充一点', '再补充一点', '自定义说明']])
    expect(lateAnswerSummary(data, zh)).toBe('前端交互 (Recommended)、补充一点、再补充一点、自定义说明')
    expect(lateAnswerClipboardText(data, zh)).toBe([
      '演示范围 — 这次问答演示要覆盖哪一层？',
      '回答：前端交互 (Recommended)',
      '',
      '还有什么补充要求？（可跳过）',
      '回答：补充一点、再补充一点、自定义说明',
    ].join('\n'))
  })

  it('marks a skipped question and a fully skipped batch with 已跳过', () => {
    const partial = lateAnswerOf(payload({
      ...reply,
      answers: [{ id: 'scope', selected: ['后端接口'] }, { id: 'notes', selected: [], custom: '   ' }],
    }))
    expect(partial).not.toBeNull()
    if (partial === null) throw new Error('Expected a late answer')
    expect(lateAnswerValues(partial, 'notes')).toEqual([])
    expect(lateAnswerRows(partial).map(row => row.answers)).toEqual([['后端接口'], []])
    expect(lateAnswerSummary(partial, zh)).toBe('后端接口、已跳过')
    expect(lateAnswerClipboardText(partial, zh)).toContain('还有什么补充要求？（可跳过）\n已跳过')

    const allSkipped = lateAnswerOf(payload({ ...reply, answers: [{ id: 'scope', selected: [] }, { id: 'notes', selected: [] }] }))
    if (allSkipped === null) throw new Error('Expected a late answer')
    expect(lateAnswerSummary(allSkipped, zh)).toBe('已跳过')
  })

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
    expect(lateAnswerValues(data, 'a')).toEqual(['x'])
  })

  it('keeps an option label the question never offered', () => {
    const data = lateAnswerOf(payload({
      kind: 'answer_to_pending_question',
      callId: 'call-ask',
      questions: [{ id: 'a', question: 'A', options: [{ label: '已知' }] }],
      answers: [{ id: 'a', selected: ['手写的外部选项'] }],
    }))
    if (data === null) throw new Error('Expected a late answer')
    expect(lateAnswerValues(data, 'a')).toEqual(['手写的外部选项'])
    expect(lateAnswerSummary(data, zh)).toBe('手写的外部选项')
  })

  it('reads only its own payload kind and keeps raw text when the payload is unreadable', () => {
    expect(lateAnswerOf('请继续')).toBeNull()
    expect(lateAnswerOf(payload({ kind: 'other', callId: 'call-ask' }))).toBeNull()
    expect(lateAnswerOf('{"kind":"answer_to_pending_question", oops')).toBeNull()
    const bare = '{ "kind": "answer_to_pending_question", "callId": "call-ask", "questions": "nope", "answers": 4, "note": "正文" }'
    const data = lateAnswerOf(bare)
    if (data === null) throw new Error('Expected a late answer')
    expect(data.questions).toEqual([])
    expect(data.answers).toEqual([])
    expect(lateAnswerSummary(data, zh)).toBe('')
    // Nothing readable to copy from the pairs, so the model-facing text is the fallback.
    expect(lateAnswerClipboardText(data, zh)).toBe(bare)
  })
})

describe('ask_user_question row model', () => {
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

  it('reports waiting progress and the question list while the call is pending', () => {
    const model = askQuestionRowModel({ name: 'ask_user_question', args, details: { status: 'pending', questions: args.questions }, failed: false }, zh)
    expect(model).toMatchObject({ title: '提问', summary: '0 / 2 · 等待回答' })
    expect(model?.record).toMatchObject({ waiting: true, items: [{ id: 'scope' }, { id: 'notes' }] })
    expect(model?.record?.items.every(item => item.answers.length === 0)).toBe(true)
  })

  it('settles the row with the late answer and pairs the skipped question', () => {
    const model = askQuestionRowModel({ name: 'ask_user_question', args, details: { status: 'pending', questions: args.questions }, failed: false, reply: reply ?? undefined }, zh)
    expect(model).toMatchObject({ title: '提问', summary: '1 / 2 · 已回答' })
    expect(model?.record).toMatchObject({
      waiting: false,
      items: [
        { id: 'scope', answers: ['前端交互 (Recommended)'] },
        { id: 'notes', answers: [] },
      ],
    })
  })

  it('answers from the result when the call recorded its own batch', () => {
    const model = askQuestionRowModel({
      name: 'ask_user_question',
      args,
      details: { status: 'answered', questions: args.questions, answers: [{ id: 'scope', selected: ['后端接口'] }, { id: 'notes', selected: [], custom: '补充' }] },
      failed: false,
    }, zh)
    expect(model?.summary).toBe('2 / 2 · 已回答')
    expect(model?.record?.items.map(item => item.answers)).toEqual([['后端接口'], ['补充']])
  })

  it('falls back to the answered count when pairing the batch would be ambiguous', () => {
    const mismatched = askQuestionRowModel({
      name: 'ask_user_question',
      args,
      details: { status: 'pending', questions: args.questions },
      failed: false,
      reply: lateAnswerOf(JSON.stringify({
        kind: 'answer_to_pending_question',
        callId: 'call-ask',
        questions: [args.questions[0]],
        answers: [{ id: 'scope', selected: ['后端接口'] }],
      })) ?? undefined,
    }, zh)
    expect(mismatched).toMatchObject({ summary: '1 / 1 · 已回答', record: null })

    const duplicated = askQuestionRowModel({
      name: 'ask_user_question',
      args,
      details: { status: 'answered', questions: args.questions, answers: [{ id: 'scope', selected: [] }, { id: 'scope', selected: ['后端接口'] }] },
      failed: false,
    }, zh)
    expect(duplicated).toMatchObject({ summary: '1 / 2 · 已回答', record: null })
  })

  it('keeps the count summary when the call records answers but no readable questions', () => {
    const model = askQuestionRowModel({
      name: 'ask_user_question',
      args: { questions: [{ id: 'scope', question: 7 }] },
      details: { status: 'answered', answers: [{ id: 'scope', selected: ['后端接口'] }] },
      failed: false,
    }, zh)
    expect(model).toMatchObject({ summary: '1 / 1 · 已回答', record: null })
  })

  it('reads the questions from the result when the arguments lost them', () => {
    const model = askQuestionRowModel({ name: 'ask_user_question', args: {}, details: { status: 'pending', questions: args.questions }, failed: false, reply: reply ?? undefined }, zh)
    expect(model?.record?.items).toHaveLength(2)
    expect(model?.summary).toBe('1 / 2 · 已回答')
  })

  it('names the failure and ignores every other tool', () => {
    expect(askQuestionRowModel({ name: 'ask_user_question', args, details: { status: 'pending', questions: args.questions }, failed: true }, zh))
      .toEqual({ title: '提问', summary: '提问失败', record: null })
    expect(askQuestionRowModel({ name: 'bash', args, details: undefined, failed: false }, zh)).toBeNull()
    expect(askQuestionRowModel({ name: 'request_user_input', args, details: { status: 'pending' }, failed: false }, zh))
      .toMatchObject({ title: '提问', summary: '0 / 2 · 等待回答' })
  })

  it('reads the projected interaction state: waiting, continued, closed, cancelled', () => {
    const base = { name: 'ask_user_question', args, details: { status: 'pending', questions: args.questions }, failed: false }
    // The live call still waits for its answer.
    expect(askQuestionRowModel({ ...base, status: 'pending' }, zh))
      .toMatchObject({ summary: '0 / 2 · 等待回答', record: { waiting: true } })
    // Continued: the agent moved on but the row still takes an answer (DSH `ask.pending`).
    expect(askQuestionRowModel({ ...base, status: 'continued' }, zh)).toMatchObject({
      summary: '已继续工作，仍可回答',
      record: { waiting: true, verdict: '等待中的问题仍可在输入框中回答' },
    })
    // Closed: the question expired without an answer (DSH `ask.closed`).
    expect(askQuestionRowModel({ ...base, status: 'expired' }, zh)).toMatchObject({
      summary: '已结束',
      record: { waiting: true, verdict: '该问题已结束，结果见下方对话' },
    })
    // Cancelled: the user gave up the whole set (DSH `ASK_CANCELLED`).
    expect(askQuestionRowModel({ ...base, status: 'cancelled' }, zh)).toMatchObject({
      summary: '已取消',
      record: { waiting: true, verdict: '本轮已取消，未提交回答' },
    })
    // Answered settles regardless of the result text still reading as pending.
    expect(askQuestionRowModel({ ...base, status: 'answered' }, zh)).toMatchObject({ summary: '已回答', record: null })
    // Without the projected list the row keeps its result-only reading.
    expect(askQuestionRowModel(base, zh)).toMatchObject({ summary: '0 / 2 · 等待回答' })
  })
})

describe('dismissed question payloads', () => {
  it('recognizes only its own kind and keeps the model-facing text', () => {
    const payload = JSON.stringify({ kind: 'dismissed_pending_question', callId: 'call-ask', questions: [], instruction: 'Do not ask again.' })
    expect(dismissedQuestionOf(payload)).toMatchObject({ callId: 'call-ask', text: payload })
    expect(dismissedQuestionOf('普通消息')).toBeNull()
    expect(dismissedQuestionOf(JSON.stringify({ kind: 'answer_to_pending_question', callId: 'call-ask' }))).toBeNull()
    expect(dismissedQuestionOf('{"kind":"dismissed_pending_question", oops')).toBeNull()
  })
})

describe('subagent row model', () => {
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
      task: '归纳子智能体一期机制',
    })
  })

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

describe('plan preview model', () => {
  const review = (id: string, detail: string, createdAt: number, status: InteractionRequest['status'] = 'pending'): InteractionRequest =>
    ({ id, kind: 'plan-review', status, detail, approveLabel: '同意执行', createdAt })

  it('reads the newest plan review, including superseded ones, and its title', () => {
    const interactions: InteractionRequest[] = [
      review('call-a', '# 第一版\n\n步骤一', 10, 'continued'),
      review('call-b', '# 第二版\n\n步骤二', 20),
      { id: 'call-q', kind: 'question', status: 'pending', questions: [], createdAt: 30 },
    ]
    expect(latestPlan(interactions, [])).toEqual({ markdown: '# 第二版\n\n步骤二', title: '第二版', key: 'call-b', pending: true })
  })

  it('falls back to the last exit_plan_mode call still in the transcript', () => {
    const messages: ChatMessage[] = [
      assistant('a-1', [{ type: 'toolCall', id: 'call-old', name: 'exit_plan_mode', arguments: { plan: '# 旧计划' } }]),
      assistant('a-2', [{ type: 'toolCall', id: 'call-new', name: 'exit_plan_mode', arguments: { plan: '# 新计划\n\n步骤' } }]),
      assistant('a-3', [{ type: 'text', text: '已提交' }]),
    ]
    expect(latestPlan(undefined, messages)).toEqual({ markdown: '# 新计划\n\n步骤', title: '新计划', key: 'call-new', pending: false })
  })

  it('ignores empty plans, other tools, and missing sources', () => {
    expect(latestPlan([review('call-empty', '   ', 10)], [])).toBeUndefined()
    expect(latestPlan([], [assistant('a-1', [{ type: 'toolCall', id: 'call-bash', name: 'bash', arguments: { plan: '# 不是计划' } }])])).toBeUndefined()
    expect(latestPlan(undefined, [])).toBeUndefined()
    expect(latestPlan([review('call-no-heading', '没有标题', 1)], [])).toEqual({ markdown: '没有标题', key: 'call-no-heading', pending: true })
  })

  it('derives the title from the first level-1 heading only', () => {
    expect(planTitle('前言\n\n# 标题 A\n\n## 小节')).toBe('标题 A')
    expect(planTitle('## 只有二级标题')).toBeUndefined()
    expect(planTitle('#   ')).toBeUndefined()
  })
})

describe('conversation stats', () => {
  const cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }

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
})
