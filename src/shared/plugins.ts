/** One plugin entry as the settings plugin market renders it. */
export interface PluginStoreItem {
  /** `name@marketplace`. */
  id: string
  name: string
  marketplace: string
  version: string
  description?: string
  displayName?: string
  category?: string
  icon?: string
  homepage?: string
  featured: boolean
  /** Present in the marketplace catalog (false for an installed plugin whose source was removed). */
  available: boolean
  installed: boolean
  enabled: boolean
  installedVersion?: string
  installedAt?: number
  updatedAt?: number
  /** How P0 materializes the package; unsupported entries can be listed but not installed. */
  sourceType: 'directory' | 'zip' | 'github' | 'git' | 'unsupported'
  capabilities: PluginCapabilities
  dependencies: string[]
}

export interface PluginCapabilities {
  /** Source-qualified skill ids (`<pluginId>:<skillName>`). */
  skills: string[]
  /** Namespaced MCP server names (`plugin_<name>_<server>`). */
  mcpServers: string[]
  uiSurfaces: string[]
  /** Manifest capability groups pi-web does not run (commands, hooks, ...). */
  unsupported: string[]
}

/** One MCP server declaration shown before an install or update is confirmed. */
export interface PluginMcpServerDescription {
  /** Manifest key (`mcpServers.<name>`). */
  name: string
  /** Namespaced runtime name (`plugin_<plugin>_<server>`). */
  serverName: string
  command: string
  args: string[]
  /** Environment variable names only; values never leave the server. */
  envKeys: string[]
  exposure: 'direct' | 'codemode' | 'deferred' | 'hidden'
}

/** Everything the install confirmation needs, without downloading more than the package itself. */
export interface PluginDescription {
  id: string
  name: string
  marketplace: string
  version: string
  description?: string
  author?: string
  homepage?: string
  sourceType: 'directory' | 'zip' | 'github' | 'git' | 'unsupported'
  /** The plugin's declared skills (`<pluginId>:<skillName>`). */
  skills: string[]
  mcpServers: PluginMcpServerDescription[]
  uiSurfaces: Array<{ id: string; title: string; server: string; resourceUri: string }>
  unsupported: string[]
  dependencies: string[]
  installed: boolean
}

export interface PluginMarketplaceSummary {
  id: string
  name: string
  source: string
  kind: 'directory' | 'url'
  pluginCount: number
  featured: string[]
  lastUpdated: number
  lastError?: string
}

export interface PluginDiagnostic {
  code: string
  message: string
  pluginId?: string
  marketplace?: string
  path?: string
}

export interface PluginOperationView {
  id: string
  pluginId: string
  status: 'running' | 'completed' | 'failed'
  error?: string
  startedAt: number
  finishedAt?: number
}

export interface PluginOverview {
  marketplaces: PluginMarketplaceSummary[]
  plugins: PluginStoreItem[]
  operations: PluginOperationView[]
  diagnostics: PluginDiagnostic[]
}

export interface AddPluginMarketplaceInput {
  /** Absolute local directory containing marketplace.json, or an HTTPS URL to marketplace.json. */
  source: string
}

export interface InstallPluginInput {
  marketplace: string
  name: string
  requestId?: string
}

export interface UpdatePluginInput {
  pluginId: string
}
