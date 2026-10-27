import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { loadPluginPackage } from '../src/server/plugin-manifest.ts'
import { writePlugin } from './plugin-fixtures.ts'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'pi-web-plugin-manifest-'))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  return root
}

describe('plugin manifest discovery', () => {
  it('loads a package, its skills, and its namespaced capabilities', async () => {
    const root = await fixture()
    await writePlugin(root, {
      manifest: {
        name: 'demo-plugin',
        version: '2.1.0',
        description: 'Demo',
        skills: ['./skills'],
        mcpServers: { canvas: { command: 'node', args: ['server.js'], exposure: 'direct' } },
        ui: { surfaces: [{ id: 'canvas', title: 'Canvas', server: 'canvas', resourceUri: 'ui://demo/canvas' }] },
        commands: ['draw'],
      },
      skills: [{ name: 'draw' }, { name: 'review' }],
    })

    const loaded = await loadPluginPackage(root, 'demo-plugin@fixture-market')

    expect(loaded.manifest.name).toBe('demo-plugin')
    expect(loaded.manifest.version).toBe('2.1.0')
    expect(loaded.capabilities.skills).toEqual(['demo-plugin@fixture-market:draw', 'demo-plugin@fixture-market:review'])
    expect(loaded.capabilities.mcpServers).toEqual(['plugin_demo_plugin_canvas'])
    expect(loaded.capabilities.uiSurfaces).toEqual(['canvas'])
    expect(loaded.capabilities.unsupported).toEqual(['commands'])
    expect(loaded.skillRoots).toHaveLength(1)
  })

  it('prefers .pi-plugin over the other compatible manifest directories', async () => {
    const root = await fixture()
    await mkdir(join(root, '.pi-plugin'), { recursive: true })
    await writeFile(join(root, '.pi-plugin', 'plugin.json'), JSON.stringify({ name: 'pi-first', version: '1.0.0' }))
    await mkdir(join(root, '.claude-plugin'), { recursive: true })
    await writeFile(join(root, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'claude-second', version: '1.0.0' }))

    const loaded = await loadPluginPackage(root, 'pi-first@fixture-market')
    expect(loaded.manifest.name).toBe('pi-first')
  })

  it('rejects missing, malformed, and inconsistent manifests', async () => {
    const root = await fixture()
    await expect(loadPluginPackage(root, 'demo@fixture-market')).rejects.toMatchObject({ code: 'PLUGIN_SOURCE_INVALID' })

    await mkdir(join(root, '.pi-plugin'), { recursive: true })
    await writeFile(join(root, '.pi-plugin', 'plugin.json'), '{ not json')
    await expect(loadPluginPackage(root, 'demo@fixture-market')).rejects.toMatchObject({ code: 'PLUGIN_SOURCE_INVALID' })

    await writeFile(join(root, '.pi-plugin', 'plugin.json'), JSON.stringify({ name: 'Bad Name', version: '1' }))
    await expect(loadPluginPackage(root, 'demo@fixture-market')).rejects.toMatchObject({ code: 'PLUGIN_SOURCE_INVALID' })

    await writeFile(join(root, '.pi-plugin', 'plugin.json'), JSON.stringify({
      name: 'demo',
      version: '1.0.0',
      ui: { surfaces: [{ id: 'canvas', title: 'Canvas', server: 'missing', resourceUri: 'ui://demo/canvas' }] },
    }))
    await expect(loadPluginPackage(root, 'demo@fixture-market')).rejects.toMatchObject({ code: 'PLUGIN_SOURCE_INVALID' })
  })

  it('rejects skill paths that escape, are missing, or are symbolic links', async () => {
    const root = await fixture()
    await mkdir(join(root, '.pi-plugin'), { recursive: true })
    const outside = await fixture()
    await mkdir(join(outside, 'skills', 'escape'), { recursive: true })
    await writeFile(join(outside, 'skills', 'escape', 'SKILL.md'), '---\nname: escape\ndescription: x\n---\nBody\n')

    for (const skills of [['../escape'], ['/absolute'], ['./missing']]) {
      await writeFile(join(root, '.pi-plugin', 'plugin.json'), JSON.stringify({ name: 'demo', version: '1.0.0', skills }))
      await expect(loadPluginPackage(root, 'demo@fixture-market')).rejects.toMatchObject({ code: 'PLUGIN_SOURCE_INVALID' })
    }

    await mkdir(join(root, 'skills'), { recursive: true })
    await symlink(join(outside, 'skills', 'escape'), join(root, 'skills', 'linked'))
    await writeFile(join(root, '.pi-plugin', 'plugin.json'), JSON.stringify({ name: 'demo', version: '1.0.0', skills: ['./skills'] }))
    await expect(loadPluginPackage(root, 'demo@fixture-market')).rejects.toMatchObject({ code: 'PLUGIN_SOURCE_INVALID' })
  })

  it('ignores directories without SKILL.md and keeps the package loadable', async () => {
    const root = await fixture()
    await writePlugin(root, { skills: [{ name: 'draw' }] })
    await mkdir(join(root, 'skills', 'not-a-skill'), { recursive: true })

    const loaded = await loadPluginPackage(root, 'demo-plugin@fixture-market')
    expect(loaded.capabilities.skills).toEqual(['demo-plugin@fixture-market:draw'])
  })
})
