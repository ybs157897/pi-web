/**
 * User font lists shared by the settings validator and the browser.
 *
 * Both sides normalize with the same rules so the persisted value, the input
 * echo, and the inline CSS variable always agree: names are comma separated,
 * quotes/backslashes/angle brackets/control characters are dropped, and every
 * non-generic name is double-quoted. An empty result selects the built-in
 * stack for that role.
 */

/** CSS Fonts generic and system family keywords, which must stay unquoted. */
const GENERIC_FAMILIES = new Set([
  'serif', 'sans-serif', 'monospace', 'cursive', 'fantasy', 'system-ui', 'ui-serif', 'ui-sans-serif',
  'ui-monospace', 'ui-rounded', 'emoji', 'math', 'fangsong', '-apple-system', 'blinkmacsystemfont',
])

/**
 * Normalize user input into a CSS font-family list.
 * @param value - user-entered or stored font list.
 * @returns the normalized list, or `''` when no family name remains.
 */
export function normalizeFontFamily(value: string): string {
  return value.split(',')
    .map(name => name.replace(/["'\\<>\u0000-\u001f\u007f]/gu, '').replace(/\s+/gu, ' ').trim())
    .filter(name => name !== '')
    .map(name => GENERIC_FAMILIES.has(name.toLowerCase()) ? name : `"${name}"`)
    .join(', ')
}
