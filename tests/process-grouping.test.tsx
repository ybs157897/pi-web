// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, within } from '@testing-library/react'
import type { ChatMessage } from '../src/shared/types.ts'
import { buildRenderModel } from '../src/web/render-model.ts'
import { exploreBucket, groupProcessParts, shellCommands, toolGroupKind } from '../src/web/process-grouping.ts'
import Transcript from '../src/web/transcript.tsx'
import { setupRenderingDom } from './rendering/setup.ts'

const t = (zh: string) => zh
beforeEach(setupRenderingDom)
afterEach(() => { cleanup() })

function call(id: string, name: string, args: Record<string, unknown>): ChatMessage['blocks'][number] {
  return { type: 'toolCall', id, name, arguments: args }
}

function messages(calls: ChatMessage['blocks'], results: readonly ChatMessage[] = [], suffix = 'group'): ChatMessage[] {
  return [
    { id: `user-${suffix}`, role: 'user', requestId: `req-${suffix}`, timestamp: 1000, blocks: [{ type: 'text', text: '查看文件并运行命令。' }] },
    { id: `assistant-${suffix}`, role: 'assistant', runId: `run-${suffix}`, timestamp: 1100, status: 'completed', blocks: calls },
    ...results,
    { id: `answer-${suffix}`, role: 'assistant', runId: `run-${suffix}`, timestamp: 1900, status: 'completed', blocks: [{ type: 'text', text: '完成。' }] },
  ]
}

function result(id: string, toolCallId: string, name: string, text = 'ok', extra: Partial<ChatMessage> = {}, runId = 'run-group'): ChatMessage {
  return { id, role: 'tool', runId, toolCallId, toolName: name, timestamp: 1500, status: 'completed',
    blocks: [{ type: 'text', text }], ...extra }
}

describe('ZCode process grouping', () => {
  it('folds consecutive read-only rows into 查阅 and keeps a single row flat', () => {
    const grouped = buildRenderModel(messages([
      call('read-1', 'read', { path: 'README.md' }),
      call('grep-1', 'grep', { pattern: 'title', path: '.' }),
      call('list-1', 'list_files', { path: 'docs' }),
    ])).runs[0]?.process
    expect(grouped).toHaveLength(1)
    expect(grouped?.[0]).toMatchObject({ kind: 'toolGroup', group: 'explore' })
    expect(grouped?.[0]?.kind === 'toolGroup' ? grouped[0].items.map(item => item.call?.id) : []).toEqual(['read-1', 'grep-1', 'list-1'])

    const single = buildRenderModel(messages([call('read-2', 'read', { path: 'README.md' })])).runs[0]?.process
    expect(single).toHaveLength(1)
    expect(single?.[0]?.kind).toBe('tool')
  })

  it('folds consecutive executable commands into 终端 and leaves writes as their own boundary', () => {
    const execute = buildRenderModel(messages([
      call('bash-1', 'bash', { command: 'printf one' }),
      call('bash-2', 'bash', { command: 'node build.mjs' }),
    ])).runs[0]?.process
    expect(execute?.[0]).toMatchObject({ kind: 'toolGroup', group: 'execute' })

    const mixed = buildRenderModel(messages([
      call('read-3', 'read', { path: 'a.ts' }),
      call('bash-rm', 'bash', { command: 'rm a.ts' }),
      call('read-4', 'read', { path: 'b.ts' }),
    ])).runs[0]?.process
    expect(mixed?.map(part => part.kind)).toEqual(['tool', 'tool', 'tool'])
  })

  it('classifies read-only shell, wrappers and redirects like ZCode', () => {
    const explore = (command: string) => {
      const item = buildRenderModel(messages([call('bash-x', 'bash', { command })])).runs[0]?.process[0]
      return item?.kind === 'tool' ? toolGroupKind(item.item) : undefined
    }
    expect(explore('ls -la')).toBe('explore')
    expect(explore('/bin/zsh -lc "cat README.md"')).toBe('explore')
    expect(explore('ls -la docs | head -40')).toBe('explore')
    expect(explore('find docs -maxdepth 1 -name "*.md" | sort')).toBe('explore')
    // ZCode includes any read-only shell, including compound scripts and find actions.
    expect(explore('for f in *.md; do cat "$f"; done')).toBe('explore')
    expect(explore('find docs -type f -exec stat -f "%z" {} + | sort')).toBe('explore')
    expect(explore('cd docs && ls')).toBe('explore')
    expect(explore('printf "x" > out.txt')).toBe('execute')
    expect(explore('git commit -m "x"')).toBe('execute')
    expect(explore('npm test')).toBe('execute')
    expect(explore('printf one')).toBe('execute')
  })

  it('classifies explore buckets and extracts commands from wrapped arrays', () => {
    const model = buildRenderModel(messages([
      call('read-5', 'read', { path: 'README.md' }),
      call('grep-5', 'grep', { pattern: 'x' }),
      call('list-5', 'list_files', { path: '.' }),
      call('fetch-5', 'web_fetch', { url: 'https://example.com' }),
    ]))
    const group = model.runs[0]?.process[0]
    expect(group?.kind).toBe('toolGroup')
    if (group?.kind !== 'toolGroup') throw new Error('Expected a tool group')
    expect(group.items.map(exploreBucket)).toEqual(['file', 'search', 'list', 'fetch'])

    const shell = buildRenderModel(messages([call('bash-array', 'bash', { command: ['/bin/bash', '-lc', 'cat a.md'] })])).runs[0]?.process[0]
    expect(shell?.kind).toBe('tool')
    if (shell?.kind !== 'tool') throw new Error('Expected a tool row')
    expect(shellCommands(shell.item)).toEqual(['cat a.md'])
    expect(toolGroupKind(shell.item)).toBe('explore')
  })

  it('renders 查阅 and 终端 parents with counts and nested child rows', () => {
    const explore = messages([
      call('read-a', 'read', { path: 'README.md' }),
      call('grep-a', 'grep', { pattern: 'title' }),
      call('list-a', 'list_files', { path: 'docs' }),
    ], [
      result('read-a-result', 'read-a', 'read', 'ok', {}, 'run-explore'),
      result('grep-a-result', 'grep-a', 'grep', 'README.md:1:title', {}, 'run-explore'),
      result('list-a-result', 'list-a', 'list_files', 'docs/', {}, 'run-explore'),
    ], 'explore')
    const execute = messages([
      call('bash-a', 'bash', { command: 'printf one' }),
      call('bash-b', 'bash', { command: 'printf two' }),
    ], [
      result('bash-a-result', 'bash-a', 'bash', 'one', { details: { command: 'printf one', exitCode: 0 } }, 'run-execute'),
      result('bash-b-result', 'bash-b', 'bash', 'two', { details: { command: 'printf two', exitCode: 0 } }, 'run-execute'),
    ], 'execute')
    render(<Transcript messages={[...explore, ...execute]} />)
    const parents = [...document.querySelectorAll('[data-tool-group]')]
    expect(parents.map(parent => parent.getAttribute('data-tool-group'))).toEqual(['explore', 'execute'])
    expect(parents[0]?.textContent).toContain('查阅')
    expect(parents[0]?.textContent).toContain('1 搜索, 1 列表, 1 文件')
    expect(parents[1]?.textContent).toContain('终端')
    expect(parents[1]?.textContent).toContain('2 个命令')

    const exploreParent = parents[0] as HTMLElement
    const toggle = exploreParent.querySelector('button[aria-label="展开工具详情"]')
    expect(toggle).not.toBeNull()
    fireEvent.click(toggle as HTMLElement)
    expect(within(exploreParent).getByText('读取')).toBeTruthy()
    expect(within(exploreParent).getByText('搜索')).toBeTruthy()
    expect(within(exploreParent).getByText('搜索列表')).toBeTruthy()
    const listRow = exploreParent.querySelector('[data-tool-name="list_files"]') as HTMLElement
    expect(listRow.textContent).toContain('"name": "list_files"')
    expect(listRow.textContent).toContain('"path": "docs"')
  })

  it('keeps a failed row status at the end and lets a listing disclose its result', () => {
    const failed = messages([
      call('bash-fail', 'bash', { command: 'exit 1' }),
    ], [
      result('bash-fail-result', 'bash-fail', 'bash', 'boom', { isError: true, status: 'error', details: { command: 'exit 1', exitCode: 1 } }, 'run-fail'),
    ], 'fail')
    render(<Transcript messages={failed} />)
    const failedRow = document.querySelector('[data-tool-name="bash"]') as HTMLElement
    expect(within(failedRow).getByText('执行失败')).toBeTruthy()
    expect(failedRow.querySelector('[title="boom"]')).not.toBeNull()

    cleanup()
    const listing = messages([
      call('list-single', 'list_files', { path: 'docs' }),
    ], [
      result('list-single-result', 'list-single', 'list_files', 'docs/', {}, 'run-list'),
    ], 'list')
    render(<Transcript messages={listing} />)
    const listRow = document.querySelector('[data-tool-name="list_files"]') as HTMLElement
    expect(listRow.textContent).toContain('搜索列表')
    expect(listRow.textContent).toContain('"path": "docs"')
    const toggle = listRow.querySelector('button[aria-label="展开工具详情"]')
    expect(toggle).not.toBeNull()
    fireEvent.click(toggle as HTMLElement)
    expect(within(listRow).getByText('docs/')).toBeTruthy()
    // The raw call is already on the row, so the body must not repeat it as "调用参数".
    expect(within(listRow).queryByText('调用参数')).toBeNull()
  })
})
