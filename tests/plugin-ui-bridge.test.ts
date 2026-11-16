/**
 * 插件 UI 桥（plugin-ui-bridge）测试：iframe 内插件页面与宿主之间的消息通道。
 *
 * 关键契约：
 * - parseBridgeMessage 只接受白名单内的 5 个 JSON-RPC 2.0 方法，校验 params 形状，
 *   非 JSON-RPC / 未知方法 / 参数畸形 / 超过 256 KiB 的帧一律丢弃（返回 null）；
 * - handleBridgeMessage 把 tools/call、resources/read 经宿主 API 转发到页面绑定的服务器并回包；
 *   ui/update-model-context 生成上限 16 KiB 的上下文条目（保留结构化内容）；
 *   ui/message 拼接文本回调；ui/open-link 仅放行 https；无 id 的通知执行副作用但不回包；
 *   上游 API 失败转为保留请求 id 的 JSON-RPC 错误；
 * - pluginUiDescriptor 从工具结果 details 提取并校验 UI 页面描述（必填字段 + 可选字段类型）。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Mock } from 'vitest'
import type { PluginContextEntry, PluginUiPage } from '../src/shared/plugin-ui.ts'
import {
  handleBridgeMessage, parseBridgeMessage, pluginUiDescriptor,
  type PluginUiBridgeHandlers,
} from '../src/web/plugin-ui-bridge.ts'

/** fetch 的 mock 类型别名。 */
type FetchMock = Mock<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>

/** 桥测试共用的插件 UI 页面描述（excalidraw 画布，绑定到 call-1）。 */
const page: PluginUiPage = {
  id: 'conversation-1:excalidraw@market:call-1',
  pluginId: 'excalidraw@market',
  serverName: 'plugin_excalidraw_canvas',
  resourceUri: 'ui://canvas',
  title: 'Excalidraw',
  toolCallId: 'call-1',
}

/**
 * 构造桥回调句柄集合，三个回调均为 vi.fn 便于断言。
 * @param overrides 覆盖个别回调
 * @returns 完整的 PluginUiBridgeHandlers
 */
function handlers(overrides: Partial<PluginUiBridgeHandlers> = {}): PluginUiBridgeHandlers {
  return {
    onContext: vi.fn(),
    onMessage: vi.fn(),
    onOpenLink: vi.fn(),
    ...overrides,
  }
}

/**
 * 用固定 JSON 响应 stub 全局 fetch。
 * @param payload 响应 JSON 体
 * @param status HTTP 状态码，默认 200
 * @returns fetch mock，供断言调用参数
 */
function stubFetch(payload: unknown, status = 200): FetchMock {
  const fetchMock: FetchMock = vi.fn(async () => new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  }))
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

/**
 * 解析 fetch 第 call 次调用的请求体 JSON。
 * @param fetchMock fetch mock
 * @param call 调用序号（默认第 0 次）
 * @returns 解析后的请求体对象
 */
function bodyOf(fetchMock: FetchMock, call = 0): Record<string, unknown> {
  const init = fetchMock.mock.calls[call]?.[1]
  return JSON.parse(String(init?.body)) as Record<string, unknown>
}

/**
 * 取 fetch 第 call 次调用的目标 URL。
 * @param fetchMock fetch mock
 * @param call 调用序号（默认第 0 次）
 * @returns URL 字符串
 */
function urlOf(fetchMock: FetchMock, call = 0): string {
  return String(fetchMock.mock.calls[call]?.[0])
}

/** 清除全局 fetch stub 与 mock。 */
afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

/** 桥消息解析（parseBridgeMessage）的输入校验测试。 */
describe('parseBridgeMessage', () => {
  // 验证白名单 5 方法全部通过解析：tools/call、resources/read（带 id 的请求），
  // ui/update-model-context（可无 id）、ui/message、ui/open-link；返回归一化的 method/id/params。
  it('accepts the five whitelisted JSON-RPC 2.0 requests', () => {
    expect(parseBridgeMessage({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'draw', arguments: { shape: 'rect' } } }))
      .toEqual({ method: 'tools/call', id: 1, params: { name: 'draw', arguments: { shape: 'rect' } } })
    expect(parseBridgeMessage({ jsonrpc: '2.0', id: 'a', method: 'resources/read', params: { uri: 'ui://canvas' } }))
      .toEqual({ method: 'resources/read', id: 'a', params: { uri: 'ui://canvas' } })
    expect(parseBridgeMessage({ jsonrpc: '2.0', method: 'ui/update-model-context', params: { content: [{ type: 'text', text: 'hello' }] } }))
      .toEqual({ method: 'ui/update-model-context', params: { content: [{ type: 'text', text: 'hello' }] } })
    expect(parseBridgeMessage({ jsonrpc: '2.0', id: 2, method: 'ui/message', params: { role: 'user', content: [{ type: 'text', text: 'hi' }] } }))
      .toEqual({ method: 'ui/message', id: 2, params: { content: [{ type: 'text', text: 'hi' }] } })
    expect(parseBridgeMessage({ jsonrpc: '2.0', id: 3, method: 'ui/open-link', params: { url: 'https://example.com' } }))
      .toEqual({ method: 'ui/open-link', id: 3, params: { url: 'https://example.com' } })
  })

  // 验证拒绝清单：非对象载荷、jsonrpc 版本不对、未知方法（fs/read）、缺 name/name 非字符串、
  // resources/read 缺 uri、ui/message 含非文本块、update-model-context 的 content 非数组、
  // id 为嵌套对象、open-link 缺 url——全部返回 null。
  it('rejects non JSON-RPC payloads, unknown methods and malformed params', () => {
    expect(parseBridgeMessage(null)).toBeNull()
    expect(parseBridgeMessage('tools/call')).toBeNull()
    expect(parseBridgeMessage([])).toBeNull()
    expect(parseBridgeMessage({})).toBeNull()
    expect(parseBridgeMessage({ jsonrpc: '1.0', id: 1, method: 'tools/call', params: { name: 'draw' } })).toBeNull()
    expect(parseBridgeMessage({ jsonrpc: '2.0', id: 1, method: 'fs/read', params: {} })).toBeNull()
    expect(parseBridgeMessage({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: {} })).toBeNull()
    expect(parseBridgeMessage({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 7 } })).toBeNull()
    expect(parseBridgeMessage({ jsonrpc: '2.0', id: 1, method: 'resources/read', params: {} })).toBeNull()
    expect(parseBridgeMessage({ jsonrpc: '2.0', id: 1, method: 'ui/message', params: { content: [{ type: 'image', text: 'x' }] } })).toBeNull()
    expect(parseBridgeMessage({ jsonrpc: '2.0', id: 1, method: 'ui/update-model-context', params: { content: 'text' } })).toBeNull()
    expect(parseBridgeMessage({ jsonrpc: '2.0', id: { nested: true }, method: 'tools/call', params: { name: 'draw' } })).toBeNull()
    expect(parseBridgeMessage({ jsonrpc: '2.0', id: 1, method: 'ui/open-link', params: {} })).toBeNull()
  })

  // 验证帧大小防线：单帧 JSON 超过 256 KiB（300 KB 文本）直接丢弃，防插件页面撑爆宿主内存。
  it('drops a frame whose JSON exceeds 256 KiB', () => {
    const oversized = {
      jsonrpc: '2.0',
      id: 1,
      method: 'ui/update-model-context',
      params: { content: [{ type: 'text', text: 'x'.repeat(300 * 1024) }] },
    }
    expect(parseBridgeMessage(oversized)).toBeNull()
  })
})

/** 桥消息处理（handleBridgeMessage）的路由、副作用与错误转换测试。 */
describe('handleBridgeMessage', () => {
  // 验证 tools/call 路由：POST /api/plugins/ui/call，请求体带页面绑定的 pluginId/serverName
  // + 工具名与参数；上游 result 原样包成 JSON-RPC 响应（保留请求 id）。
  it('routes tools/call through the page-bound server and returns its result', async () => {
    const fetchMock = stubFetch({ result: { content: [{ type: 'text', text: 'drawn' }] } })
    const response = await handleBridgeMessage(
      { method: 'tools/call', id: 7, params: { name: 'draw', arguments: { shape: 'rect' } } },
      page,
      handlers(),
    )
    expect(urlOf(fetchMock)).toBe('/api/plugins/ui/call')
    expect(bodyOf(fetchMock)).toEqual({
      pluginId: 'excalidraw@market',
      serverName: 'plugin_excalidraw_canvas',
      tool: 'draw',
      arguments: { shape: 'rect' },
    })
    expect(response).toEqual({ jsonrpc: '2.0', id: 7, result: { content: [{ type: 'text', text: 'drawn' }] } })
  })

  // 验证 resources/read 路由：POST /api/plugins/ui/read-resource，携带 pluginId/serverName/uri；
  // 上游 resource 对象原样回给插件页面。
  it('routes resources/read to the page-bound server and returns the read result', async () => {
    const resource = { contents: [{ uri: 'ui://canvas', mimeType: 'text/html', text: '<html></html>' }] }
    const fetchMock = stubFetch({ resource })
    const response = await handleBridgeMessage(
      { method: 'resources/read', id: 8, params: { uri: 'ui://canvas/state' } },
      page,
      handlers(),
    )
    expect(urlOf(fetchMock)).toBe('/api/plugins/ui/read-resource')
    expect(bodyOf(fetchMock)).toEqual({
      pluginId: 'excalidraw@market',
      serverName: 'plugin_excalidraw_canvas',
      uri: 'ui://canvas/state',
    })
    expect(response).toEqual({ jsonrpc: '2.0', id: 8, result: resource })
  })

  // 验证 ui/update-model-context：触发一次 onContext，条目带 pluginId/toolCallId、
  // structuredContent 原样保留；文本按字节截断到不超过 16 KiB（20 KB 输入被裁剪）。
  it('builds a context entry capped at 16 KiB and keeps structured content', async () => {
    const onContext = vi.fn<(entry: PluginContextEntry) => void>()
    const text = 'x'.repeat(20 * 1024)
    const response = await handleBridgeMessage(
      {
        method: 'ui/update-model-context',
        id: 9,
        params: {
          content: [{ type: 'text', text }, { type: 'text', text: ' tail' }],
          structuredContent: { selection: ['a'] },
        },
      },
      page,
      handlers({ onContext }),
    )
    expect(response).toEqual({ jsonrpc: '2.0', id: 9, result: {} })
    expect(onContext).toHaveBeenCalledTimes(1)
    const entry = onContext.mock.calls[0]![0]
    expect(entry.pluginId).toBe('excalidraw@market')
    expect(entry.toolCallId).toBe('call-1')
    expect(entry.structuredContent).toEqual({ selection: ['a'] })
    expect(new TextEncoder().encode(entry.text).byteLength).toBeLessThanOrEqual(16 * 1024)
    expect(entry.text.startsWith('x')).toBe(true)
  })

  // 验证 ui/message：多个文本块拼成一条消息（换行连接）传给 onMessage，请求回空 result。
  it('forwards ui/message text and answers a request', async () => {
    const onMessage = vi.fn()
    const response = await handleBridgeMessage(
      { method: 'ui/message', id: 10, params: { content: [{ type: 'text', text: 'first' }, { type: 'text', text: 'second' }] } },
      page,
      handlers({ onMessage }),
    )
    expect(onMessage).toHaveBeenCalledWith('first\nsecond')
    expect(response).toEqual({ jsonrpc: '2.0', id: 10, result: {} })
  })

  // 验证 open-link 白名单：https 触发 onOpenLink 并回空 result；http 与 javascript: 伪协议
  // 都拒绝（回调不触发），返回 -32602 错误，防任意协议跳转/脚本注入。
  it('opens https links only', async () => {
    const onOpenLink = vi.fn()
    const allowed = await handleBridgeMessage(
      { method: 'ui/open-link', id: 11, params: { url: 'https://example.com/docs' } },
      page,
      handlers({ onOpenLink }),
    )
    expect(onOpenLink).toHaveBeenCalledWith('https://example.com/docs')
    expect(allowed).toEqual({ jsonrpc: '2.0', id: 11, result: {} })

    onOpenLink.mockClear()
    const denied = await handleBridgeMessage(
      { method: 'ui/open-link', id: 12, params: { url: 'http://example.com/docs' } },
      page,
      handlers({ onOpenLink }),
    )
    expect(onOpenLink).not.toHaveBeenCalled()
    expect(denied).toEqual({ jsonrpc: '2.0', id: 12, error: { code: -32602, message: 'Only https links can be opened' } })

    const javascript = await handleBridgeMessage(
      { method: 'ui/open-link', id: 13, params: { url: 'javascript:alert(1)' } },
      page,
      handlers({ onOpenLink }),
    )
    expect(onOpenLink).not.toHaveBeenCalled()
    expect(javascript).toEqual({ jsonrpc: '2.0', id: 13, error: { code: -32602, message: 'Only https links can be opened' } })
  })

  // 验证通知（无 id）语义：onMessage 副作用照常执行，但不返回任何响应对象（null）。
  it('performs a notification side effect but returns no response', async () => {
    const onMessage = vi.fn()
    const response = await handleBridgeMessage(
      { method: 'ui/message', params: { content: [{ type: 'text', text: 'no id' }] } },
      page,
      handlers({ onMessage }),
    )
    expect(onMessage).toHaveBeenCalledWith('no id')
    expect(response).toBeNull()
  })

  // 验证错误转换：上游 409（PLAN_BLOCKED）失败被转为 JSON-RPC -32603 内部错误，
  // 错误消息保留上游文案、请求 id 不变。
  it('turns an API failure into a JSON-RPC error that keeps the request id', async () => {
    stubFetch({ error: 'plan mode blocks this plugin tool', code: 'PLAN_BLOCKED' }, 409)
    const response = await handleBridgeMessage(
      { method: 'tools/call', id: 14, params: { name: 'draw' } },
      page,
      handlers(),
    )
    expect(response).toEqual({
      jsonrpc: '2.0',
      id: 14,
      error: { code: -32603, message: 'plan mode blocks this plugin tool' },
    })
  })
})

/** UI 页面描述提取（pluginUiDescriptor）的校验测试。 */
describe('pluginUiDescriptor', () => {
  // 验证合法 details.ui 的提取：额外字段（other）被丢弃，必填四字段与可选字段
  // （heightHint/preferredDisplayMode/showInline/toolCallId）按原值规范化输出。
  it('accepts a well-formed details.ui and normalizes the optional fields', () => {
    expect(pluginUiDescriptor({
      ui: {
        pluginId: 'excalidraw@market',
        serverName: 'plugin_excalidraw_canvas',
        resourceUri: 'ui://canvas',
        title: 'Excalidraw',
        heightHint: 420,
        preferredDisplayMode: 'fullscreen',
        showInline: false,
        toolCallId: 'call-1',
      },
      other: true,
    })).toEqual({
      pluginId: 'excalidraw@market',
      serverName: 'plugin_excalidraw_canvas',
      resourceUri: 'ui://canvas',
      title: 'Excalidraw',
      heightHint: 420,
      preferredDisplayMode: 'fullscreen',
      showInline: false,
      toolCallId: 'call-1',
    })
  })

  // 验证校验失败：details 缺失、空对象、缺必填字段、可选字段类型错误
  // （heightHint 非数字、displayMode 非法枚举、showInline 非布尔）均返回 undefined。
  it('rejects a missing required field or a wrong optional type', () => {
    expect(pluginUiDescriptor(undefined)).toBeUndefined()
    expect(pluginUiDescriptor({})).toBeUndefined()
    expect(pluginUiDescriptor({ ui: { pluginId: 'p', serverName: 's' } })).toBeUndefined()
    expect(pluginUiDescriptor({ ui: { pluginId: 'p', serverName: 's', resourceUri: 'u', heightHint: 'tall' } })).toBeUndefined()
    expect(pluginUiDescriptor({ ui: { pluginId: 'p', serverName: 's', resourceUri: 'u', preferredDisplayMode: 'window' } })).toBeUndefined()
    expect(pluginUiDescriptor({ ui: { pluginId: 'p', serverName: 's', resourceUri: 'u', showInline: 'yes' } })).toBeUndefined()
  })

  // 验证 JSON 字符串形态：details 为 JSON 编码字符串时同样解析并提取描述。
  it('reads a JSON-encoded details payload', () => {
    expect(pluginUiDescriptor(JSON.stringify({
      ui: { pluginId: 'p', serverName: 's', resourceUri: 'u' },
    }))).toEqual({ pluginId: 'p', serverName: 's', resourceUri: 'u' })
  })
})
