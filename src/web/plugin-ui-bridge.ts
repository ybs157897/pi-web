import { createContext } from 'react'
import type {
  PluginContextEntry, PluginUiCallInput, PluginUiDescriptor, PluginUiPage, PluginUiReadResourceInput,
} from '../shared/plugin-ui.ts'
import { truncatePluginContext } from '../shared/plugin-ui.ts'
import { api } from './api.ts'

/** 转录区正在渲染的会话 id；内联插件页用它发起经过策略校验的调用。 */
export const PluginUiConversationContext = createContext<string | undefined>(undefined)

/** 每条「页面 → 宿主」消息的大小上限；超限的 JSON 载荷直接丢弃，不解析。 */
const MAX_BRIDGE_MESSAGE_BYTES = 256 * 1024

/** 转录区尝试读 UI 描述符的持久化 `details` 值的大小上限。 */
const MAX_DETAILS_BYTES = 1_000_000

/** 请求携带的 JSON-RPC id；通知没有 id，也不会得到响应。 */
export type PluginUiBridgeId = string | number

/** 一个文本内容块（ui/message、ui/update-model-context 的载荷单元）。 */
export interface PluginUiTextPart {
  type: 'text'
  text: string
}

/**
 * 白名单内的「页面 → 宿主」调用。只有这五个已文档化的方法会解析；其余方法
 * （以及任何格式错误或超限的帧）都被 `parseBridgeMessage` 拒绝。
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

/** 宿主对一个请求的回答；通知（无 id）不产生响应。 */
export type PluginUiBridgeResponse =
  | { jsonrpc: '2.0'; id: PluginUiBridgeId; result: unknown }
  | { jsonrpc: '2.0'; id: PluginUiBridgeId | null; error: { code: number; message: string } }

/** 宿主处理桥接调用的回调集合；inspector 与内联卡片各自提供自己的实现。 */
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

/** 必填的非空字符串；其他任何取值返回 undefined。 */
function requiredString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined
}

/** 可选字符串字段：缺席保持缺席；出现但类型不对则整个对象拒绝。 */
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

/** `params.content` 是文本块数组；缺席视为空列表，格式错误则拒绝。 */
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
 * 功能：校验一条 `message` 事件载荷。只有携带白名单方法的 JSON-RPC 2.0 对象能通过；
 * 未知方法、参数畸形、超过 256 KiB 的帧都返回 null，宿主绝不处理不完整载荷。
 * @param data postMessage 事件的 data
 * @returns 解析后的强类型消息；不合规返回 null
 * 内部逻辑：先验 jsonrpc/method/id/params 形状与字节预算，再按方法逐个校验必填参数（name/uri/url 必须是非空字符串，content 逐块校验）。
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

/** `ui/open-link` 只允许导航到 https 目的地。 */
function httpsLink(value: string): string | undefined {
  try {
    return new URL(value).protocol === 'https:' ? value : undefined
  } catch {
    return undefined
  }
}

/**
 * 功能：把一条解析后的页面调用执行到宿主 API 上，返回 JSON-RPC 应答。
 * @param message 已解析的桥接消息
 * @param page 页面身份（pluginId/serverName 由宿主侧确定）
 * @param handlers 三个宿主回调（onContext/onMessage/onOpenLink）
 * @returns 应答对象；通知（无 id）只执行副作用不返回应答；执行异常返回 -32603
 * 内部逻辑：页面绑定的 plugin/server 永远覆盖 params 里带的值，页面因此无法调用其他插件的 MCP 服务器；ui/open-link 仅放行 https（否则 -32602）；资源读取直接回传服务端已返回的 MCP ReadResourceResult。
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
        // 服务端返回的已经是 MCP `ReadResourceResult`（`{ contents: [...] }`）。
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
  // 沙箱没有同源访问权，origin 是不透明的，目标 origin 只能是 `*`。
  frame.contentWindow?.postMessage(payload, '*')
}

/**
 * 功能：iframe `load` 后的握手：向页面发送 `ui/initialize` 请求，页面就绪时以 `ui/initialized` 应答。
 * @param frame 插件页 iframe
 * @param page 页面身份（id 用于构造请求 id）
 */
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

/**
 * 功能：以 MCP Apps 的 `tool-result` 通知向已挂载页面投递它要渲染的工具结果。
 * @param frame 插件页 iframe
 * @param page 页面身份（content/structuredContent 来自工具结果的 details.ui）
 */
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
 * 功能：判断一个已落定的工具结果是否渲染内联页面（而非只提供侧栏表面）。
 * @param details 工具结果的 details
 * @param state 工具行状态（streaming/status/isError）
 * @returns 流式中、运行中、出错取消一律 false；descriptor 有效且非 fullscreen、未显式关内联时 true
 */
export function showsInlinePluginUi(details: unknown, state: { streaming?: boolean; status?: string; isError?: boolean } | undefined): boolean {
  if (state === undefined || state.streaming === true || state.status === 'running'
    || state.status === 'error' || state.status === 'cancelled' || state.isError === true) return false
  const ui = pluginUiDescriptor(details)
  return ui !== undefined && ui.preferredDisplayMode !== 'fullscreen' && ui.showInline !== false
}

/**
 * 功能：严格校验工具结果 `details.ui` 并解析成插件页描述符。任何字段类型错误或缺
 * `pluginId`/`serverName`/`resourceUri` 都整体拒绝——工具行回退到通用展示，而不是挂载一个坏页面。
 * @param details 对象或 JSON 字符串（超 1MB 不解析）
 * @returns 合法的 PluginUiDescriptor；不合法返回 undefined
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
