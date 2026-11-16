// @vitest-environment jsdom
/**
 * 思考块（ReasoningBlock）计时与折叠摘要测试。
 *
 * 关键契约：
 * - 折叠流式态：标题"正在思考"带 data-running，摘要行只显示最新一行，不展示耗时、不启动秒级计时器；
 * - 展开流式态：标题"思考"，计时只在展开且流式时走秒（fake timers 推进验证）；
 * - 流式结束后计时冻结在最终值，标题切回"思考"，旧思考无记录时长时显示"持续了几秒"；
 * - 展开的思考内容按纯文本渲染（**不解析** Markdown），摘要行变化时重放入场动画、同一行内追加不重放。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { ReasoningBlock } from '../src/web/message-rendering/ReasoningBlock.tsx'
import { setupRenderingDom } from './rendering/setup.ts'

/** 文案函数直通：zh 文本原样返回，便于按中文字面查询。 */
const t = (zh: string) => zh
/** 每个用例前补齐 jsdom 缺失 API；结束后清理 fake timers、stub 与 mock。 */
beforeEach(setupRenderingDom)
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks() })

/**
 * 以默认 props 渲染 ReasoningBlock 并允许覆盖。
 * @param props 覆盖项（text/streaming 等），其余取默认值
 * @returns render 结果（含 rerender）
 */
function renderBlock(props: Partial<Parameters<typeof ReasoningBlock>[0]> = {}) {
  return render(<ReasoningBlock id="thought" text="想一想" streaming={false} redacted={false} preview t={t} {...props} />)
}

/** 思考块的折叠/展开计时与摘要行为测试。 */
describe('reasoning block timing and collapsed summary', () => {
  // 折叠流式态：验证标题带 data-running、摘要显示多行文本中的"最新一句"、
  // 不出现"思考中"展开态标题，也没有"持续了 N 秒"计时（收起态无需每秒重渲染）。
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
  // 展开流式态走秒：点击展开后标题不带 data-running，"持续了 1 秒"出现；
  // fake timers 推进 1.2s/2.2s 计时跟随增长（1→2 秒），证明计时器只在展开+流式时运行。
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
  // 流式结束冻结：rerender 为 streaming=false 后计时停在"持续了 2 秒"，
  // 再推进 5 秒 fake time 数值不变（计时器已清除），标题为"思考"而非"正在思考"。
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
  // 旧数据兜底：已完成但无时长记录（历史消息没存 durationMs）的思考块显示"持续了几秒"占位。
  it('keeps 持续了几秒 when a finished thought has no recorded duration', () => {
    renderBlock({ text: '旧思考', streaming: false })
    expect(screen.getByRole('button', { name: '思考' })).toBeTruthy()
    expect(screen.getByText('持续了几秒')).toBeTruthy()
    expect(screen.queryByText('正在思考')).toBeNull()
  })
  // 内容安全/保真：展开区域按纯文本渲染，Markdown 粗体语法（**not parsed**）不被解析成 <strong>，
  // 换行原样保留，同时底部仍显示"持续了几秒"。
  it('keeps expanded thought content as plain text', () => {
    renderBlock({ text: 'line1\n**not parsed**', streaming: false })
    fireEvent.click(screen.getByRole('button', { name: '思考' }))
    expect(screen.getByRole('region', { name: '思考内容' }).textContent).toBe('line1\n**not parsed**')
    expect(document.querySelector('strong')).toBeNull()
    expect(screen.getByText('持续了几秒')).toBeTruthy()
  })
  // 入场动画重放判定：同一行内追加文字（"第一行"→"第一行继续"）复用同一 DOM 节点不重放动画；
  // 换新行（出现"第二行"）时替换节点并卸载旧行（重放动画）。
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
