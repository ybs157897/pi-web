import { describe, expect, it } from 'vitest'
import { buildCallCards, parseTrajectory, summarizeCalls } from '../src/web/trajectory-view.ts'

/** Realistic assistant message per pi-ai's AssistantMessage, as the capture records it. */
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

function responseText(task: string, request: number, ts: number, message: Record<string, unknown>): string {
  return JSON.stringify({ type: 'response', ts, conversationId: '7', task, request, message })
}

describe('parseTrajectory', () => {
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

  it('skips corrupt lines without losing the rest', () => {
    const text = [
      '{"type":"request","ts":1000,"task":"t1","request":1',
      requestText('t1', 1, 1000, []),
      'not json at all',
      responseText('t1', 1, 2400, assistantMessage()),
    ].join('\n')
    expect(parseTrajectory(text).map(line => line.type)).toEqual(['request', 'response'])
  })

  it('tolerates empty and blank text', () => {
    expect(parseTrajectory('')).toEqual([])
    expect(parseTrajectory('\n \n\t\n')).toEqual([])
  })
})

describe('buildCallCards', () => {
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

  it('keeps a response that arrives before any request as its own card', () => {
    const text = responseText('t1', 1, 2000, assistantMessage())
    const cards = buildCallCards(parseTrajectory(text))
    expect(cards).toHaveLength(1)
    expect(cards[0]!.modelId).toBe('repro-model')
    expect(cards[0]!.outputText).toBe('DONE')
    expect(cards[0]!.input).toEqual([])
  })

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
  it('totals the call count and token usage', () => {
    const cards = buildCallCards(parseTrajectory([
      requestText('t1', 1, 1000, []),
      responseText('t1', 1, 2000, assistantMessage()),
      JSON.stringify({ type: 'sidecall', ts: 3000, purpose: 'session title', startedAt: 2950, durationMs: 460, input: 'x', answer: assistantMessage({ usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } }) }),
    ].join('\n')))
    expect(summarizeCalls(cards)).toEqual({ count: 2, inputTokens: 130, outputTokens: 50 })
  })

  it('stays at zero for an empty timeline', () => {
    expect(summarizeCalls([])).toEqual({ count: 0, inputTokens: 0, outputTokens: 0 })
  })
})
