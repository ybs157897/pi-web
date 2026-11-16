/**
 * 插件 UI 服务端链路测试：描述符投影、surface 列表、页面 HTML 与运行时宿主策略。
 *
 * 关键契约：
 * - pluginUiDescriptorFromMeta 只保留文档化的 `_meta.ui` 字段（多余键如 secret 丢弃）、
 *   heightHint 取整、可选字段类型非法时丢弃该字段；必填缺失（身份/空 resourceUri）整体拒绝；
 *   扁平的 `ui/resourceUri` 拼写也被接受；真实 MCP tools/call 结果被投影成 details.ui 且不泄露 _meta 其他键；
 * - 商店层面：uiSurfaces 只列已启用插件，pluginServer 按 serverName 解析归属；
 * - 页面 HTML 注入沙箱 CSP（幂等，不重复注入）；资源文本取第一个 text 内容；
 * - 运行时宿主：页面/资源/调用三类入口可用；跨插件借服务器、readOnly 会话（ACCESS_DENIED）、
 *   计划模式（PLAN_BLOCKED）、hidden exposure 服务器一律拒绝；禁用插件后 surface 与页面全部不可用。
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { afterEach, describe, expect, it } from 'vitest'
import type { Context } from '@earendil-works/chord/context'
import { NOOP_TELEMETRY_CONTEXT } from '@earendil-works/pi-telemetry'
import type { JsonValue } from '@earendil-works/chord'
import type { ToolExecutionApi, ToolExecutionResult } from '@earendil-works/pi-durable'
import { createRuntime } from '../src/server/runtime/index.ts'
import type { Runtime } from '../src/server/contracts.ts'
import { McpRegistry } from '../src/server/mcp/registry.ts'
import { PluginStore } from '../src/server/plugins/store.ts'
import { buildPluginUiPageHtml, pluginUiResourceText } from '../src/server/plugins/ui.ts'
import type { PluginMcpServerConfig } from '../src/server/plugins/types.ts'
import { pluginUiDescriptorFromMeta } from '../src/shared/plugin-ui.ts'
import { writeMarketplace, writePlugin } from './plugin-fixtures.ts'

/** 页面 HTML 必须携带的沙箱 CSP（无 connect-src、无表单、无 base 注入）。 */
const EXPECTED_CSP = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: https:; connect-src 'none'; form-action 'none'; base-uri 'none'"
/** fixture 页面的资源 URI。 */
const PAGE_URI = 'ui://ui-plugin/canvas'
/** fixture 页面的完整 HTML。 */
const PAGE_HTML = '<!doctype html><html><head><title>Canvas</title></head><body><div id="app">canvas</div></body></html>'

/** 真实 stdio MCP 服务器 fixture：一个插件服务器同时应答工具调用与页面资源；
 *  各工具返回不同形态的 _meta（嵌套 ui 对象 / 扁平 ui/resourceUri / 无 resourceUri）并附带 secret 泄露探测键。 */
const MCP_UI_FIXTURE = `
import { createInterface } from 'node:readline'

const send = message => process.stdout.write(JSON.stringify(message) + '\\n')
const tools = [
  { name: 'echo', description: 'Echo back', inputSchema: { type: 'object', properties: { text: { type: 'string' } } } },
  { name: 'flat', description: 'Flat meta', inputSchema: { type: 'object', properties: {} } },
  { name: 'no_uri', description: 'No resource uri', inputSchema: { type: 'object', properties: {} } },
]
const page = ${JSON.stringify(PAGE_HTML)}

createInterface({ input: process.stdin }).on('line', line => {
  if (line.trim() === '') return
  const message = JSON.parse(line)
  if (message.id === undefined) return
  if (message.method === 'initialize') {
    send({ jsonrpc: '2.0', id: message.id, result: {
      protocolVersion: '2025-11-25',
      capabilities: { tools: {}, resources: {} },
      serverInfo: { name: 'ui-fixture', version: '1.0.0' },
    } })
    return
  }
  if (message.method === 'tools/list') {
    send({ jsonrpc: '2.0', id: message.id, result: { tools } })
    return
  }
  if (message.method === 'tools/call') {
    const name = message.params?.name
    const text = message.params?.arguments?.text ?? ''
    if (name === 'flat') {
      send({ jsonrpc: '2.0', id: message.id, result: {
        content: [{ type: 'text', text: 'flat' }],
        _meta: { 'ui/resourceUri': 'ui://ui-plugin/flat', secret: 'leak' },
      } })
      return
    }
    if (name === 'no_uri') {
      send({ jsonrpc: '2.0', id: message.id, result: {
        content: [{ type: 'text', text: 'no-uri' }],
        _meta: { ui: { title: 'No uri', secret: 'leak' } },
      } })
      return
    }
    send({ jsonrpc: '2.0', id: message.id, result: {
      content: [{ type: 'text', text: 'plugin:' + text }],
      _meta: { ui: {
        resourceUri: 'ui://ui-plugin/canvas',
        title: 'Canvas',
        heightHint: 320,
        preferredDisplayMode: 'inline',
        showInline: true,
        toolCallId: 'call-ui-1',
        secret: 'leak',
      } },
    } })
    return
  }
  if (message.method === 'resources/read') {
    if (message.params?.uri === ${JSON.stringify(PAGE_URI)}) {
      send({ jsonrpc: '2.0', id: message.id, result: {
        contents: [{ uri: ${JSON.stringify(PAGE_URI)}, mimeType: 'text/html', text: page }],
      } })
      return
    }
    send({ jsonrpc: '2.0', id: message.id, error: { code: -32602, message: 'unknown resource' } })
    return
  }
  send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'method not found: ' + message.method } })
})
`

/** ui-plugin manifest：direct 与 hidden 两个 MCP 服务器 + 一个 UI surface。 */
const UI_MANIFEST = {
  name: 'ui-plugin',
  version: '1.0.0',
  skills: [],
  mcpServers: {
    canvas: { command: process.execPath, args: ['${PLUGIN_ROOT}/server.mjs'], exposure: 'direct' },
    hidden: { command: process.execPath, args: ['${PLUGIN_ROOT}/server.mjs'], exposure: 'hidden' },
  },
  ui: { surfaces: [{ id: 'canvas', title: 'Canvas', server: 'canvas', resourceUri: PAGE_URI }] },
}

/** 工具执行用的最小 Context（遥测空实现、无中止信号）。 */
const EMPTY_CONTEXT: Context = {
  telemetry: NOOP_TELEMETRY_CONTEXT,
  abortSignal: undefined,
  value: () => undefined,
  toString: () => 'pi-web-plugin-ui-test',
}

/** 临时目录 / runtime / MCP 管理器的清理函数，afterEach 逆序执行。 */
const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

/**
 * 轮询异步动作直到返回非 undefined。
 * @param action 探测动作，undefined 表示未就绪
 * @param label 超时错误中的等待目标
 * @param timeoutMs 总超时，默认 15 秒
 * @returns 首个非 undefined 结果
 */
async function eventually<T>(action: () => Promise<T | undefined> | T | undefined, label: string, timeoutMs = 15_000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await action()
    if (value !== undefined) return value
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`)
    await delay(20)
  }
}

/**
 * 创建临时目录并注册清理。
 * @param prefix mkdtemp 前缀
 * @returns 目录绝对路径
 */
async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix))
  cleanups.push(() => rm(directory, { recursive: true, force: true }))
  return directory
}

/**
 * 构建已安装 ui-plugin 的 PluginStore（市场接入 + 异步安装等待完成）。
 * @returns 就绪的 PluginStore
 */
async function storeFixture(): Promise<PluginStore> {
  const root = await temporaryDirectory('pi-web-plugin-ui-store-')
  const market = join(root, 'market')
  await writeMarketplace(market, { plugins: [{ name: 'ui-plugin' }] })
  await writePlugin(join(market, 'ui-plugin'), { pluginName: 'ui-plugin', skills: [], manifest: UI_MANIFEST })
  const store = await PluginStore.open({ dataDir: join(root, 'data') })
  await store.addMarketplace(market)
  store.startInstall({ marketplace: 'fixture-market', name: 'ui-plugin' })
  await eventually(() => store.overview().plugins.find(plugin => plugin.installed), 'ui-plugin install')
  return store
}

/** runtime fixture 句柄：runtime 与市场目录路径。 */
interface UiRuntimeFixture {
  runtime: Runtime
  market: string
}

/**
 * 构建完整 runtime fixture：临时目录 + 含 ui-plugin（真实 stdio MCP 服务器）的市场 + demo runtime。
 * @returns runtime 与市场路径
 */
async function runtimeFixture(): Promise<UiRuntimeFixture> {
  const root = await temporaryDirectory('pi-web-plugin-ui-runtime-')
  const dataDir = join(root, 'data')
  const workspace = join(root, 'workspace')
  const piDir = join(root, 'pi')
  const market = join(root, 'market')
  await Promise.all([mkdir(workspace, { recursive: true }), mkdir(piDir, { recursive: true })])
  await writeFile(join(piDir, 'settings.json'), '{}')
  await writeMarketplace(market, { plugins: [{ name: 'ui-plugin' }] })
  await writePlugin(join(market, 'ui-plugin'), { pluginName: 'ui-plugin', skills: [], manifest: UI_MANIFEST })
  await writeFile(join(market, 'ui-plugin', 'server.mjs'), MCP_UI_FIXTURE)
  const runtime = await createRuntime({ dataDir, workspace, piDir, demo: true })
  cleanups.push(() => runtime.close())
  return { runtime, market }
}

/** 取工具执行结果第一个 text 块的文本（无则空串）。 */
function outputText(result: ToolExecutionResult<JsonValue>): string {
  const block = result.output?.[0]
  return block?.type === 'text' ? block.text : ''
}

/** 描述符投影（pluginUiDescriptorFromMeta）与真实 MCP 结果投影测试。 */
describe('plugin UI descriptor projection', () => {
  // 验证白名单投影：只保留文档化字段、heightHint 小数取整、插件身份（pluginId/serverName）由调用方注入，
  // _meta 中未文档化的键（secret、other）不进入描述符。
  it('keeps only the documented `_meta.ui` fields and adds the plugin identity', () => {
    const descriptor = pluginUiDescriptorFromMeta({
      ui: {
        resourceUri: 'ui://demo/canvas',
        title: 'Canvas',
        heightHint: 300.4,
        preferredDisplayMode: 'fullscreen',
        showInline: false,
        toolCallId: 'call-1',
        secret: 'leak',
      },
      other: 'leak',
    }, { pluginId: 'demo@market', serverName: 'plugin_demo_canvas' })
    expect(descriptor).toEqual({
      pluginId: 'demo@market',
      serverName: 'plugin_demo_canvas',
      resourceUri: 'ui://demo/canvas',
      title: 'Canvas',
      heightHint: 300,
      preferredDisplayMode: 'fullscreen',
      showInline: false,
      toolCallId: 'call-1',
    })
    expect(Object.keys(descriptor ?? {})).not.toContain('secret')
  })

  // 验证校验：缺身份、空 resourceUri、空 ui、_meta 缺失 → 整体 undefined；
  // 可选字段类型非法（displayMode 非法枚举/heightHint 负数/showInline 非布尔/title 非字符串）
  // 时仅丢弃该字段，其余合法字段照常投影。
  it('rejects missing identity, empty resource URIs, and invalid optional fields', () => {
    expect(pluginUiDescriptorFromMeta({ ui: { resourceUri: 'ui://demo' } }, { pluginId: undefined, serverName: 's' })).toBeUndefined()
    expect(pluginUiDescriptorFromMeta({ ui: { resourceUri: '' } }, { pluginId: 'demo@market', serverName: 's' })).toBeUndefined()
    expect(pluginUiDescriptorFromMeta({ ui: {} }, { pluginId: 'demo@market', serverName: 's' })).toBeUndefined()
    expect(pluginUiDescriptorFromMeta(undefined, { pluginId: 'demo@market', serverName: 's' })).toBeUndefined()
    expect(pluginUiDescriptorFromMeta({
      ui: { resourceUri: 'ui://demo', preferredDisplayMode: 'popup', heightHint: -1, showInline: 'yes', title: 42 },
    }, { pluginId: 'demo@market', serverName: 's' })).toEqual({
      pluginId: 'demo@market',
      serverName: 's',
      resourceUri: 'ui://demo',
    })
  })

  // 验证扁平拼写：`ui/resourceUri` 键（部分 MCP 实现的写法）同样解析出描述符。
  it('accepts the flattened `ui/resourceUri` spelling', () => {
    expect(pluginUiDescriptorFromMeta(
      { 'ui/resourceUri': 'ui://demo/flat' },
      { pluginId: 'demo@market', serverName: 'plugin_demo_canvas' },
    )).toEqual({ pluginId: 'demo@market', serverName: 'plugin_demo_canvas', resourceUri: 'ui://demo/flat' })
  })

  // 验证真实链路投影：McpRegistry 加载插件服务器后执行 echo 工具，结果 details.ui 携带完整描述符
  // 且 secret 不泄露；flat 工具的扁平 ui/resourceUri 也投影（无 title 等可选字段）；
  // 无 resourceUri 的工具结果不产出 details.ui。
  it('projects a real MCP tools/call result into details.ui', async () => {
    const root = await temporaryDirectory('pi-web-plugin-ui-mcp-')
    const serverPath = join(root, 'server.mjs')
    await writeFile(serverPath, MCP_UI_FIXTURE)
    const pluginServers: PluginMcpServerConfig[] = [{
      pluginId: 'ui-plugin@fixture-market',
      pluginName: 'ui-plugin',
      serverKey: 'canvas',
      serverName: 'plugin_ui_plugin_canvas',
      command: process.execPath,
      args: [serverPath],
      env: {},
      cwd: root,
      dataPath: join(root, 'data'),
      exposure: 'direct',
    }]
    const manager = await McpRegistry.open({
      configPath: join(root, 'mcp.json'),
      pluginServers: () => pluginServers,
    })
    cleanups.push(() => manager.close())
    const tools = manager.extension()?.tools ?? []
    const echo = tools.find(tool => tool.name === 'mcp__plugin_ui_plugin_canvas__echo')
    expect(echo).toBeDefined()
    const result = await echo!.execute({ text: 'hi' }, {} as ToolExecutionApi, EMPTY_CONTEXT)
    expect(outputText(result)).toBe('plugin:hi')
    expect((result.details as Record<string, unknown>).ui).toEqual({
      pluginId: 'ui-plugin@fixture-market',
      serverName: 'plugin_ui_plugin_canvas',
      resourceUri: 'ui://ui-plugin/canvas',
      title: 'Canvas',
      heightHint: 320,
      preferredDisplayMode: 'inline',
      showInline: true,
      toolCallId: 'call-ui-1',
    })
    expect(JSON.stringify(result.details)).not.toContain('leak')

    const flat = tools.find(tool => tool.name === 'mcp__plugin_ui_plugin_canvas__flat')
    const flatResult = await flat!.execute({}, {} as ToolExecutionApi, EMPTY_CONTEXT)
    expect((flatResult.details as Record<string, unknown>).ui).toEqual({
      pluginId: 'ui-plugin@fixture-market',
      serverName: 'plugin_ui_plugin_canvas',
      resourceUri: 'ui://ui-plugin/flat',
    })

    const noUri = tools.find(tool => tool.name === 'mcp__plugin_ui_plugin_canvas__no_uri')
    const noUriResult = await noUri!.execute({}, {} as ToolExecutionApi, EMPTY_CONTEXT)
    expect((noUriResult.details as Record<string, unknown>).ui).toBeUndefined()
  }, 30_000)
})

/** 商店层面的 UI surface 列表与服务器归属解析测试。 */
describe('plugin UI surfaces in the store', () => {
  // 验证 surface 列表（命名空间 id、来源插件、serverName、resourceUri）与 pluginServer 归属解析
  // （未知 serverName → undefined）；禁用插件后 surface 清空、归属解析失效。
  it('lists enabled surfaces and resolves their owning plugin server', async () => {
    const store = await storeFixture()
    const surfaces = store.uiSurfaces()
    expect(surfaces).toEqual([{
      id: 'ui-plugin@fixture-market:canvas',
      pluginId: 'ui-plugin@fixture-market',
      pluginName: 'ui-plugin',
      title: 'Canvas',
      serverName: 'plugin_ui_plugin_canvas',
      resourceUri: PAGE_URI,
    }])
    expect(store.pluginServer('plugin_ui_plugin_canvas')).toEqual({
      pluginId: 'ui-plugin@fixture-market',
      pluginName: 'ui-plugin',
      serverKey: 'canvas',
    })
    expect(store.pluginServer('plugin_unknown_canvas')).toBeUndefined()

    await store.setEnabled('ui-plugin@fixture-market', false)
    expect(store.uiSurfaces()).toEqual([])
    expect(store.pluginServer('plugin_ui_plugin_canvas')).toBeUndefined()
  })
})

/** 页面 HTML 包装（buildPluginUiPageHtml）与资源文本提取测试。 */
describe('plugin UI page HTML', () => {
  // 验证片段包装：裸 HTML 片段被包进带沙箱 CSP meta 的完整文档，片段原样保留。
  it('wraps a fragment with the sandbox CSP', () => {
    const html = buildPluginUiPageHtml('<div id="app">hi</div>')
    expect(html).toContain(`content="${EXPECTED_CSP}"`)
    expect(html).toContain('<div id="app">hi</div>')
  })

  // 验证 CSP 注入幂等：已有 <head> 的完整页面只注入一次 CSP（紧跟 head 开标签）；
  // pluginUiResourceText 取 uri 匹配的第一个 text 内容（跳过 blob 条目），全 blob 时为 undefined。
  it('injects the CSP into an existing head and reads the first text resource', () => {
    const html = buildPluginUiPageHtml(PAGE_HTML)
    expect(html.match(/Content-Security-Policy/gu)).toHaveLength(1)
    expect(html).toContain(`<head><meta http-equiv="Content-Security-Policy" content="${EXPECTED_CSP}"><title>Canvas</title>`)
    expect(pluginUiResourceText({ contents: [{ uri: 'x', blob: 'AA==' }, { uri: PAGE_URI, text: 'page' }] })).toBe('page')
    expect(pluginUiResourceText({ contents: [{ uri: 'x', blob: 'AA==' }] })).toBeUndefined()
  })
})

/** 运行时宿主（pluginUiPage/ReadResource/Call）的服务与策略测试。 */
describe('plugin UI runtime host', () => {
  // 验证宿主全链路：surface 列表、页面 HTML（带 CSP + 页面内容）、资源读取、工具转发（_meta.ui 保留）；
  // 策略矩阵——跨插件借服务器拒绝、readOnly 会话 ACCESS_DENIED、计划模式 PLAN_BLOCKED、
  // hidden 服务器不可调用；禁用插件后 surface 清空且页面不可用。
  it('serves a page, forwards calls, and applies read-only and Plan policy', async () => {
    const f = await runtimeFixture()
    await f.runtime.addPluginMarketplace(f.market)
    await f.runtime.installPlugin({ marketplace: 'fixture-market', name: 'ui-plugin' })
    await eventually(() => f.runtime.mcp().servers.find(server => server.name === 'plugin_ui_plugin_canvas' && server.status === 'connected'), 'plugin UI MCP server')

    const pluginId = 'ui-plugin@fixture-market'
    expect(f.runtime.pluginUiSurfaces()).toEqual([{
      id: `${pluginId}:canvas`,
      pluginId,
      pluginName: 'ui-plugin',
      title: 'Canvas',
      serverName: 'plugin_ui_plugin_canvas',
      resourceUri: PAGE_URI,
    }])

    const html = await f.runtime.pluginUiPage({ pluginId, serverName: 'plugin_ui_plugin_canvas', uri: PAGE_URI })
    expect(html).toContain(`content="${EXPECTED_CSP}"`)
    expect(html).toContain('<div id="app">canvas</div>')

    const resource = await f.runtime.pluginUiReadResource({ pluginId, serverName: 'plugin_ui_plugin_canvas', uri: PAGE_URI })
    expect(resource.contents).toHaveLength(1)
    expect(pluginUiResourceText(resource)).toContain('<div id="app">')

    const call = await f.runtime.pluginUiCall({ pluginId, serverName: 'plugin_ui_plugin_canvas', tool: 'echo', arguments: { text: 'hi' } })
    expect(call.content).toEqual([{ type: 'text', text: 'plugin:hi' }])
    expect(call._meta).toMatchObject({ ui: { resourceUri: PAGE_URI } })

    await expect(f.runtime.pluginUiPage({
      pluginId: 'other@fixture-market',
      serverName: 'plugin_ui_plugin_canvas',
      uri: PAGE_URI,
    })).rejects.toMatchObject({ code: 'PLUGIN_UI_UNAVAILABLE' })

    const readOnly = await f.runtime.create({ title: 'Read-only', accessMode: 'readOnly' })
    await expect(f.runtime.pluginUiCall({
      conversationId: readOnly.conversation.id,
      pluginId,
      serverName: 'plugin_ui_plugin_canvas',
      tool: 'echo',
      arguments: { text: 'blocked' },
    })).rejects.toMatchObject({ code: 'ACCESS_DENIED' })

    const planning = await f.runtime.create({ title: 'Plan' })
    await f.runtime.setPlan(planning.conversation.id, true)
    await expect(f.runtime.pluginUiCall({
      conversationId: planning.conversation.id,
      pluginId,
      serverName: 'plugin_ui_plugin_canvas',
      tool: 'echo',
      arguments: { text: 'blocked' },
    })).rejects.toMatchObject({ code: 'PLAN_BLOCKED' })

    // hidden 服务器虽已连接，但其工具永远不能从页面调用。
    await expect(f.runtime.pluginUiCall({
      pluginId,
      serverName: 'plugin_ui_plugin_hidden',
      tool: 'echo',
      arguments: { text: 'blocked' },
    })).rejects.toMatchObject({ code: 'PLUGIN_UI_UNAVAILABLE' })

    // 其他插件的页面不能借用本插件的服务器。
    await expect(f.runtime.pluginUiCall({
      pluginId: 'other@fixture-market',
      serverName: 'plugin_ui_plugin_canvas',
      tool: 'echo',
    })).rejects.toMatchObject({ code: 'PLUGIN_UI_UNAVAILABLE' })

    await f.runtime.setPluginEnabled(pluginId, false)
    expect(f.runtime.pluginUiSurfaces()).toEqual([])
    await expect(f.runtime.pluginUiPage({ pluginId, serverName: 'plugin_ui_plugin_canvas', uri: PAGE_URI }))
      .rejects.toMatchObject({ code: 'PLUGIN_UI_UNAVAILABLE' })
  }, 30_000)
})
