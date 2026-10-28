import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Mock } from 'vitest'
import type { PluginContextEntry, PluginUiPage } from '../src/shared/plugin-ui.ts'
import {
  handleBridgeMessage, parseBridgeMessage, pluginUiDescriptor,
  type PluginUiBridgeHandlers,
} from '../src/web/plugin-ui-bridge.ts'

type FetchMock = Mock<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>

const page: PluginUiPage = {
  id: 'conversation-1:excalidraw@market:call-1',
  pluginId: 'excalidraw@market',
  serverName: 'plugin_excalidraw_canvas',
  resourceUri: 'ui://canvas',
  title: 'Excalidraw',
  toolCallId: 'call-1',
}

function handlers(overrides: Partial<PluginUiBridgeHandlers> = {}): PluginUiBridgeHandlers {
  return {
    onContext: vi.fn(),
    onMessage: vi.fn(),
    onOpenLink: vi.fn(),
    ...overrides,
  }
}

function stubFetch(payload: unknown, status = 200): FetchMock {
  const fetchMock: FetchMock = vi.fn(async () => new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  }))
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

function bodyOf(fetchMock: FetchMock, call = 0): Record<string, unknown> {
  const init = fetchMock.mock.calls[call]?.[1]
  return JSON.parse(String(init?.body)) as Record<string, unknown>
}

function urlOf(fetchMock: FetchMock, call = 0): string {
  return String(fetchMock.mock.calls[call]?.[0])
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('parseBridgeMessage', () => {
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

describe('handleBridgeMessage', () => {
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

describe('pluginUiDescriptor', () => {
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

  it('rejects a missing required field or a wrong optional type', () => {
    expect(pluginUiDescriptor(undefined)).toBeUndefined()
    expect(pluginUiDescriptor({})).toBeUndefined()
    expect(pluginUiDescriptor({ ui: { pluginId: 'p', serverName: 's' } })).toBeUndefined()
    expect(pluginUiDescriptor({ ui: { pluginId: 'p', serverName: 's', resourceUri: 'u', heightHint: 'tall' } })).toBeUndefined()
    expect(pluginUiDescriptor({ ui: { pluginId: 'p', serverName: 's', resourceUri: 'u', preferredDisplayMode: 'window' } })).toBeUndefined()
    expect(pluginUiDescriptor({ ui: { pluginId: 'p', serverName: 's', resourceUri: 'u', showInline: 'yes' } })).toBeUndefined()
  })

  it('reads a JSON-encoded details payload', () => {
    expect(pluginUiDescriptor(JSON.stringify({
      ui: { pluginId: 'p', serverName: 's', resourceUri: 'u' },
    }))).toEqual({ pluginId: 'p', serverName: 's', resourceUri: 'u' })
  })
})
