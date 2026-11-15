/**
 * 插件 UI 宿主的服务端。
 *
 * 插件页面是插件声明 server 的一个 MCP 资源。宿主读取它、注入沙箱 CSP，
 * 以惰性 HTML 文档的形式返回。页面发起的调用（`tools/call`、`resources/read`）
 * 都回传给运行时，重新套用会话的访问模式与 Plan 状态：页面只是另一个工具入口，
 * 绝不是权限绕行通道。
 */
import type { CallToolResult, ReadResourceResult } from '@earendil-works/pi-mcp'
import type { PluginUiCallInput, PluginUiReadResourceInput, PluginUiSurfaceView, PluginUiPageRequest } from '../../shared/plugin-ui.ts'

/** 设计规范为插件页面固定的 CSP：禁网络，只允许内联 script/style。 */
export const PLUGIN_UI_CSP = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: https:; connect-src 'none'; form-action 'none'; base-uri 'none'"

/** 插件页面响应的 Content-Type。 */
export const PLUGIN_UI_PAGE_CONTENT_TYPE = 'text/html; charset=utf-8'
/** 页面发起的 `tools/call` 参数大小上限。 */
export const MAX_PLUGIN_UI_ARGUMENT_BYTES = 256 * 1024

const CSP_META = `<meta http-equiv="Content-Security-Policy" content="${PLUGIN_UI_CSP}">`

/** 把 CSP 注入文档 head；资源是 HTML 片段时套一层最小壳再注入。 */
export function buildPluginUiPageHtml(resourceText: string): string {
  if (/<head\b[^>]*>/iu.test(resourceText)) {
    return resourceText.replace(/<head\b[^>]*>/iu, match => `${match}${CSP_META}`)
  }
  return `<!doctype html><html><head><meta charset="utf-8">${CSP_META}</head><body>${resourceText}</body></html>`
}

/** 取资源中的第一个文本主体——插件 UI 页面必须是文本资源。 */
export function pluginUiResourceText(result: ReadResourceResult): string | undefined {
  for (const content of result.contents) {
    if ('text' in content && typeof content.text === 'string') return content.text
  }
  return undefined
}

/** 参数序列化后在离开宿主前测得的字节大小，供上限校验。 */
export function pluginUiArgumentsSize(value: unknown): number {
  if (value === undefined) return 0
  return Buffer.byteLength(JSON.stringify(value) ?? '', 'utf8')
}

/**
 * 这些路由使用的运行时接口。接口定义放在这里（而非 `contracts.ts`），让插件 UI
 * 宿主自己持有契约；`createRuntime` 返回的对象满足它即可。
 */
declare module '../contracts.ts' {
  interface Runtime {
    /** 检查器可打开的已启用插件 UI 面。 */
    pluginUiSurfaces(): PluginUiSurfaceView[]
    /** 读取一个插件页面资源，返回带 CSP 的 HTML 文档。 */
    pluginUiPage(input: PluginUiPageRequest): Promise<string>
    /** 在所有权与会话策略校验之后转发页面发起的 MCP 工具调用。 */
    pluginUiCall(input: PluginUiCallInput): Promise<CallToolResult>
    /** 在所有权校验之后转发页面发起的 MCP 资源读取。 */
    pluginUiReadResource(input: PluginUiReadResourceInput): Promise<ReadResourceResult>
  }
}
