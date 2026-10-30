/**
 * Plugin marketplace operations and the page host bridge.
 *
 * Pages are a second tool entry point, so a page-originated call re-applies the
 * conversation's read-only and Plan rules before it reaches the plugin's MCP server.
 */
import type { Harness } from '@earendil-works/pi-durable'
import type { CallToolResult, ReadResourceResult } from '@earendil-works/pi-mcp'
import type { InstallPluginInput, PluginDescription, PluginOverview } from '../../shared/plugins.ts'
import type {
  PluginUiCallInput, PluginUiPageRequest, PluginUiReadResourceInput, PluginUiSurfaceView,
} from '../../shared/plugin-ui.ts'
import type { McpRegistry } from '../mcp/registry.ts'
import type { PluginStore } from '../plugins/store.ts'
import { MAX_PLUGIN_UI_ARGUMENT_BYTES, buildPluginUiPageHtml, pluginUiArgumentsSize, pluginUiResourceText } from '../plugins/ui.ts'
import { Plans } from '../tools/plan.ts'
import { RuntimeError } from '../runtime-errors.ts'
import { CTX, META, PLUGIN_UI_PLAN_TOOLS, READ_ONLY_TOOLS, parseConversationId } from './helpers.ts'

export interface PluginsDeps {
  pluginStore: PluginStore
  mcp: McpRegistry
  harness: () => Harness
  listeners: Set<() => void>
  /** Resolves once plugin-driven MCP reloads started by the store have settled. */
  flushRefresh: () => Promise<void>
}

export function createPlugins(deps: PluginsDeps) {
  const { pluginStore, mcp, harness: harnessRef, listeners, flushRefresh } = deps

  const requirePluginUiServer = (pluginId: string, serverName: string): void => {
    const owner = pluginStore.pluginServer(serverName)
    if (owner === undefined || owner.pluginId !== pluginId) {
      throw new RuntimeError('PLUGIN_UI_UNAVAILABLE', '插件 UI 服务不可用')
    }
  }
  const readPluginUiResource = async (serverName: string, uri: string): Promise<ReadResourceResult> => {
    try {
      return await mcp.readResource(serverName, uri)
    } catch (error) {
      throw new RuntimeError('PLUGIN_UI_UNAVAILABLE', error instanceof Error ? error.message : String(error))
    }
  }

  return {
    overview: async (): Promise<PluginOverview> => pluginStore.overview(),
    addMarketplace: (source: string) => pluginStore.addMarketplace(source),
    removeMarketplace: (id: string) => pluginStore.removeMarketplace(id),
    refreshMarketplace: (id: string) => pluginStore.refreshMarketplace(id),
    install: async (input: InstallPluginInput) => ({ operationId: pluginStore.startInstall(input).id }),
    update: async (pluginId: string) => ({ operationId: pluginStore.startUpdate({ pluginId }).id }),
    describe: (pluginId: string): Promise<PluginDescription> => pluginStore.describe(pluginId),
    uninstall: async (pluginId: string, keepData: boolean): Promise<PluginOverview> => {
      const overview = await pluginStore.uninstall(pluginId, keepData)
      await flushRefresh()
      return overview
    },
    setEnabled: async (pluginId: string, enabled: boolean): Promise<PluginOverview> => {
      const overview = await pluginStore.setEnabled(pluginId, enabled)
      await flushRefresh()
      return overview
    },
    watch: (listener: () => void): (() => void) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    uiSurfaces: (): PluginUiSurfaceView[] => pluginStore.uiSurfaces(),
    uiPage: async (input: PluginUiPageRequest): Promise<string> => {
      requirePluginUiServer(input.pluginId, input.serverName)
      const resource = await readPluginUiResource(input.serverName, input.uri)
      const text = pluginUiResourceText(resource)
      if (text === undefined) throw new RuntimeError('PLUGIN_UI_UNAVAILABLE', '插件页面不是文本资源')
      return buildPluginUiPageHtml(text)
    },
    uiCall: async (input: PluginUiCallInput): Promise<CallToolResult> => {
      requirePluginUiServer(input.pluginId, input.serverName)
      const server = mcp.view().servers.find(item => item.name === input.serverName)
      const tool = server?.tools.find(item => item.name === input.tool)
      if (server === undefined || server.status !== 'connected' || tool === undefined || tool.exposure === 'hidden') {
        throw new RuntimeError('PLUGIN_UI_UNAVAILABLE', '插件 UI 工具不可用')
      }
      if (pluginUiArgumentsSize(input.arguments) > MAX_PLUGIN_UI_ARGUMENT_BYTES) {
        throw new RuntimeError('INVALID_INPUT', '插件工具参数过大')
      }
      if (input.conversationId !== undefined) {
        const conversationId = parseConversationId(input.conversationId)
        const harness = harnessRef()
        const metadata = await harness.snapshot(META, conversationId, CTX)
        if (metadata === undefined) throw new RuntimeError('NOT_FOUND', '会话不存在')
        // The page is a second tool entry point: the same read-only and Plan rules apply.
        if (metadata.accessMode === 'readOnly' && !READ_ONLY_TOOLS.has(input.tool)) {
          throw new RuntimeError('ACCESS_DENIED', '只读会话不允许调用插件工具')
        }
        const plan = await harness.snapshot(Plans, conversationId, CTX)
        if (plan?.active === true && !PLUGIN_UI_PLAN_TOOLS.has(input.tool)) {
          throw new RuntimeError('PLAN_BLOCKED', '计划模式下不允许调用插件工具')
        }
      }
      try {
        return await mcp.callTool(input.serverName, input.tool, input.arguments)
      } catch (error) {
        throw new RuntimeError('PLUGIN_UI_UNAVAILABLE', error instanceof Error ? error.message : String(error))
      }
    },
    uiReadResource: async (input: PluginUiReadResourceInput): Promise<ReadResourceResult> => {
      requirePluginUiServer(input.pluginId, input.serverName)
      return await readPluginUiResource(input.serverName, input.uri)
    },
  }
}
