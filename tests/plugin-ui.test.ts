import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { afterEach, describe, expect, it } from 'vitest'
import type { Context } from '@earendil-works/chord/context'
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

const EXPECTED_CSP = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: https:; connect-src 'none'; form-action 'none'; base-uri 'none'"
const PAGE_URI = 'ui://ui-plugin/canvas'
const PAGE_HTML = '<!doctype html><html><head><title>Canvas</title></head><body><div id="app">canvas</div></body></html>'

/** A real stdio MCP server: one plugin server answers tools and the page resource. */
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

const EMPTY_CONTEXT: Context = {
  abortSignal: undefined,
  value: () => undefined,
  toString: () => 'pi-web-plugin-ui-test',
}

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

async function eventually<T>(action: () => Promise<T | undefined> | T | undefined, label: string, timeoutMs = 15_000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await action()
    if (value !== undefined) return value
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`)
    await delay(20)
  }
}

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix))
  cleanups.push(() => rm(directory, { recursive: true, force: true }))
  return directory
}

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

interface UiRuntimeFixture {
  runtime: Runtime
  market: string
}

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

function outputText(result: ToolExecutionResult<JsonValue>): string {
  const block = result.output?.[0]
  return block?.type === 'text' ? block.text : ''
}

describe('plugin UI descriptor projection', () => {
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

  it('accepts the flattened `ui/resourceUri` spelling', () => {
    expect(pluginUiDescriptorFromMeta(
      { 'ui/resourceUri': 'ui://demo/flat' },
      { pluginId: 'demo@market', serverName: 'plugin_demo_canvas' },
    )).toEqual({ pluginId: 'demo@market', serverName: 'plugin_demo_canvas', resourceUri: 'ui://demo/flat' })
  })

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

describe('plugin UI surfaces in the store', () => {
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

describe('plugin UI page HTML', () => {
  it('wraps a fragment with the sandbox CSP', () => {
    const html = buildPluginUiPageHtml('<div id="app">hi</div>')
    expect(html).toContain(`content="${EXPECTED_CSP}"`)
    expect(html).toContain('<div id="app">hi</div>')
  })

  it('injects the CSP into an existing head and reads the first text resource', () => {
    const html = buildPluginUiPageHtml(PAGE_HTML)
    expect(html.match(/Content-Security-Policy/gu)).toHaveLength(1)
    expect(html).toContain(`<head><meta http-equiv="Content-Security-Policy" content="${EXPECTED_CSP}"><title>Canvas</title>`)
    expect(pluginUiResourceText({ contents: [{ uri: 'x', blob: 'AA==' }, { uri: PAGE_URI, text: 'page' }] })).toBe('page')
    expect(pluginUiResourceText({ contents: [{ uri: 'x', blob: 'AA==' }] })).toBeUndefined()
  })
})

describe('plugin UI runtime host', () => {
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

    // A hidden server is connected but its tools are never callable from a page.
    await expect(f.runtime.pluginUiCall({
      pluginId,
      serverName: 'plugin_ui_plugin_hidden',
      tool: 'echo',
      arguments: { text: 'blocked' },
    })).rejects.toMatchObject({ code: 'PLUGIN_UI_UNAVAILABLE' })

    // A page from another plugin cannot borrow this plugin's server.
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
