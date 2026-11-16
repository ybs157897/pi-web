import { describe, expect, it } from 'vitest'
import { latestOwnAnswer } from '../src/server/conversation/subagent-answer.ts'
import type { ChatMessage } from '../src/shared/types.ts'

/**
 * 构造一条助手文本消息的 fixture。
 * @param id 消息 id
 * @param body 文本块内容
 * @param overrides 覆盖默认字段的属性（如 status: 'error'、isError）
 * @returns 时间戳固定为 100 的 ChatMessage，便于测试只关注消息顺序而非时间
 */
function assistantText(id: string, body: string, overrides: Partial<ChatMessage> = {}): ChatMessage {
  return { id, role: 'assistant', blocks: [{ type: 'text', text: body }], timestamp: 100, ...overrides }
}

/** 子智能体被 spawn 时插入的用户消息，requestId 带 team-spawn 前缀，作为「成员自有回合」的起点标记。 */
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

  // 边界：status === 'error' 与 isError === true 两种失败标记都要跳过，
  // 向前回退到最后一条成功文本，避免把报错当作成员的「答案」。
  it('skips errored turns and falls back to the last good one', () => {
    const messages: ChatMessage[] = [
      assistantText('a1', '可用的中间结论'),
      assistantText('a2', 'Error: harness exploded', { status: 'error' }),
      assistantText('a3', 'Error: flagged inline', { isError: true }),
    ]
    expect(latestOwnAnswer(messages, 200)).toBe('可用的中间结论')
  })

  // 核心所有权规则：fork 出来的成员继承了主智能体的上一轮文本（spawn 边界之前的消息），
  // 这段文本永远不能当作成员自己的答案——无论成员是否已经产出过回答。
  it('never shows the lead text a forked member inherited, before or after the member answers', () => {
    const leadPrefix = assistantText('lead-1', '主智能体的上一轮答案，不是成员的')
    const before = [leadPrefix, spawnInput]
    expect(latestOwnAnswer(before, 200)).toBe('')

    const after = [leadPrefix, spawnInput, assistantText('member-1', '成员自己的回答')]
    expect(latestOwnAnswer(after, 200)).toBe('成员自己的回答')
  })

  // 边界：成员自有回合全部失败时宁可返回空串，也不回退去借用继承的 lead 文本。
  it('ignores the lead prefix even when the member’s own turns all errored', () => {
    const messages: ChatMessage[] = [
      assistantText('lead-1', '主智能体的上一轮答案'),
      spawnInput,
      assistantText('member-1', '成员失败输出', { status: 'error' }),
    ]
    expect(latestOwnAnswer(messages, 200)).toBe('')
  })

  // 二次 spawn 场景：消息截取以最后一次 spawn 边界（timestamp 200）为准，
  // 更早的第一轮成员回答落在边界之前，不得计入。
  it('only honours the last spawn boundary when a session was spawned twice', () => {
    const messages: ChatMessage[] = [
      assistantText('lead-1', '更早的 Lead 文本'),
      { ...spawnInput, id: 'user-spawn-1', requestId: 'team-spawn:lead-1:forker', timestamp: 150 },
      assistantText('member-1', '第一轮成员回答'),
      { ...spawnInput, id: 'user-spawn-2', timestamp: 250 },
    ]
    expect(latestOwnAnswer(messages, 200)).toBe('')
  })

  // 超长答案按上限截断并补省略号（199 个字符 + …），供列表预览使用。
  it('truncates long answers to the limit with an ellipsis', () => {
    expect(latestOwnAnswer([assistantText('a1', 'x'.repeat(300))], 200)).toBe(`${'x'.repeat(199)}…`)
  })

  // 空会话不报错，返回空串让调用方自行决定展示文案。
  it('returns empty for a session without any assistant text', () => {
    expect(latestOwnAnswer([], 200)).toBe('')
  })
})
