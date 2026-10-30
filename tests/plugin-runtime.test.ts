import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { afterEach, describe, expect, it } from 'vitest'
import { createApp } from '../src/server/app.ts'
import { createRuntime } from '../src/server/runtime/index.ts'
import type { Runtime } from '../src/server/contracts.ts'
import { writeMarketplace, writePlugin } from './plugin-fixtures.ts'

/** Minimal stdio MCP server used to prove a plugin server is reachable without a restart. */
const MCP_FIXTURE = `
import { createInterface } from 'node:readline'

const send = message => process.stdout.write(JSON.stringify(message) + '\\n')
const tools = [{ name: 'echo', description: 'Echo back', inputSchema: { type: 'object', properties: { text: { type: 'string' } } } }]

createInterface({ input: process.stdin }).on('line', line => {
  if (line.trim() === '') return
  const message = JSON.parse(line)
  if (message.id === undefined) return
  if (message.method === 'initialize') {
    send({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'plugin-fixture', version: '1.0.0' } } })
    return
  }
  if (message.method === 'tools/list') {
    send({ jsonrpc: '2.0', id: message.id, result: { tools } })
    return
  }
  if (message.method === 'tools/call') {
    send({ jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: 'plugin:' + (message.params?.arguments?.text ?? '') }] } })
    return
  }
  send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'method not found: ' + message.method } })
})
`

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'pi-web-plugin-runtime-'))
  const dataDir = join(root, 'data')
  const workspace = join(root, 'workspace')
  const piDir = join(root, 'pi')
  const market = join(root, 'market')
  await Promise.all([mkdir(workspace, { recursive: true }), mkdir(piDir, { recursive: true })])
  await writeFile(join(piDir, 'settings.json'), '{}')
  await writeMarketplace(market, {
    plugins: [
      { name: 'demo-plugin', listing: { displayName: 'Demo plugin' } },
      { name: 'http-plugin', description: 'Installed over HTTP' },
    ],
  })
  await writePlugin(join(market, 'demo-plugin'), { skills: [{ name: 'draw' }] })
  await writePlugin(join(market, 'http-plugin'), { pluginName: 'http-plugin', skills: [{ name: 'review' }] })
  let runtime = await createRuntime({ dataDir, workspace, piDir, demo: true })
  cleanups.push(async () => { await runtime.close(); await rm(root, { recursive: true, force: true }) })
  return {
    dataDir,
    workspace,
    piDir,
    market,
    get runtime(): Runtime { return runtime },
    async restart() {
      await runtime.close()
      runtime = await createRuntime({ dataDir, workspace, piDir, demo: true })
    },
  }
}

async function eventually<T>(action: () => Promise<T | undefined>, label: string, timeoutMs = 10_000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await action()
    if (value !== undefined) return value
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`)
    await delay(20)
  }
}

describe('plugin runtime integration', () => {
  it('installs a plugin and exposes its skill through the runtime and HTTP routes', async () => {
    const f = await fixture()
    await f.runtime.addPluginMarketplace(f.market)
    const workspace = f.runtime.workspaces()[0]!
    const app = createApp(f.runtime, { demo: true })

    const overview = await f.runtime.plugins()
    expect(overview.marketplaces).toHaveLength(1)
    expect(overview.plugins).toHaveLength(2)

    const installed = await app.request('/api/plugins/install', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ marketplace: 'fixture-market', name: 'http-plugin', requestId: 'install-http-plugin' }),
    })
    expect(installed.status).toBe(202)
    expect(await installed.json()).toMatchObject({ operationId: expect.any(String) })
    await eventually(async () => {
      const current = await f.runtime.plugins()
      return current.plugins.find(plugin => plugin.id === 'http-plugin@fixture-market' && plugin.installed) ? current : undefined
    }, 'HTTP plugin install')

    await f.runtime.installPlugin({ marketplace: 'fixture-market', name: 'demo-plugin' })
    const ready = await eventually(async () => {
      const current = await f.runtime.plugins()
      const installedPlugins = current.plugins.filter(plugin => plugin.installed)
      return installedPlugins.length === 2 ? current : undefined
    }, 'both plugins installed')
    expect(ready.operations.every(operation => operation.status === 'completed')).toBe(true)

    const httpCatalog = await app.request(`/api/workspaces/${workspace.id}/skills`)
    expect(httpCatalog.status).toBe(200)
    const catalog = await httpCatalog.json()
    const pluginSkill = catalog.skills.find((skill: { id: string }) => skill.id === 'demo-plugin@fixture-market:draw')
    expect(pluginSkill).toMatchObject({ source: 'plugin', pluginId: 'demo-plugin@fixture-market', pluginName: 'demo-plugin', writable: false })
    expect(catalog.skills.some((skill: { id: string }) => skill.id === 'http-plugin@fixture-market:review')).toBe(true)

    const loaded = await f.runtime.skill(workspace.id, 'demo-plugin@fixture-market:draw')
    expect(loaded.content).toContain('Use the draw workflow')
    expect(loaded.skill.source).toBe('plugin')

    const disabled = await app.request('/api/plugins/demo-plugin@fixture-market', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: false }),
    })
    expect(disabled.status).toBe(200)
    const afterDisable = await f.runtime.skills(workspace.id)
    expect(afterDisable.skills.some(skill => skill.id === 'demo-plugin@fixture-market:draw')).toBe(false)
    expect(afterDisable.skills.some(skill => skill.id === 'http-plugin@fixture-market:review')).toBe(true)

    const removed = await app.request('/api/plugins/http-plugin@fixture-market', { method: 'DELETE' })
    expect(removed.status).toBe(200)
    const afterRemove = await f.runtime.skills(workspace.id)
    expect(afterRemove.skills.some(skill => skill.id === 'http-plugin@fixture-market:review')).toBe(false)
  }, 30_000)

  it('keeps installs across a runtime restart and surfaces marketplace diagnostics', async () => {
    const f = await fixture()
    const app = createApp(f.runtime, { demo: true })
    const bad = await app.request('/api/plugins/marketplaces', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ source: 'relative/path' }),
    })
    expect(bad.status).toBe(400)

    expect((await app.request('/api/plugins/marketplaces', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ source: f.market }),
    })).status).toBe(201)
    await f.runtime.installPlugin({ marketplace: 'fixture-market', name: 'demo-plugin' })
    await eventually(async () => {
      const current = await f.runtime.plugins()
      return current.plugins.find(plugin => plugin.id === 'demo-plugin@fixture-market')?.installed ? current : undefined
    }, 'install before restart')

    await f.restart()
    const restartedApp = createApp(f.runtime, { demo: true })
    const overview = await f.runtime.plugins()
    expect(overview.plugins.find(plugin => plugin.id === 'demo-plugin@fixture-market')).toMatchObject({ installed: true, enabled: true })
    const workspace = f.runtime.workspaces()[0]!
    const catalog = await f.runtime.skills(workspace.id)
    expect(catalog.skills.some(skill => skill.id === 'demo-plugin@fixture-market:draw')).toBe(true)

    const refreshed = await restartedApp.request('/api/plugins/marketplaces/fixture-market/refresh', { method: 'POST' })
    expect(refreshed.status).toBe(200)
    const removedSource = await restartedApp.request('/api/plugins/marketplaces/fixture-market', { method: 'DELETE' })
    expect(removedSource.status).toBe(200)
    const afterSourceRemoval = await f.runtime.plugins()
    expect(afterSourceRemoval.plugins.find(plugin => plugin.id === 'demo-plugin@fixture-market')).toMatchObject({ installed: true, available: false })
  }, 30_000)
})

describe('plugin MCP projection', () => {
  it('connects a plugin MCP server without a restart and drops it when disabled', async () => {
    const f = await fixture()
    await writeMarketplace(f.market, {
      plugins: [
        { name: 'demo-plugin', listing: { displayName: 'Demo plugin' } },
        { name: 'http-plugin', description: 'Installed over HTTP' },
        { name: 'mcp-plugin' },
      ],
    })
    await writePlugin(join(f.market, 'mcp-plugin'), {
      pluginName: 'mcp-plugin',
      skills: [],
      manifest: {
        name: 'mcp-plugin',
        version: '1.0.0',
        mcpServers: {
          echo: { command: process.execPath, args: ['${PLUGIN_ROOT}/server.mjs'], exposure: 'direct' },
        },
      },
    })
    await writeFile(join(f.market, 'mcp-plugin', 'server.mjs'), MCP_FIXTURE)
    await f.runtime.addPluginMarketplace(f.market)
    expect(f.runtime.mcp().servers).toHaveLength(0)

    await f.runtime.installPlugin({ marketplace: 'fixture-market', name: 'mcp-plugin' })
    const server = await eventually(async () => {
      const current = f.runtime.mcp().servers.find(item => item.name === 'plugin_mcp_plugin_echo')
      return current?.status === 'connected' ? current : undefined
    }, 'plugin MCP server connected')
    expect(server).toMatchObject({ pluginId: 'mcp-plugin@fixture-market', transport: 'stdio', exposure: 'direct' })
    expect(server.tools.map(tool => tool.name)).toContain('echo')

    const detail = await f.runtime.create({ title: 'plugin tool' })
    await f.runtime.submit(detail.conversation.id, {
      text: '[plugin-tool:mcp__plugin_mcp_plugin_echo__echo]',
      requestId: 'plugin-tool-echo',
    })
    const answer = await eventually(async () => {
      const current = await f.runtime.detail(detail.conversation.id)
      const text = current.messages
        .filter(message => message.role === 'assistant')
        .flatMap(message => message.blocks.flatMap(block => block.type === 'text' ? [block.text] : []))
        .join('\n')
      return text.includes('plugin:hello') ? text : undefined
    }, 'plugin tool answer')
    expect(answer).toContain('插件工具返回：plugin:hello')

    await f.runtime.setPluginEnabled('mcp-plugin@fixture-market', false)
    expect(f.runtime.mcp().servers.some(item => item.name === 'plugin_mcp_plugin_echo')).toBe(false)
    const catalog = await f.runtime.skills(f.runtime.workspaces()[0]!.id)
    expect(catalog.skills.some(skill => skill.pluginId === 'mcp-plugin@fixture-market')).toBe(false)
  }, 30_000)
})
