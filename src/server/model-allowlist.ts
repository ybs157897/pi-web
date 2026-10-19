/** The scripted demo provider: its model stays selectable whatever the allowlist says. */
export const DEMO_MODEL_PROVIDER = 'pi-web-demo'

type ModelIdentity = { provider: string; modelId: string }

/**
 * Whether one model passes the project allowlist. An empty allowlist filters
 * nothing, a trailing `*` turns an entry into a prefix pattern, and the demo
 * provider is always allowed so the scripted demo stays usable.
 */
export function modelWithinAllowlist(allowlist: readonly string[] | undefined, model: ModelIdentity): boolean {
  if (model.provider === DEMO_MODEL_PROVIDER) return true
  if (!allowlist || allowlist.length === 0) return true
  const full = `${model.provider}/${model.modelId}`
  return allowlist.some(entry => entry.endsWith('*') ? full.startsWith(entry.slice(0, -1)) : full === entry)
}

/** `provider/modelId`, optionally with a trailing `*`; `*` anywhere else never matches. */
export function isValidAllowlistEntry(entry: string): boolean {
  if (entry.length === 0 || entry.length > 200 || /\s/u.test(entry)) return false
  const star = entry.indexOf('*')
  if (star !== -1 && star !== entry.length - 1) return false
  const pattern = star === entry.length - 1 ? entry.slice(0, -1) : entry
  const slash = pattern.indexOf('/')
  return slash > 0 && slash < pattern.length - 1
}

/** What the settings route stores: trimmed, blank-free and de-duplicated, in input order. */
export function normalizeModelAllowlist(entries: readonly string[]): string[] {
  const seen = new Set<string>()
  const normalized: string[] = []
  for (const entry of entries) {
    const value = entry.trim()
    if (value === '' || seen.has(value)) continue
    seen.add(value)
    normalized.push(value)
  }
  return normalized
}
