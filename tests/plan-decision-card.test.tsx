// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import QuestionComposer from '../src/web/QuestionComposer.tsx'
import { api } from '../src/web/api.ts'
import type { InteractionRequest } from '../src/shared/types.ts'
import { setupRenderingDom } from './rendering/setup.ts'

vi.mock('../src/web/api.ts', async importOriginal => {
  const original = await importOriginal<typeof import('../src/web/api.ts')>()
  return { ApiFailure: original.ApiFailure, api: { ...original.api, answerInteraction: vi.fn(), cancelInteraction: vi.fn() } }
})

const apiMock = vi.mocked(api, true)

beforeEach(() => {
  setupRenderingDom()
  apiMock.answerInteraction = vi.fn().mockResolvedValue({ conversation: { id: 'c1' } })
  apiMock.cancelInteraction = vi.fn().mockResolvedValue({ conversation: { id: 'c1' } })
})

afterEach(cleanup)

function pendingReview(): InteractionRequest & { detail: string } {
  return {
    id: 'call-1',
    kind: 'plan-review',
    status: 'pending',
    detail: '# 演示计划\n\n把计划模式跑通。',
    approveLabel: '同意执行',
    createdAt: 1,
  }
}

function renderCard(review: InteractionRequest = pendingReview(), onAnswered = vi.fn()) {
  render(<QuestionComposer conversationId="c1" interactions={[review]} onAnswered={onAnswered} onOpenPlan={vi.fn()} />)
  return onAnswered
}

describe('plan review decision card (ZCode elicitation)', () => {
  it('renders the plan excerpt card and the permission decision card', () => {
    renderCard()
    expect(screen.getByText('计划')).toBeTruthy()
    // The pill lives inside the clickable plan card, so it is not exposed as its own button role.
    expect(screen.getByText('查看完整计划')).toBeTruthy()
    expect(screen.getByText('需要权限')).toBeTruthy()
    expect(screen.getByText('实施计划')).toBeTruthy()
    expect(screen.getByRole('radio', { name: '批准 退出计划模式并开始实施。' })).toBeTruthy()
    expect(screen.getByPlaceholderText('输入你的回答…')).toBeTruthy()
    expect(screen.getByRole('button', { name: '忽略' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '提交' })).toBeTruthy()
    // The old footer buttons are gone from the excerpt card.
    expect(screen.queryByRole('button', { name: '要求修改' })).toBeNull()
    expect(screen.queryByRole('button', { name: '同意执行' })).toBeNull()
  })

  it("submits an empty decision as an explicit approval, ZCode's continueOrSubmit", async () => {
    const onAnswered = renderCard()
    fireEvent.click(screen.getByRole('button', { name: '提交' }))
    await vi.waitFor(() => expect(apiMock.answerInteraction).toHaveBeenCalledTimes(1))
    expect(apiMock.answerInteraction).toHaveBeenCalledWith('c1', 'call-1', [
      { id: 'plan-review', selected: ['批准'] },
    ])
    await vi.waitFor(() => expect(onAnswered).toHaveBeenCalled())
  })

  it('submits typed text alone as the requested changes', async () => {
    renderCard()
    fireEvent.change(screen.getByPlaceholderText('输入你的回答…'), { target: { value: '补上回滚说明' } })
    fireEvent.click(screen.getByRole('button', { name: '提交' }))
    await vi.waitFor(() => expect(apiMock.answerInteraction).toHaveBeenCalledTimes(1))
    expect(apiMock.answerInteraction).toHaveBeenCalledWith('c1', 'call-1', [
      { id: 'plan-review', selected: [], custom: '补上回滚说明' },
    ])
  })

  it('sends the approve selection when the option is chosen and submits', async () => {
    renderCard()
    const approve = screen.getByRole('radio', { name: '批准 退出计划模式并开始实施。' })
    expect(approve.getAttribute('aria-checked')).toBe('false')
    fireEvent.click(approve)
    expect(approve.getAttribute('aria-checked')).toBe('true')
    fireEvent.click(screen.getByRole('button', { name: '提交' }))
    await vi.waitFor(() => expect(apiMock.answerInteraction).toHaveBeenCalledTimes(1))
    expect(apiMock.answerInteraction).toHaveBeenCalledWith('c1', 'call-1', [
      { id: 'plan-review', selected: ['批准'], custom: undefined },
    ])
  })

  it('dismisses through the ignore button and reaches the cancel API', async () => {
    const onAnswered = renderCard()
    fireEvent.click(screen.getByRole('button', { name: '忽略' }))
    await vi.waitFor(() => expect(apiMock.cancelInteraction).toHaveBeenCalledTimes(1))
    expect(apiMock.cancelInteraction).toHaveBeenCalledWith('c1', 'call-1')
    await vi.waitFor(() => expect(onAnswered).toHaveBeenCalled())
  })

  it('moves focus between the approve option and the answer line with the arrow keys', () => {
    renderCard()
    const approve = screen.getByRole('radio', { name: '批准 退出计划模式并开始实施。' })
    const answer = screen.getByPlaceholderText('输入你的回答…')
    approve.focus()
    const group = approve.closest('[role="radiogroup"]')!
    fireEvent.keyDown(group, { key: 'ArrowDown' })
    expect(document.activeElement).toBe(answer)
    fireEvent.keyDown(group, { key: 'ArrowUp' })
    expect(document.activeElement).toBe(approve)
  })

  it('leaves the transcript record alone once the review settles', () => {
    renderCard({ ...pendingReview(), status: 'answered', approved: true })
    expect(screen.queryByText('需要权限')).toBeNull()
    expect(screen.queryByText('查看完整计划')).toBeNull()
  })
})
