const MIN_INSPECTOR_WIDTH = 240
const MIN_CONVERSATION_WIDTH = 360
const DEFAULT_INSPECTOR_RATIO = 0.45
export const INSPECTOR_DIVIDER_WIDTH = 8

/** Available widths inside the shell's main body, after the left sidebar. */
export function inspectorLayout(containerWidth: number, preferredWidth?: number) {
  const contentWidth = Math.floor(containerWidth) - INSPECTOR_DIVIDER_WIDTH
  const max = contentWidth - MIN_CONVERSATION_WIDTH
  if (!Number.isFinite(max) || max <= MIN_INSPECTOR_WIDTH) return null

  const min = MIN_INSPECTOR_WIDTH
  const requested = preferredWidth !== undefined && Number.isFinite(preferredWidth)
    ? preferredWidth
    : Math.round(contentWidth * DEFAULT_INSPECTOR_RATIO)
  return { min, max, width: Math.min(max, Math.max(min, requested)) }
}
