/**
 * 插件商店视图模型（plugin-store-model）纯函数测试。
 *
 * 覆盖：按安装状态筛选 + 关键词搜索（匹配显示名/描述等字段）、显示名与首字母派生、
 * 插件状态机（available/installed/unsupported）、版本更新判断、能力标签生成，
 * 以及运行中/最近失败操作的查找。全部为无副作用函数，直接对返回值断言。
 */
import { describe, expect, it } from 'vitest'
import type { PluginStoreItem } from '../src/shared/plugins.ts'
import {
  capabilityTags,
  displayName,
  failedOperation,
  filterPlugins,
  pluginInitial,
  pluginState,
  runningOperation,
  updateAvailable,
} from '../src/web/plugin-store-model.ts'

/**
 * 构造 PluginStoreItem fixture，默认为一个未安装的 directory 来源插件"demo@market"。
 * @param overrides 需要覆盖的字段，浅合并到默认值之上
 * @returns 可直接传给被测函数的商店条目
 */
function item(overrides: Partial<PluginStoreItem> = {}): PluginStoreItem {
  return {
    id: 'demo@market',
    name: 'demo',
    marketplace: 'market',
    version: '1.0.0',
    featured: false,
    available: true,
    installed: false,
    enabled: false,
    sourceType: 'directory',
    capabilities: { skills: [], mcpServers: [], uiSurfaces: [], unsupported: [] },
    dependencies: [],
    ...overrides,
  }
}

/** 商店视图模型的派生逻辑测试。 */
describe('plugin store view model', () => {
  // 验证筛选器三种档位（all/available/installed）的结果划分，以及关键词同时命中
  // displayName（"studio" → Beta Studio）和 description（"diagrams"）字段；无命中返回空数组。
  it('filters by installation state and searches display/description fields', () => {
    const available = item({ id: 'a@market', name: 'alpha', description: 'Draw diagrams' })
    const installed = item({ id: 'b@market', name: 'beta', installed: true, enabled: true, displayName: 'Beta Studio' })
    const unavailable = item({ id: 'c@market', name: 'gamma', available: false, installed: true, enabled: false })

    expect(filterPlugins([available, installed, unavailable], 'all', '').map(plugin => plugin.id)).toEqual(['a@market', 'b@market', 'c@market'])
    expect(filterPlugins([available, installed, unavailable], 'available', '').map(plugin => plugin.id)).toEqual(['a@market'])
    expect(filterPlugins([available, installed, unavailable], 'installed', '').map(plugin => plugin.id)).toEqual(['b@market', 'c@market'])
    expect(filterPlugins([available, installed], 'all', 'studio').map(plugin => plugin.id)).toEqual(['b@market'])
    expect(filterPlugins([available, installed], 'all', 'diagrams').map(plugin => plugin.id)).toEqual(['a@market'])
    expect(filterPlugins([available, installed], 'all', 'nothing')).toEqual([])
  })

  // 验证派生展示信息：displayName 优先级、首字母取显示名首字符大写、状态判定
  // （未安装→available；已安装→installed；unsupported 来源→unsupported；不可用但已安装仍算 installed）、
  // updateAvailable 仅在远程版本高于已装版本且来源受支持时为 true、能力标签的中文化计数（技能/MCP/界面/不支持项）。
  it('derives display names, initials, states, and capability tags', () => {
    expect(displayName(item({ name: 'demo', displayName: 'Demo Studio' }))).toBe('Demo Studio')
    expect(displayName(item())).toBe('demo')
    expect(pluginInitial(item({ displayName: 'excalidraw' }))).toBe('E')
    expect(pluginState(item())).toBe('available')
    expect(pluginState(item({ installed: true }))).toBe('installed')
    expect(pluginState(item({ sourceType: 'github' }))).toBe('available')
    expect(pluginState(item({ sourceType: 'unsupported' }))).toBe('unsupported')
    expect(updateAvailable(item({ installed: true, version: '2.0.0', installedVersion: '1.0.0' }))).toBe(true)
    expect(updateAvailable(item({ installed: true, version: '1.0.0', installedVersion: '1.0.0' }))).toBe(false)
    expect(updateAvailable(item({ installed: true, version: '2.0.0', installedVersion: '1.0.0', sourceType: 'unsupported' }))).toBe(false)
    expect(pluginState(item({ available: false, installed: true }))).toBe('installed')
    expect(capabilityTags(item({
      capabilities: { skills: ['a'], mcpServers: ['b'], uiSurfaces: ['c'], unsupported: ['hooks'] },
    }))).toEqual(['技能 1', 'MCP 1', '界面 1', '不支持 hooks'])
  })

  // 验证操作查找：runningOperation 只返回该插件的 running 操作、failedOperation 只返回最近的失败操作；
  // 全部成功时 failedOperation 为 undefined；插件 id 不匹配时不返回任何操作。
  it('finds a running operation and only the newest failed operation', () => {
    const operations = [
      { id: '1', pluginId: 'demo@market', status: 'failed' as const, error: 'bad', startedAt: 1, finishedAt: 2 },
      { id: '2', pluginId: 'demo@market', status: 'running' as const, startedAt: 3 },
    ]
    expect(runningOperation(item(), operations)?.id).toBe('2')
    expect(failedOperation(item(), operations)).toBeUndefined()
    const failedOnly = [{ id: '3', pluginId: 'demo@market', status: 'failed' as const, error: 'bad', startedAt: 4, finishedAt: 5 }]
    expect(failedOperation(item(), failedOnly)?.id).toBe('3')
    expect(runningOperation(item({ id: 'other@market' }), operations)).toBeUndefined()
  })
})
