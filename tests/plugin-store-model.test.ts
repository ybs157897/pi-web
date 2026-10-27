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

describe('plugin store view model', () => {
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
