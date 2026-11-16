/**
 * ProcessRow（进程/终端行组件）交互契约测试。
 *
 * 通过 renderToStaticMarkup 检查静态 HTML：折叠/展开的无障碍标注（aria-expanded）、
 * 摘要与详情内容的互斥渲染、以及独立操作按钮（如"查看计划"）位于折叠切换按钮之外，
 * 点击不会误触折叠。
 */
import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { ProcessRow } from '../src/web/ProcessRow.tsx'

/** ProcessRow 的渲染契约：无障碍展开标注与独立操作区的隔离。 */
describe('process row interaction contract', () => {
  // 折叠态：验证 aria-expanded="false"、只渲染 summary 不渲染 children（详情），
  // 且 accessory 按钮（"查看计划"）紧跟在切换 button 之后——它是独立操作，不属于切换目标。
  it('announces expansion state and keeps an independent action outside the toggle', () => {
    const html = renderToStaticMarkup(<ProcessRow icon="T" title="终端" open={false} expandable onToggle={() => {}}
      summary={<span>printf example</span>} accessory={<button type="button">查看计划</button>}>output</ProcessRow>)
    expect(html).toContain('aria-expanded="false"')
    expect(html).toContain('printf example')
    expect(html).not.toContain('output')
    expect(html).toMatch(/<\/button><button type="button">查看计划<\/button>/u)
  })
  // 展开态：验证 aria-expanded="true" 时渲染 children（终端输出）并移除折叠时的 summary 文本。
  it('shows details when expanded and removes the collapsed summary', () => {
    const html = renderToStaticMarkup(<ProcessRow icon="T" title="终端" open expandable onToggle={() => {}}
      summary="summary">terminal output</ProcessRow>)
    expect(html).toContain('aria-expanded="true"')
    expect(html).toContain('terminal output')
    expect(html).not.toContain('summary')
  })
})
