// @vitest-environment jsdom
/**
 * 真实消息渲染组件的交互测试（jsdom）：代码块、表格、图片画廊、终端、思考块、
 * 工具行接线与 Mermaid 安全防线。
 *
 * 关键契约：
 * - 代码块：复制原文到剪贴板、换行开关在流式落定后保持、未闭合围栏落定后高亮且内容不丢；
 *   剪贴板拒绝时不显示"已复制"；Shiki 高亮经 diffs-container shadow DOM；
 * - 表格预览对话框：行数/列对齐保留、关闭后焦点还原、复制原始 Markdown、导出 CSV blob；
 * - 文件链接芯片接 onOpenFile（起始行），嵌在链接里的图片不产生嵌套按钮，独立图片可预览；
 * - 相邻独立图片聚合成画廊（上一张/放大 125%）；onOpenFile 回调替换不重建代码块与换行状态；
 * - XSS 防线：script 不注入、javascript: 链接移除、CJK 强调正常渲染；
 * - 终端：阅读旧输出时冻结跟随、回到底部恢复跟随（data-following）；ANSI 颜色保留、
 *   退出码显示、多行命令原文保留、HTML 不注入；
 * - 思考块纯文本 + aria-expanded；工具行芯片接 onOpenFile/onInspectDiff，工作组折叠状态
 *   穿透保持子行展开态；Mermaid foreignObject 标签保留但 onclick/script 剥除；
 *   Mermaid 渲染前的输入体积防线（长度/行数/节点数上限）。
 */
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
/** 文案函数直通：zh 文本原样返回。 */
const t = (zh: string) => zh
/** 每个用例前补齐 jsdom 缺失 API；结束后清理 mock 与全局 stub。 */
beforeEach(setupRenderingDom)
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

/** 渲染组件交互契约测试。 */
describe('real message rendering interactions', () => {
  // 验证代码块交互：换行开关 aria-pressed 翻转且 rerender（流式落定）后状态保持；
  // 复制按钮把原始代码写入剪贴板并短暂显示"已复制"；高亮完成（data-highlighted），
  // Shiki 输出出现在 diffs-container shadow DOM 中。
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
  // 验证未闭合围栏落定：streaming 时代码查看器未高亮（data-highlighted=false），
  // 补上闭合 ``` 后内容完整（shadow DOM 含 const count = 1）、恰好一个代码块且转为高亮。
  it('settles an incomplete fence into highlighted code without losing content', async () => {
    const { rerender } = render(<AnswerMarkdown text={'```ts\nconst count = 1'} streaming t={t} />)
    expect(document.querySelector('[data-message-code-viewer]')?.getAttribute('data-highlighted')).toBe('false')
    rerender(<AnswerMarkdown text={'```ts\nconst count = 1\n```'} t={t} />)
    await waitFor(() => expect(document.querySelector('diffs-container')?.shadowRoot?.textContent).toContain('const count = 1'))
    expect(document.querySelectorAll('[data-message-code-block]')).toHaveLength(1)
    expect(document.querySelector('[data-message-code-viewer]')?.getAttribute('data-highlighted')).toBe('true')
  })
  // 验证复制失败反馈：剪贴板 writeText 拒绝时出现 status 提示但不出"已复制"按钮。
  it('does not announce copy success when the clipboard rejects', async () => {
    vi.mocked(navigator.clipboard.writeText).mockRejectedValue(new Error('denied'))
    render(<MessageCodeBlock code="hello" t={t} />)
    fireEvent.click(screen.getByRole('button', { name: '复制代码' }))
    await screen.findByRole('status')
    expect(screen.queryByRole('button', { name: '已复制' })).toBeNull()
  })
  // 验证表格预览对话框：两行数据、右对齐列头保留 align 属性、关闭后焦点回到打开按钮；
  // "复制 Markdown"写回原始管道文本；"下载 CSV"触发一次锚点点击且 blob 类型为 text/csv。
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
  // 验证文件路径导航：点击"源文件"芯片以路径+起始行（L7→7）回调 onOpenFile；
  // 带链接的图片内不嵌套 button（避免按钮嵌链接的无障碍违规）；独立图片可打开预览对话框。
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
  // 验证图片画廊：相邻独立图片聚合为一个画廊容器；点开第二张、上一张切回第一张、
  // 放大操作显示 125% 缩放指示。
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
  // 验证宿主能力更新：onOpenFile 回调替换后点击文件芯片用新回调（旧回调不触发），
  // 且代码块不重建、换行开关状态保持。
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
  // 验证 XSS 防线：CJK 粗体正常渲染为 STRONG；<script> 不进入文档；
  // javascript: 危险链接不渲染为可点击链接。
  it('keeps code and raw HTML inert while rendering CJK emphasis', () => {
    render(<AnswerMarkdown t={t} text={'中文**重点**\n\n<script>window.injected=true</script>\n\n[危险](javascript:alert(1))'} />)
    expect(screen.getByText('重点').tagName).toBe('STRONG')
    expect(document.querySelector('script')).toBeNull()
    expect(screen.queryByRole('link', { name: '危险' })).toBeNull()
  })
  // 验证终端跟随逻辑：运行中用户在底部时新输出自动跟随（scrollTop 钉在最大值）；
  // 用户滚回顶部后新输出被抑制（不进入 DOM、不打断阅读）；手动滚回底部后恢复跟随（data-following=true）。
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
  // 验证终端保真与安全：ANSI 转义渲染为颜色样式、显式退出码 7 显示"退出码 7"、
  // 输出中的 <script> 不注入、多行命令原文（含换行）完整保留。
  it('preserves command newlines, ANSI colors and explicit failure status without HTML injection', () => {
    render(<ProcessTerminal command={'printf first\nprintf second'} output={'\u001b[31mRED\u001b[0m\n<script>unsafe</script>'} exitCode={7} running={false} t={t} />)
    expect(screen.getByText('RED').getAttribute('style')).toContain('color')
    expect(screen.getByText('退出码 7')).toBeTruthy()
    expect(document.querySelector('script')).toBeNull()
    expect(document.querySelector('[data-message-terminal]')?.textContent).toContain('printf first\nprintf second')
  })
  // 验证思考块：折叠按钮 aria-expanded 初始 false、点击展开为"思考内容"区域、
  // 内容按纯文本保留（Markdown 粗体不解析）。
  it('keeps thought content as text and exposes keyboard-ready expansion state', async () => {
    render(<ReasoningBlock id="thought" text={'line1\n**not parsed**'} streaming={false} redacted={false} preview t={t} />)
    const toggle = screen.getByRole('button', { name: '思考' })
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(toggle)
    expect(screen.getByRole('region', { name: '思考内容' }).textContent).toBe('line1\n**not parsed**')
    expect(screen.queryByRole('strong')).toBeNull()
  })
  // 验证工具行接线与折叠穿透：read 行文件芯片回调 onOpenFile（无展开按钮）；
  // edit 行芯片回调 onInspectDiff 携带完整 diff；bash 行展开出现"命令输出"区域；
  // 工作组折叠/展开后子行保持展开；改动文件摘要可独立开合并打开差异。
  it('connects read and edit file chips to the host and preserves tool disclosure through work-group toggles', () => {
    const onOpenFile = vi.fn(), onInspectDiff = vi.fn()
    render(<Transcript messages={processMessages()} onOpenFile={onOpenFile} onInspectDiff={onInspectDiff} onOpenTool={() => {}} />)
    const group = screen.getByRole('button', { name: '已工作 11 秒' })
    expect(group.getAttribute('aria-expanded')).toBe('false')
    expect(screen.queryByRole('button', { name: 'example.ts' })).toBeNull()
    fireEvent.click(group)
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
    fireEvent.click(group)
    expect(screen.queryByRole('region', { name: '命令输出' })).toBeNull()
    fireEvent.click(group)
    expect(within(terminal).getByRole('button', { name: '收起工具详情' }).getAttribute('aria-expanded')).toBe('true')
    const changes = screen.getByRole('button', { name: '展开已更改文件' })
    expect(changes.getAttribute('aria-expanded')).toBe('false')
    expect(screen.queryByRole('button', { name: '查看 example.ts 的改动' })).toBeNull()
    fireEvent.click(changes)
    expect(changes.getAttribute('aria-expanded')).toBe('true')
    onInspectDiff.mockClear()
    fireEvent.click(screen.getByRole('button', { name: '查看 example.ts 的改动' }))
    expect(onInspectDiff).toHaveBeenCalledWith(expect.objectContaining({ path: 'src/example.ts', oldText: 'const count = 1\n', newText: 'const count = 2\n' }))
    fireEvent.click(changes)
    expect(screen.queryByRole('button', { name: '查看 example.ts 的改动' })).toBeNull()
  })
  // 验证 Mermaid 净化配置：foreignObject 内的文本标签（"开始"）与结构保留，
  // onclick 事件属性与 <script> 被剥除。
  it('preserves Mermaid foreignObject labels while stripping active HTML', () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"><foreignObject><div xmlns="http://www.w3.org/1999/xhtml" onclick="alert(1)">开始<script>alert(1)</script></div></foreignObject></svg>'
    const safe = DOMPurify.sanitize(svg, diagramSanitizeConfig)
    expect(safe).toContain('开始')
    expect(safe).toContain('foreignObject')
    expect(safe).not.toContain('onclick')
    expect(safe).not.toContain('<script')
  })
  // 验证渲染前防线：正常流程图放行；超长文本（20k+）、超多行（600+）、超多节点（450+）拒绝，
  // 避免恶意输入拖死 Mermaid 渲染器。
  it('guards expensive Mermaid input before loading the renderer', () => {
    expect(canRenderDiagram('flowchart LR\nA-->B')).toBe(true)
    expect(canRenderDiagram('x'.repeat(20_001))).toBe(false)
    expect(canRenderDiagram('A-->B\n'.repeat(601))).toBe(false)
    expect(canRenderDiagram('A[x]-->B-->C\n'.repeat(450))).toBe(false)
  })
})
