// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { ReasoningBlock } from '../src/web/message-rendering/ReasoningBlock.tsx'
import { setupRenderingDom } from './rendering/setup.ts'

const t = (zh: string) => zh
beforeEach(setupRenderingDom)
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks() })

function renderBlock(props: Partial<Parameters<typeof ReasoningBlock>[0]> = {}) {
  return render(<ReasoningBlock id="thought" text="想一想" streaming={false} redacted={false} preview t={t} {...props} />)
}

describe('reasoning block timing and collapsed summary', () => {
  it('shows 正在思考 with the latest line while a collapsed stream runs', () => {
    vi.useFakeTimers()
    renderBlock({ text: '第一行\n\n  最新一句', streaming: true })
    const title = screen.getByText('正在思考')
    expect(title.hasAttribute('data-running')).toBe(true)
    expect(screen.getByText('最新一句')).toBeTruthy()
    expect(screen.queryByText('思考中')).toBeNull()
    // 收起态不展示耗时，也不需要每秒重渲染。
    expect(screen.queryByText(/^持续了 /u)).toBeNull()
  })
  it('counts thought seconds only while expanded and streaming', () => {
    vi.useFakeTimers()
    renderBlock({ streaming: true })
    fireEvent.click(screen.getByRole('button', { name: '正在思考' }))
    expect(screen.getByText('思考').hasAttribute('data-running')).toBe(false)
    expect(screen.getByText('持续了 1 秒')).toBeTruthy()
    act(() => { vi.advanceTimersByTime(1200) })
    expect(screen.getByText(/^持续了 [12] 秒$/u)).toBeTruthy()
    act(() => { vi.advanceTimersByTime(1000) })
    expect(screen.getByText('持续了 2 秒')).toBeTruthy()
  })
  it('freezes the counted seconds when streaming ends', () => {
    vi.useFakeTimers()
    const { rerender } = renderBlock({ streaming: true })
    fireEvent.click(screen.getByRole('button', { name: '正在思考' }))
    act(() => { vi.advanceTimersByTime(1200) })
    rerender(<ReasoningBlock id="thought" text="想完了" streaming={false} redacted={false} preview t={t} />)
    expect(screen.getByRole('button', { name: '思考' })).toBeTruthy()
    expect(screen.getByText('持续了 2 秒')).toBeTruthy()
    act(() => { vi.advanceTimersByTime(5000) })
    expect(screen.getByText('持续了 2 秒')).toBeTruthy()
    expect(screen.queryByText('正在思考')).toBeNull()
  })
  it('keeps 持续了几秒 when a finished thought has no recorded duration', () => {
    renderBlock({ text: '旧思考', streaming: false })
    expect(screen.getByRole('button', { name: '思考' })).toBeTruthy()
    expect(screen.getByText('持续了几秒')).toBeTruthy()
    expect(screen.queryByText('正在思考')).toBeNull()
  })
  it('keeps expanded thought content as plain text', () => {
    renderBlock({ text: 'line1\n**not parsed**', streaming: false })
    fireEvent.click(screen.getByRole('button', { name: '思考' }))
    expect(screen.getByRole('region', { name: '思考内容' }).textContent).toBe('line1\n**not parsed**')
    expect(document.querySelector('strong')).toBeNull()
    expect(screen.getByText('持续了几秒')).toBeTruthy()
  })
  it('replays the summary entrance only when the latest line changes', () => {
    const { rerender } = renderBlock({ text: '第一行', streaming: true })
    const firstLine = screen.getByText('第一行')
    rerender(<ReasoningBlock id="thought" text="第一行继续" streaming redacted={false} preview t={t} />)
    expect(screen.getByText('第一行继续')).toBe(firstLine)
    rerender(<ReasoningBlock id="thought" text={'第一行继续\n第二行'} streaming redacted={false} preview t={t} />)
    expect(screen.getByText('第二行')).not.toBe(firstLine)
    expect(firstLine.isConnected).toBe(false)
  })
})
