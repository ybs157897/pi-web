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
 * 读取折叠分组头部里的 ZCode 统计条文本。
 * @param header 分组头部按钮元素
 * @returns data-process-statistics 节点文本，没有统计时为 null
 */
function statisticsOf(header: HTMLElement): string | null {
  return header.querySelector('[data-process-statistics]')?.textContent ?? null
}

/**
 * 折叠工作分组预览测试。
 *
 * 关键契约：
 * - 折叠的分组头部只保留 ZCode 两行形态：「已工作 X」+ 统计（该轮只有提问时是「提问 1 次」）；
 *   展开后统计行消失（正文与工作列表可见）；
 * - detailed 策略下降级（demote）较旧的一轮并显示统计，最新一轮保持展开且头部没有第二行。
 */
describe('folded work group preview', () => {
  // 折叠态 aria-expanded=false 且头部带统计行；点击展开后 aria-expanded=true、统计行移除、正文节点标记 data-open。
  it('summarizes a collapsed header and drops the summary while open', () => {
    render(<Transcript messages={turn('one', 548_000)} policy={presentationPolicyFor('standard')} />)
    const header = screen.getByRole('button', { name: '已工作 9 分 8 秒' })

    expect(header.getAttribute('aria-expanded')).toBe('false')
    expect(statisticsOf(header)).toBe('提问 1 次')

    fireEvent.click(header)

    expect(header.getAttribute('aria-expanded')).toBe('true')
    expect(statisticsOf(header)).toBeNull()
    expect(document.getElementById(header.getAttribute('aria-controls') ?? '')?.hasAttribute('data-open')).toBe(true)
  })

  // 多轮场景：较旧的一轮被降级为折叠（带统计），最新一轮（3 秒）保持展开且头部没有统计行。
  it('summarizes a demoted turn and leaves the newest open one bare', () => {
    render(<Transcript messages={[...turn('older', 548_000), ...turn('newer', 3_000)]} policy={presentationPolicyFor('detailed')} />)
    const [older, newer] = screen.getAllByRole('button', { name: /^已工作/ })

    expect(older?.getAttribute('aria-expanded')).toBe('false')
    expect(statisticsOf(older as HTMLElement)).toBe('提问 1 次')
    expect(newer?.getAttribute('aria-expanded')).toBe('true')
    expect(statisticsOf(newer as HTMLElement)).toBeNull()
  })

  it('summarizes the question call when the collapsed run has no prose', () => {
    const messages = turn('tools', 548_000)
    messages[1] = { ...messages[1]!, blocks: [messages[1]!.blocks[1]!] }
    render(<Transcript messages={messages} policy={presentationPolicyFor('standard')} />)

    const header = screen.getByRole('button', { name: '已工作 9 分 8 秒', description: '提问 1 次' })
    expect(statisticsOf(header)).toBe('提问 1 次')
  })

  // ZCode summary group：折叠头给出「已查阅 N 项，已执行 N 命令」，展开后是一条带行文案的
  // 扁平工作列表（已读取 / 已执行），不再是需要二次展开的「查阅/终端」子组。
  it('summarizes tools in the header and opens a flat work list with settled row labels', () => {
    const messages: ChatMessage[] = [
      { id: 'user-rows', role: 'user', requestId: 'req-rows', timestamp: 1000, blocks: [{ type: 'text', text: '看下文件' }] },
      { id: 'work-rows', role: 'assistant', runId: 'run-rows', timestamp: 1100, status: 'completed', blocks: [
        { type: 'toolCall', id: 'read-1', name: 'read', arguments: { path: 'a.ts' } },
        { type: 'toolCall', id: 'bash-1', name: 'bash', arguments: { command: 'npm test' } },
      ] },
      { id: 'read-result', role: 'tool', runId: 'run-rows', toolCallId: 'read-1', toolName: 'read', timestamp: 1200,
        status: 'completed', details: { lines: [{ number: 1, text: 'const a = 1' }], totalLines: 1 }, blocks: [{ type: 'text', text: 'const a = 1' }] },
      { id: 'bash-result', role: 'tool', runId: 'run-rows', toolCallId: 'bash-1', toolName: 'bash', timestamp: 1300,
        status: 'completed', details: { command: 'npm test' }, blocks: [{ type: 'text', text: 'ok' }] },
      { id: 'answer-rows', role: 'assistant', runId: 'run-rows', timestamp: 1900, status: 'completed',
        durationMs: 548_000, blocks: [{ type: 'text', text: '完成。' }] },
    ]
    render(<Transcript messages={messages} policy={presentationPolicyFor('standard')} />)
    const header = screen.getByRole('button', { name: '已工作 9 分 8 秒' })

    expect(statisticsOf(header)).toBe('已查阅 1 项，已执行 1 命令')

    fireEvent.click(header)
    const body = document.querySelector('[data-work-list]')
    expect(body).not.toBeNull()
    expect(body?.textContent).toContain('已读取')
    expect(body?.textContent).toContain('a.ts')
    expect(body?.textContent).toContain('已执行')
    expect(body?.textContent).toContain('npm test')
  })

  // 运行中收起时，折叠头两行换成「当前动作行」+「工作中 X」，动作行随执行中的工具切换；
  // 展开或完成后不出现这一行。
  it('shows the running action row above the working title while collapsed', () => {
    const messages: ChatMessage[] = [
      { id: 'user-live', role: 'user', requestId: 'req-live', timestamp: 1000, blocks: [{ type: 'text', text: '跑测试' }] },
      { id: 'work-live', role: 'assistant', runId: 'run-live', timestamp: 1030, streaming: true, blocks: [
        { type: 'toolCall', id: 'bash-live', name: 'bash', arguments: { command: 'npm test' } },
      ] },
    ]
    render(<Transcript messages={messages} policy={presentationPolicyFor('standard')} running />)
    const header = screen.getByRole('button', { name: /^工作中/ })

    // live 组默认展开；手动收起后才显示动作行。
    expect(header.getAttribute('aria-expanded')).toBe('true')
    expect(header.querySelector('[data-current-work]')).toBeNull()

    fireEvent.click(header)
    expect(header.getAttribute('aria-expanded')).toBe('false')
    const currentWork = header.querySelector('[data-current-work]')
    expect(currentWork?.textContent).toContain('正在执行')
    expect(currentWork?.textContent).toContain('npm test')
    expect(header.textContent).toContain('工作中')
  })
})
