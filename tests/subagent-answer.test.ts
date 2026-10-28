import { describe, expect, it } from 'vitest'
import { latestOwnAnswer } from '../src/server/subagent-answer.ts'
import type { ChatMessage } from '../src/shared/types.ts'

function assistantText(id: string, body: string, overrides: Partial<ChatMessage> = {}): ChatMessage {
  return { id, role: 'assistant', blocks: [{ type: 'text', text: body }], timestamp: 100, ...overrides }
}

const spawnInput: ChatMessage = {
  id: 'user-spawn', requestId: 'team-spawn:lead-1:forker', role: 'user',
  blocks: [{ type: 'text', text: 'spawn' }], timestamp: 200,
}

describe('subagent answer ownership', () => {
  it('takes a fresh child’s own last assistant text', () => {
    const messages: ChatMessage[] = [
      { id: 'user-1', requestId: 'subagent:task-1', role: 'user', blocks: [{ type: 'text', text: 'task' }], timestamp: 50 },
      assistantText('a1', '第一版结论'),
      assistantText('a2', '最终结论'),
    ]
    expect(latestOwnAnswer(messages, 200)).toBe('最终结论')
  })

  it('skips errored turns and falls back to the last good one', () => {
    const messages: ChatMessage[] = [
      assistantText('a1', '可用的中间结论'),
      assistantText('a2', 'Error: harness exploded', { status: 'error' }),
      assistantText('a3', 'Error: flagged inline', { isError: true }),
    ]
    expect(latestOwnAnswer(messages, 200)).toBe('可用的中间结论')
  })

  it('never shows the lead text a forked member inherited, before or after the member answers', () => {
    const leadPrefix = assistantText('lead-1', '主智能体的上一轮答案，不是成员的')
    const before = [leadPrefix, spawnInput]
    expect(latestOwnAnswer(before, 200)).toBe('')

    const after = [leadPrefix, spawnInput, assistantText('member-1', '成员自己的回答')]
    expect(latestOwnAnswer(after, 200)).toBe('成员自己的回答')
  })

  it('ignores the lead prefix even when the member’s own turns all errored', () => {
    const messages: ChatMessage[] = [
      assistantText('lead-1', '主智能体的上一轮答案'),
      spawnInput,
      assistantText('member-1', '成员失败输出', { status: 'error' }),
    ]
    expect(latestOwnAnswer(messages, 200)).toBe('')
  })

  it('only honours the last spawn boundary when a session was spawned twice', () => {
    const messages: ChatMessage[] = [
      assistantText('lead-1', '更早的 Lead 文本'),
      { ...spawnInput, id: 'user-spawn-1', requestId: 'team-spawn:lead-1:forker', timestamp: 150 },
      assistantText('member-1', '第一轮成员回答'),
      { ...spawnInput, id: 'user-spawn-2', timestamp: 250 },
    ]
    expect(latestOwnAnswer(messages, 200)).toBe('')
  })

  it('truncates long answers to the limit with an ellipsis', () => {
    expect(latestOwnAnswer([assistantText('a1', 'x'.repeat(300))], 200)).toBe(`${'x'.repeat(199)}…`)
  })

  it('returns empty for a session without any assistant text', () => {
    expect(latestOwnAnswer([], 200)).toBe('')
  })
})
