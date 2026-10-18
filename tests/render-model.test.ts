import { describe, expect, it } from 'vitest'
import type { ChatMessage } from '../src/shared/types.ts'
import { buildRenderModel, reasoningDisplay } from '../src/web/render-model.ts'
import { buildToolRenderModel } from '../src/web/tool-render-model.ts'
import type { ToolItem } from '../src/web/render-model.ts'
import { safeWorkspaceAssetUrl, sandboxedHtml } from '../src/web/inspector-document.ts'

function user(id: string, requestId: string): ChatMessage {
  return { id, requestId, role: 'user', blocks: [{ type: 'text', text: `prompt ${id}` }], timestamp: 100 }
}

function assistant(id: string, blocks: ChatMessage['blocks'], overrides: Partial<ChatMessage> = {}): ChatMessage {
  return { id, role: 'assistant', blocks, timestamp: 200, ...overrides }
}

describe('transcript render model', () => {
  it('groups each user run and preserves reasoning, tool, and answer order', () => {
    const messages: ChatMessage[] = [
      user('user-1', 'request-1'),
      assistant('assistant-1', [
        { type: 'thinking', text: 'Need to inspect the file' },
        { type: 'toolCall', id: 'call-1', name: 'read', arguments: { path: 'hello.txt' } },
      ], { runId: 'run-1', status: 'completed' }),
      { id: 'tool-1', role: 'tool', blocks: [{ type: 'text', text: 'Hello' }], timestamp: 300,
        runId: 'run-1', toolCallId: 'call-1', toolName: 'read' },
      assistant('assistant-2', [{ type: 'text', text: 'The file says hello.' }], { runId: 'run-1', status: 'completed' }),
      user('user-2', 'request-2'),
      assistant('assistant-3', [{ type: 'text', text: 'Done.' }], { runId: 'run-2', status: 'completed' }),
    ]

    const result = buildRenderModel(messages)

    expect(result.runs).toHaveLength(2)
    expect(result.runs[0]).toMatchObject({ key: 'run:request-1', runId: 'run-1', status: 'completed' })
    expect(result.runs[0]?.process.map(part => part.kind)).toEqual(['reasoning', 'tool'])
    expect(result.runs[0]?.process[1]).toMatchObject({ kind: 'tool', item: { key: 'tool:call-1', result: { id: 'tool-1' } } })
    expect(result.runs[0]?.responses.map(response => response.key)).toEqual(['assistant-2:response'])
    expect(result.runs[1]?.users.map(message => message.id)).toEqual(['user-2'])
  })

  it('keeps the streaming process and settled answer on stable render keys without duplicating tool results', () => {
    const pending = user('user-live', 'request-live')
    const assistantLive = assistant('assistant-live', [
      { type: 'thinking', text: 'Checking' },
      { type: 'toolCall', id: 'call-live', name: 'bash', arguments: { command: 'pwd' } },
    ], { runId: 'run-live', streaming: true, status: 'running' })
    const live = buildRenderModel([pending, assistantLive]).runs[0]
    const settled = buildRenderModel([
      pending,
      assistant('assistant-live', [
        { type: 'thinking', text: 'Checking' },
        { type: 'toolCall', id: 'call-live', name: 'bash', arguments: { command: 'pwd' } },
      ], { runId: 'run-live', status: 'completed', durationMs: 1200 }),
      { id: 'tool-live', role: 'tool', blocks: [{ type: 'text', text: '/work' }], timestamp: 300,
        runId: 'run-live', toolCallId: 'call-live', toolName: 'bash' },
      assistant('assistant-final', [{ type: 'text', text: 'The workspace is /work.' }], { runId: 'run-live', status: 'completed' }),
    ]).runs[0]

    expect(settled?.key).toBe(live?.key)
    expect(settled?.process.map(part => part.key)).toEqual(live?.process.map(part => part.key))
    expect(settled?.process.filter(part => part.kind === 'tool')).toHaveLength(1)
    expect(settled?.responses.map(part => part.key)).toEqual(['assistant-final:response'])
    expect(settled?.durationMs).toBe(1200)
  })

  it('nests child tool calls under their recorded parent call', () => {
    const result = buildRenderModel([
      user('user-nested', 'request-nested'),
      assistant('assistant-parent', [{ type: 'toolCall', id: 'call-parent', name: 'agent', arguments: {} }], { runId: 'run-nested' }),
      assistant('assistant-child', [{ type: 'toolCall', id: 'call-child', name: 'read', arguments: { path: 'a.txt' } }],
        { runId: 'run-nested', parentToolCallId: 'call-parent' }),
      { id: 'tool-parent', role: 'tool', blocks: [{ type: 'text', text: 'child started' }], timestamp: 250,
        runId: 'run-nested', toolCallId: 'call-parent', toolName: 'agent' },
      { id: 'tool-child', role: 'tool', blocks: [{ type: 'text', text: 'contents' }], timestamp: 300,
        runId: 'run-nested', toolCallId: 'call-child', toolName: 'read', parentToolCallId: 'call-parent' },
      assistant('assistant-final-nested', [{ type: 'text', text: 'Finished.' }], { runId: 'run-nested', status: 'completed' }),
    ])
    const process = result.runs[0]?.process
    const parent = process?.find(part => part.kind === 'tool')
    expect(process?.filter(part => part.kind === 'tool')).toHaveLength(1)
    expect(parent?.kind === 'tool' ? parent.item.children.map(child => child.call?.id) : []).toEqual(['call-child'])
    expect(parent?.kind === 'tool' ? parent.item.children[0]?.result?.id : undefined).toBe('tool-child')
  })

  it('keeps a steering message in its recorded position within the active run', () => {
    const result = buildRenderModel([
      { ...user('user-first', 'request-first'), runId: 'run-steer' },
      assistant('assistant-before-steer', [{ type: 'thinking', text: 'Working' }], { runId: 'run-steer', status: 'running' }),
      { ...user('user-steer', 'request-steer'), runId: 'run-steer' },
      assistant('assistant-after-steer', [{ type: 'text', text: 'Updated answer.' }], { runId: 'run-steer', status: 'completed' }),
    ])
    const run = result.runs[0]
    expect(run?.users.map(message => message.id)).toEqual(['user-first', 'user-steer'])
    expect(run?.process.map(part => part.kind)).toEqual(['reasoning', 'user'])
    expect(run?.process[1]).toMatchObject({ kind: 'user', message: { id: 'user-steer' } })
    expect(run?.responses).toHaveLength(1)
  })

  it('keeps errors and cancellations distinct', () => {
    const error = buildRenderModel([user('user-error', 'request-error'), assistant('assistant-error', [], { status: 'error' })]).runs[0]
    const cancelled = buildRenderModel([user('user-stop', 'request-stop'), assistant('assistant-stop', [], { status: 'cancelled' })]).runs[0]
    const recoveredToolError = buildRenderModel([
      user('user-recovered', 'request-recovered'),
      assistant('assistant-call', [{ type: 'toolCall', id: 'call-error', name: 'read', arguments: { path: 'missing.txt' } }]),
      { id: 'tool-error', role: 'tool', blocks: [{ type: 'text', text: 'File not found' }], timestamp: 250,
        toolCallId: 'call-error', toolName: 'read', isError: true },
      assistant('assistant-recovered', [{ type: 'text', text: 'The file does not exist.' }]),
    ]).runs[0]
    expect(error?.status).toBe('error')
    expect(cancelled?.status).toBe('cancelled')
    expect(recoveredToolError?.status).toBe('completed')
  })

  it('does not expose redacted thinking text to the transcript renderer', () => {
    const model = buildRenderModel([assistant('assistant-redacted', [
      { type: 'thinking', text: 'private reasoning must stay hidden', redacted: true },
      { type: 'text', text: 'Public answer.' },
    ], { status: 'completed' })])
    const part = model.runs[0]?.process.find(item => item.kind === 'reasoning')
    expect(part?.kind).toBe('reasoning')
    if (part?.kind !== 'reasoning') throw new Error('Expected a reasoning process item')
    const display = reasoningDisplay(part.text, part.redacted, 'Reasoning is hidden')
    expect(display).toEqual({ summary: 'Reasoning is hidden', text: '' })
    expect(JSON.stringify(display)).not.toContain('private reasoning must stay hidden')
    expect(model.runs[0]?.responses[0]?.blocks).toEqual([{ type: 'text', text: 'Public answer.' }])
  })

  it('tolerates unknown tool details without changing the normal text result', () => {
    const call = { type: 'toolCall' as const, id: 'custom-1', name: 'custom_tool', arguments: { input: 'value' } }
    const message = assistant('assistant-tool', [call], { status: 'completed' })
    const item = {
      key: 'tool:custom-1', message, call, children: [], order: 0,
      result: { id: 'tool-result', role: 'tool', blocks: [{ type: 'text', text: 'custom result' }], timestamp: 300,
        toolCallId: 'custom-1', toolName: 'custom_tool', details: ['unknown', { value: 1 }] } satisfies ChatMessage,
    }

    expect(() => buildToolRenderModel(item, (chinese) => chinese, false)).not.toThrow()
    expect(buildToolRenderModel(item, chinese => chinese, false)).toMatchObject({ output: 'custom result', knownPresentation: false })
  })

  it('selects DSH command, read, diff, search, and web cards from recorded fields', () => {
    const build = (name: string, args: Record<string, unknown>, result: Partial<ChatMessage>): ReturnType<typeof buildToolRenderModel> => {
      const message = assistant(`call-message:${name}`, [{ type: 'toolCall', id: `call:${name}`, name, arguments: args }])
      const item: ToolItem = {
        key: `tool:call:${name}`,
        message,
        call: { type: 'toolCall', id: `call:${name}`, name, arguments: args },
        result: { id: `result:${name}`, role: 'tool', blocks: [], timestamp: 300, toolCallId: `call:${name}`, toolName: name, ...result },
        children: [],
        order: 0,
      }
      return buildToolRenderModel(item, chinese => chinese, false)
    }

    expect(build('bash', { command: 'pwd' }, { blocks: [{ type: 'text', text: '/workspace' }], details: { exitCode: 0 } }))
      .toMatchObject({ title: '执行了命令', command: 'pwd', output: '/workspace', exitCode: 0 })
    expect(build('read', { path: 'a.ts' }, { blocks: [{ type: 'text', text: 'const a = 1' }], details: { lines: [{ number: 4, text: 'const a = 1' }], totalLines: 8 } }))
      .toMatchObject({ title: '读取了文件', read: { lines: [{ number: 4, text: 'const a = 1' }], totalLines: 8 } })
    expect(build('edit', { path: 'a.ts' }, { artifacts: [{ kind: 'edit', path: 'a.ts', before: 'old', after: 'new' }] }))
      .toMatchObject({ title: '编辑了文件', diffs: [{ path: 'a.ts', oldText: 'old', newText: 'new' }] })
    expect(build('grep', { pattern: 'hello' }, { blocks: [{ type: 'text', text: 'a.ts:3:hello world' }] }))
      .toMatchObject({ search: { kind: 'matches', files: [{ path: 'a.ts', matches: [{ lineNumber: 3, line: 'hello world' }] }] } })
    expect(build('web_search', { query: 'pi durable' }, { details: { sources: [{ url: 'https://example.com', title: 'Example' }], answer: 'Found one result.' } }))
      .toMatchObject({ web: { kind: 'search', answer: 'Found one result.', sources: [{ url: 'https://example.com' }] } })
  })

  it('restricts HTML previews and file asset links to the isolated workspace renderer', () => {
    const preview = sandboxedHtml('<h1>preview</h1><script>window.parent.secret = true</script>')
    expect(preview).toContain("default-src 'none'")
    expect(preview).toContain("connect-src 'none'")
    expect(preview).toContain("form-action 'none'")
    expect(preview).toContain("navigate-to 'none'")
    expect(preview).toContain("script-src 'unsafe-inline'")
    expect(preview).not.toContain('allow-same-origin')
    expect(safeWorkspaceAssetUrl('/api/workspaces/w-1/asset?path=a.pdf', 'http://127.0.0.1:4317/'))
      .toBe('http://127.0.0.1:4317/api/workspaces/w-1/asset?path=a.pdf')
    expect(safeWorkspaceAssetUrl('https://example.com/a.png', 'http://127.0.0.1:4317/')).toBeUndefined()
    expect(safeWorkspaceAssetUrl('/api/settings', 'http://127.0.0.1:4317/')).toBeUndefined()
  })
})
