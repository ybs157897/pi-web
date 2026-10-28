/** One enabled plugin UI surface the host can open. */
export interface PluginUiSurfaceView {
  /** `${pluginId}:${surfaceId}`. */
  id: string
  pluginId: string
  pluginName: string
  title: string
  /** Namespaced MCP server name (`plugin_<name>_<server>`). */
  serverName: string
  resourceUri: string
}

/** The validated `details.ui` a tool result carries for the transcript. */
export interface PluginUiDescriptor {
  pluginId: string
  serverName: string
  resourceUri: string
  title?: string
  heightHint?: number
  preferredDisplayMode?: 'inline' | 'fullscreen'
  showInline?: boolean
  toolCallId?: string
}

/** One mounted plugin page; the right inspector keeps every page alive while switching tabs. */
export interface PluginUiPage extends PluginUiDescriptor {
  id: string
  /** Page bridge calls carry this so the server re-applies readOnly/Plan policy. */
  conversationId?: string
  content?: unknown
  structuredContent?: unknown
}

/** One composer chip produced by `ui/update-model-context`. */
export interface PluginContextEntry {
  pluginId: string
  toolCallId?: string
  text: string
  structuredContent?: unknown
}

export interface PluginUiPageRequest {
  pluginId: string
  serverName: string
  uri: string
}

export interface PluginUiCallInput {
  conversationId?: string
  pluginId: string
  serverName: string
  tool: string
  arguments?: unknown
}

export interface PluginUiReadResourceInput {
  pluginId: string
  serverName: string
  uri: string
}

const MAX_RESOURCE_URI_LENGTH = 2_048
const MAX_UI_TITLE_LENGTH = 200
const MAX_UI_TOOL_CALL_ID_LENGTH = 200
const MAX_UI_HEIGHT_HINT = 4_000

function recordOf(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function boundedString(value: unknown, maxLength: number): string | undefined {
  return typeof value === 'string' && value.length > 0 && value.length <= maxLength ? value : undefined
}

function uiRecord(meta: Record<string, unknown>): Record<string, unknown> | undefined {
  const nested = recordOf(meta.ui)
  if (nested !== undefined) return nested
  // `_meta["ui/resourceUri"]` is the flattened MCP Apps spelling some servers still emit.
  const flat = boundedString(meta['ui/resourceUri'], MAX_RESOURCE_URI_LENGTH)
  return flat === undefined ? undefined : { resourceUri: flat }
}

/**
 * Validate the `_meta` of one MCP `tools/call` result into the descriptor the transcript reads.
 * Only the documented fields survive: every other `_meta` key stays out of the browser.
 */
export function pluginUiDescriptorFromMeta(
  meta: unknown,
  identity: { pluginId: string | undefined; serverName: string },
): PluginUiDescriptor | undefined {
  if (identity.pluginId === undefined) return undefined
  const container = recordOf(meta)
  if (container === undefined) return undefined
  const ui = uiRecord(container)
  if (ui === undefined) return undefined

  const resourceUri = boundedString(ui.resourceUri, MAX_RESOURCE_URI_LENGTH)
  if (resourceUri === undefined) return undefined
  const title = boundedString(ui.title, MAX_UI_TITLE_LENGTH)
  const heightHint = typeof ui.heightHint === 'number' && Number.isFinite(ui.heightHint) && ui.heightHint > 0
    ? Math.min(Math.round(ui.heightHint), MAX_UI_HEIGHT_HINT)
    : undefined
  const preferredDisplayMode = ui.preferredDisplayMode === 'inline' || ui.preferredDisplayMode === 'fullscreen'
    ? ui.preferredDisplayMode
    : undefined
  const showInline = typeof ui.showInline === 'boolean' ? ui.showInline : undefined
  const toolCallId = boundedString(ui.toolCallId, MAX_UI_TOOL_CALL_ID_LENGTH)

  return {
    pluginId: identity.pluginId,
    serverName: identity.serverName,
    resourceUri,
    ...(title === undefined ? {} : { title }),
    ...(heightHint === undefined ? {} : { heightHint }),
    ...(preferredDisplayMode === undefined ? {} : { preferredDisplayMode }),
    ...(showInline === undefined ? {} : { showInline }),
    ...(toolCallId === undefined ? {} : { toolCallId }),
  }
}

/** The `# Plugin context:` block appended to a submitted message. */
export function pluginContextBlock(entries: readonly PluginContextEntry[]): string {
  if (entries.length === 0) return ''
  const sections = entries.map((entry) => {
    const header = `## Plugin ${entry.pluginId}${entry.toolCallId === undefined ? '' : ` (${entry.toolCallId})`}`
    const structured = entry.structuredContent === undefined
      ? ''
      : `\n\n\`\`\`json\n${JSON.stringify(entry.structuredContent, null, 2)}\n\`\`\``
    return `${header}\n\n${entry.text}${structured}`
  })
  return `# Plugin context:\n\n${sections.join('\n\n')}`
}

/** Keep one page's context under ZCode's 16 KiB single-entry limit. */
export function truncatePluginContext(text: string, maxBytes = 16 * 1024): string {
  const bytes = new TextEncoder().encode(text)
  if (bytes.byteLength <= maxBytes) return text
  return new TextDecoder().decode(bytes.slice(0, maxBytes)).replace(/\uFFFD$/u, '')
}
