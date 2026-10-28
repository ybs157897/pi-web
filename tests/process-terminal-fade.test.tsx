// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { ProcessTerminal } from '../src/web/ProcessTerminal.tsx'
import { setupRenderingDom } from './rendering/setup.ts'

const t = (zh: string) => zh
beforeEach(setupRenderingDom)
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

/** jsdom 没有布局：手动给视口喂尺寸，并让 scrollTop 像真实浏览器一样被夹在可滚动范围内。 */
function mockScrollMetrics(element: HTMLElement, metrics: { clientHeight: number; scrollHeight: number }) {
  let top = 0
  const clamp = (value: number) => Math.max(0, Math.min(metrics.scrollHeight - metrics.clientHeight, value))
  Object.defineProperty(element, 'clientHeight', { configurable: true, get: () => metrics.clientHeight })
  Object.defineProperty(element, 'scrollHeight', { configurable: true, get: () => metrics.scrollHeight })
  Object.defineProperty(element, 'scrollTop', { configurable: true, get: () => top, set: value => { top = clamp(value) } })
  return {
    metrics,
    scrollTo(value: number) { top = clamp(value); fireEvent.scroll(element) },
  }
}

describe('process terminal scroll fade edges', () => {
  it('reports no hidden edges when the output fits inside the viewport', () => {
    const { rerender } = render(<ProcessTerminal command="demo" output="line1\nline2" running={false} t={t} />)
    const region = screen.getByRole('region', { name: '命令输出' })
    const view = mockScrollMetrics(region, { clientHeight: 200, scrollHeight: 200 })
    view.scrollTo(0)
    rerender(<ProcessTerminal command="demo" output="line1\nline2" running={false} t={t} />)
    expect(region.getAttribute('data-edges')).toBe('none')
  })

  it('marks both edges in the middle, bottom at the top and top at the bottom', () => {
    const { rerender } = render(<ProcessTerminal command="demo" output={'line1\nline2\nline3'} running={false} t={t} />)
    const region = screen.getByRole('region', { name: '命令输出' })
    const view = mockScrollMetrics(region, { clientHeight: 100, scrollHeight: 300 })
    const renderAgain = () => rerender(<ProcessTerminal command="demo" output={'line1\nline2\nline3'} running={false} t={t} />)

    view.scrollTo(100); renderAgain()
    expect(region.getAttribute('data-edges')).toBe('both')

    view.scrollTo(0); renderAgain()
    expect(region.getAttribute('data-edges')).toBe('bottom')

    view.scrollTo(200); renderAgain()
    expect(region.getAttribute('data-edges')).toBe('top')

    view.scrollTo(100); renderAgain()
    expect(region.getAttribute('data-edges')).toBe('both')
  })

  it('recomputes edges when streamed content outgrows the viewport', () => {
    const { rerender } = render(<ProcessTerminal command="demo" output="line1" running={false} t={t} />)
    const region = screen.getByRole('region', { name: '命令输出' })
    const view = mockScrollMetrics(region, { clientHeight: 100, scrollHeight: 100 })
    view.scrollTo(0)
    expect(region.getAttribute('data-edges')).toBe('none')

    view.metrics.scrollHeight = 400
    rerender(<ProcessTerminal command="demo" output={'line1\nline2\nline3\nline4'} running={false} t={t} />)
    expect(region.getAttribute('data-edges')).toBe('bottom')
  })

  it('observes viewport and content sizes and disconnects on unmount', () => {
    const observers: Array<{ targets: unknown[]; disconnect: ReturnType<typeof vi.fn> }> = []
    vi.stubGlobal('ResizeObserver', class {
      targets: unknown[] = []
      disconnect = vi.fn()
      constructor() { observers.push(this) }
      observe(target: unknown) { this.targets.push(target) }
    })
    const { unmount } = render(<ProcessTerminal command="demo" output="line1" running={false} t={t} />)
    const region = screen.getByRole('region', { name: '命令输出' })
    const outputObserver = observers.find(observer => observer.targets.includes(region))
    expect(outputObserver?.targets).toEqual([region, region.firstElementChild])
    unmount()
    expect(outputObserver?.disconnect).toHaveBeenCalledTimes(1)
  })
})
