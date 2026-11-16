// @vitest-environment jsdom
/**
 * 命令输出终端（ProcessTerminal）滚动渐隐边缘指示测试。
 *
 * 关键契约：输出区域通过 data-edges 属性报告被遮挡的边缘——
 * 内容不超出视口为 none；滚动在中间为 both；顶部为 bottom；底部为 top。
 * 边缘状态随流式输出增长重新计算，ResizeObserver 观察视口与内容两个元素、卸载时断开。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { ProcessTerminal } from '../src/web/ProcessTerminal.tsx'
import { setupRenderingDom } from './rendering/setup.ts'

/** 文案函数直通：zh 文本原样返回。 */
const t = (zh: string) => zh
/** 每个用例前补齐 jsdom 缺失 API；结束后清理。 */
beforeEach(setupRenderingDom)
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

/**
 * jsdom 没有布局：手动给视口喂尺寸，并让 scrollTop 像真实浏览器一样被夹在可滚动范围内。
 * @param element 输出区域元素
 * @param metrics 视口高度 clientHeight 与内容高度 scrollHeight
 * @returns 含 metrics（可后续改 scrollHeight 模拟内容增长）与 scrollTo 的控制句柄
 */
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

/** data-edges 边缘指示随滚动位置与内容量变化的测试。 */
describe('process terminal scroll fade edges', () => {
  // 验证内容不超过视口（clientHeight == scrollHeight）时无论怎么滚动都报 none（无隐藏边缘）。
  it('reports no hidden edges when the output fits inside the viewport', () => {
    const { rerender } = render(<ProcessTerminal command="demo" output="line1\nline2" running={false} t={t} />)
    const region = screen.getByRole('region', { name: '命令输出' })
    const view = mockScrollMetrics(region, { clientHeight: 200, scrollHeight: 200 })
    view.scrollTo(0)
    rerender(<ProcessTerminal command="demo" output="line1\nline2" running={false} t={t} />)
    expect(region.getAttribute('data-edges')).toBe('none')
  })

  // 验证四个滚动位置的状态：中间（scrollTop=100）上下都遮 → both；
  // 顶部（0）→ bottom（只遮下缘）；底部（200）→ top（只遮上缘）；回到中间又变 both。
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

  // 验证内容增长触发重算：初始不超视口为 none，流式追加后 scrollHeight 变 400、
  // 即使滚动位置停在顶部也重新报 bottom。
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

  // 验证观察器接线：ResizeObserver 同时观察输出区域（视口尺寸）与其第一个子元素（内容尺寸）；
  // 组件卸载时恰好调用一次 disconnect。
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
