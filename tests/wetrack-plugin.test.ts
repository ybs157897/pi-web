import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const root = resolve('plugins/wetrack-defects')
let child: ChildProcessWithoutNullStreams | undefined

interface RpcResponse { jsonrpc: '2.0'; id: number; result?: unknown; error?: { message?: string } }

function start(): { request: (id: number, method: string, params?: unknown) => Promise<RpcResponse>; close: () => void } {
  const proc = spawn(process.execPath, ['server.mjs'], {
    cwd: root,
    env: { ...process.env, WETRACK_FIXTURE: resolve(root, 'fixtures/demo.json') },
  })
  child = proc
  let buffer = ''
  const waiters = new Map<number, (message: RpcResponse) => void>()
  proc.stdout.setEncoding('utf8')
  proc.stdout.on('data', (chunk: string) => {
    buffer += chunk
    let index = buffer.indexOf('\n')
    while (index >= 0) {
      const line = buffer.slice(0, index).trim()
      buffer = buffer.slice(index + 1)
      index = buffer.indexOf('\n')
      if (line === '') continue
      const message = JSON.parse(line) as RpcResponse
      waiters.get(message.id)?.(message)
      waiters.delete(message.id)
    }
  })
  const request = (id: number, method: string, params?: unknown): Promise<RpcResponse> => new Promise((resolveRequest, rejectRequest) => {
    const timer = setTimeout(() => { waiters.delete(id); rejectRequest(new Error(`timeout: ${method}`)) }, 5_000)
    waiters.set(id, message => { clearTimeout(timer); resolveRequest(message) })
    proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) }) + '\n')
  })
  return { request, close: () => { proc.kill() } }
}

afterEach(() => { child?.kill(); child = undefined })

describe('WeTrack plugin MCP server', () => {
  it('lists pending defects, reads a detail and renders a hierarchical report', async () => {
    const { request, close } = start()
    try {
      expect((await request(1, 'initialize')).result).toMatchObject({ serverInfo: { name: 'wetrack-defects' } })
      const tools = await request(2, 'tools/list') as { result: { tools: Array<{ name: string }> } }
      expect(tools.result.tools.map(tool => tool.name)).toEqual(expect.arrayContaining(['wetrack_pending', 'wetrack_detail', 'wetrack_report']))

      const pending = await request(3, 'tools/call', { name: 'wetrack_pending', arguments: {} }) as unknown as { result: { content: Array<{ text: string }>; structuredContent: { kind: string; count: number }; _meta: { ui: { resourceUri: string; preferredDisplayMode: string } } } }
      expect(pending.result.structuredContent).toMatchObject({ kind: 'pending', count: 2 })
      expect(pending.result._meta.ui).toMatchObject({ resourceUri: 'ui://wetrack/board', preferredDisplayMode: 'fullscreen' })
      expect(pending.result.content[0]?.text).toContain('DTS006749813')

      const detail = await request(4, 'tools/call', { name: 'wetrack_detail', arguments: { defectNumber: 'DTS006744740' } }) as unknown as { result: { content: Array<{ text: string }>; structuredContent: { defectNumber: string; moduleName: string } } }
      expect(detail.result.structuredContent).toMatchObject({ defectNumber: 'DTS006744740', moduleName: '安保服务' })
      // The model must receive the full description, not only the one-line summary.
      expect(detail.result.content[0]?.text).toContain('步骤')
      expect(detail.result.content[0]?.text).toContain('attachmentFiles')

      const report = await request(5, 'tools/call', { name: 'wetrack_report', arguments: {
        title: 'DTS006744740 根因分析',
        conclusion: '根因结论',
        sections: [{ title: '根因与证据', items: ['src/a.ts:42'], children: [{ title: '待确认', items: ['需要运行时确认'] }] }],
      } }) as unknown as { result: { structuredContent: { kind: string; sections: Array<{ children?: unknown[] }> } } }
      expect(report.result.structuredContent.kind).toBe('report')
      expect(report.result.structuredContent.sections[0]?.children).toHaveLength(1)

      const resource = await request(6, 'resources/read', { uri: 'ui://wetrack/board' }) as unknown as { result: { contents: Array<{ text: string }> } }
      expect(resource.result.contents[0]?.text).toContain('WeTrack 缺陷')
    } finally {
      close()
    }
  })
})
