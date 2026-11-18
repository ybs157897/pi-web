// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Inspector from '../src/web/Inspector.tsx'
import type { InspectorTab, TabFile } from '../src/web/inspector-tabs.ts'
import { setupRenderingDom } from './rendering/setup.ts'

beforeEach(setupRenderingDom)
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

function documentTab(file: TabFile): InspectorTab {
  return { id: file.path, type: 'document', title: file.path, openedAt: 1, doc: { kind: 'file', file } }
}

function sourceRow(container: HTMLElement, line: number): HTMLElement | null {
  return container.querySelector(`[data-source-line="${line}"]`)
}

function mockLineGeometry(): void {
  vi.spyOn(HTMLElement.prototype, 'offsetTop', 'get').mockImplementation(function (this: HTMLElement) {
    return Number(this.dataset.sourceLine ?? 0) * 20
  })
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(20)
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(200)
}

describe('inspector line navigation', () => {
  it('centers a new request in the source scrollport and preserves scroll across normal tab switches', () => {
    mockLineGeometry()
    const text = { path: 'a.txt', content: Array.from({ length: 100 }, (_, i) => `row ${i + 1}`).join('\r\n') }
    const other = documentTab({ path: 'b.txt', content: 'other document' })
    const onClose = vi.fn()
    const view = (activeTabId: string, line?: number, lineRequestId?: number) => <Inspector
      tabs={[documentTab({ ...text, line, lineRequestId }), other]} activeTabId={activeTabId} onClose={onClose} />
    const { rerender, container } = render(view('a.txt'))
    const viewport = screen.getByRole('region', { name: 'a.txt 的源码' })
    container.scrollTop = 24

    rerender(view('a.txt', 66, 1))
    const row = sourceRow(container, 66)
    expect(row?.getAttribute('aria-current')).toBe('location')
    expect(row?.textContent).toContain('row 66')
    expect(viewport.scrollTop).toBe(66 * 20 - 90)
    expect(container.scrollTop).toBe(24)

    viewport.scrollTop = 450
    rerender(view('b.txt', 66, 1))
    rerender(view('a.txt', 66, 1))
    expect(viewport.scrollTop).toBe(450)
    rerender(view('a.txt', 66, 2))
    expect(viewport.scrollTop).toBe(66 * 20 - 90)

    rerender(view('a.txt', 81, 3))
    expect(sourceRow(container, 81)?.getAttribute('aria-current')).toBe('location')
    expect(row?.getAttribute('aria-current')).toBeNull()
    expect(viewport.scrollTop).toBe(81 * 20 - 90)
  })

  it.each(['README.md', 'example.html'])('switches an existing %s preview to source on every line request', path => {
    const file = { path, content: path.endsWith('md') ? '# Heading\nText' : '<h1>Heading</h1>\n<p>Text</p>' }
    const view = (line?: number, lineRequestId?: number) => <Inspector
      tabs={[documentTab({ ...file, line, lineRequestId })]} activeTabId={path} onClose={vi.fn()} />
    const { container, rerender } = render(view())
    expect(screen.getByRole('button', { name: '预览' }).getAttribute('aria-pressed')).toBe('true')
    expect(sourceRow(container, 2)).toBeNull()

    rerender(view(2, 1))
    expect(screen.getByRole('button', { name: '源码' }).getAttribute('aria-pressed')).toBe('true')
    expect(sourceRow(container, 2)?.getAttribute('aria-current')).toBe('location')
    fireEvent.click(screen.getByRole('button', { name: '预览' }))
    expect(sourceRow(container, 2)).toBeNull()
    rerender(view(2, 2))
    expect(sourceRow(container, 2)?.getAttribute('aria-current')).toBe('location')
  })

  it('shows omitted text and invalid targets without highlighting an unrelated line', () => {
    const file: TabFile = { path: 'long.md', line: 2001, lineRequestId: 1, content: '# previous\nactual target\nfollowing',
      textWindow: { startLine: 2000, totalLines: 4000, clippedLines: true } }
    const view = (next: TabFile) => <Inspector tabs={[documentTab(next)]} activeTabId={file.path} onClose={vi.fn()} />
    const { container, rerender } = render(view(file))
    expect(sourceRow(container, 2001)?.getAttribute('aria-current')).toBe('location')
    expect(screen.queryByRole('button', { name: '预览' })).toBeNull()
    expect(screen.getByText('第 2000–2002 行，共 4000 行')).toBeTruthy()
    expect(screen.getByText('部分长行已截断')).toBeTruthy()

    const firstExcerpt = { ...file, content: '# First', line: 4001, lineRequestId: 2,
      textWindow: { startLine: 1, totalLines: 4000, clippedLines: false } }
    rerender(view(firstExcerpt))
    expect(container.querySelector('[data-source-line][aria-current]')).toBeNull()
    expect(screen.getByRole('status').textContent).toBe('文件中没有第 4001 行（共 4000 行）')
  })

  it('renders a bounded number of rows around a deep target in a full text response', () => {
    const file = { path: 'long.txt', line: 7000, content: Array.from({ length: 8_000 }, (_, i) => `row ${i + 1}`).join('\n') }
    const { container } = render(<Inspector tabs={[documentTab(file)]} activeTabId={file.path} onClose={vi.fn()} />)
    expect(container.querySelectorAll('[data-source-line]')).toHaveLength(800)
    expect(sourceRow(container, 7000)?.getAttribute('aria-current')).toBe('location')
    fireEvent.click(screen.getByRole('button', { name: '下一段' }))
    expect(sourceRow(container, 8000)?.textContent).toContain('row 8000')
    expect(screen.getByRole('button', { name: '下一段' })).toHaveProperty('disabled', true)
  })

  it('exposes pending reads and file errors in the tabbed inspector', () => {
    const empty = { onClose: vi.fn(), onOpenNewTab: vi.fn() }
    const { rerender } = render(<Inspector {...empty} loading />)
    expect(screen.getByRole('status').textContent).toBe('正在读取文件…')
    rerender(<Inspector {...empty} error="文件不存在" />)
    expect(screen.getByRole('alert').textContent).toBe('文件不存在')
  })
})
