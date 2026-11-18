// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import Transcript from '../src/web/transcript.tsx'
import { presentationPolicyFor } from '../src/web/presentation-policy.ts'
import { processMessages } from './rendering/samples.ts'
import { setupRenderingDom } from './rendering/setup.ts'

/** Transcript「进行中 vs 已结算」两种呈现状态的渲染契约测试（jsdom 环境）。 */
beforeEach(setupRenderingDom)
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

/** 固定的 token 用量与成本样本，挂到末条消息上供「用量」按钮渲染。 */
const usage = {
  input: 100, output: 20, cacheRead: 300, cacheWrite: 0, totalTokens: 420,
  cost: { input: 0.001, output: 0.002, cacheRead: 0.0001, cacheWrite: 0, total: 0.0031 },
}

/**
 * 构造一组测试消息。
 * @returns processMessages 产出的 3 条消息，末条（最终回答）挂上 usage 样本
 */
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

    // 会话仍在进行（running）时：单条消息状态可能已是 completed（工具轮次之间），
    // 但终态动作（复制）、用量、耗时与变更文件都必须隐藏；rerender 去掉 running 后全部出现。
    expect(screen.getByText(/^工作中/)).toBeTruthy()
    expect(screen.getByText(/^工作中/).closest('button')?.getAttribute('aria-expanded')).toBe('true')
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
