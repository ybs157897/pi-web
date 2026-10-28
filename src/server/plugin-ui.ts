/**
 * Server side of the plugin UI host.
 *
 * A plugin page is one MCP resource of a plugin-declared server. The host reads it, injects the
 * sandbox CSP, and serves it as an inert HTML document. Calls the page makes (`tools/call`,
 * `resources/read`) travel back through the runtime, which re-applies the conversation's access
 * mode and Plan state: the page is another tool entry point, never a permission bypass.
 */
import type { CallToolResult, ReadResourceResult } from '@earendil-works/pi-mcp'
import type { PluginUiCallInput, PluginUiReadResourceInput, PluginUiSurfaceView, PluginUiPageRequest } from '../shared/plugin-ui.ts'

/** The exact policy the design fixes for plugin pages: no network, inline script/style only. */
export const PLUGIN_UI_CSP = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: https:; connect-src 'none'; form-action 'none'; base-uri 'none'"

export const PLUGIN_UI_PAGE_CONTENT_TYPE = 'text/html; charset=utf-8'
/** Page-originated `tools/call` arguments stay under this size. */
export const MAX_PLUGIN_UI_ARGUMENT_BYTES = 256 * 1024

const CSP_META = `<meta http-equiv="Content-Security-Policy" content="${PLUGIN_UI_CSP}">`

/** Put the policy inside the document's head; a fragment gets a minimal shell instead. */
export function buildPluginUiPageHtml(resourceText: string): string {
  if (/<head\b[^>]*>/iu.test(resourceText)) {
    return resourceText.replace(/<head\b[^>]*>/iu, match => `${match}${CSP_META}`)
  }
  return `<!doctype html><html><head><meta charset="utf-8">${CSP_META}</head><body>${resourceText}</body></html>`
}

/** The first textual resource body, which is what a plugin UI page has to be. */
export function pluginUiResourceText(result: ReadResourceResult): string | undefined {
  for (const content of result.contents) {
    if ('text' in content && typeof content.text === 'string') return content.text
  }
  return undefined
}

/** Serialized arguments must stay bounded before they leave the host. */
export function pluginUiArgumentsSize(value: unknown): number {
  if (value === undefined) return 0
  return Buffer.byteLength(JSON.stringify(value) ?? '', 'utf8')
}

/**
 * The runtime surface these routes use. The interface lives here (not in `contracts.ts`) so the
 * plugin UI host owns its own contract; `createRuntime` returns an object that satisfies it.
 */
declare module './contracts.ts' {
  interface Runtime {
    /** Enabled plugin UI surfaces the inspector may open. */
    pluginUiSurfaces(): PluginUiSurfaceView[]
    /** Read one plugin page resource and return it as a CSP-carrying HTML document. */
    pluginUiPage(input: PluginUiPageRequest): Promise<string>
    /** Forward a page-originated MCP tool call after ownership and conversation policy checks. */
    pluginUiCall(input: PluginUiCallInput): Promise<CallToolResult>
    /** Forward a page-originated MCP resource read after ownership checks. */
    pluginUiReadResource(input: PluginUiReadResourceInput): Promise<ReadResourceResult>
  }
}
