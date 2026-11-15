/**
 * 插件市场操作与页面宿主桥接。
 *
 * 插件页面是第二工具入口，因此来自页面的调用在到达插件的 MCP 服务前，
 * 会重新套用所在会话的只读与计划模式规则。
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

/** 插件 feature 的依赖注入契约：插件商店、MCP 注册表与组合根提供的会话侧回调。 */
export interface PluginsDeps {
  pluginStore: PluginStore
  mcp: McpRegistry
  harness: () => Harness
  listeners: Set<() => void>
  /** 等待商店触发的插件级 MCP 重载全部落定后 resolve。 */
  flushRefresh: () => Promise<void>
}

/**
 * 功能：创建插件 feature 服务，负责插件市场的增删改查与插件 UI 页面宿主。
 * @param deps 依赖注入：pluginStore 提供市场与安装状态，mcp 提供资源/工具访问，
 *              harness 惰性获取运行时（解除构造顺序耦合），listeners 是变更通知集合
 * 职责边界：本 feature 只做插件域操作与 UI 桥接；页面发起的工具调用在此重新套用
 * 只读与计划模式规则后再转发给 MCP 服务。
 */
export function createPlugins(deps: PluginsDeps) {
  const { pluginStore, mcp, harness: harnessRef, listeners, flushRefresh } = deps

  /** 校验 serverName 确实属于指定插件，防止跨插件访问 MCP 服务。 */
  const requirePluginUiServer = (pluginId: string, serverName: string): void => {
    const owner = pluginStore.pluginServer(serverName)
    if (owner === undefined || owner.pluginId !== pluginId) {
      throw new RuntimeError('PLUGIN_UI_UNAVAILABLE', '插件 UI 服务不可用')
    }
  }
  /** 读取插件资源；失败统一包装为 PLUGIN_UI_UNAVAILABLE，避免底层错误直接外泄。 */
  const readPluginUiResource = async (serverName: string, uri: string): Promise<ReadResourceResult> => {
    try {
      return await mcp.readResource(serverName, uri)
    } catch (error) {
      throw new RuntimeError('PLUGIN_UI_UNAVAILABLE', error instanceof Error ? error.message : String(error))
    }
  }

  return {
    /** 插件总览：已装插件、市场与进行中的安装操作。 */
    overview: async (): Promise<PluginOverview> => pluginStore.overview(),
    /** 添加一个插件市场来源。 */
    addMarketplace: (source: string) => pluginStore.addMarketplace(source),
    /** 删除一个插件市场来源。 */
    removeMarketplace: (id: string) => pluginStore.removeMarketplace(id),
    /** 手动刷新指定市场。 */
    refreshMarketplace: (id: string) => pluginStore.refreshMarketplace(id),
    /** 启动安装，立即返回操作 ID 供前端轮询进度。 */
    install: async (input: InstallPluginInput) => ({ operationId: pluginStore.startInstall(input).id }),
    /** 启动更新，立即返回操作 ID 供前端轮询进度。 */
    update: async (pluginId: string) => ({ operationId: pluginStore.startUpdate({ pluginId }).id }),
    /** 读取插件描述（能力清单、版本等）。 */
    describe: (pluginId: string): Promise<PluginDescription> => pluginStore.describe(pluginId),
    /** 卸载插件，可选保留其数据；卸载触发的 MCP 重载完成后才返回。 */
    uninstall: async (pluginId: string, keepData: boolean): Promise<PluginOverview> => {
      const overview = await pluginStore.uninstall(pluginId, keepData)
      await flushRefresh()
      return overview
    },
    /** 启用/停用插件；开关触发的 MCP 重载完成后才返回。 */
    setEnabled: async (pluginId: string, enabled: boolean): Promise<PluginOverview> => {
      const overview = await pluginStore.setEnabled(pluginId, enabled)
      await flushRefresh()
      return overview
    },
    /** 订阅插件变更通知，返回取消订阅函数。 */
    watch: (listener: () => void): (() => void) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    /** 列出各插件对外暴露的 UI 页面（surface）清单。 */
    uiSurfaces: (): PluginUiSurfaceView[] => pluginStore.uiSurfaces(),
    /** 渲染插件 UI 页面：校验归属后读取文本资源并包装成宿主 HTML。 */
    uiPage: async (input: PluginUiPageRequest): Promise<string> => {
      requirePluginUiServer(input.pluginId, input.serverName)
      const resource = await readPluginUiResource(input.serverName, input.uri)
      const text = pluginUiResourceText(resource)
      if (text === undefined) throw new RuntimeError('PLUGIN_UI_UNAVAILABLE', '插件页面不是文本资源')
      return buildPluginUiPageHtml(text)
    },
    /** 从插件页面调用插件工具；会话上下文存在时先套用只读与计划模式规则。 */
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
        // 页面是第二工具入口：同样适用只读与计划模式规则。
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
    /** 从插件页面读取指定 URI 的资源原文，仅做归属校验后透传。 */
    uiReadResource: async (input: PluginUiReadResourceInput): Promise<ReadResourceResult> => {
      requirePluginUiServer(input.pluginId, input.serverName)
      return await readPluginUiResource(input.serverName, input.uri)
    },
  }
}
