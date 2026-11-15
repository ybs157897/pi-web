import type { PluginOperationView, PluginStoreItem } from '../shared/plugins.ts'

/** 插件市场页签过滤档位。 */
export type PluginFilter = 'all' | 'installed' | 'available'

/**
 * 功能：设置页插件市场的过滤与搜索（纯函数，便于直接测试）。
 * @param plugins 市场目录条目
 * @param filter 档位：installed 只留已安装，available 只留未安装且可安装的
 * @param query 搜索词（大小写不敏感，匹配名称/描述/市场/分类/技能）
 * @returns 过滤后的条目数组
 */
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

/**
 * 功能：取插件展示名。
 * @returns displayName 去空白后的值，空则回落插件 id 名。
 */
export function displayName(plugin: PluginStoreItem): string {
  return plugin.displayName?.trim() || plugin.name
}

/**
 * 功能：推导插件的四态展示状态。
 * @returns installed 已安装；unsupported 来源类型不支持；available 可安装；unavailable 不可用
 */
export function pluginState(plugin: PluginStoreItem): 'installed' | 'available' | 'unsupported' | 'unavailable' {
  if (plugin.installed) return 'installed'
  if (plugin.sourceType === 'unsupported') return 'unsupported'
  return plugin.available ? 'available' : 'unavailable'
}

/**
 * 功能：判断已安装插件是否有更新——目录里的版本号已与本地安装版本不同。
 * @returns 有更新返回 true（来源不支持的插件不算）
 */
export function updateAvailable(plugin: PluginStoreItem): boolean {
  return plugin.installed && plugin.available && plugin.sourceType !== 'unsupported' &&
    plugin.version !== (plugin.installedVersion ?? plugin.version)
}

/**
 * 功能：生成卡片上能力标签的人工可读文案（技能/MCP/界面计数与不支持项）。
 * @returns 标签字符串数组，空能力不产生标签
 */
export function capabilityTags(plugin: PluginStoreItem): string[] {
  const tags: string[] = []
  if (plugin.capabilities.skills.length > 0) tags.push(`技能 ${plugin.capabilities.skills.length}`)
  if (plugin.capabilities.mcpServers.length > 0) tags.push(`MCP ${plugin.capabilities.mcpServers.length}`)
  if (plugin.capabilities.uiSurfaces.length > 0) tags.push(`界面 ${plugin.capabilities.uiSurfaces.length}`)
  for (const capability of plugin.capabilities.unsupported) tags.push(`不支持 ${capability}`)
  return tags
}

/**
 * 功能：取某插件最近一次的操作记录（按 startedAt 比较）。
 * @returns 最新操作；无则 undefined
 */
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

/**
 * 功能：取插件最近一次「进行中」的安装/卸载操作，用于卡片上的进行态展示。
 * @returns 最近的 running 操作；最近操作不是 running 时 undefined
 */
export function runningOperation(
  plugin: PluginStoreItem,
  operations: readonly PluginOperationView[],
): PluginOperationView | undefined {
  const latest = latestOperation(plugin, operations)
  return latest?.status === 'running' ? latest : undefined
}

/**
 * 功能：取插件最近一次「失败」的操作，用于卡片上的错误提示。
 * @returns 最近的 failed 操作；最近操作不是 failed 时 undefined
 */
export function failedOperation(
  plugin: PluginStoreItem,
  operations: readonly PluginOperationView[],
): PluginOperationView | undefined {
  const latest = latestOperation(plugin, operations)
  return latest?.status === 'failed' ? latest : undefined
}

/**
 * 功能：生成插件图标占位的首字母，在用户选定图标来源前不暴露远程图片。
 * @returns 展示名首字符大写；名字为空回落 'P'
 */
export function pluginInitial(plugin: PluginStoreItem): string {
  return (displayName(plugin).trim()[0] ?? 'P').toUpperCase()
}
