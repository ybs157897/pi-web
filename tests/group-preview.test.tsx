// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { ChatMessage } from '../src/shared/types.ts'
import Transcript from '../src/web/transcript.tsx'
import { presentationPolicyFor } from '../src/web/presentation-policy.ts'
import { setupRenderingDom } from './rendering/setup.ts'

/** 每个用例前：搭建渲染 DOM 环境。 */
beforeEach(setupRenderingDom)
/** 每个用例后：卸载组件清理 DOM。 */
afterEach(() => { cleanup() })

const prose = '我倾向 A：改动面最小，且语义最准。'
const answer = '两个问题已经发给你了，等你选择后我再动手改代码。'

/**
 * 构造一轮对话：开场 prose 与 ask_user_question 调用共写在同一条 assistant 消息里（模型实际输出形态），
 * 后跟工具答复与最终回答。
 * @param tag 标识该轮的 id 后缀
 * @param durationMs 本轮工作时长；用于触发折叠分组
 * @returns 一轮的四条消息（user / assistant+提问 / tool 答复 / assistant 回答）
 */
function turn(tag: string, durationMs?: number): ChatMessage[] {
  return [
    { id: `user-${tag}`, role: 'user', requestId: `req-${tag}`, timestamp: 1000, blocks: [{ type: 'text', text: '先看方案。' }] },
    { id: `work-${tag}`, role: 'assistant', runId: `run-${tag}`, timestamp: 1100, status: 'completed', blocks: [
      { type: 'text', text: prose },
      { type: 'toolCall', id: `ask-${tag}`, name: 'ask_user_question', arguments: { questions: [{ id: 'q1', question: '用哪个方案？' }] } },
    ] },
    { id: `asked-${tag}`, role: 'tool', runId: `run-${tag}`, toolCallId: `ask-${tag}`, toolName: 'ask_user_question', timestamp: 1200,
      status: 'completed', details: { status: 'answered', answers: [{ id: 'q1', selected: ['A'] }] }, blocks: [{ type: 'text', text: 'answered' }] },
    { id: `answer-${tag}`, role: 'assistant', runId: `run-${tag}`, timestamp: 1900, status: 'completed', blocks: [{ type: 'text', text: answer }],
      ...(durationMs === undefined ? {} : { durationMs }) },
  ]
}

/**
 * 读取折叠分组头部里的过程预览文本。
 * @param header 分组头部按钮元素
 * @returns data-process-preview 节点文本，没有预览时为 null
 */
function previewOf(header: HTMLElement): string | null {
  return header.querySelector('[data-process-preview]')?.textContent ?? null
}

/**
 * 折叠工作分组预览测试。
 *
 * 关键契约：
 * - 折叠的分组头部展示该轮的 prose 预览；展开后预览消失（正文可见）；
 * - detailed 策略下降级（demote）较旧的一轮并显示预览，最新一轮保持展开且头部裸露无预览；
 * - 没写 prose 的纯工具运行保持裸头部（无预览文本）。
 */
describe('folded work group preview', () => {
  // 折叠态 aria-expanded=false 且头部带 prose 预览；点击展开后 aria-expanded=true、预览移除、正文节点标记 data-open。
  it('names the folded prose in a collapsed header and drops it while open', () => {
    render(<Transcript messages={turn('one', 548_000)} policy={presentationPolicyFor('standard')} />)
    const header = screen.getByRole('button', { name: '已工作 9 分 8 秒' })

    expect(header.getAttribute('aria-expanded')).toBe('false')
    expect(previewOf(header)).toBe(prose)

    fireEvent.click(header)

    expect(header.getAttribute('aria-expanded')).toBe('true')
    expect(previewOf(header)).toBeNull()
    expect(document.getElementById(header.getAttribute('aria-controls') ?? '')?.hasAttribute('data-open')).toBe(true)
  })

  // 多轮场景：较旧的一轮被降级为折叠（带预览），最新一轮（3 秒）保持展开且头部没有预览。
  it('previews a demoted turn and leaves the newest open one bare', () => {
    render(<Transcript messages={[...turn('older', 548_000), ...turn('newer', 3_000)]} policy={presentationPolicyFor('detailed')} />)
    const [older, newer] = screen.getAllByRole('button', { name: /^已工作/ })

    expect(older?.getAttribute('aria-expanded')).toBe('false')
    expect(previewOf(older as HTMLElement)).toBe(prose)
    expect(newer?.getAttribute('aria-expanded')).toBe('true')
    expect(previewOf(newer as HTMLElement)).toBeNull()
  })

  // 运行里没有 prose（assistant 消息只含工具调用块）时，折叠头部保持裸露，不渲染预览。
  it('keeps the bare header for a run that wrote no prose', () => {
    const messages = turn('tools', 548_000)
    messages[1] = { ...messages[1]!, blocks: [messages[1]!.blocks[1]!] }
    render(<Transcript messages={messages} policy={presentationPolicyFor('standard')} />)

    expect(previewOf(screen.getByRole('button', { name: '已工作 9 分 8 秒' }))).toBeNull()
  })
})
