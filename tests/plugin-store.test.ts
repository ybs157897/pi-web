/**
 * PluginStore（插件商店持久层）生命周期与更新测试。
 *
 * 关键契约：
 * - 安装：市场接入 → 目录插件安装（异步操作 completed）→ installed/enabled 状态、
 *   命名空间化技能、skillRoots、installed.json 持久化、cache/<market>/<plugin>/<version> 落盘、
 *   私有数据目录创建；
 * - 幂等：重复安装不产生第二条记录；状态跨 store 重开保留；enable/disable 即时增删 skillRoots；
 * - 卸载：可保留或删除插件私有数据目录；ZIP 校验和篡改失败且不落任何安装记录；
 * - 依赖：同市场内 dependencies 自动连带安装；unsupported 来源安装失败；
 * - github/git 来源归类为可安装 kind、畸形 repo 归为 unsupported；
 * - 移除市场不卸载已装插件（转为 available:false）；同 id 不同来源的市场拒绝（CONFLICT）；
 * - 更新：catalog 版本变化后 update 安全新版本并删除旧版本包；包版本与 catalog 不符时
 *   失败且保持已装版本；describe 不泄露 env 值（只给 envKeys）；MCP 服务器投影带
 *   PLUGIN_ROOT/PLUGIN_DATA 占位符展开；能力变更通过 onChange 通知监听者。
 */
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { afterEach, describe, expect, it } from 'vitest'
import { PluginStore } from '../src/server/plugins/store.ts'
import { dataDirectoryName, pluginIdOf } from '../src/server/plugins/types.ts'
import { makeZip, writeMarketplace, writePlugin } from './plugin-fixtures.ts'

/** 临时目录 / HTTP 服务器的清理函数，afterEach 逆序执行。 */
const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

/**
 * 创建 PluginStore 测试环境：空数据目录 + 市场目录占位。
 * @returns dataDir 与 market 路径
 */
async function fixture(): Promise<{ dataDir: string; market: string }> {
  const root = await mkdtemp(join(tmpdir(), 'pi-web-plugin-store-'))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  const dataDir = join(root, 'data')
  const market = join(root, 'market')
  await mkdir(dataDir, { recursive: true })
  return { dataDir, market }
}

/**
 * 轮询异步动作直到返回非 undefined。
 * @param action 探测动作，undefined 表示未就绪
 * @param label 超时错误中的等待目标
 * @param timeoutMs 总超时，默认 8 秒
 * @returns 首个非 undefined 结果
 */
async function eventually<T>(action: () => Promise<T | undefined> | T | undefined, label: string, timeoutMs = 8_000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await action()
    if (value !== undefined) return value
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`)
    await delay(20)
  }
}

/**
 * 等待某插件的操作（安装/更新）离开 running 状态。
 * @param store 目标商店
 * @param pluginId 插件 id
 * @returns 操作终态 {status, error?}
 */
async function waitOperation(store: PluginStore, pluginId: string): Promise<{ status: string; error?: string }> {
  return eventually(() => {
    const operation = store.overview().operations.find(item => item.pluginId === pluginId)
    if (operation === undefined || operation.status === 'running') return undefined
    return { status: operation.status, ...(operation.error === undefined ? {} : { error: operation.error }) }
  }, `install ${pluginId}`)
}

/**
 * 启动一个对任何请求都返回给定 ZIP 的本地 HTTP 服务器。
 * @param zip 响应字节
 * @returns 插件下载 URL
 */
async function serveZip(zip: Buffer): Promise<string> {
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/zip' })
    response.end(zip)
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  cleanups.push(async () => { await new Promise<void>(resolve => server.close(() => resolve())) })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('no port')
  return `http://127.0.0.1:${address.port}/plugin.zip`
}

/** 商店生命周期：接入、安装、幂等、启停、卸载、依赖与来源校验测试。 */
describe('plugin store lifecycle', () => {
  // 验证首次安装全链路：市场接入后条目 available；安装操作 completed；
  // installed/enabled/版本/命名空间技能正确；skillRoots 投影插件来源；
  // installed.json 与 cache 目录落盘、私有数据目录创建。
  it('adds a marketplace, installs a directory plugin, and projects its skill root', async () => {
    const { dataDir, market } = await fixture()
    await writeMarketplace(market, { plugins: [{ name: 'demo-plugin', listing: { displayName: 'Demo' } }] })
    await writePlugin(join(market, 'demo-plugin'))
    const store = await PluginStore.open({ dataDir })

    const added = await store.addMarketplace(market)
    expect(added.marketplaces).toHaveLength(1)
    expect(added.plugins[0]).toMatchObject({ id: 'demo-plugin@fixture-market', available: true, installed: false, displayName: 'Demo' })

    const operation = store.startInstall({ marketplace: 'fixture-market', name: 'demo-plugin' })
    expect(operation.status).toBe('running')
    expect(await waitOperation(store, 'demo-plugin@fixture-market')).toEqual({ status: 'completed' })

    const overview = store.overview()
    const item = overview.plugins.find(plugin => plugin.id === 'demo-plugin@fixture-market')
    expect(item).toMatchObject({ installed: true, enabled: true, installedVersion: '1.0.0' })
    expect(item?.capabilities.skills).toEqual(['demo-plugin@fixture-market:draw'])
    expect(store.skillRoots()).toHaveLength(1)
    expect(store.skillRoots()[0]).toMatchObject({ source: 'plugin', pluginId: 'demo-plugin@fixture-market', pluginName: 'demo-plugin' })
    expect(JSON.parse(await readFile(store.installedPath, 'utf8')).plugins).toHaveLength(1)
    expect(await readFile(join(dataDir, 'plugins', 'cache', 'fixture-market', 'demo-plugin', '1.0.0', '.pi-plugin', 'plugin.json'), 'utf8')).toContain('demo-plugin')
    await expect(access(join(dataDir, 'plugins', 'data', dataDirectoryName('demo-plugin@fixture-market')))).resolves.toBeUndefined()
  })

  // 验证幂等与持久化：重复安装仍只有一条记录；重开 store 后 installed/enabled 状态
  // 与 skillRoots（禁用时空）保留；重新启用后 skillRoots 恢复。
  it('is idempotent, persists across reopen, and honors enable/disable', async () => {
    const { dataDir, market } = await fixture()
    await writeMarketplace(market, { plugins: [{ name: 'demo-plugin' }] })
    await writePlugin(join(market, 'demo-plugin'))
    const store = await PluginStore.open({ dataDir })
    await store.addMarketplace(market)
    store.startInstall({ marketplace: 'fixture-market', name: 'demo-plugin' })
    await waitOperation(store, 'demo-plugin@fixture-market')

    store.startInstall({ marketplace: 'fixture-market', name: 'demo-plugin' })
    await waitOperation(store, 'demo-plugin@fixture-market')
    expect(store.overview().plugins.filter(plugin => plugin.installed)).toHaveLength(1)

    await store.setEnabled('demo-plugin@fixture-market', false)
    expect(store.skillRoots()).toHaveLength(0)
    expect(store.overview().plugins[0]?.enabled).toBe(false)

    const reopened = await PluginStore.open({ dataDir })
    expect(reopened.overview().plugins[0]).toMatchObject({ installed: true, enabled: false })
    expect(reopened.skillRoots()).toHaveLength(0)
    await reopened.setEnabled('demo-plugin@fixture-market', true)
    expect(reopened.skillRoots()).toHaveLength(1)
  })

  // 验证卸载语义：keepData=true 时卸载后私有数据目录保留（可重装续用）；
  // 默认卸载删除数据目录与 cache 包目录。
  it('uninstalls and can keep plugin data', async () => {
    const { dataDir, market } = await fixture()
    await writeMarketplace(market, { plugins: [{ name: 'demo-plugin' }] })
    await writePlugin(join(market, 'demo-plugin'))
    const store = await PluginStore.open({ dataDir })
    await store.addMarketplace(market)
    store.startInstall({ marketplace: 'fixture-market', name: 'demo-plugin' })
    await waitOperation(store, 'demo-plugin@fixture-market')

    const dataDirPath = join(dataDir, 'plugins', 'data', dataDirectoryName('demo-plugin@fixture-market'))
    await writeFile(join(dataDirPath, 'keep.txt'), 'private data')
    const afterKeep = await store.uninstall('demo-plugin@fixture-market', true)
    expect(afterKeep.plugins[0]).toMatchObject({ installed: false, available: true })
    expect(store.skillRoots()).toHaveLength(0)
    await expect(access(dataDirPath)).resolves.toBeUndefined()

    store.startInstall({ marketplace: 'fixture-market', name: 'demo-plugin' })
    await waitOperation(store, 'demo-plugin@fixture-market')
    await store.uninstall('demo-plugin@fixture-market')
    await expect(access(dataDirPath)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(access(join(dataDir, 'plugins', 'cache', 'fixture-market', 'demo-plugin'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  // 验证依赖解析：main-plugin 声明依赖 helper-plugin，安装主插件时连带安装依赖，
  // overview 记录解析后的依赖 id 列表。
  it('resolves dependencies inside one marketplace', async () => {
    const { dataDir, market } = await fixture()
    await writeMarketplace(market, { plugins: [{ name: 'main-plugin', version: '1.0.0' }, { name: 'helper-plugin', version: '1.0.0' }] })
    await writePlugin(join(market, 'helper-plugin'), { pluginName: 'helper-plugin' })
    await writePlugin(join(market, 'main-plugin'), {
      pluginName: 'main-plugin',
      manifest: { name: 'main-plugin', version: '1.0.0', dependencies: ['helper-plugin'] },
      skills: [],
    })
    const store = await PluginStore.open({ dataDir })
    await store.addMarketplace(market)

    store.startInstall({ marketplace: 'fixture-market', name: 'main-plugin' })
    expect(await waitOperation(store, 'main-plugin@fixture-market')).toEqual({ status: 'completed' })
    const installed = store.overview().plugins.filter(plugin => plugin.installed).map(plugin => plugin.id).sort()
    expect(installed).toEqual(['helper-plugin@fixture-market', 'main-plugin@fixture-market'])
    const main = store.overview().plugins.find(plugin => plugin.id === 'main-plugin@fixture-market')
    expect(main?.dependencies).toEqual(['helper-plugin@fixture-market'])
  })

  // 验证校验和防线：sha256 不匹配的 ZIP 安装失败（error 含 checksum），
  // 不产生安装记录（installedPath 文件不存在）。
  it('fails a tampered ZIP without adding an install record', async () => {
    const { dataDir, market } = await fixture()
    const zip = makeZip([{ name: '.pi-plugin/plugin.json', content: JSON.stringify({ name: 'zip-plugin', version: '1.0.0' }) }])
    const url = await serveZip(zip)
    await writeMarketplace(market, {
      plugins: [{ name: 'zip-plugin', source: { source: 'url', type: 'zip', url, sha256: '0'.repeat(64) } }],
    })
    const store = await PluginStore.open({ dataDir })
    await store.addMarketplace(market)

    store.startInstall({ marketplace: 'fixture-market', name: 'zip-plugin' })
    const operation = await waitOperation(store, 'zip-plugin@fixture-market')
    expect(operation.status).toBe('failed')
    expect(operation.error).toContain('checksum')
    const item = store.overview().plugins.find(plugin => plugin.id === 'zip-plugin@fixture-market')
    expect(item?.installed).toBe(false)
    await expect(access(store.installedPath)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  // 验证不支持来源：npm 来源条目 sourceType=unsupported，安装失败且错误含 "not supported"。
  it('reports unsupported sources without installing', async () => {
    const { dataDir, market } = await fixture()
    await writeMarketplace(market, {
      plugins: [{ name: 'legacy-plugin', source: { source: 'npm', package: 'legacy-plugin' } }],
    })
    const store = await PluginStore.open({ dataDir })
    await store.addMarketplace(market)
    const item = store.overview().plugins[0]
    expect(item?.sourceType).toBe('unsupported')

    store.startInstall({ marketplace: 'fixture-market', name: 'legacy-plugin' })
    const operation = await waitOperation(store, 'legacy-plugin@fixture-market')
    expect(operation.status).toBe('failed')
    expect(operation.error).toContain('not supported')
  })

  // 验证来源归类：合法 github（含 repo/ref/path）与 git URL 归为对应可安装 kind；
  // repo 字段不是合法仓库（not-a-repository）归为 unsupported。
  it('normalizes GitHub and git sources as installable kinds', async () => {
    const { dataDir, market } = await fixture()
    await writeMarketplace(market, {
      plugins: [
        { name: 'hub-plugin', source: { source: 'github', repo: 'owner/repo', ref: 'main', path: 'packages/hub' } },
        { name: 'git-plugin', source: { source: 'git', url: 'https://example.com/plugin.git' } },
        { name: 'bad-hub', source: { source: 'github', repo: 'not-a-repository' } },
      ],
    })
    const store = await PluginStore.open({ dataDir })
    await store.addMarketplace(market)
    const byName = new Map(store.overview().plugins.map(plugin => [plugin.name, plugin]))
    expect(byName.get('hub-plugin')?.sourceType).toBe('github')
    expect(byName.get('git-plugin')?.sourceType).toBe('git')
    expect(byName.get('bad-hub')?.sourceType).toBe('unsupported')
  })

  // 验证市场移除：市场列表清空但已装插件保留（installed:true、available:false），skillRoots 不受影响。
  it('removes a marketplace without uninstalling its plugins', async () => {
    const { dataDir, market } = await fixture()
    await writeMarketplace(market, { plugins: [{ name: 'demo-plugin' }] })
    await writePlugin(join(market, 'demo-plugin'))
    const store = await PluginStore.open({ dataDir })
    await store.addMarketplace(market)
    store.startInstall({ marketplace: 'fixture-market', name: 'demo-plugin' })
    await waitOperation(store, 'demo-plugin@fixture-market')

    const afterRemove = await store.removeMarketplace('fixture-market')
    expect(afterRemove.marketplaces).toHaveLength(0)
    expect(afterRemove.plugins[0]).toMatchObject({ id: pluginIdOf('demo-plugin', 'fixture-market'), installed: true, available: false })
    expect(store.skillRoots()).toHaveLength(1)
  })

  // 验证 id 冲突防线：两个不同来源目录声明同一市场名（same-market），第二个接入被 CONFLICT 拒绝。
  it('rejects two marketplaces with one id but different sources', async () => {
    const { dataDir, market } = await fixture()
    await writeMarketplace(market, { name: 'same-market', plugins: [] })
    const other = `${market}-other`
    await writeMarketplace(other, { name: 'same-market', plugins: [] })
    cleanups.push(() => rm(other, { recursive: true, force: true }))
    const store = await PluginStore.open({ dataDir })
    await store.addMarketplace(market)
    await expect(store.addMarketplace(other)).rejects.toMatchObject({ code: 'CONFLICT' })
  })
})

/** 更新流程与能力投影（describe/MCP 服务器/onChange）测试。 */
describe('plugin store updates and capability projection', () => {
  // 验证版本更新：catalog 升到 2.0.0 并 refresh 后 overview 显示 installedVersion 仍为 1.0.0
  // （describe 描述 catalog 候选包）；startUpdate 完成后 installedVersion=2.0.0、
  // 旧版本 cache 目录删除、skillRoots 指向新版本路径。
  it('updates an installed plugin to the catalog version and removes the old package', async () => {
    const { dataDir, market } = await fixture()
    await writeMarketplace(market, { plugins: [{ name: 'demo-plugin', version: '1.0.0' }] })
    await writePlugin(join(market, 'demo-plugin'), { version: '1.0.0', skills: [{ name: 'draw', description: 'v1 description' }] })
    const store = await PluginStore.open({ dataDir })
    await store.addMarketplace(market)
    store.startInstall({ marketplace: 'fixture-market', name: 'demo-plugin' })
    await waitOperation(store, 'demo-plugin@fixture-market')
    const oldPath = join(dataDir, 'plugins', 'cache', 'fixture-market', 'demo-plugin', '1.0.0')
    expect(await readFile(join(oldPath, 'skills', 'draw', 'SKILL.md'), 'utf8')).toContain('v1 description')

    await writeMarketplace(market, { plugins: [{ name: 'demo-plugin', version: '2.0.0' }] })
    await writePlugin(join(market, 'demo-plugin'), { version: '2.0.0', skills: [{ name: 'draw', description: 'v2 description' }] })
    await store.refreshMarketplace('fixture-market')
    expect(store.overview().plugins[0]).toMatchObject({ installed: true, version: '2.0.0', installedVersion: '1.0.0' })
    // 更新确认描述的是 catalog 候选包，而非已安装版本。
    expect(await store.describe('demo-plugin@fixture-market')).toMatchObject({ version: '2.0.0', installed: true })

    const operation = store.startUpdate({ pluginId: 'demo-plugin@fixture-market' })
    expect(operation).toMatchObject({ pluginId: 'demo-plugin@fixture-market', status: 'running' })
    expect(await waitOperation(store, 'demo-plugin@fixture-market')).toEqual({ status: 'completed' })

    const updated = store.overview().plugins[0]
    expect(updated).toMatchObject({ installed: true, version: '2.0.0', installedVersion: '2.0.0' })
    await expect(access(oldPath)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readFile(join(dataDir, 'plugins', 'cache', 'fixture-market', 'demo-plugin', '2.0.0', 'skills', 'draw', 'SKILL.md'), 'utf8')).toContain('v2 description')
    expect(store.skillRoots()[0]?.path).toContain(join('demo-plugin', '2.0.0', 'skills'))
  })

  // 验证失败回滚：包版本与 catalog 不符时更新失败（错误含 "does not match the catalog version"），
  // 已装版本（1.0.0）与其 cache 目录、skillRoots 原样保留。
  it('keeps the installed version when the update package is invalid', async () => {
    const { dataDir, market } = await fixture()
    await writeMarketplace(market, { plugins: [{ name: 'demo-plugin', version: '1.0.0' }] })
    await writePlugin(join(market, 'demo-plugin'), { version: '1.0.0' })
    const store = await PluginStore.open({ dataDir })
    await store.addMarketplace(market)
    store.startInstall({ marketplace: 'fixture-market', name: 'demo-plugin' })
    await waitOperation(store, 'demo-plugin@fixture-market')

    // catalog 标 2.0.0 但包内 manifest 仍是 1.0.0：staging 先校验再激活。
    await writeMarketplace(market, { plugins: [{ name: 'demo-plugin', version: '2.0.0' }] })
    await store.refreshMarketplace('fixture-market')
    store.startUpdate({ pluginId: 'demo-plugin@fixture-market' })
    const operation = await waitOperation(store, 'demo-plugin@fixture-market')
    expect(operation.status).toBe('failed')
    expect(operation.error).toContain('does not match the catalog version')
    expect(store.overview().plugins[0]).toMatchObject({ installedVersion: '1.0.0' })
    await expect(access(join(dataDir, 'plugins', 'cache', 'fixture-market', 'demo-plugin', '1.0.0', '.pi-plugin', 'plugin.json'))).resolves.toBeUndefined()
    expect(store.skillRoots()).toHaveLength(1)
  })

  // 验证 describe 与 MCP 投影：describe 只给 envKeys 不泄露 env 值（secret-value 不出现）；
  // 安装后 mcpServers 投影完整服务器配置——cwd 指向 cache 版本目录、PLUGIN_ROOT/PLUGIN_DATA
  // 占位符展开、原始 env 值保留；禁用插件后服务器列表清空。
  it('describes a candidate without leaking env values and projects enabled MCP servers', async () => {
    const { dataDir, market } = await fixture()
    await writeMarketplace(market, { plugins: [{ name: 'mcp-plugin' }] })
    await writePlugin(join(market, 'mcp-plugin'), {
      manifest: {
        name: 'mcp-plugin',
        version: '1.0.0',
        mcpServers: {
          echo: {
            command: 'node',
            args: ['${PLUGIN_ROOT}/server.js'],
            env: { PLUGIN_DATA: '${PLUGIN_DATA}', TOKEN: 'secret-value' },
            exposure: 'direct',
          },
        },
      },
    })
    const store = await PluginStore.open({ dataDir })
    await store.addMarketplace(market)

    const description = await store.describe('mcp-plugin@fixture-market')
    expect(description).toMatchObject({
      id: 'mcp-plugin@fixture-market',
      installed: false,
      mcpServers: [{
        name: 'echo',
        serverName: 'plugin_mcp_plugin_echo',
        command: 'node',
        args: ['${PLUGIN_ROOT}/server.js'],
        envKeys: ['PLUGIN_DATA', 'TOKEN'],
        exposure: 'direct',
      }],
    })
    expect(JSON.stringify(description)).not.toContain('secret-value')

    store.startInstall({ marketplace: 'fixture-market', name: 'mcp-plugin' })
    await waitOperation(store, 'mcp-plugin@fixture-market')
    const servers = store.mcpServers()
    expect(servers).toHaveLength(1)
    const server = servers[0]!
    expect(server).toMatchObject({
      pluginId: 'mcp-plugin@fixture-market',
      serverName: 'plugin_mcp_plugin_echo',
      exposure: 'direct',
    })
    expect(server.cwd).toContain(join('cache', 'fixture-market', 'mcp-plugin', '1.0.0'))
    expect(server.args[0]).toBe(join(server.cwd, 'server.js'))
    expect(server.env.PLUGIN_DATA).toBe(server.dataPath)
    expect(server.env.PLUGIN_ROOT).toBe(server.cwd)
    expect(server.env.TOKEN).toBe('secret-value')

    await store.setEnabled('mcp-plugin@fixture-market', false)
    expect(store.mcpServers()).toHaveLength(0)
  })

  // 验证 onChange 通知：接入市场（marketplace）、安装（install 恰好一次）、禁用（enable）、
  // 卸载（uninstall）都推送给监听者。
  it('reports capability-changing mutations to its listener', async () => {
    const { dataDir, market } = await fixture()
    await writeMarketplace(market, { plugins: [{ name: 'demo-plugin' }] })
    await writePlugin(join(market, 'demo-plugin'))
    const events: string[] = []
    const store = await PluginStore.open({ dataDir, onChange: event => events.push(event.reason) })
    await store.addMarketplace(market)
    store.startInstall({ marketplace: 'fixture-market', name: 'demo-plugin' })
    await waitOperation(store, 'demo-plugin@fixture-market')
    await store.setEnabled('demo-plugin@fixture-market', false)
    await store.uninstall('demo-plugin@fixture-market')
    expect(events[0]).toBe('marketplace')
    expect(events.filter(event => event === 'install')).toHaveLength(1)
    expect(events).toContain('enable')
    expect(events).toContain('uninstall')
  })
})
