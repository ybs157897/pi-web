/**
 * 插件 manifest 发现与加载（loadPluginPackage）测试。
 *
 * 关键契约：
 * - 从 .pi-plugin/plugin.json 加载包，技能列表按 "<plugin>@<market>:<skill>" 命名空间化，
 *   MCP 服务器名改写为 plugin_<name>_<server>，UI surface 提取 id，commands 等归入 unsupported；
 * - 兼容多个 manifest 目录（.pi-plugin / .claude-plugin 等）时优先 .pi-plugin；
 * - 缺失、格式错误、名称不合法、UI surface 引用不存在的服务器均拒绝（PLUGIN_SOURCE_INVALID）；
 * - 技能路径不得越界（../、绝对路径）、不得缺失、不得是符号链接（防符号链接逃逸）；
 * - 技能目录下没有 SKILL.md 的子目录被忽略，不影响包加载。
 */
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { loadPluginPackage } from '../src/server/plugins/manifest.ts'
import { writePlugin } from './plugin-fixtures.ts'

/** 每个用例创建的临时目录清理函数，afterEach 逆序执行。 */
const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

/**
 * 创建一个临时目录并注册到清理列表。
 * @returns 临时目录绝对路径
 */
async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'pi-web-plugin-manifest-'))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  return root
}

/** loadPluginPackage 的发现、加载与安全校验测试。 */
describe('plugin manifest discovery', () => {
  // 验证完整加载路径：manifest 各字段解析正确，技能名带市场命名空间前缀，
  // MCP 服务器名改写为扁平的 plugin_demo_plugin_canvas，unsupported 收纳 commands。
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

  // 验证 manifest 目录优先级：.pi-plugin 与 .claude-plugin 同时存在时加载前者。
  it('prefers .pi-plugin over the other compatible manifest directories', async () => {
    const root = await fixture()
    await mkdir(join(root, '.pi-plugin'), { recursive: true })
    await writeFile(join(root, '.pi-plugin', 'plugin.json'), JSON.stringify({ name: 'pi-first', version: '1.0.0' }))
    await mkdir(join(root, '.claude-plugin'), { recursive: true })
    await writeFile(join(root, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'claude-second', version: '1.0.0' }))

    const loaded = await loadPluginPackage(root, 'pi-first@fixture-market')
    expect(loaded.manifest.name).toBe('pi-first')
  })

  // 验证四类非法 manifest 全部以 PLUGIN_SOURCE_INVALID 拒绝：
  // 目录缺失、JSON 语法错误、名称含空格等不合法标识、UI surface 引用了不存在的 MCP 服务器。
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

  // 验证技能路径安全：../ 越界、绝对路径、指向缺失目录均拒绝；
  // 即使路径合法，skills 目录内含指向包外目标的符号链接（linked → outside/escape）也拒绝，防符号链接逃逸。
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

  // 验证宽容性边界：技能目录中的杂项子目录（无 SKILL.md）被忽略而非报错，包仍可加载且技能列表正确。
  it('ignores directories without SKILL.md and keeps the package loadable', async () => {
    const root = await fixture()
    await writePlugin(root, { skills: [{ name: 'draw' }] })
    await mkdir(join(root, 'skills', 'not-a-skill'), { recursive: true })

    const loaded = await loadPluginPackage(root, 'demo-plugin@fixture-market')
    expect(loaded.capabilities.skills).toEqual(['demo-plugin@fixture-market:draw'])
  })
})
