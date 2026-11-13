/**
 * Mention tokens a room post may carry: `@<botName>` for one member, `@all` for everyone.
 * Matching is case-insensitive; returned names keep the roster's canonical casing.
 */
export const MENTION_PATTERN = /@([A-Za-z][A-Za-z0-9]*(?:-[A-Za-z0-9]+)*)/gu

export type ResolvedMentions = {
  /** True when the text contains at least one @token that looks like a mention. */
  hadMention: boolean
  /** True when `@all` (any case) is present. */
  all: boolean
  /** Roster names resolved from the tokens, in canonical casing, deduplicated. */
  names: string[]
}

export function resolveMentions(text: string, names: readonly string[]): ResolvedMentions {
  const byLower = new Map(names.map(name => [name.toLowerCase(), name]))
  const tokens = [...text.matchAll(MENTION_PATTERN)].map(match => match[1] ?? '')
  if (tokens.length === 0) return { hadMention: false, all: false, names: [] }
  if (tokens.some(token => token.toLowerCase() === 'all')) {
    return { hadMention: true, all: true, names: [...names] }
  }
  const resolved: string[] = []
  const seen = new Set<string>()
  for (const token of tokens) {
    const name = byLower.get(token.toLowerCase())
    if (name === undefined || seen.has(name)) continue
    seen.add(name)
    resolved.push(name)
  }
  return { hadMention: true, all: false, names: resolved }
}

/** Resolved mention names; `@all` expands to the full provided list. An empty result means no resolved targets, not "broadcast". */
export function parseMentions(text: string, names: readonly string[]): string[] {
  return resolveMentions(text, names).names
}
