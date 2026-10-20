import type { ProviderModelInput } from '../shared/types.ts'

/** One editable reasoning row: the level and the wire value sent for it. */
export interface ReasoningEntry {
  level: string
  /** Wire value; null is the Off row, which sends nothing. */
  value: string | null
}

/** Every level the API accepts, in escalation order. */
export const REASONING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const

/**
 * The rows the editor shows for one model: the levels that actually declare a
 * wire value, plus Off when the map can stop thinking. A null-pinned level is
 * an absence, not a row — rendering it made a deleted level reappear after
 * every save.
 */
export function draftReasoningLevels(model: ProviderModelInput): ReasoningEntry[] | undefined {
  const map = model.thinkingLevelMap
  if (map === undefined || map === null) return undefined
  const entries: ReasoningEntry[] = Object.entries(map)
    .filter(([, value]) => typeof value === 'string' && value !== '')
    .map(([level, value]) => ({ level, value: value as string }))
  // `off` absent means "supported, send nothing"; an explicit null means the
  // model cannot stop thinking, so there is no Off row to edit.
  if (map.off !== null && !entries.some(entry => entry.level === 'off')) {
    entries.unshift({ level: 'off', value: null })
  }
  return entries
}

/**
 * Pin undeclared levels to null, matching DSH's `reasoningEfforts` adapter:
 * a level the user did not configure is not offered, instead of pi-ai
 * defaulting the five base levels to "supported". An Off row with no value
 * stays absent so turning thinking off sends no parameter.
 */
export function pinReasoningLevels(entries: readonly ReasoningEntry[]): Record<string, string | null> {
  const map: Record<string, string | null> = Object.fromEntries(
    REASONING_LEVELS.filter(level => level !== 'off').map(level => [level, null]),
  )
  for (const entry of entries) {
    if (entry.level === 'off' && entry.value === null) {
      delete map.off
      continue
    }
    map[entry.level] = entry.value ?? entry.level
  }
  return map
}
