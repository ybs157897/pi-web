/**
 * Bot name pool. Grok Bot names its Bots with short, capitalized, one-or-two word names
 * (31% single word, 21.5% a single person-like name, only 8% carry a "Bot" suffix); this pool
 * follows the same shape and reuses the astronomical family Grok uses for its voices, so a
 * preset team and a hand-created Bot read as one product.
 */
export const BOT_NAME_POOL = [
  'Atlas', 'Aurora', 'Kepler', 'Orion', 'Luna', 'Rigel', 'Sirius', 'Vega',
  'Lyra', 'Iris', 'Helios', 'Ursa', 'Zenith', 'Castor', 'Perseus', 'Lumen',
  'Celeste', 'Cosmo', 'Altair', 'Naksh', 'Carina', 'Helix', 'Liora', 'Lux',
  'Ara', 'Eve', 'Leo', 'Rex', 'Sal', 'Zagan',
] as const

/** First pool name not already taken; falls back to a numbered tail once the pool runs out. */
export function suggestBotName(taken: Iterable<string>): string {
  const used = new Set(Array.from(taken, name => name.toLowerCase()))
  for (const name of BOT_NAME_POOL) {
    if (!used.has(name.toLowerCase())) return name
  }
  for (let index = 2; ; index += 1) {
    const candidate = `${BOT_NAME_POOL[0]}-${index}`
    if (!used.has(candidate.toLowerCase())) return candidate
  }
}
