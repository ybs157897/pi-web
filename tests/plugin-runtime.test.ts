/**
 * 插件运行时集成测试（真实 runtime + HTTP API）。
 *
 * 关键契约：
 * - 安装流程：添加市场 → 两种安装路径（HTTP API 异步任务 / runtime 直装）→
 *   技能以 "plugin@market:skill" 命名空间出现在工作区目录（source=plugin、不可写）；
 * - 禁用插件即从技能目录移除其技能（其他插件不受影响），卸载同理会移除技能；
 * - 安装状态跨 runtime 重启保留；坏市场来源 400，移除市场后插件转为 installed+available:false 并出现诊断；
 * - MCP 投影：插件 manifest 声明的 stdio MCP 服务器无需重启即可连接（PLUGIN_ROOT 占位符展开），
 *   会话中可通过 mcp__ 前缀工具调用拿到回显结果；禁用插件即断开其服务器并移除其技能。
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { afterEach, describe, expect, it } from 'vitest'
import { createApp } from '../src/server/app.ts'
import { createRuntime } from '../src/server/runtime/index.ts'
import type { Runtime } from '../src/server/contracts.ts'
import { writeMarketplace, writePlugin } from './plugin-fixtures.ts'

/** 最小 stdio MCP 服务器 fixture：用于证明插件服务器无需重启即可被连接。响应 initialize / tools/list / tools/call。 */
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

/**
 * 搭建完整的插件运行时环境：临时 data/workspace/pi 目录 + 含两个插件（demo-plugin、http-plugin）
 * 的本地市场 + demo 模式 runtime，并注册关闭/删除清理。
 * @returns 目录路径、runtime（getter 支持 restart 后取新实例）与 restart()（关停后用同一数据目录重建）
 */
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

/**
 * 轮询执行异步动作直到返回非 undefined（异步安装/连接是后台任务，无法同步等待）。
 * @param action 每次轮询执行的探测动作，undefined 表示尚未就绪
 * @param label 超时错误信息中的等待目标名称
 * @param timeoutMs 总超时，默认 10 秒
 * @returns 首个非 undefined 的探测结果
 */
async function eventually<T>(action: () => Promise<T | undefined>, label: string, timeoutMs = 10_000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await action()
    if (value !== undefined) return value
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`)
    await delay(20)
  }
}

/** 安装、技能暴露、禁用与卸载的端到端集成测试。 */
describe('plugin runtime integration', () => {
  // 验证完整安装链路：市场接入后 overview 含 2 个插件；HTTP API 安装返回 202 + operationId
  // 并异步完成；runtime 直装另一插件；两个插件技能都进入工作区技能目录（只读、带插件元数据）；
  // runtime.skill 能加载技能正文；PATCH 禁用只移除该插件技能；DELETE 卸载移除另一插件技能。
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

  // 验证持久化与诊断：坏来源添加市场返回 400；安装的插件在 runtime 重启后仍 installed+enabled
  // 且技能仍在目录中；市场 refresh 与删除正常；删除市场来源后插件变为 installed+available:false。
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

/** 插件 MCP 服务器的连接、工具调用与禁用断开测试。 */
describe('plugin MCP projection', () => {
  // 验证 MCP 投影生命周期：安装含 stdio MCP 服务器的插件后无需重启即 connected
  // （服务器名 plugin_mcp_plugin_echo、transport=stdio、exposure=direct、tools 含 echo）；
  // 会话中直接调用该工具能拿到 fixture 回显（"插件工具返回：plugin:hello"）；
  // 禁用插件后服务器从列表移除、其技能也从目录消失。
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
