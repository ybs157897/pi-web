import type { PluginOperationView, PluginStoreItem } from '../shared/plugins.ts'

export type PluginFilter = 'all' | 'installed' | 'available'

/** The settings market's filter and search, kept pure for direct tests. */
export function filterPlugins(
  plugins: readonly PluginStoreItem[],
  filter: PluginFilter,
  query: string,
): PluginStoreItem[] {
  const needle = query.trim().toLowerCase()
  return plugins.filter((plugin) => {
    if (filter === 'installed' && !plugin.installed) return false
    if (filter === 'available' && (plugin.installed || !plugin.available)) return false
    if (needle === '') return true
    const haystack = [plugin.name, plugin.displayName, plugin.description, plugin.marketplace, plugin.category, ...plugin.capabilities.skills]
      .filter((value): value is string => typeof value === 'string')
      .join('\n')
      .toLowerCase()
    return haystack.includes(needle)
  })
}

export function displayName(plugin: PluginStoreItem): string {
  return plugin.displayName?.trim() || plugin.name
}

export function pluginState(plugin: PluginStoreItem): 'installed' | 'available' | 'unsupported' | 'unavailable' {
  if (plugin.installed) return 'installed'
  if (plugin.sourceType === 'unsupported') return 'unsupported'
  return plugin.available ? 'available' : 'unavailable'
}

/** An installed plugin whose catalog entry moved to a different version. */
export function updateAvailable(plugin: PluginStoreItem): boolean {
  return plugin.installed && plugin.available && plugin.sourceType !== 'unsupported' &&
    plugin.version !== (plugin.installedVersion ?? plugin.version)
}

/** Human labels for the capability tags rendered on each card. */
export function capabilityTags(plugin: PluginStoreItem): string[] {
  const tags: string[] = []
  if (plugin.capabilities.skills.length > 0) tags.push(`技能 ${plugin.capabilities.skills.length}`)
  if (plugin.capabilities.mcpServers.length > 0) tags.push(`MCP ${plugin.capabilities.mcpServers.length}`)
  if (plugin.capabilities.uiSurfaces.length > 0) tags.push(`界面 ${plugin.capabilities.uiSurfaces.length}`)
  for (const capability of plugin.capabilities.unsupported) tags.push(`不支持 ${capability}`)
  return tags
}

function latestOperation(
  plugin: PluginStoreItem,
  operations: readonly PluginOperationView[],
): PluginOperationView | undefined {
  let latest: PluginOperationView | undefined
  for (const operation of operations) {
    if (operation.pluginId !== plugin.id) continue
    if (latest === undefined || operation.startedAt > latest.startedAt) latest = operation
  }
  return latest
}

export function runningOperation(
  plugin: PluginStoreItem,
  operations: readonly PluginOperationView[],
): PluginOperationView | undefined {
  const latest = latestOperation(plugin, operations)
  return latest?.status === 'running' ? latest : undefined
}

export function failedOperation(
  plugin: PluginStoreItem,
  operations: readonly PluginOperationView[],
): PluginOperationView | undefined {
  const latest = latestOperation(plugin, operations)
  return latest?.status === 'failed' ? latest : undefined
}

/** One icon letter without exposing a remote image until the user has chosen a source. */
export function pluginInitial(plugin: PluginStoreItem): string {
  return (displayName(plugin).trim()[0] ?? 'P').toUpperCase()
}
