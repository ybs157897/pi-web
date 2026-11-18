// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AnswerMarkdown } from '../src/web/AnswerMarkdown.tsx'
import { parseAnswerFileLink } from '../src/web/answer-markdown-model.ts'
import { presentationPolicyFor } from '../src/web/presentation-policy.ts'
import Transcript from '../src/web/transcript.tsx'
import type { ChatMessage } from '../src/shared/types.ts'
import { setupRenderingDom } from './rendering/setup.ts'

const t = (zh: string) => zh

beforeEach(setupRenderingDom)
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

describe('assistant file references', () => {
  it.each([
    ['src/file.ts#L12-18', 'src/file.ts', 12],
    ['README.md:12:3', 'README.md', 12],
    ['Makefile:2', 'Makefile', 2],
    ['src/file.ts:12-18', 'src/file.ts', 12],
    ['/workspace/report%2520final.md:12', '/workspace/report%20final.md', 12],
    ['file:///workspace/交付%20计划.md#l12-L18', '/workspace/交付 计划.md', 12],
    ['file:///C:/work/report%20final.md:12:3', 'C:/work/report final.md', 12],
    [String.raw`C:\work\.config\a.ts:12:3`, String.raw`C:\work\.config\a.ts`, 12],
  ])('parses %s', (input, path, line) => {
    expect(parseAnswerFileLink(input)).toEqual({ path, line })
  })

  it.each([
    '#L12', '#说明', 'file://other-host/path/a.ts:3', 'src/x.ts#overview',
    'src/x.ts:0', 'src/x.ts:2:0', 'src/x.ts:3-2', 'src/x.ts#L3-2',
    'src/x.ts:9007199254740992', 'javascript:9', 'https://example.com/some.ts:90',
  ])('does not treat %s as a file reference', (input) => {
    expect(parseAnswerFileLink(input)).toBeUndefined()
  })

  it('passes the original target and first line from Markdown, code spans and prose', () => {
    const onOpenFile = vi.fn()
    const windows = String.raw`[Windows](C:\work\.config\a.ts:40:8)`
    const markdown = [
      '[README](README.md:9:2)',
      '[交付计划](<docs/交付 计划.md#L76>)',
      '[模型省略定界符](docs/目录/交付 计划.md:77)',
      '[绝对路径](file:///workspace/report%2520final.md#L4)',
      windows,
      '`src/routes/pricing.ts:184:33`',
      '`Makefile`:2',
      '检查 src/worker.ts:19-21，和 “docs/交付 计划.md:24”。',
    ].join('\n\n')
    render(<AnswerMarkdown t={t} text={markdown} onOpenFile={onOpenFile} />)
    const examples = [
      ['README', 'README.md', 9],
      ['交付计划', 'docs/交付 计划.md', 76],
      ['模型省略定界符', 'docs/目录/交付 计划.md', 77],
      ['绝对路径', '/workspace/report%20final.md', 4],
      ['Windows', String.raw`C:\work\.config\a.ts`, 40],
      ['src/routes/pricing.ts:184:33', 'src/routes/pricing.ts', 184],
      ['Makefile:2', 'Makefile', 2],
      ['src/worker.ts:19-21', 'src/worker.ts', 19],
      ['docs/交付 计划.md:24', 'docs/交付 计划.md', 24],
    ] as const
    for (const [label, path, line] of examples) {
      fireEvent.click(screen.getByRole('button', { name: label }))
      expect(onOpenFile).toHaveBeenLastCalledWith(path, line)
    }
    expect(screen.getByText('检查', { exact: false }).textContent).toBe('检查 src/worker.ts:19-21，和 “docs/交付 计划.md:24”。')
  })

  it('leaves external URLs, Markdown fragments, code symbols, ambiguous basenames and fenced paths alone', () => {
    const onOpenFile = vi.fn()
    const markdown = '# 标题\n\n[章节](#标题) [line-shaped fragment](#L3) [Web](https://example.com/s.ts:7)\n\n`React.useState` `same.ts`\n\n```txt\nsrc/fenced.ts:7\n```'
    render(<AnswerMarkdown t={t} text={markdown} onOpenFile={onOpenFile} filePaths={['one/same.ts', 'two/same.ts']} />)
    expect(screen.getByRole('link', { name: '章节' }).getAttribute('href')).toMatch(/^#/u)
    expect(screen.getByRole('link', { name: 'line-shaped fragment' }).getAttribute('href')).toBe('#L3')
    expect(screen.getByRole('link', { name: 'Web' }).getAttribute('href')).toBe('https://example.com/s.ts:7')
    expect(screen.getByText('React.useState').tagName).toBe('CODE')
    expect(screen.getByText('same.ts').tagName).toBe('CODE')
    expect(screen.queryByRole('button', { name: 'src/fenced.ts:7' })).toBeNull()
  })

  it('resolves a read artifact basename in the process and reply and opens the requested read offset', () => {
    const onOpenFile = vi.fn()
    const messages: ChatMessage[] = [
      { id: 'u', role: 'user', timestamp: 1, blocks: [{ type: 'text', text: 'Investigate' }] },
      { id: 'pre', role: 'assistant', timestamp: 2, blocks: [
        { type: 'text', text: 'Inspecting `price.ts:18`' },
        { type: 'toolCall', id: 'r', name: 'read', arguments: { path: 'src/routes/price.ts', offset: 17 } },
      ] },
      { id: 'read', role: 'tool', timestamp: 3, toolCallId: 'r', toolName: 'read',
        blocks: [{ type: 'text', text: 'file content' }], artifacts: [{ kind: 'read', path: 'src/routes/price.ts', lineStart: 18 }] },
      { id: 'post', role: 'assistant', timestamp: 4, blocks: [{ type: 'text', text: 'See price.ts and `price.ts:21`.' }] },
    ]
    const { container } = render(<Transcript messages={messages} onOpenFile={onOpenFile}
      policy={presentationPolicyFor('verbose')} />)
    fireEvent.click(screen.getByRole('button', { name: 'price.ts:18' }))
    expect(onOpenFile).toHaveBeenLastCalledWith('src/routes/price.ts', 18)
    fireEvent.click(screen.getByRole('button', { name: 'price.ts:21' }))
    expect(onOpenFile).toHaveBeenLastCalledWith('src/routes/price.ts', 21)
    fireEvent.click(within(container.querySelector('[data-message-id="post"]') as HTMLElement).getByRole('button', { name: 'price.ts' }))
    expect(onOpenFile).toHaveBeenLastCalledWith('src/routes/price.ts', undefined)
    fireEvent.click(within(container.querySelector('[data-tool-name="read"]') as HTMLElement).getByRole('button', { name: 'price.ts' }))
    expect(onOpenFile).toHaveBeenLastCalledWith('src/routes/price.ts', 17)
  })
})
