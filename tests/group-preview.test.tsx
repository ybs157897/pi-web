// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
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

describe('work group disclosure', () => {
  it('shows only the work title while folded and keeps the final answer outside of the work group', () => {
    render(<Transcript messages={turn('one', 548_000)} policy={presentationPolicyFor('standard')} />)
    const header = screen.getByRole('button', { name: /^已工作/ })
    const body = document.getElementById(header.getAttribute('aria-controls') ?? '')

    expect(header.getAttribute('aria-expanded')).toBe('false')
    expect(header.textContent).toBe('已工作 9 分 8 秒')
    expect(header.getAttribute('aria-describedby')).toBeNull()
    expect(body?.getAttribute('aria-hidden')).toBe('true')
    // 中间正文（prose）现在渲染在折叠区外，与用户输入同层左对齐。
    expect(screen.getAllByText(prose)).toHaveLength(1)
    expect(body?.textContent).not.toContain(prose)
    expect(screen.getAllByText(answer)).toHaveLength(1)
    expect(body?.textContent).not.toContain(answer)

    fireEvent.click(header)

    expect(header.getAttribute('aria-expanded')).toBe('true')
    expect(body?.getAttribute('aria-hidden')).toBe('false')
    expect(screen.getAllByText(prose)).toHaveLength(1)
    expect(screen.getAllByText(answer)).toHaveLength(1)
  })

  it('folds the newest completed turn and older turns in the default detailed view', () => {
    render(<Transcript messages={[...turn('older', 548_000), ...turn('newer', 3_000)]} />)
    const headers = screen.getAllByRole('button', { name: /^已工作/ })

    expect(headers.map(header => header.getAttribute('aria-expanded'))).toEqual(['false', 'false'])
    expect(headers.map(header => header.textContent)).toEqual(['已工作 9 分 8 秒', '已工作 3 秒'])
  })

  it('folds work on both sides of a steering message without hiding or duplicating user input', () => {
    const runId = 'run-steered'
    const messages: ChatMessage[] = [
      { id: 'original-input', role: 'user', requestId: 'original', runId, timestamp: 1000,
        blocks: [{ type: 'text', text: '先检查一下。' }] },
      { id: 'work-before-steer', role: 'assistant', runId, timestamp: 1200, status: 'completed', blocks: [
        { type: 'toolCall', id: 'read-original', name: 'read', arguments: { path: 'before.txt' } },
      ] },
      { id: 'steer', role: 'user', requestId: 'steer-request', runId, timestamp: 1500,
        blocks: [{ type: 'text', text: '也看看第二个文件。' }] },
      { id: 'work-after-steer', role: 'assistant', runId, timestamp: 1800, status: 'completed', blocks: [
        { type: 'toolCall', id: 'read-followup', name: 'read', arguments: { path: 'after.txt' } },
      ] },
      { id: 'steered-answer', role: 'assistant', runId, timestamp: 4200,
        status: 'completed', durationMs: 3000, blocks: [{ type: 'text', text: '两个文件均已检查。' }] },
    ]
    const { rerender } = render(<Transcript messages={messages} conversationId="steered" running />)
    // 运行中折叠头的可访问名是统计文案或当前动作；「工作中 X」在回合尾。
    const header = screen.getByRole('button', { name: /查阅|执行|正在/ })
    expect(screen.getByRole('status', { name: '加载中' }).textContent).toContain('工作中')
    const [firstId, secondId] = header.getAttribute('aria-controls')!.split(' ')
    const before = document.getElementById(firstId!)!
    const after = document.getElementById(secondId!)!
    const input = screen.getByText('也看看第二个文件。')
    expect(before.textContent).toContain('before.txt')
    expect(after.textContent).toContain('after.txt')
    expect(before.compareDocumentPosition(input) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(input.compareDocumentPosition(after) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(header).toHaveProperty('disabled', false)
    expect(header.getAttribute('aria-expanded')).toBe('true')

    fireEvent.click(header)
    expect([before, after].map(section => section.getAttribute('aria-hidden'))).toEqual(['true', 'true'])
    expect(input.closest('[aria-hidden="true"]')).toBeNull()
    fireEvent.click(header)
    const copyInput = within(input.closest<HTMLElement>('[data-role="user"]')!).getByRole('button', { name: '复制用户消息' })
    copyInput.focus()
    rerender(<Transcript messages={messages} conversationId="steered" />)
    expect(header.getAttribute('aria-expanded')).toBe('false')
    expect(document.activeElement).toBe(copyInput)
    expect([before, after].map(section => section.getAttribute('aria-hidden'))).toEqual(['true', 'true'])
    expect(screen.getAllByText('也看看第二个文件。')).toEqual([input])
    expect(screen.getAllByText('两个文件均已检查。')).toHaveLength(1)

    fireEvent.click(header)
    expect([before, after].map(section => section.getAttribute('aria-hidden'))).toEqual(['false', 'false'])
    expect(screen.getAllByText('也看看第二个文件。')).toEqual([input])
  })

  it('folds leading reasoning with even a single command and starts a new work group after prose', () => {
    const messages: ChatMessage[] = [
      { id: 'request', requestId: 'request', role: 'user', timestamp: 1000, blocks: [{ type: 'text', text: '检查环境和文件' }] },
      { id: 'first', runId: 'run', role: 'assistant', timestamp: 1100, blocks: [
        { type: 'thinking', text: '先检查运行环境' },
        { type: 'toolCall', name: 'bash', id: 'command', arguments: { command: 'node --version' } },
      ] },
      { id: 'command-result', runId: 'run', role: 'tool', timestamp: 1200, toolCallId: 'command', toolName: 'bash',
        blocks: [{ type: 'text', text: 'v24' }] },
      { id: 'second', runId: 'run', role: 'assistant', timestamp: 1300, blocks: [
        { type: 'text', text: '环境已确认，现在检查配置。' },
        { type: 'thinking', text: '定位配置' },
        { type: 'toolCall', name: 'read', id: 'file', arguments: { path: 'config.ts' } },
      ] },
      { id: 'file-result', runId: 'run', role: 'tool', timestamp: 1400, toolCallId: 'file', toolName: 'read',
        blocks: [{ type: 'text', text: 'export default {}' }] },
      { id: 'final', runId: 'run', role: 'assistant', timestamp: 2000, durationMs: 1000, status: 'completed',
        blocks: [{ type: 'text', text: '配置检查完毕。' }] },
    ]
    render(<Transcript messages={messages} policy={presentationPolicyFor('standard')} />)
    fireEvent.click(screen.getByRole('button', { name: '已工作 1 秒' }))
    // 中间正文把过程切成两段，各自一个折叠区（ZCode 的 flowItems 口径）。
    const sections = [...document.querySelectorAll<HTMLElement>('[data-process-section]')]
    expect(sections).toHaveLength(2)
    const lists = sections.map(section => section.querySelector<HTMLElement>('[data-work-list]')!)
    const [firstGroup] = [...lists[0]!.children] as HTMLElement[]
    const [secondGroup] = [...lists[1]!.children] as HTMLElement[]
    // 中间正文（narration）渲染在折叠区外，与用户输入同层全宽。
    const narration = screen.getAllByText('环境已确认，现在检查配置。')
    expect(narration).toHaveLength(1)
    expect(narration[0]!.closest('[aria-hidden="true"]')).toBeNull()
    expect(narration[0]!.closest('[data-process-inline-text]')).not.toBeNull()
    for (const [group, title] of [[firstGroup, '已执行 1 命令'], [secondGroup, '已查阅 1 项']] as const) {
      expect(group.hasAttribute('data-work-step-group')).toBe(true)
      const toggle = within(group).getByRole('button', { name: title })
      expect(toggle.getAttribute('aria-expanded')).toBe('false')
      expect(within(group).queryByRole('button', { name: '思考' })).toBeNull()
      fireEvent.click(toggle)
      const steps = document.getElementById(toggle.getAttribute('aria-controls')!)!
      expect(steps.textContent).toMatch(/^思考/u)
      expect(within(steps).getByRole('button', { name: '思考' })).toBeTruthy()
    }
    // 最终答案在回复区，不在任何折叠区内。
    expect(screen.getAllByText('配置检查完毕。')).toHaveLength(1)
  })

  it('keeps standalone reasoning, narration and independently expandable tool steps in order', () => {
    const messages: ChatMessage[] = [
      { id: 'user-rows', role: 'user', requestId: 'req-rows', timestamp: 1000, blocks: [{ type: 'text', text: '看下文件' }] },
      { id: 'work-rows', role: 'assistant', runId: 'run-rows', timestamp: 1100, status: 'completed', blocks: [
        { type: 'thinking', text: '先看现状' },
        { type: 'text', text: '我先读文件并运行测试。' },
        { type: 'toolCall', id: 'read-1', name: 'read', arguments: { path: 'a.ts' } },
        { type: 'thinking', text: '再验证结果' },
        { type: 'toolCall', id: 'bash-1', name: 'bash', arguments: { command: 'npm test' } },
      ] },
      { id: 'read-result', role: 'tool', runId: 'run-rows', toolCallId: 'read-1', toolName: 'read', timestamp: 1200,
        status: 'completed', details: { lines: [{ number: 1, text: 'const a = 1' }], totalLines: 1 }, blocks: [{ type: 'text', text: 'const a = 1' }] },
      { id: 'bash-result', role: 'tool', runId: 'run-rows', toolCallId: 'bash-1', toolName: 'bash', timestamp: 1300,
        status: 'completed', details: { command: 'npm test' }, blocks: [{ type: 'text', text: 'ok' }] },
      { id: 'answer-rows', role: 'assistant', runId: 'run-rows', timestamp: 1900, status: 'completed',
        durationMs: 548_000, blocks: [{ type: 'text', text: '已完成验证。' }] },
    ]
    render(<Transcript messages={messages} policy={presentationPolicyFor('standard')} />)
    const header = screen.getByRole('button', { name: '已工作 9 分 8 秒' })
    expect(screen.queryByRole('button', { name: '已查阅 1 项，已执行 1 命令' })).toBeNull()

    fireEvent.click(header)
    // 正文「我先读文件并运行测试。」把过程切成两段，折叠区外全宽渲染。
    const narration = screen.getAllByText('我先读文件并运行测试。')
    expect(narration).toHaveLength(1)
    expect(narration[0]!.closest('[data-process-inline-text]')).not.toBeNull()
    const reasoningRow = document.querySelector<HTMLElement>('[data-process-leading-icon]')?.parentElement
    expect(reasoningRow?.querySelector('[data-process-leading-icon]')).not.toBeNull()
    expect(reasoningRow?.textContent).toContain('思考')
    const stepGroup = document.querySelector<HTMLElement>('[data-work-step-group]')
    expect(stepGroup).not.toBeNull()
    const stepsToggle = within(stepGroup!).getByRole('button', { name: '已查阅 1 项，已执行 1 命令' })
    expect(stepsToggle.getAttribute('aria-expanded')).toBe('false')

    fireEvent.click(stepsToggle)
    const details = document.getElementById(stepsToggle.getAttribute('aria-controls') ?? '')
    expect(details?.textContent).toMatch(/已读取.*a\.ts.*思考.*已执行.*npm test/u)
    expect(screen.getAllByText('已完成验证。')).toHaveLength(1)
    expect(details?.textContent).not.toContain('已完成验证。')
  })

  // 运行中折叠头承载统计文案（或收起时的当前动作），「工作中 X」在回合尾的指示条；
  // 动作行随执行中的工具切换，完成后不再出现。
  it('shows the current action in the header and the working timer at the turn tail', () => {
    const messages: ChatMessage[] = [
      { id: 'user-live', role: 'user', requestId: 'req-live', timestamp: 1000, blocks: [{ type: 'text', text: '跑测试' }] },
      { id: 'work-live', role: 'assistant', runId: 'run-live', timestamp: 1030, streaming: true, blocks: [
        { type: 'thinking', text: '先检查测试配置' },
        { type: 'toolCall', id: 'bash-live', name: 'bash', arguments: { command: 'npm test' } },
      ] },
    ]
    const policy = presentationPolicyFor('standard')
    const reasoningOnly = [messages[0]!, { ...messages[1]!, blocks: messages[1]!.blocks.slice(0, 1) }]
    const { rerender } = render(<Transcript messages={reasoningOnly} policy={policy} running />)
    const workList = document.querySelector<HTMLElement>('[data-work-list]')!
    expect(workList.children).toHaveLength(1)
    expect(workList.firstElementChild?.hasAttribute('data-work-step-group')).toBe(false)
    rerender(<Transcript messages={messages} policy={policy} running />)
    expect(workList.children).toHaveLength(1)
    expect(workList.firstElementChild?.hasAttribute('data-work-step-group')).toBe(true)
    expect(workList.firstElementChild?.textContent).toMatch(/思考.*npm test/u)

    // live 组默认展开：折叠头显示统计文案，展开时不显示当前动作行。
    const header = screen.getByRole('button', { name: /已执行|已查阅|工具调用/ })
    expect(header.getAttribute('aria-expanded')).toBe('true')
    expect(header.querySelector('[class*="currentWorkLabel"]')).toBeNull()

    // 收起后整行换成当前动作（ZCode 的 tail 组行为）。
    fireEvent.click(header)
    expect(header.getAttribute('aria-expanded')).toBe('false')
    expect(header.textContent).toContain('正在执行')
    expect(header.textContent).toContain('npm test')
    // 「工作中 X」在回合尾的指示条，不在折叠头。
    const indicator = screen.getByRole('status', { name: '加载中' })
    expect(indicator.textContent).toContain('工作中')
    expect(header.textContent).not.toContain('工作中')

    fireEvent.click(header)
    const reasoning = screen.getByRole('button', { name: '思考' })
    reasoning.focus()
    const settled: ChatMessage[] = [
      messages[0]!,
      { ...messages[1]!, streaming: false, status: 'completed' },
      { id: 'live-result', role: 'tool', runId: 'run-live', toolCallId: 'bash-live', toolName: 'bash',
        timestamp: 2000, status: 'completed', blocks: [{ type: 'text', text: 'ok' }] },
      { id: 'live-answer', role: 'assistant', runId: 'run-live', timestamp: 3000, status: 'completed',
        blocks: [{ type: 'text', text: '测试完成。' }] },
    ]
    rerender(<Transcript messages={settled} policy={policy} />)

    expect(screen.getByRole('button', { name: /^已工作/ })).toBe(header)
    expect(header.getAttribute('aria-expanded')).toBe('false')
    expect(document.activeElement).toBe(header)
    expect(header.querySelector('[class*="currentWorkLabel"]')).toBeNull()
    expect(screen.queryByRole('status', { name: '加载中' })).toBeNull()
    expect(screen.getAllByText('测试完成。')).toHaveLength(1)

    fireEvent.click(header)
    rerender(<Transcript messages={structuredClone(settled)} policy={policy} />)
    expect(header.getAttribute('aria-expanded')).toBe('true')
  })
})
