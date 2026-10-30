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

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

async function fixture(): Promise<{ dataDir: string; market: string }> {
  const root = await mkdtemp(join(tmpdir(), 'pi-web-plugin-store-'))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  const dataDir = join(root, 'data')
  const market = join(root, 'market')
  await mkdir(dataDir, { recursive: true })
  return { dataDir, market }
}

async function eventually<T>(action: () => Promise<T | undefined> | T | undefined, label: string, timeoutMs = 8_000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await action()
    if (value !== undefined) return value
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`)
    await delay(20)
  }
}

async function waitOperation(store: PluginStore, pluginId: string): Promise<{ status: string; error?: string }> {
  return eventually(() => {
    const operation = store.overview().operations.find(item => item.pluginId === pluginId)
    if (operation === undefined || operation.status === 'running') return undefined
    return { status: operation.status, ...(operation.error === undefined ? {} : { error: operation.error }) }
  }, `install ${pluginId}`)
}

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

describe('plugin store lifecycle', () => {
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

describe('plugin store updates and capability projection', () => {
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
    // The update confirmation describes the catalog package, not the installed one.
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

  it('keeps the installed version when the update package is invalid', async () => {
    const { dataDir, market } = await fixture()
    await writeMarketplace(market, { plugins: [{ name: 'demo-plugin', version: '1.0.0' }] })
    await writePlugin(join(market, 'demo-plugin'), { version: '1.0.0' })
    const store = await PluginStore.open({ dataDir })
    await store.addMarketplace(market)
    store.startInstall({ marketplace: 'fixture-market', name: 'demo-plugin' })
    await waitOperation(store, 'demo-plugin@fixture-market')

    // Catalog says 2.0.0 but the package still declares 1.0.0: staging validates before activation.
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
