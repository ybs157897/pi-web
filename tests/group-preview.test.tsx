// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { ChatMessage } from '../src/shared/types.ts'
import Transcript from '../src/web/transcript.tsx'
import { presentationPolicyFor } from '../src/web/presentation-policy.ts'
import { setupRenderingDom } from './rendering/setup.ts'

beforeEach(setupRenderingDom)
afterEach(() => { cleanup() })

const prose = '我倾向 A：改动面最小，且语义最准。'
const answer = '两个问题已经发给你了，等你选择后我再动手改代码。'

/** One turn whose lead-in prose shares a message with the question call, as the model writes it. */
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

function previewOf(header: HTMLElement): string | null {
  return header.querySelector('[data-process-preview]')?.textContent ?? null
}

describe('folded work group preview', () => {
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

  it('previews a demoted turn and leaves the newest open one bare', () => {
    render(<Transcript messages={[...turn('older', 548_000), ...turn('newer', 3_000)]} policy={presentationPolicyFor('detailed')} />)
    const [older, newer] = screen.getAllByRole('button', { name: /^已工作/ })

    expect(older?.getAttribute('aria-expanded')).toBe('false')
    expect(previewOf(older as HTMLElement)).toBe(prose)
    expect(newer?.getAttribute('aria-expanded')).toBe('true')
    expect(previewOf(newer as HTMLElement)).toBeNull()
  })

  it('keeps the bare header for a run that wrote no prose', () => {
    const messages = turn('tools', 548_000)
    messages[1] = { ...messages[1]!, blocks: [messages[1]!.blocks[1]!] }
    render(<Transcript messages={messages} policy={presentationPolicyFor('standard')} />)

    expect(previewOf(screen.getByRole('button', { name: '已工作 9 分 8 秒' }))).toBeNull()
  })
})
