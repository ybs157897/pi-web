import { describe, expect, it } from 'vitest'
import { buildCallCards, parseTrajectory, summarizeCalls } from '../src/web/trajectory-view.ts'

/**
 * 轨迹查看器（trajectory-view）纯函数契约测试：JSONL 解析的行过滤与容错、
 * 请求/响应配对成调用卡片（含消息整形与 token/耗时提取）、时间线汇总。
 */

/**
 * 构造贴近 pi-ai AssistantMessage 形状的助手消息（capture 记录的原样形状）。
 * @param overrides 覆盖默认字段（content/stopReason/usage 等）
 * @returns 默认 usage 120/45、时长 1300ms 的消息对象
 */
function assistantMessage(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    role: 'assistant',
    content: [{ type: 'text', text: 'DONE' }],
    api: 'anthropic-messages',
    provider: 'repro',
    model: 'repro-model',
    usage: { input: 120, output: 45, cacheRead: 0, cacheWrite: 0, totalTokens: 165, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: 'stop',
    timestamp: 1100,
    durationMs: 1300,
    ...overrides,
  }
}

/**
 * 构造 request 行 JSONL 文本。
 * @param messages 轮廓或全量消息数组
 */
function requestText(task: string, request: number, ts: number, messages: unknown[]): string {
  return JSON.stringify({
    type: 'request',
    ts,
    conversationId: '7',
    task,
    request,
    model: { provider: 'repro', modelId: 'repro-model' },
    thinkingLevel: 'off',
    messageCount: messages.length,
    messages,
  })
}

/**
 * 构造 response 行 JSONL 文本。
 * @param message 最终消息对象
 */
function responseText(task: string, request: number, ts: number, message: Record<string, unknown>): string {
  return JSON.stringify({ type: 'response', ts, conversationId: '7', task, request, message })
}

describe('parseTrajectory', () => {
  // 行过滤契约：只保留模型 IO 行（request/response/sidecall），
  // 转录（entry/conversation）、任务、目录、工具行全部丢弃。
  it('keeps only the model-IO lines and drops transcript, task, catalog and tools lines', () => {
    const text = [
      JSON.stringify({ type: 'conversation', id: 7, record: { title: 'Traj' } }),
      JSON.stringify({ type: 'entry', id: 1, seq: 1, head: false, ts: 10, record: { kind: 'pi.user' } }),
      requestText('t1', 1, 1000, [{ role: 'user', content: 'hi' }]),
      JSON.stringify({ type: 'task', id: 2, kind: 'pi.generation', status: 'done', ts: 1100, startedAt: 1100, endedAt: 2400, record: {} }),
      responseText('t1', 1, 2400, assistantMessage()),
      JSON.stringify({ type: 'catalog', ts: 1005, conversationId: '7', task: 't1', request: 1, model: { provider: 'repro', modelId: 'repro-model' }, hash: 'abc', tools: [{ name: 'read' }] }),
      JSON.stringify({ type: 'tools', ts: 2500, conversationId: '7', assistant: 3, results: [4] }),
      JSON.stringify({ type: 'sidecall', ts: 3000, conversationId: '7', purpose: 'session title', startedAt: 2950, durationMs: 460, input: 'Summarize.', answer: assistantMessage() }),
    ].join('\n') + '\n'
    const lines = parseTrajectory(text)
    expect(lines.map(line => line.type)).toEqual(['request', 'response', 'sidecall'])
  })

  // 容错：半截 JSON 与纯垃圾行被跳过，其余行不受影响。
  it('skips corrupt lines without losing the rest', () => {
    const text = [
      '{"type":"request","ts":1000,"task":"t1","request":1',
      requestText('t1', 1, 1000, []),
      'not json at all',
      responseText('t1', 1, 2400, assistantMessage()),
    ].join('\n')
    expect(parseTrajectory(text).map(line => line.type)).toEqual(['request', 'response'])
  })

  // 边界：空文本与纯空白文本解析为空数组。
  it('tolerates empty and blank text', () => {
    expect(parseTrajectory('')).toEqual([])
    expect(parseTrajectory('\n \n\t\n')).toEqual([])
  })
})

describe('buildCallCards', () => {
  // 配对契约：request 与 response 按 task/request 编号配对成一张调用卡片；
  // 输入按角色整形（图片折叠 [image]、system 直取文本），输出拆出正文与工具调用。
  it('pairs a request with its response by task/request and shapes model IO', () => {
    const text = [
      requestText('t1', 1, 1000, [
        { role: 'system', content: 'You are helpful.' },
        { role: 'user', content: [{ type: 'text', text: '要点?' }, { type: 'image', data: 'aaa', mimeType: 'image/png' }] },
      ]),
      responseText('t1', 1, 2400, assistantMessage({
        content: [
          { type: 'text', text: 'DONE' },
          { type: 'toolCall', id: 'call-1', name: 'read', arguments: { path: 'notes.md' } },
        ],
        stopReason: 'toolUse',
      })),
    ].join('\n')
    const cards = buildCallCards(parseTrajectory(text))
    expect(cards).toHaveLength(1)
    const card = cards[0]!
    expect(card.index).toBe(1)
    expect(card.side).toBe(false)
    expect(card.modelId).toBe('repro-model')
    expect(card.timestamp).toBe(1000)
    expect(card.durationMs).toBe(1300)
    expect(card.inputTokens).toBe(120)
    expect(card.outputTokens).toBe(45)
    expect(card.error).toBeNull()
    expect(card.input).toEqual([
      { role: 'system', text: 'You are helpful.' },
      { role: 'user', text: '要点?\n[image]' },
    ])
    expect(card.outputText).toBe('DONE')
    expect(card.toolCalls).toEqual([{ name: 'read', arguments: '{"path":"notes.md"}' }])
  })

  // 工具轮：同一任务内第 2 次请求/响应配对为新卡片；输入行整形出
  // assistant 的调用与 tool 结果行，token 按各轮 usage 分别提取。
  it('pairs tool rounds within one task and shapes tool results into lines', () => {
    const text = [
      requestText('t1', 1, 1000, [{ role: 'user', content: 'read notes.md' }]),
      responseText('t1', 1, 2000, assistantMessage({ timestamp: 1100, durationMs: 900 })),
      requestText('t1', 2, 2100, [
        { role: 'user', content: 'read notes.md' },
        { role: 'assistant', content: [{ type: 'toolCall', id: 'call-1', name: 'read', arguments: { path: 'notes.md' } }] },
        { role: 'toolResult', toolCallId: 'call-1', toolName: 'read', content: [{ type: 'text', text: 'note body' }], isError: false, timestamp: 2050 },
      ]),
      responseText('t1', 2, 3000, assistantMessage({ timestamp: 2150, durationMs: 850, usage: { input: 300, output: 80, cacheRead: 0, cacheWrite: 0, totalTokens: 380, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } })),
    ].join('\n')
    const cards = buildCallCards(parseTrajectory(text))
    expect(cards).toHaveLength(2)
    expect(cards[0]!.inputTokens).toBe(120)
    expect(cards[0]!.outputTokens).toBe(45)
    const round = cards[1]!
    expect(round.index).toBe(2)
    expect(round.durationMs).toBe(850)
    expect(round.inputTokens).toBe(300)
    expect(round.outputTokens).toBe(80)
    expect(round.input).toEqual([
      { role: 'user', text: 'read notes.md' },
      { role: 'assistant', toolName: 'read', text: '{"path":"notes.md"}' },
      { role: 'tool', toolName: 'read', text: 'note body' },
    ])
  })

  // 旁路调用卡片：带 purpose 标签、时间取 startedAt；error 行与缺 usage 的行
  // 都要容错（token 记 0、输出文本为空）。
  it('shapes sidecalls with their purpose label and tolerates errors and missing usage', () => {
    const text = [
      JSON.stringify({
        type: 'sidecall',
        ts: 3000,
        conversationId: '7',
        purpose: 'session title',
        model: { provider: 'repro', modelId: 'repro-model' },
        startedAt: 2950,
        durationMs: 460,
        input: 'Summarize this conversation.',
        answer: assistantMessage({ usage: { input: 88, output: 6, cacheRead: 0, cacheWrite: 0, totalTokens: 94, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } }),
      }),
      JSON.stringify({
        type: 'sidecall',
        ts: 4000,
        conversationId: '7',
        purpose: 'commit message',
        startedAt: 3900,
        durationMs: 90,
        input: 'Write a commit message.',
        error: 'rate limited',
      }),
    ].join('\n')
    const cards = buildCallCards(parseTrajectory(text))
    expect(cards).toHaveLength(2)
    const titled = cards[0]!
    expect(titled.side).toBe(true)
    expect(titled.purpose).toBe('session title')
    expect(titled.timestamp).toBe(2950)
    expect(titled.durationMs).toBe(460)
    expect(titled.input).toEqual([{ role: 'user', text: 'Summarize this conversation.' }])
    expect(titled.inputTokens).toBe(88)
    expect(titled.outputTokens).toBe(6)
    expect(titled.outputText).toBe('DONE')
    const failed = cards[1]!
    expect(failed.side).toBe(true)
    expect(failed.error).toBe('rate limited')
    expect(failed.outputText).toBe('')
    expect(failed.inputTokens).toBe(0)
    expect(failed.outputTokens).toBe(0)
  })

  // 孤儿响应（task/request 对不上号）合并进上一张卡片而非丢弃；
  // 请求侧事实（输入、时间戳）不被合并覆盖。
  it('merges an unmatched response into the previous card instead of dropping it', () => {
    const text = [
      requestText('t1', 1, 1000, [{ role: 'user', content: 'hi' }]),
      responseText('t1', 1, 2000, assistantMessage({ content: [{ type: 'text', text: 'first' }], timestamp: 1100, durationMs: 900 })),
      responseText('t9', 7, 2500, assistantMessage({ content: [{ type: 'text', text: 'stray' }], timestamp: 2100, durationMs: 400 })),
    ].join('\n')
    const cards = buildCallCards(parseTrajectory(text))
    expect(cards).toHaveLength(1)
    expect(cards[0]!.outputText).toBe('stray')
    expect(cards[0]!.durationMs).toBe(400)
    // The request-shaped facts stay untouched by the merge.
    expect(cards[0]!.input).toEqual([{ role: 'user', text: 'hi' }])
    expect(cards[0]!.timestamp).toBe(1000)
  })

  // 边界：任何请求之前先到的响应自成一张卡片（输入为空）。
  it('keeps a response that arrives before any request as its own card', () => {
    const text = responseText('t1', 1, 2000, assistantMessage())
    const cards = buildCallCards(parseTrajectory(text))
    expect(cards).toHaveLength(1)
    expect(cards[0]!.modelId).toBe('repro-model')
    expect(cards[0]!.outputText).toBe('DONE')
    expect(cards[0]!.input).toEqual([])
  })

  // 回退规则：响应缺 durationMs 与 usage 时，耗时回退为 ts 差值、token 记 0。
  it('falls back to the ts difference when the response carries no durationMs and no usage', () => {
    const text = [
      requestText('t1', 1, 1000, [{ role: 'user', content: 'hi' }]),
      responseText('t1', 1, 2250, { role: 'assistant', content: [{ type: 'text', text: 'DONE' }], provider: 'repro', model: 'repro-model', stopReason: 'stop', timestamp: 1100 }),
    ].join('\n')
    const cards = buildCallCards(parseTrajectory(text))
    expect(cards).toHaveLength(1)
    expect(cards[0]!.durationMs).toBe(1250)
    expect(cards[0]!.inputTokens).toBe(0)
    expect(cards[0]!.outputTokens).toBe(0)
  })

  // 错误标注：stopReason=error 的响应把 errorMessage 提升为卡片错误。
  it('marks responses that ended in an error', () => {
    const text = [
      requestText('t1', 1, 1000, []),
      responseText('t1', 1, 1500, assistantMessage({ stopReason: 'error', errorMessage: 'provider 500', content: [] })),
    ].join('\n')
    const cards = buildCallCards(parseTrajectory(text))
    expect(cards[0]!.error).toBe('provider 500')
  })
})

describe('summarizeCalls', () => {
  // 汇总：调用数与输入/输出 token 合计覆盖主链与旁路调用。
  it('totals the call count and token usage', () => {
    const cards = buildCallCards(parseTrajectory([
      requestText('t1', 1, 1000, []),
      responseText('t1', 1, 2000, assistantMessage()),
      JSON.stringify({ type: 'sidecall', ts: 3000, purpose: 'session title', startedAt: 2950, durationMs: 460, input: 'x', answer: assistantMessage({ usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } }) }),
    ].join('\n')))
    expect(summarizeCalls(cards)).toEqual({ count: 2, inputTokens: 130, outputTokens: 50 })
  })

  // 边界：空时间线汇总为全零。
  it('stays at zero for an empty timeline', () => {
    expect(summarizeCalls([])).toEqual({ count: 0, inputTokens: 0, outputTokens: 0 })
  })
})
