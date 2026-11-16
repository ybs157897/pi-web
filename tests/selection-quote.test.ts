// @vitest-environment jsdom
import { createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import SelectionChatPane from '../src/web/SelectionChatPane.tsx'
import SelectionAskPopover from '../src/web/SelectionAskPopover.tsx'
import { buildSideChatPrompt } from '../src/web/selection-quote.ts'
import { setupRenderingDom } from './rendering/setup.ts'

/**
 * 划词侧聊（selection quote）契约测试：引用块拼装规则、侧聊面板的渲染与交互、
 * 划词弹层的显隐与回调。
 */

/**
 * 挂载 SelectionChatPane 的冒烟测试辅助。
 * 本 spec 是 `.ts` 文件（无 JSX 转换），因此通过 `createElement` 挂载。
 * @param props messages 消息列表、busy 忙态、onSend 发送回调
 * @returns testing-library 的 render 结果
 */
function renderPane(props: { messages?: Array<{ role: 'user' | 'assistant'; text: string }>; busy?: boolean; onSend?: (text: string) => void }) {
  return render(createElement(SelectionChatPane, {
    conversationId: 'side-1', title: '辅助对话 1',
    messages: props.messages ?? [], busy: props.busy ?? false, onSend: props.onSend ?? (() => {}),
  }))
}

beforeEach(() => { setupRenderingDom() })
afterEach(() => { cleanup(); vi.restoreAllMocks() })

/** 四行代码样本，供引用块拼装用例复用。 */
const CODE = ['line-1', 'line-2', 'line-3', 'line-4'].join('\n')

describe('buildSideChatPrompt', () => {
  // 有来源时的拼装契约：来源标题行 + 对应语言围栏 + 问题，三段以空行分隔。
  it('prepends a sourced fenced quote before the question', () => {
    expect(buildSideChatPrompt(CODE, '这段做什么？', 'src/a.ts')).toBe(
      '来自 src/a.ts 的引用：\n\n```ts\nline-1\nline-2\nline-3\nline-4\n```\n\n这段做什么？',
    )
  })

  // 无来源时标题回退为「引用内容」，围栏语言回退为 text。
  it('falls back to 引用内容 and the text fence without a source', () => {
    expect(buildSideChatPrompt('just one line', 'why?')).toBe(
      '引用内容：\n\n```text\njust one line\n```\n\nwhy?',
    )
  })

  // 长引用折叠边界：保留首尾各 6 行，中间以「省略 N 行」占位（20 行省略 8 行）。
  it('keeps six lines at each end of a long quote and names the elided middle', () => {
    const lines = Array.from({ length: 20 }, (_, index) => `L${index + 1}`)
    const prompt = buildSideChatPrompt(lines.join('\n'), '总结一下', 'big.md')
    expect(prompt).toContain('…（省略 8 行）…')
    expect(prompt).toContain('L6\n…（省略 8 行）…\nL15')
    expect(prompt).toContain('```markdown')
    expect(prompt).not.toContain('L10\n')
  })

  // 阈值边界：12 行整段保留不折叠；13 行起折叠，即使只省 1 行。
  it('keeps a 12-line quote whole and elides one line at 13', () => {
    const twelve = Array.from({ length: 12 }, (_, index) => `L${index + 1}`)
    expect(buildSideChatPrompt(twelve.join('\n'), 'q')).not.toContain('省略')
    expect(buildSideChatPrompt([...twelve, 'L13'].join('\n'), 'q')).toContain('…（省略 1 行）…')
  })

  // 边界：问题为空白时只返回引用块，不追加空问题段。
  it('returns the quote block alone when the question is blank', () => {
    const prompt = buildSideChatPrompt('one line', '   ')
    expect(prompt).toBe('引用内容：\n\n```text\none line\n```')
  })

  // 边界：引用为空白时原样返回问题，不产出空引用块。
  it('returns the question verbatim when the quote is blank', () => {
    expect(buildSideChatPrompt('   ', '这段做什么？')).toBe('这段做什么？')
  })

  // 围栏前先修剪引用首尾空白，避免空行混入代码块首尾。
  it('trims the quote edges before fencing it', () => {
    expect(buildSideChatPrompt('  padded  ', 'q', 'x.py')).toBe(
      '来自 x.py 的引用：\n\n```python\npadded\n```\n\nq',
    )
  })

  // 围栏语言按来源扩展名推断；无法识别的扩展名回退 text。
  it('infers markdown and python fence languages from the source extension', () => {
    expect(buildSideChatPrompt('a', '', 'README.md')).toContain('```markdown\n')
    expect(buildSideChatPrompt('a', '', 'tool.py')).toContain('```python\n')
    expect(buildSideChatPrompt('a', '', 'notes')).toContain('```text\n')
  })
})

describe('SelectionChatPane (render smoke)', () => {
  /** 一问一答的消息样本，验证用户纯文本与助手 markdown 两种渲染路径。 */
  const messages = [
    { role: 'user' as const, text: '这段代码做什么？' },
    { role: 'assistant' as const, text: '它把引用与问题拼成一条消息。' },
  ]

  // 边界：空消息流时展示引导文案，而非空白面板。
  it('shows the guide when the feed is empty', () => {
    renderPane({})
    expect(screen.getByText('选中正文后点「在侧聊中提问」，或在下方直接输入')).toBeTruthy()
  })

  // 两种角色行都可见：用户原文与助手 markdown 渲染结果。
  it('renders user text and assistant markdown rows', () => {
    renderPane({ messages })
    expect(screen.getByText('这段代码做什么？')).toBeTruthy()
    expect(screen.getByText(/拼成一条消息/)).toBeTruthy()
  })

  // 输入契约：Enter 发送修剪后的草稿并清空输入框；Shift+Enter 换行不发送；
  // busy 时 Enter 失效并显示「正在回复…」状态行。
  it('sends the trimmed draft on Enter and not on Shift+Enter, blocking while busy', () => {
    const onSend = vi.fn()
    renderPane({ onSend })
    const input = screen.getByLabelText('发送侧聊消息') as HTMLTextAreaElement
    fireEvent.change(input, { target: { value: '  帮我看看  ' } })
    fireEvent.keyDown(input, { key: 'Enter', shiftKey: true })
    expect(onSend).not.toHaveBeenCalled()
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onSend).toHaveBeenCalledWith('帮我看看')
    expect(input.value).toBe('')
    // busy: the send button and Enter are inert and the busy row shows.
    const busyPane = renderPane({ busy: true, onSend }).container
    const busyInput = busyPane.querySelector('textarea')!
    fireEvent.change(busyInput, { target: { value: '第二条' } })
    fireEvent.keyDown(busyInput, { key: 'Enter' })
    expect(onSend).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('status').textContent).toBe('正在回复…')
  })
})

describe('SelectionAskPopover', () => {
  /** jsdom 的 Range 没有几何实现，且 rAF 可能不存在：两个都在测试里垫掉。 */
  function stubGeometry(): void {
    Object.defineProperty(Range.prototype, 'getBoundingClientRect', {
      configurable: true,
      value: (): DOMRect => ({
        width: 120, height: 16, top: 40, left: 10, right: 130, bottom: 56, x: 10, y: 40,
        toJSON: () => ({}),
      } as DOMRect),
    })
    vi.stubGlobal('requestAnimationFrame', (callback: (time: number) => void) => { callback(0); return 1 })
    vi.stubGlobal('cancelAnimationFrame', () => {})
  }

  function mount(onAsk: (quote: string) => void): { container: HTMLElement; target: HTMLElement } {
    const container = document.createElement('div')
    const target = document.createElement('p')
    target.textContent = '被引用的正文内容'
    container.appendChild(target)
    document.body.appendChild(container)
    render(createElement(SelectionAskPopover, { containerRef: { current: container }, onAsk }))
    return { container, target }
  }

  // 弹层契约：容器内出现选区时展示按钮，点击后以选中文本回调 onAsk
  // 并收起（collapse）选区。
  it('appears for a selection inside the container and reports the quote on click', () => {
    stubGeometry()
    const onAsk = vi.fn()
    const { target } = mount(onAsk)
    const range = document.createRange()
    range.selectNodeContents(target)
    const selection = window.getSelection()!
    selection.removeAllRanges()
    selection.addRange(range)
    fireEvent(document, new Event('selectionchange'))
    const button = screen.getByText('在侧聊中提问')
    fireEvent.click(button)
    expect(onAsk).toHaveBeenCalledWith('被引用的正文内容')
    expect(selection.isCollapsed).toBe(true)
  })

  // 边界：容器外的选区不得触发弹层，按钮保持不可见。
  it('stays hidden when the selection lives outside the container', () => {
    stubGeometry()
    const onAsk = vi.fn()
    const { target } = mount(onAsk)
    const outside = document.createElement('p')
    outside.textContent = '容器外的文字'
    document.body.appendChild(outside)
    const range = document.createRange()
    range.selectNodeContents(outside)
    const selection = window.getSelection()!
    selection.removeAllRanges()
    selection.addRange(range)
    void target
    fireEvent(document, new Event('selectionchange'))
    expect(screen.queryByText('在侧聊中提问')).toBeNull()
  })
})
