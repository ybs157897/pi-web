import { createContext } from 'react'
import type {
  PluginContextEntry, PluginUiCallInput, PluginUiDescriptor, PluginUiPage, PluginUiReadResourceInput,
} from '../shared/plugin-ui.ts'
import { truncatePluginContext } from '../shared/plugin-ui.ts'
import { api } from './api.ts'

/** The conversation a transcript is rendering; inline plugin pages use it for policy-checked calls. */
export const PluginUiConversationContext = createContext<string | undefined>(undefined)

/** Cap every page → host frame; a larger JSON payload is dropped, not parsed. */
const MAX_BRIDGE_MESSAGE_BYTES = 256 * 1024

/** Cap for a durable `details` value the transcript tries to read a UI descriptor from. */
const MAX_DETAILS_BYTES = 1_000_000

/** The JSON-RPC id a request carries; notifications have none and get no response. */
export type PluginUiBridgeId = string | number

export interface PluginUiTextPart {
  type: 'text'
  text: string
}

/**
 * One whitelisted page → host call. Only the five documented methods parse; every
 * other method (and every malformed or oversized frame) is rejected by `parseBridgeMessage`.
 */
export type PluginUiBridgeMessage =
  | { method: 'tools/call'; id?: PluginUiBridgeId; params: { name: string; arguments?: unknown } }
  | { method: 'resources/read'; id?: PluginUiBridgeId; params: { uri: string } }
  | {
      method: 'ui/update-model-context'
      id?: PluginUiBridgeId
      params: { content?: PluginUiTextPart[]; structuredContent?: unknown }
    }
  | { method: 'ui/message'; id?: PluginUiBridgeId; params: { content?: PluginUiTextPart[] } }
  | { method: 'ui/open-link'; id?: PluginUiBridgeId; params: { url: string } }

/** The host's answer to one request; notifications (no id) produce no response. */
export type PluginUiBridgeResponse =
  | { jsonrpc: '2.0'; id: PluginUiBridgeId; result: unknown }
  | { jsonrpc: '2.0'; id: PluginUiBridgeId | null; error: { code: number; message: string } }

/** What the host does with a bridged call; the inspector and inline card supply their own. */
export interface PluginUiBridgeHandlers {
  onContext: (entry: PluginContextEntry) => void
  onMessage: (text: string) => void
  onOpenLink: (url: string) => void
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseJsonRecord(value: string): Record<string, unknown> | undefined {
  if (value.length > MAX_DETAILS_BYTES) return undefined
  try {
    const parsed: unknown = JSON.parse(value)
    return isRecord(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

/** A required non-empty string, or undefined when the value is anything else. */
function requiredString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined
}

/** Optional string field: absent stays absent, a present non-string rejects the object. */
function optionalString(value: unknown): { ok: true; value?: string } | { ok: false } {
  if (value === undefined) return { ok: true }
  return typeof value === 'string' ? { ok: true, value } : { ok: false }
}

function jsonByteLength(value: unknown): number {
  const json = JSON.stringify(value)
  return typeof json === 'string' ? new TextEncoder().encode(json).byteLength : Number.POSITIVE_INFINITY
}

function readId(record: Record<string, unknown>): { ok: true; id?: PluginUiBridgeId } | { ok: false } {
  const value = record.id
  if (value === undefined) return { ok: true }
  if (typeof value === 'string' || typeof value === 'number') return { ok: true, id: value }
  return { ok: false }
}

/** `params.content` is an array of text parts; absent means an empty list, malformed rejects. */
function parseTextContent(value: unknown): PluginUiTextPart[] | undefined {
  if (value === undefined) return []
  if (!Array.isArray(value)) return undefined
  const parts: PluginUiTextPart[] = []
  for (const entry of value) {
    if (!isRecord(entry) || entry.type !== 'text' || typeof entry.text !== 'string') return undefined
    parts.push({ type: 'text', text: entry.text })
  }
  return parts
}

/**
 * Validate one `message` event payload. Only JSON-RPC 2.0 objects carrying one of the
 * whitelisted methods survive; unknown methods, malformed params and frames over
 * 256 KiB return null so the host never acts on a partial payload.
 */
export function parseBridgeMessage(data: unknown): PluginUiBridgeMessage | null {
  if (!isRecord(data) || data.jsonrpc !== '2.0' || typeof data.method !== 'string') return null
  let bytes: number
  try {
    bytes = jsonByteLength(data)
  } catch {
    return null
  }
  if (bytes > MAX_BRIDGE_MESSAGE_BYTES) return null
  const id = readId(data)
  if (!id.ok) return null
  const rawParams = data.params
  if (rawParams !== undefined && !isRecord(rawParams)) return null
  const params: Record<string, unknown> = rawParams === undefined ? {} : rawParams
  switch (data.method) {
    case 'tools/call': {
      const name = requiredString(params.name)
      if (name === undefined) return null
      return {
        method: 'tools/call',
        ...(id.id === undefined ? {} : { id: id.id }),
        params: {
          name,
          ...(params.arguments === undefined ? {} : { arguments: params.arguments }),
        },
      }
    }
    case 'resources/read': {
      const uri = requiredString(params.uri)
      if (uri === undefined) return null
      return { method: 'resources/read', ...(id.id === undefined ? {} : { id: id.id }), params: { uri } }
    }
    case 'ui/update-model-context': {
      const content = parseTextContent(params.content)
      if (content === undefined) return null
      return {
        method: 'ui/update-model-context',
        ...(id.id === undefined ? {} : { id: id.id }),
        params: {
          ...(params.content === undefined ? {} : { content }),
          ...(params.structuredContent === undefined ? {} : { structuredContent: params.structuredContent }),
        },
      }
    }
    case 'ui/message': {
      const content = parseTextContent(params.content)
      if (content === undefined) return null
      return {
        method: 'ui/message',
        ...(id.id === undefined ? {} : { id: id.id }),
        params: { content },
      }
    }
    case 'ui/open-link': {
      const url = requiredString(params.url)
      if (url === undefined) return null
      return { method: 'ui/open-link', ...(id.id === undefined ? {} : { id: id.id }), params: { url } }
    }
    default:
      return null
  }
}

function respond(message: PluginUiBridgeMessage, result: unknown): PluginUiBridgeResponse | null {
  return message.id === undefined ? null : { jsonrpc: '2.0', id: message.id, result }
}

function fail(message: PluginUiBridgeMessage, code: number, text: string): PluginUiBridgeResponse | null {
  return message.id === undefined ? null : { jsonrpc: '2.0', id: message.id, error: { code, message: text } }
}

/** `ui/open-link` may only navigate to an https destination. */
function httpsLink(value: string): string | undefined {
  try {
    return new URL(value).protocol === 'https:' ? value : undefined
  } catch {
    return undefined
  }
}

/**
 * Execute one parsed page call against the host API and return the JSON-RPC answer.
 * The page's plugin/server binding always wins over anything it puts in params, so a
 * page cannot call another plugin's MCP server. Notifications (no id) perform their
 * side effect but never produce a response.
 */
export async function handleBridgeMessage(
  message: PluginUiBridgeMessage,
  page: PluginUiPage,
  handlers: PluginUiBridgeHandlers,
): Promise<PluginUiBridgeResponse | null> {
  try {
    switch (message.method) {
      case 'tools/call': {
        const input: PluginUiCallInput = {
          pluginId: page.pluginId,
          serverName: page.serverName,
          tool: message.params.name,
          ...(page.conversationId === undefined ? {} : { conversationId: page.conversationId }),
          ...(message.params.arguments === undefined ? {} : { arguments: message.params.arguments }),
        }
        const { result } = await api.pluginUiCall(input)
        return respond(message, result)
      }
      case 'resources/read': {
        const input: PluginUiReadResourceInput = {
          pluginId: page.pluginId,
          serverName: page.serverName,
          uri: message.params.uri,
        }
        const { resource } = await api.pluginUiReadResource(input)
        // The server already returns the MCP `ReadResourceResult` (`{ contents: [...] }`).
        return respond(message, resource)
      }
      case 'ui/update-model-context': {
        const text = truncatePluginContext((message.params.content ?? []).map(part => part.text).join('\n'))
        handlers.onContext({
          pluginId: page.pluginId,
          ...(page.toolCallId === undefined ? {} : { toolCallId: page.toolCallId }),
          text,
          ...(message.params.structuredContent === undefined ? {} : { structuredContent: message.params.structuredContent }),
        })
        return respond(message, {})
      }
      case 'ui/message': {
        handlers.onMessage((message.params.content ?? []).map(part => part.text).join('\n'))
        return respond(message, {})
      }
      case 'ui/open-link': {
        const url = httpsLink(message.params.url)
        if (url === undefined) return fail(message, -32602, 'Only https links can be opened')
        handlers.onOpenLink(url)
        return respond(message, {})
      }
    }
  } catch (error) {
    return fail(message, -32603, error instanceof Error ? error.message : String(error))
  }
}

function postToFrame(frame: HTMLIFrameElement, payload: unknown): void {
  // The sandbox has no same-origin access, so its origin is opaque and the target must be `*`.
  frame.contentWindow?.postMessage(payload, '*')
}

/** Handshake after `load`: the page answers `ui/initialized` when it is ready. */
export function sendInitialize(frame: HTMLIFrameElement, page: PluginUiPage): void {
  postToFrame(frame, {
    jsonrpc: '2.0',
    id: `pi-ui-initialize:${page.id}`,
    method: 'ui/initialize',
    params: {
      appInfo: { name: 'pi-web', version: '0.1.0' },
      appCapabilities: {},
    },
  })
}

/** Deliver the tool result a mounted page renders, as an MCP Apps `tool-result` notification. */
export function sendToolResult(frame: HTMLIFrameElement, page: PluginUiPage): void {
  postToFrame(frame, {
    jsonrpc: '2.0',
    method: 'ui/notifications/tool-result',
    params: {
      content: page.content === undefined ? [] : page.content,
      ...(page.structuredContent === undefined ? {} : { structuredContent: page.structuredContent }),
    },
  })
}

/**
 * Strictly validate a tool result's `details.ui` into a descriptor. A wrong field type or a
 * missing `pluginId`/`serverName`/`resourceUri` rejects the whole descriptor, so the row falls
 * back to its generic presentation instead of mounting a broken page.
 */
export function pluginUiDescriptor(details: unknown): PluginUiDescriptor | undefined {
  const record = isRecord(details) ? details : typeof details === 'string' ? parseJsonRecord(details) : undefined
  if (record === undefined || !isRecord(record.ui)) return undefined
  const ui = record.ui
  const pluginId = requiredString(ui.pluginId)
  const serverName = requiredString(ui.serverName)
  const resourceUri = requiredString(ui.resourceUri)
  if (pluginId === undefined || serverName === undefined || resourceUri === undefined) return undefined
  const title = optionalString(ui.title)
  if (!title.ok) return undefined
  const toolCallId = optionalString(ui.toolCallId)
  if (!toolCallId.ok) return undefined
  if (ui.heightHint !== undefined && (typeof ui.heightHint !== 'number' || !Number.isFinite(ui.heightHint) || ui.heightHint <= 0)) return undefined
  if (ui.preferredDisplayMode !== undefined && ui.preferredDisplayMode !== 'inline' && ui.preferredDisplayMode !== 'fullscreen') return undefined
  if (ui.showInline !== undefined && typeof ui.showInline !== 'boolean') return undefined
  return {
    pluginId,
    serverName,
    resourceUri,
    ...(title.value === undefined ? {} : { title: title.value }),
    ...(toolCallId.value === undefined ? {} : { toolCallId: toolCallId.value }),
    ...(ui.heightHint === undefined ? {} : { heightHint: ui.heightHint as number }),
    ...(ui.preferredDisplayMode === undefined ? {} : { preferredDisplayMode: ui.preferredDisplayMode as PluginUiDescriptor['preferredDisplayMode'] }),
    ...(ui.showInline === undefined ? {} : { showInline: ui.showInline }),
  }
}
