/**
 * 插件来源（marketplace / plugin package）解析与物化测试。
 *
 * 关键契约：
 * - parseMarketplaceSource 接受 HTTPS 与回环 HTTP URL、本地目录，拒绝其他 http 主机与相对路径；
 * - loadMarketplace 读取并归一化目录（directory/zip/unsupported）与 URL 来源的市场目录，
 *   损坏 JSON 报 PLUGIN_SOURCE_INVALID、无 marketplace.json 报 MARKETPLACE_NOT_FOUND；
 * - materializePluginSource：directory 来源复制到 staging 并产出内容指纹（相同内容指纹一致）；
 *   目录越界（../）与符号链接拒绝；zip 来源下载 + sha256 校验（不匹配报 PLUGIN_CHECKSUM_MISMATCH）+
 *   解包，包内路径穿越/符号链接/加密条目拒绝；unsupported 来源直接报错。
 */
import { createServer, type Server } from 'node:http'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { loadMarketplace, materializePluginSource, parseMarketplaceSource } from '../src/server/plugins/source.ts'
import { makeZip, writeMarketplace, writePlugin } from './plugin-fixtures.ts'

/** 临时目录与本地 HTTP 服务器的清理函数，afterEach 逆序执行。 */
const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

/**
 * 创建临时目录并注册到清理列表。
 * @returns 临时目录绝对路径
 */
async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'pi-web-plugin-source-'))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  return root
}

/**
 * 启动一个只读静态文件的本地 HTTP 服务器（随机端口，仅回环地址）。
 * @param routes URL 路径 → 响应体；未命中的路径返回 404
 * @returns 服务基地址 url（注册清理）与原始 server 句柄
 */
async function serve(routes: Record<string, Buffer | string>): Promise<{ url: string; server: Server }> {
  const server = createServer((request, response) => {
    const content = routes[request.url ?? '']
    if (content === undefined) {
      response.writeHead(404).end('missing')
      return
    }
    response.writeHead(200, { 'content-type': 'application/octet-stream' })
    response.end(content)
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  cleanups.push(async () => { await new Promise<void>(resolve => server.close(() => resolve())) })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('test server has no port')
  return { url: `http://127.0.0.1:${address.port}`, server }
}

/** 市场目录来源的解析与加载测试。 */
describe('marketplace sources', () => {
  // 验证传输白名单：https 任意主机、http 仅限 127.0.0.1/localhost 回环；非回环 http 与相对路径抛错。
  it('accepts HTTPS and loopback HTTP but rejects other transports', () => {
    expect(parseMarketplaceSource('https://example.com/marketplace.json').kind).toBe('url')
    expect(parseMarketplaceSource('http://127.0.0.1:8080/marketplace.json').kind).toBe('url')
    expect(parseMarketplaceSource('http://localhost:8080/marketplace.json').kind).toBe('url')
    expect(() => parseMarketplaceSource('http://example.com/marketplace.json')).toThrow()
    expect(() => parseMarketplaceSource('relative/path')).toThrow()
  })

  // 验证本地目录市场的归一化：featured/插件顺序保留；条目 source 按类型分类——
  // 相对路径 → directory、url+sha256 对象 → zip、npm 等其它 → unsupported。
  it('loads and normalizes a local marketplace catalog', async () => {
    const root = await fixture()
    await writeMarketplace(root, {
      name: 'local-market',
      featured: ['demo-plugin'],
      plugins: [
        { name: 'demo-plugin', version: '1.2.0', source: './demo-plugin', category: 'design', listing: { displayName: 'Demo' } },
        { name: 'remote', version: '1.0.0', source: { source: 'url', type: 'zip', url: 'https://example.com/p.zip', sha256: 'a'.repeat(64) } },
        { name: 'legacy', version: '1.0.0', source: { source: 'npm' } },
      ],
    })

    const catalog = await loadMarketplace(parseMarketplaceSource(root))
    expect(catalog.name).toBe('local-market')
    expect(catalog.featured).toEqual(['demo-plugin'])
    expect(catalog.plugins.map(plugin => plugin.name)).toEqual(['demo-plugin', 'remote', 'legacy'])
    expect(catalog.plugins[0]?.source.kind).toBe('directory')
    expect(catalog.plugins[1]?.source.kind).toBe('zip')
    expect(catalog.plugins[2]?.source.kind).toBe('unsupported')
  })

  // 验证 HTTP 市场加载：通过回环 HTTP 服务器提供 marketplace.json，加载成功；
  // HTTP 条目（无 sha256 元数据）的插件来源归为 unsupported。
  it('loads a catalog over loopback HTTP', async () => {
    const root = await fixture()
    await writeMarketplace(root, { name: 'http-market', plugins: [{ name: 'demo-plugin' }] })
    const catalog = await readFile(join(root, 'marketplace.json'), 'utf8')
    const { url } = await serve({ '/marketplace.json': catalog })

    const loaded = await loadMarketplace(parseMarketplaceSource(`${url}/marketplace.json`))
    expect(loaded.name).toBe('http-market')
    expect(loaded.plugins[0]?.source.kind).toBe('unsupported')
  })

  // 验证失败分支：JSON 损坏 → PLUGIN_SOURCE_INVALID；目录里根本没有 marketplace.json → MARKETPLACE_NOT_FOUND。
  it('rejects an invalid catalog and a marketplace without marketplace.json', async () => {
    const root = await fixture()
    await writeFile(join(root, 'marketplace.json'), '{ broken')
    await expect(loadMarketplace(parseMarketplaceSource(root))).rejects.toMatchObject({ code: 'PLUGIN_SOURCE_INVALID' })

    const empty = await fixture()
    await expect(loadMarketplace(parseMarketplaceSource(empty))).rejects.toMatchObject({ code: 'MARKETPLACE_NOT_FOUND' })
  })
})

/** 插件包物化（复制 / 下载解包）与安全校验测试。 */
describe('plugin packages', () => {
  // 验证 directory 来源：整包复制到 staging、指纹为 sha256:<64hex> 格式；
  // 相同内容复制到不同目标目录时指纹一致（指纹基于内容而非路径）。
  it('copies a directory package and fingerprints its contents', async () => {
    const root = await fixture()
    const marketplace = join(root, 'market')
    const plugin = join(marketplace, 'demo-plugin')
    await writePlugin(plugin)
    const destination = join(root, 'staging', 'demo')

    const first = await materializePluginSource({ kind: 'directory', path: './demo-plugin', display: 'directory' }, {
      marketplaceRoot: marketplace,
      destination,
    })
    expect(first.sourceType).toBe('directory')
    expect(first.fingerprint).toMatch(/^sha256:[a-f0-9]{64}$/)
    expect(await readFile(join(destination, '.pi-plugin', 'plugin.json'), 'utf8')).toContain('demo-plugin')

    const second = await materializePluginSource({ kind: 'directory', path: './demo-plugin', display: 'directory' }, {
      marketplaceRoot: marketplace,
      destination: join(root, 'staging', 'demo-2'),
    })
    expect(second.fingerprint).toBe(first.fingerprint)
  })

  // 验证目录包安全：路径越出市场根（../outside）与包内含符号链接文件（escape → 包外目标）均拒绝。
  it('rejects traversal and symbolic links in a directory package', async () => {
    const root = await fixture()
    const marketplace = join(root, 'market')
    await mkdir(marketplace, { recursive: true })
    await expect(materializePluginSource({ kind: 'directory', path: '../outside', display: 'directory' }, {
      marketplaceRoot: marketplace,
      destination: join(root, 'staging', 'outside'),
    })).rejects.toMatchObject({ code: 'PLUGIN_SOURCE_INVALID' })

    const plugin = join(marketplace, 'linked')
    await mkdir(plugin, { recursive: true })
    await symlink(join(root, 'target'), join(plugin, 'escape'))
    await expect(materializePluginSource({ kind: 'directory', path: './linked', display: 'directory' }, {
      marketplaceRoot: marketplace,
      destination: join(root, 'staging', 'linked'),
    })).rejects.toMatchObject({ code: 'PLUGIN_SOURCE_INVALID' })
  })

  // 验证 zip 来源全流程：HTTP 下载 → sha256 与 manifest 声明一致 → 解包到 staging，
  // plugin.json 与 SKILL.md 内容完好，指纹即文件校验和。
  it('downloads, checksums, and extracts a ZIP package', async () => {
    const root = await fixture()
    const zip = makeZip([
      { name: '.pi-plugin/plugin.json', content: JSON.stringify({ name: 'zip-plugin', version: '1.0.0' }) },
      { name: 'skills/draw/SKILL.md', content: '---\nname: draw\ndescription: Draw\n---\nBody\n' },
    ])
    const sha256 = createHash('sha256').update(zip).digest('hex')
    const { url } = await serve({ '/plugin.zip': zip })
    const destination = join(root, 'staging', 'zip')

    const result = await materializePluginSource({ kind: 'zip', url: `${url}/plugin.zip`, sha256, display: 'zip' }, { destination })
    expect(result.sourceType).toBe('zip')
    expect(result.fingerprint).toBe(`sha256:${sha256}`)
    expect(await readFile(join(destination, '.pi-plugin', 'plugin.json'), 'utf8')).toContain('zip-plugin')
    expect(await readFile(join(destination, 'skills', 'draw', 'SKILL.md'), 'utf8')).toContain('name: draw')
  })

  // 验证校验和防线：声明 sha256 与实际文件不符时拒绝（PLUGIN_CHECKSUM_MISMATCH），不解包。
  it('rejects a checksum mismatch', async () => {
    const root = await fixture()
    const zip = makeZip([{ name: 'a.txt', content: 'hello' }])
    const { url } = await serve({ '/plugin.zip': zip })
    await expect(materializePluginSource({ kind: 'zip', url: `${url}/plugin.zip`, sha256: '0'.repeat(64), display: 'zip' }, {
      destination: join(root, 'staging'),
    })).rejects.toMatchObject({ code: 'PLUGIN_CHECKSUM_MISMATCH' })
  })

  // 验证 zip 内容三类攻击全部拒绝（即使校验和匹配）：../ 路径穿越条目、符号链接条目、加密条目。
  it('rejects ZIP traversal, symlinks, and encryption', async () => {
    const root = await fixture()
    for (const entry of [
      { name: '../evil.txt', content: 'x' },
      { name: 'link', content: 'x', symlink: true },
      { name: 'secret.txt', content: 'x', encrypt: true },
    ]) {
      const zip = makeZip([entry])
      const sha256 = createHash('sha256').update(zip).digest('hex')
      const { url } = await serve({ '/plugin.zip': zip })
      await expect(materializePluginSource({ kind: 'zip', url: `${url}/plugin.zip`, sha256, display: 'zip' }, {
        destination: join(root, 'staging', entry.name.replace(/\W/gu, '_')),
      }), entry.name).rejects.toMatchObject({ code: 'PLUGIN_SOURCE_INVALID' })
    }
  })

  // 验证不可物化的来源（如 github）：直接报 PLUGIN_UNSUPPORTED_SOURCE，不做任何 IO。
  it('reports unsupported sources', async () => {
    await expect(materializePluginSource({ kind: 'unsupported', display: 'github', reason: 'P1' }, {
      destination: '/tmp/unused',
    })).rejects.toMatchObject({ code: 'PLUGIN_UNSUPPORTED_SOURCE' })
  })
})
