// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { AnswerMarkdown } from '../src/web/AnswerMarkdown.tsx'
import { MessageCodeBlock } from '../src/web/message-rendering/CodeBlock.tsx'
import { MarkdownTable } from '../src/web/message-rendering/MarkdownTable.tsx'
import { ProcessTerminal } from '../src/web/ProcessTerminal.tsx'
import { ProcessRow } from '../src/web/ProcessRow.tsx'
import { ReasoningBlock } from '../src/web/message-rendering/ReasoningBlock.tsx'
import { UiPreferencesProvider, DEFAULT_UI_SETTINGS } from '../src/web/ui-preferences.tsx'
import { setupRenderingDom } from './rendering/setup.ts'
import DOMPurify from 'dompurify'
import { diagramSanitizeConfig } from '../src/web/message-rendering/diagram-model.ts'
import Transcript from '../src/web/transcript.tsx'
import { processMessages } from './rendering/samples.ts'
import { canRenderDiagram } from '../src/web/message-rendering/Diagram.tsx'
const t = (zh: string) => zh
beforeEach(setupRenderingDom)
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

describe('real message rendering interactions', () => {
  it('copies exact code, toggles wrapping, and keeps the toggle when the stream settles', async () => {
    const code = 'const greeting = "你好";\nconsole.log(greeting);'
    const { rerender } = render(<MessageCodeBlock code={code} language="typescript" streaming t={t} />)
    fireEvent.click(screen.getByRole('button', { name: '自动换行' }))
    expect(screen.getByRole('button', { name: '自动换行' }).getAttribute('aria-pressed')).toBe('true')
    rerender(<MessageCodeBlock code={code} language="typescript" t={t} />)
    expect(screen.getByRole('button', { name: '自动换行' }).getAttribute('aria-pressed')).toBe('true')
    fireEvent.click(screen.getByRole('button', { name: '复制代码' }))
    await screen.findByRole('button', { name: '已复制' })
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(code)
    expect(document.querySelector('[data-message-code-viewer]')?.getAttribute('data-highlighted')).toBe('true')
    await waitFor(() => expect(document.querySelector('diffs-container')?.shadowRoot?.textContent).toContain('greeting'))
  })
  it('settles an incomplete fence into highlighted code without losing content', async () => {
    const { rerender } = render(<AnswerMarkdown text={'```ts\nconst count = 1'} streaming t={t} />)
    expect(document.querySelector('[data-message-code-viewer]')?.getAttribute('data-highlighted')).toBe('false')
    rerender(<AnswerMarkdown text={'```ts\nconst count = 1\n```'} t={t} />)
    await waitFor(() => expect(document.querySelector('diffs-container')?.shadowRoot?.textContent).toContain('const count = 1'))
    expect(document.querySelectorAll('[data-message-code-block]')).toHaveLength(1)
    expect(document.querySelector('[data-message-code-viewer]')?.getAttribute('data-highlighted')).toBe('true')
  })
  it('does not announce copy success when the clipboard rejects', async () => {
    vi.mocked(navigator.clipboard.writeText).mockRejectedValue(new Error('denied'))
    render(<MessageCodeBlock code="hello" t={t} />)
    fireEvent.click(screen.getByRole('button', { name: '复制代码' }))
    await screen.findByRole('status')
    expect(screen.queryByRole('button', { name: '已复制' })).toBeNull()
  })
  it('previews a table, restores focus, exports its data and retains column alignment', async () => {
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    render(<MarkdownTable t={t}><thead><tr><th align="right">编号</th><th>说明</th></tr></thead><tbody><tr><td>1</td><td>=1+2</td></tr></tbody></MarkdownTable>)
    const opener = screen.getByRole('button', { name: '预览表格' }); opener.focus(); fireEvent.click(opener)
    const dialog = screen.getByRole('dialog', { name: '表格预览' })
    expect(within(dialog).getAllByRole('row')).toHaveLength(2)
    expect(within(dialog).getByRole('columnheader', { name: '编号' }).getAttribute('align')).toBe('right')
    fireEvent.click(within(dialog).getByRole('button', { name: '关闭' }))
    expect(document.activeElement).toBe(opener)
    fireEvent.click(screen.getByRole('button', { name: '复制 Markdown' }))
    await screen.findByRole('button', { name: '已复制' })
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith('| 编号 | 说明 |\n| --- | --- |\n| 1 | =1+2 |')
    fireEvent.click(screen.getByRole('button', { name: '下载 CSV' }))
    expect(click).toHaveBeenCalledOnce()
    const blob = vi.mocked(URL.createObjectURL).mock.calls[0]?.[0] as Blob
    expect(blob.type).toBe('text/csv;charset=utf-8')
  })
  it('navigates exact workspace paths and avoids nested image buttons inside links', async () => {
    const onOpenFile = vi.fn()
    const pathImages = { resolve: () => 'https://assets.test/image.png' }
    render(<AnswerMarkdown t={t} onOpenFile={onOpenFile} pathImages={pathImages} text={'[源文件](src/main.ts#L7-L9)\n\n[![图片](/image.png)](https://example.com)\n\n![单图](/image.png)'} />)
    fireEvent.click(screen.getByRole('button', { name: '源文件' }))
    expect(onOpenFile).toHaveBeenCalledWith('src/main.ts', 7)
    const link = screen.getByRole('link', { name: '图片' })
    expect(link.querySelector('button')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '预览图片：单图' }))
    expect(screen.getByRole('dialog', { name: '单图' })).toBeTruthy()
  })
  it('groups adjacent standalone images and opens the selected gallery item', async () => {
    render(<AnswerMarkdown t={t} pathImages={{ resolve: path => `https://images.test${path}` }} text={'![第一张](/one.png)\n\n![第二张](/two.png)'} />)
    expect(document.querySelectorAll('[data-markdown-image-gallery]')).toHaveLength(1)
    fireEvent.click(screen.getByRole('button', { name: '预览图片：第二张' }))
    await screen.findByRole('dialog', { name: '第二张' })
    fireEvent.click(screen.getByRole('button', { name: '上一张图片' }))
    expect(screen.getByRole('dialog', { name: '第一张' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '放大图片' }))
    expect(screen.getByText('125%')).toBeTruthy()
  })
  it('updates host file capabilities without replacing code blocks or their wrap state', async () => {
    const first = vi.fn(), next = vi.fn()
    const text = '[文件](README.md)\n\n```ts\nconst n = 1\n```'
    const { rerender } = render(<AnswerMarkdown t={t} text={text} onOpenFile={first} />)
    fireEvent.click(screen.getByRole('button', { name: '自动换行' }))
    rerender(<AnswerMarkdown t={t} text={text} onOpenFile={next} />)
    fireEvent.click(screen.getByRole('button', { name: '文件' }))
    expect(next).toHaveBeenCalledWith('README.md', undefined)
    expect(first).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: '自动换行' }).getAttribute('aria-pressed')).toBe('true')
  })
  it('keeps code and raw HTML inert while rendering CJK emphasis', () => {
    render(<AnswerMarkdown t={t} text={'中文**重点**\n\n<script>window.injected=true</script>\n\n[危险](javascript:alert(1))'} />)
    expect(screen.getByText('重点').tagName).toBe('STRONG')
    expect(document.querySelector('script')).toBeNull()
    expect(screen.queryByRole('link', { name: '危险' })).toBeNull()
  })
  it('keeps terminal output frozen while the user reads older lines, then resumes at the bottom', () => {
    const { rerender } = render(<ProcessTerminal command="demo" output="line1\nline2" running t={t} />)
    const region = screen.getByRole('region', { name: '命令输出' })
    Object.defineProperty(region, 'clientHeight', { configurable: true, value: 40 })
    Object.defineProperty(region, 'scrollHeight', { configurable: true, value: 200 })
    let top = 0
    Object.defineProperty(region, 'scrollTop', { configurable: true, get: () => top, set: n => { top = Math.max(0, Math.min(160, n)) } })
    rerender(<ProcessTerminal command="demo" output="line1\nline2\nline3" running t={t} />)
    expect(top).toBe(160)
    top = 0; fireEvent.scroll(region)
    rerender(<ProcessTerminal command="demo" output="line1\nline2\nline3\nline4" running t={t} />)
    expect(region.textContent).not.toContain('line4')
    top = 160; fireEvent.scroll(region)
    expect(region.textContent).toContain('line4')
    expect(region.getAttribute('data-following')).toBe('true')
  })
  it('preserves command newlines, ANSI colors and explicit failure status without HTML injection', () => {
    render(<ProcessTerminal command={'printf first\nprintf second'} output={'\u001b[31mRED\u001b[0m\n<script>unsafe</script>'} exitCode={7} running={false} t={t} />)
    expect(screen.getByText('RED').getAttribute('style')).toContain('color')
    expect(screen.getByText('退出码 7')).toBeTruthy()
    expect(document.querySelector('script')).toBeNull()
    expect(document.querySelector('[data-message-terminal]')?.textContent).toContain('printf first\nprintf second')
  })
  it('keeps thought content as text and exposes keyboard-ready expansion state', async () => {
    render(<ReasoningBlock id="thought" text={'line1\n**not parsed**'} streaming={false} redacted={false} preview t={t} />)
    const toggle = screen.getByRole('button', { name: '思考' })
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(toggle)
    expect(screen.getByRole('region', { name: '思考内容' }).textContent).toBe('line1\n**not parsed**')
    expect(screen.queryByRole('strong')).toBeNull()
  })
  it('connects read and edit file chips to the host and preserves tool disclosure through work-group toggles', () => {
    const onOpenFile = vi.fn(), onInspectDiff = vi.fn()
    render(<Transcript messages={processMessages()} onOpenFile={onOpenFile} onInspectDiff={onInspectDiff} onOpenTool={() => {}} />)
    const read = document.querySelector('[data-tool-name=read]') as HTMLElement
    fireEvent.click(within(read).getByRole('button', { name: 'example.ts' }))
    expect(onOpenFile).toHaveBeenCalledWith('src/example.ts')
    expect(within(read).queryByRole('button', { name: '展开工具详情' })).toBeNull()
    const edit = document.querySelector('[data-tool-name=edit]') as HTMLElement
    fireEvent.click(within(edit).getByRole('button', { name: 'example.ts' }))
    expect(onInspectDiff).toHaveBeenCalledWith(expect.objectContaining({ path: 'src/example.ts', oldText: 'const count = 1\n', newText: 'const count = 2\n' }))
    const terminal = document.querySelector('[data-tool-name=bash]') as HTMLElement
    fireEvent.click(within(terminal).getByRole('button', { name: '展开工具详情' }))
    expect(within(terminal).getByRole('region', { name: '命令输出' })).toBeTruthy()
    const group = screen.getByRole('button', { name: '已工作 11 秒' })
    fireEvent.click(group); fireEvent.click(group)
    expect(within(terminal).getByRole('button', { name: '收起工具详情' }).getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByRole('button', { name: '展开已更改文件' }).getAttribute('aria-expanded')).toBe('false')
  })
  it('preserves Mermaid foreignObject labels while stripping active HTML', () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"><foreignObject><div xmlns="http://www.w3.org/1999/xhtml" onclick="alert(1)">开始<script>alert(1)</script></div></foreignObject></svg>'
    const safe = DOMPurify.sanitize(svg, diagramSanitizeConfig)
    expect(safe).toContain('开始')
    expect(safe).toContain('foreignObject')
    expect(safe).not.toContain('onclick')
    expect(safe).not.toContain('<script')
  })
  it('guards expensive Mermaid input before loading the renderer', () => {
    expect(canRenderDiagram('flowchart LR\nA-->B')).toBe(true)
    expect(canRenderDiagram('x'.repeat(20_001))).toBe(false)
    expect(canRenderDiagram('A-->B\n'.repeat(601))).toBe(false)
    expect(canRenderDiagram('A[x]-->B-->C\n'.repeat(450))).toBe(false)
  })
})
