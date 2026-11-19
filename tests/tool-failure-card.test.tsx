// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import type { ToolItem } from '../src/web/render-model.ts'
import ToolCard from '../src/web/ToolCard.tsx'

const zh = (chinese: string) => chinese

afterEach(cleanup)

function failureItem(name: string, args: Record<string, unknown>, output: string): ToolItem {
  const call = { id: 'failure-call', type: 'toolCall', name, arguments: args } as const
  return {
    key: 'tool:failure-call',
    call,
    message: { id: 'assistant-call', role: 'assistant', blocks: [call], timestamp: 10 },
    result: {
      id: 'result-error', role: 'tool', toolName: name, toolCallId: call.id, status: 'error', timestamp: 20,
      blocks: [{ type: 'text', text: output }],
    },
    children: [],
    order: 0,
  }
}

describe('tool failure card', () => {
  it('explains a missing file in the accessible row and discloses the diagnostic on demand', () => {
    const output = "<harness>\n[error] ENOENT: no such file or directory, open '/local/workspace/sample.txt'\n</harness>"
    render(<ToolCard item={failureItem('read', { path: 'sample.txt' }, output)} runRunning={false} t={zh}/>)

    const row = screen.getByRole('button', { name: /读取文件失败.*sample\.txt.*找不到文件/u })
    expect(row.getAttribute('aria-expanded')).toBe('false')
    expect(screen.queryByText(/<harness>|ENOENT/u)).toBeNull()

    fireEvent.click(row)
    expect(row.getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByText(/ENOENT: no such file or directory/u)).toBeTruthy()
    expect(screen.queryByText(/<harness>|\[error\]/u)).toBeNull()
  })

  it('does not guess at an unknown failure or put JavaScript in the collapsed script row', () => {
    const output = 'Script failed\nWall time 0.2 seconds\nOutput:\nScript error:\nError: Operation not accepted'
    render(<ToolCard item={failureItem('codemode', { code: 'const ws = "/local/workspace"' }, output)} runRunning={false} t={zh}/>)
    const row = screen.getByRole('button', { name: /脚本执行失败.*原因见工具详情/u })
    expect(row.getAttribute('aria-expanded')).toBe('false')
    expect(screen.queryByText(/const ws|Operation not accepted/u)).toBeNull()
  })
})
