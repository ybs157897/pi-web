import { createServer, type Server } from 'node:http'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { loadMarketplace, materializePluginSource, parseMarketplaceSource } from '../src/server/plugin-source.ts'
import { makeZip, writeMarketplace, writePlugin } from './plugin-fixtures.ts'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'pi-web-plugin-source-'))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  return root
}

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

describe('marketplace sources', () => {
  it('accepts HTTPS and loopback HTTP but rejects other transports', () => {
    expect(parseMarketplaceSource('https://example.com/marketplace.json').kind).toBe('url')
    expect(parseMarketplaceSource('http://127.0.0.1:8080/marketplace.json').kind).toBe('url')
    expect(parseMarketplaceSource('http://localhost:8080/marketplace.json').kind).toBe('url')
    expect(() => parseMarketplaceSource('http://example.com/marketplace.json')).toThrow()
    expect(() => parseMarketplaceSource('relative/path')).toThrow()
  })

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

  it('loads a catalog over loopback HTTP', async () => {
    const root = await fixture()
    await writeMarketplace(root, { name: 'http-market', plugins: [{ name: 'demo-plugin' }] })
    const catalog = await readFile(join(root, 'marketplace.json'), 'utf8')
    const { url } = await serve({ '/marketplace.json': catalog })

    const loaded = await loadMarketplace(parseMarketplaceSource(`${url}/marketplace.json`))
    expect(loaded.name).toBe('http-market')
    expect(loaded.plugins[0]?.source.kind).toBe('unsupported')
  })

  it('rejects an invalid catalog and a marketplace without marketplace.json', async () => {
    const root = await fixture()
    await writeFile(join(root, 'marketplace.json'), '{ broken')
    await expect(loadMarketplace(parseMarketplaceSource(root))).rejects.toMatchObject({ code: 'PLUGIN_SOURCE_INVALID' })

    const empty = await fixture()
    await expect(loadMarketplace(parseMarketplaceSource(empty))).rejects.toMatchObject({ code: 'MARKETPLACE_NOT_FOUND' })
  })
})

describe('plugin packages', () => {
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

  it('rejects a checksum mismatch', async () => {
    const root = await fixture()
    const zip = makeZip([{ name: 'a.txt', content: 'hello' }])
    const { url } = await serve({ '/plugin.zip': zip })
    await expect(materializePluginSource({ kind: 'zip', url: `${url}/plugin.zip`, sha256: '0'.repeat(64), display: 'zip' }, {
      destination: join(root, 'staging'),
    })).rejects.toMatchObject({ code: 'PLUGIN_CHECKSUM_MISMATCH' })
  })

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

  it('reports unsupported sources', async () => {
    await expect(materializePluginSource({ kind: 'unsupported', display: 'github', reason: 'P1' }, {
      destination: '/tmp/unused',
    })).rejects.toMatchObject({ code: 'PLUGIN_UNSUPPORTED_SOURCE' })
  })
})
