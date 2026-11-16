// @vitest-environment jsdom
/**
 * 会话过程行的分组（process grouping）测试，参照 ZCode 的折叠交互。
 *
 * 关键契约：
 * - 连续只读工具（read/grep/list_files 等）折叠为一个"查阅"组；连续可执行命令折叠为"终端"组；
 *   单行不折叠；写入类命令（重定向、git commit、npm test）是组边界，打断只读连续段；
 * - 只读 shell 分类覆盖包装器（/bin/zsh -lc）、管道、复合脚本、find -exec、cd&&ls；
 * - 组头显示类型计数（"1 搜索, 1 列表, 1 文件"、"2 个命令"），展开后显示子行；
 * - 失败行保留状态徽标；list_files 行可展开披露结果，但不重复"调用参数"区块。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, within } from '@testing-library/react'
import type { ChatMessage } from '../src/shared/types.ts'
import { buildRenderModel } from '../src/web/render-model.ts'
import { exploreBucket, groupProcessParts, shellCommands, toolGroupKind } from '../src/web/process-grouping.ts'
import Transcript from '../src/web/transcript.tsx'
import { setupRenderingDom } from './rendering/setup.ts'

/** 文案函数直通：zh 文本原样返回。 */
const t = (zh: string) => zh
/** 每个用例前补齐 jsdom 缺失 API；结束后卸载组件。 */
beforeEach(setupRenderingDom)
afterEach(() => { cleanup() })

/**
 * 构造一个 toolCall 内容块。
 * @param id 调用 id
 * @param name 工具名
 * @param args 工具参数
 * @returns ContentBlock
 */
function call(id: string, name: string, args: Record<string, unknown>): ChatMessage['blocks'][number] {
  return { type: 'toolCall', id, name, arguments: args }
}

/**
 * 构造一段完整会话消息：用户提问 → assistant 带工具调用 → 可选工具结果 → assistant 结论。
 * @param calls assistant 消息中的工具调用块
 * @param results 附在调用之后的工具结果消息
 * @param suffix id/runId 后缀，避免多个 fixture 串台
 * @returns ChatMessage 数组
 */
function messages(calls: ChatMessage['blocks'], results: readonly ChatMessage[] = [], suffix = 'group'): ChatMessage[] {
  return [
    { id: `user-${suffix}`, role: 'user', requestId: `req-${suffix}`, timestamp: 1000, blocks: [{ type: 'text', text: '查看文件并运行命令。' }] },
    { id: `assistant-${suffix}`, role: 'assistant', runId: `run-${suffix}`, timestamp: 1100, status: 'completed', blocks: calls },
    ...results,
    { id: `answer-${suffix}`, role: 'assistant', runId: `run-${suffix}`, timestamp: 1900, status: 'completed', blocks: [{ type: 'text', text: '完成。' }] },
  ]
}

/**
 * 构造一条工具结果消息。
 * @param id 消息 id
 * @param toolCallId 对应的调用 id
 * @param name 工具名
 * @param text 结果文本
 * @param extra 额外字段覆盖（isError/details/status 等）
 * @param runId 所属 run
 * @returns ChatMessage（role=tool）
 */
function result(id: string, toolCallId: string, name: string, text = 'ok', extra: Partial<ChatMessage> = {}, runId = 'run-group'): ChatMessage {
  return { id, role: 'tool', runId, toolCallId, toolName: name, timestamp: 1500, status: 'completed',
    blocks: [{ type: 'text', text }], ...extra }
}

/** 过程行分组与折叠渲染测试。 */
describe('ZCode process grouping', () => {
  // 验证只读折叠：连续 read/grep/list_files 归入一个 explore 组（子项按原顺序）；
  // 单个只读工具保持独立 tool 行不折叠。
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

  // 验证终端折叠与写边界：连续 bash 命令归入 execute 组；
  // read + 写命令（rm）+ read 的混合序列不被折叠（写入打断只读连续段，三行各自独立）。
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

  // 验证 shell 命令分类（对齐 ZCode）：包装器/管道/复合脚本/find -exec/cd&&ls 均为 explore；
  // 输出重定向、git commit、npm test、printf 输出为 execute。
  it('classifies read-only shell, wrappers and redirects like ZCode', () => {
    const explore = (command: string) => {
      const item = buildRenderModel(messages([call('bash-x', 'bash', { command })])).runs[0]?.process[0]
      return item?.kind === 'tool' ? toolGroupKind(item.item) : undefined
    }
    expect(explore('ls -la')).toBe('explore')
    expect(explore('/bin/zsh -lc "cat README.md"')).toBe('explore')
    expect(explore('ls -la docs | head -40')).toBe('explore')
    expect(explore('find docs -maxdepth 1 -name "*.md" | sort')).toBe('explore')
    // ZCode 将所有只读 shell 归为 explore，包括复合脚本与 find 操作。
    expect(explore('for f in *.md; do cat "$f"; done')).toBe('explore')
    expect(explore('find docs -type f -exec stat -f "%z" {} + | sort')).toBe('explore')
    expect(explore('cd docs && ls')).toBe('explore')
    expect(explore('printf "x" > out.txt')).toBe('execute')
    expect(explore('git commit -m "x"')).toBe('execute')
    expect(explore('npm test')).toBe('execute')
    expect(explore('printf one')).toBe('execute')
  })

  // 验证 explore 子桶与命令提取：组内子项按工具类型分桶（file/search/list/fetch）；
  // bash 参数为数组形式（/bin/bash -lc 'cat a.md'）时 shellCommands 提取命令字符串并归为 explore。
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

  // 验证组头渲染与展开：查阅组显示"查阅"+ 分类计数（"1 搜索, 1 列表, 1 文件"），
  // 终端组显示"终端"+ 命令计数；展开查阅组后出现子行（读取/搜索/搜索列表），
  // list_files 子行带工具名与参数 JSON。
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

  // 验证失败行与结果披露：失败 bash 行保留"执行失败"徽标（title 属性带错误文本）；
  // 单独 list_files 行显示"搜索列表"与参数，展开后可见结果 docs/，且行上已含调用参数
  // 时正文不再重复"调用参数"区块。
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
    // 调用原文已在行上，正文不得再以"调用参数"重复。
    expect(within(listRow).queryByText('调用参数')).toBeNull()
  })
})
