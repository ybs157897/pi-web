import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { existsSync } from 'node:fs'
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const root = resolve('plugins/wetrack-defects')
const PROBE_SAMPLES = resolve('artifacts/wetrack-probe/samples')
const FIXTURE_ENV: NodeJS.ProcessEnv = { ...process.env, WETRACK_FIXTURE: resolve(root, 'fixtures/demo.json') }
let child: ChildProcessWithoutNullStreams | undefined

/**
 * WeTrack 插件 MCP server 的进程级测试：spawn plugins/wetrack-defects/server.mjs，
 * 走真实 stdio JSON-RPC。验证工具清单、fixture/CLI 数据源、信封解包、
 * 分层报告渲染与 UI 资源。
 */
interface RpcResponse { jsonrpc: '2.0'; id: number; result?: unknown; error?: { message?: string } }

/**
 * 构造以「node -e 脚本」为 CLI 后端的环境变量。
 * @param script CLI 被调用时执行的 Node 脚本（通常输出固定 JSON）
 * @returns 清空 fixture/script/CLI 配置、只留 WETRACK_CLI_JSON 的环境
 */
function cliEnv(script: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    WETRACK_FIXTURE: '',
    WETRACK_SCRIPT: '',
    WETRACK_CLI: '',
    WETRACK_CLI_JSON: JSON.stringify([process.execPath, '-e', script]),
  }
}

/**
 * 启动插件 MCP server 子进程并建立行分帧的 JSON-RPC 客户端。
 * @param env 传给子进程的环境变量，默认指向内置 demo fixture
 * @returns request 按 id 发送请求并在 5 秒内等待对应响应（超时抛错）；close 杀掉子进程
 */
function start(env: NodeJS.ProcessEnv = FIXTURE_ENV): { request: (id: number, method: string, params?: unknown) => Promise<RpcResponse>; close: () => void } {
  const proc = spawn(process.execPath, ['server.mjs'], {
    cwd: root,
    env,
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

/** 兜底回收子进程，防止用例失败时留下孤儿 node 进程。 */
afterEach(() => { child?.kill(); child = undefined })

describe('WeTrack plugin MCP server', () => {
  // 基础链路：initialize 握手 → tools/list → wetrack_pending（fixture 两条 +
  // fullscreen UI 资源元数据）→ wetrack_detail（模型要拿到完整描述而非单行摘要）→
  // wetrack_report 分层结构 → ui://wetrack/board 资源可读。
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

  // rd-cli 信封契约：success:true 解包 data；success:false（含非零退出码）转为
  // isError 工具错误，错误文案保留「code：message」原文。
  it('unwraps the rd-cli envelope and reports business failures as tool errors', async () => {
    const ok = start(cliEnv('process.stdout.write(JSON.stringify({success:true,data:{items:[{defectNumber:"DTS000000666"}]}}))'))
    try {
      const pending = await ok.request(1, 'tools/call', { name: 'wetrack_pending', arguments: {} }) as { result: { structuredContent: { count: number; items: Array<{ defectNumber: string }> } } }
      expect(pending.result.structuredContent).toMatchObject({ count: 1 })
      expect(pending.result.structuredContent.items[0]?.defectNumber).toBe('DTS000000666')
    } finally {
      ok.close()
    }

    const failed = start(cliEnv('process.stdout.write(JSON.stringify({success:false,error:{code:"API_KEY_INVALID",message:"API Key 无效或已吊销",stage:"auth"}}));process.exitCode=3'))
    try {
      const reply = await failed.request(1, 'tools/call', { name: 'wetrack_pending', arguments: {} }) as { result: { isError?: boolean; content: Array<{ text: string }> } }
      expect(reply.result.isError).toBe(true)
      expect(reply.result.content[0]?.text).toContain('API_KEY_INVALID：API Key 无效或已吊销')
    } finally {
      failed.close()
    }
  })

  // 真实 CLI 子进程（shell 脚本）路径：过滤参数映射为 advanced-query 旗标、
  // detail 正确解包；advanced-query 需要至少一个项目/产品线/缺陷/需求过滤条件，
  // 缺失时应引导补参而不是放行到 BIZ_400。
  it.skipIf(process.platform === 'win32')('maps filters to advanced-query flags, unwraps detail and guards filter-only queries', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pi web wetrack-'))
    try {
      const cli = join(dir, 'rd-cli')
      await writeFile(cli, [
        '#!/usr/bin/env node',
        'const argv = process.argv.slice(2)',
        'const payload = argv.includes("detail")',
        '  ? { success: true, data: { defectNumber: "DTS006744740", moduleName: "安保服务", simpleDesc: "x" } }',
        '  : { success: true, data: { items: [{ defectNumber: "DTS1", argv: argv.join(" ") }] } }',
        'process.stdout.write(JSON.stringify(payload))',
      ].join('\n'), 'utf8')
      await chmod(cli, 0o755)
      const env = { ...process.env, WETRACK_FIXTURE: '', WETRACK_SCRIPT: '', WETRACK_CLI_JSON: '', WETRACK_CLI: cli }
      const tool = start(env)
      try {
        const query = await tool.request(1, 'tools/call', {
          name: 'wetrack_pending',
          arguments: { project: 'DH3.RDA000902', owner: '340188', status: '205' },
        }) as { result: { structuredContent: { items: Array<{ argv: string }> } } }
        expect(query.result.structuredContent.items[0]?.argv).toBe('wetrack advanced-query --project-num DH3.RDA000902 --cur-user-name 340188 --defect-status 205 --json')

        const detail = await tool.request(2, 'tools/call', { name: 'wetrack_detail', arguments: { defectNumber: 'DTS006744740' } }) as { result: { structuredContent: { defectNumber: string; moduleName: string } } }
        expect(detail.result.structuredContent).toMatchObject({ defectNumber: 'DTS006744740', moduleName: '安保服务' })

        // advanced-query 至少需要项目/产品线/缺陷/需求之一，缺参应主动引导而不是以 BIZ_400 失败。
        const guarded = await tool.request(3, 'tools/call', { name: 'wetrack_pending', arguments: { owner: '340188' } }) as { result: { isError?: boolean; content: Array<{ text: string }> } }
        expect(guarded.result.isError).toBe(true)
        expect(guarded.result.content[0]?.text).toContain('项目编号')
      } finally {
        tool.close()
      }
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  // 探针回放：用抓包的真实 detail 响应原样回放（需本地存在 artifacts 样本），
  // 验证解析器对真实数据形状（含 processHistories）的兼容。
  it.skipIf(!existsSync(PROBE_SAMPLES))('replays the captured detail response', async () => {
    const text = await readFile(join(PROBE_SAMPLES, 'detail.json'), 'utf8')
    const tool = start(cliEnv(`process.stdout.write(${JSON.stringify(text)})`))
    try {
      const reply = await tool.request(1, 'tools/call', { name: 'wetrack_detail', arguments: { defectNumber: 'DTS006744740' } }) as { result: { structuredContent: { defectNumber: string; processHistories: unknown[] } } }
      expect(reply.result.structuredContent.defectNumber).toBe('DTS006744740')
      expect(Array.isArray(reply.result.structuredContent.processHistories)).toBe(true)
    } finally {
      tool.close()
    }
  })
})
