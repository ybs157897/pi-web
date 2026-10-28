import type { Config } from 'dompurify'
/** Mermaid's HTML labels live in a foreignObject integration point. Keep safe labels, not scripts or event handlers. */
export const diagramSanitizeConfig: Config = {
  USE_PROFILES: { html: true, svg: true, svgFilters: true }, ADD_TAGS: ['foreignObject'],
  HTML_INTEGRATION_POINTS: { foreignobject: true }, FORBID_TAGS: ['script', 'iframe', 'object', 'embed'],
}
