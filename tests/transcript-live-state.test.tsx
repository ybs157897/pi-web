// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import Transcript from '../src/web/transcript.tsx'
import { presentationPolicyFor } from '../src/web/presentation-policy.ts'
import { processMessages } from './rendering/samples.ts'
import { setupRenderingDom } from './rendering/setup.ts'

beforeEach(setupRenderingDom)
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

const usage = {
  input: 100, output: 20, cacheRead: 300, cacheWrite: 0, totalTokens: 420,
  cost: { input: 0.001, output: 0.002, cacheRead: 0.0001, cacheWrite: 0, total: 0.0031 },
}

function messages() {
  const values = processMessages(3)
  const answer = values.at(-1)
  if (answer !== undefined) answer.usage = usage
  return values
}

describe('live transcript state', () => {
  it('keeps end-state actions, usage, time and changed files hidden until the run settles', () => {
    const values = messages()
    const policy = presentationPolicyFor('standard')
    const { rerender } = render(<Transcript messages={values} conversationId="conv-live" running policy={policy} />)

    // The run's message status is already completed between tool rounds; the conversation is not.
    expect(screen.getByText('工作中')).toBeTruthy()
    expect(screen.getByText('工作中').closest('button')?.getAttribute('aria-expanded')).toBe('true')
    expect(screen.queryByRole('button', { name: '复制回答' })).toBeNull()
    expect(screen.queryByRole('button', { name: /用量/ })).toBeNull()
    expect(document.querySelector('[data-message-changes]')).toBeNull()

    rerender(<Transcript messages={values} conversationId="conv-live" policy={policy} />)

    expect(screen.getByText('已工作 11 秒')).toBeTruthy()
    expect(screen.getByText('已工作 11 秒').closest('button')?.getAttribute('aria-expanded')).toBe('false')
    expect(screen.getByRole('button', { name: '复制回答' })).toBeTruthy()
    expect(screen.getByRole('button', { name: /用量/ })).toBeTruthy()
    expect(document.querySelector('[data-message-changes]')).toBeTruthy()
  })
})
