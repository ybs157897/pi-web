// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import type { ComponentProps } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Composer from '../src/web/Composer.tsx'
import { DEFAULT_UI_SETTINGS, UiPreferencesProvider } from '../src/web/ui-preferences.tsx'
import { setupRenderingDom } from './rendering/setup.ts'

beforeEach(setupRenderingDom)
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

function composerProps(overrides: Partial<ComponentProps<typeof Composer>> = {}): ComponentProps<typeof Composer> {
  return {
    value: '', images: [], thinkingLevel: 'off', busy: false, queue: [], sendMode: 'followUp', sending: false,
    model: { provider: 'demo', modelId: 'test' },
    catalog: {
      models: [{ provider: 'demo', modelId: 'test', name: 'Test', available: true, reasoning: false, contextWindow: 50_000 }],
      providers: [], thinkingLevels: ['off'],
    },
    stats: {
      runCount: 3, stepCount: 9, tokensPerSecond: 42.3, totalTokens: 13_550,
      input: 3_000, output: 350, cacheRead: 9_600, cacheWrite: 600, contextTokens: 12_000,
    },
    onChange: vi.fn(), onAddImages: vi.fn(), onRemoveImage: vi.fn(), onSend: vi.fn(), onStop: vi.fn(),
    onRemoveQueue: vi.fn(), onSelectModel: vi.fn(), onThinkingLevel: vi.fn(), onSendMode: vi.fn(),
    ...overrides,
  }
}

describe('composer usage disclosure', () => {
  it('groups performance, all token buckets, and context under one trigger', () => {
    render(<Composer {...composerProps()} />)
    const trigger = screen.getByRole('button', { name: '用量 · 上下文已用 24%' })
    expect(trigger.getAttribute('aria-expanded')).toBe('false')
    expect(screen.queryByText('缓存命中')).toBeNull()

    trigger.focus()
    fireEvent.click(trigger)
    const panel = screen.getByRole('region', { name: '用量详情' })
    expect(trigger.getAttribute('aria-controls')).toBe(panel.id)
    expect(trigger.getAttribute('aria-expanded')).toBe('true')
    const stats = within(panel)
    for (const [label, value] of [
      ['轮数', '3'], ['步数', '9'], ['输出速度', '42 tok/s'], ['Token 总量', '13,550'], ['缓存命中', '73%'],
      ['未缓存输入', '3,000'], ['缓存读取', '9,600'], ['缓存写入', '600'], ['输出', '350'], ['上下文已用', '~12K / 50K (24%)'],
    ]) {
      expect(stats.getByText(label).nextElementSibling?.textContent).toBe(value)
    }

    panel.focus()
    fireEvent.keyDown(panel, { key: 'Escape' })
    expect(document.activeElement).toBe(trigger)
    expect(trigger.getAttribute('aria-expanded')).toBe('false')
    expect(screen.queryByRole('region', { name: '用量详情' })).toBeNull()
  })

  it('keeps full details reachable in compact mode and lets send mode open independently', () => {
    const onSendMode = vi.fn()
    render(<UiPreferencesProvider value={{ ...DEFAULT_UI_SETTINGS, locale: 'en', performanceUsage: 'compact' }}>
      <Composer {...composerProps({ busy: true, onSendMode })} />
    </UiPreferencesProvider>)
    const trigger = screen.getByRole('button', { name: 'Usage · 13.6K tok' })
    expect(trigger.textContent).toBe('13.6K tok')
    fireEvent.click(trigger)
    expect(within(screen.getByRole('region', { name: 'Usage details' })).getByText('Context used')).toBeTruthy()

    const mode = screen.getByRole('button', { name: 'Queue' })
    fireEvent.pointerDown(mode)
    fireEvent.click(mode)
    expect(screen.queryByRole('region', { name: 'Usage details' })).toBeNull()
    fireEvent.click(screen.getByRole('menuitem', { name: 'Steer now' }))
    expect(onSendMode).toHaveBeenCalledWith('steer')
  })

  it('allows looking up run and step counts before token measurements arrive', () => {
    const stats = { runCount: 1, stepCount: 2, totalTokens: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, contextTokens: 0 }
    render(<Composer {...composerProps({ stats })} />)
    fireEvent.click(screen.getByRole('button', { name: '用量 · 1 轮' }))
    const panel = within(screen.getByRole('region', { name: '用量详情' }))
    expect(panel.getByText('轮数')).toBeTruthy()
    expect(panel.getByText('步数')).toBeTruthy()
    expect(panel.queryByText('Token 总量')).toBeNull()
    expect(panel.queryByText('上下文已用')).toBeNull()
  })
})
