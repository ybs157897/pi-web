import type { Config } from 'dompurify'
/**
 * Mermaid 图渲染前对 SVG 做 DOMPurify 的白名单配置。
 *
 * Mermaid 的 HTML 标签放在 SVG 的 foreignObject 集成点里，需要显式放开该标签与集成点；
 * 但脚本、iframe、object、embed 及一切事件处理器一律禁掉——保住标签文本，不保可执行内容。
 */
export const diagramSanitizeConfig: Config = {
  USE_PROFILES: { html: true, svg: true, svgFilters: true }, ADD_TAGS: ['foreignObject'],
  HTML_INTEGRATION_POINTS: { foreignobject: true }, FORBID_TAGS: ['script', 'iframe', 'object', 'embed'],
}
