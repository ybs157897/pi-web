/** Shared result shaping for the literal and regex workspace searches. */

export interface SearchMatch {
  path: string
  line: number
  excerpt: string
}

export const MAX_EXCERPT_LENGTH = 200
export const MAX_TOOL_OUTPUT_BYTES = 48 * 1_024

export function cleanExcerpt(value: string): string {
  return value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim()
}

export function makeExcerpt(line: string, matchIndex: number): string {
  const clean = cleanExcerpt(line)
  if (clean.length <= MAX_EXCERPT_LENGTH) return clean
  const originalPrefix = line.slice(0, matchIndex)
  const cleanIndex = cleanExcerpt(originalPrefix).length
  const half = Math.floor((MAX_EXCERPT_LENGTH - 2) / 2)
  let start = Math.max(0, cleanIndex - half)
  let end = Math.min(clean.length, start + MAX_EXCERPT_LENGTH - 2)
  if (end - start < MAX_EXCERPT_LENGTH - 2) start = Math.max(0, end - (MAX_EXCERPT_LENGTH - 2))
  return `${start > 0 ? '…' : ''}${clean.slice(start, end)}${end < clean.length ? '…' : ''}`
}

/**
 * Render matches under the tool output budget. Entries are dropped from the tail and the result is
 * marked truncated, so a large search never exceeds the model-facing cap.
 */
export function boundedSearch(
  values: {
    scope: string
    query: string
    kind: 'literal' | 'regex'
    include?: string
    scannedFiles: number
    skippedOversize: number
    skippedBinary: number
    skippedUnreadable: number
    matches: SearchMatch[]
    truncated: boolean
  },
): string {
  while (true) {
    const lines = values.matches.map(match => `- ${JSON.stringify(match.path)}:${match.line}: ${match.excerpt}`)
    const noun = values.kind === 'regex' ? 'regex match' : 'literal match'
    const text = [
      `Found ${values.matches.length} ${noun}${values.matches.length === 1 ? '' : 'es'} for ${JSON.stringify(values.query)} under ${JSON.stringify(values.scope)}${values.include ? ` in files matching ${JSON.stringify(values.include)}` : ''}; searched ${values.scannedFiles} files; skipped ${values.skippedUnreadable} unreadable, ${values.skippedBinary} binary, and ${values.skippedOversize} oversized files.`,
      ...lines,
      ...(values.truncated ? ['TRUNCATED: the search is incomplete or results were omitted by workspace limits.'] : []),
    ].join('\n')
    if (Buffer.byteLength(text) <= MAX_TOOL_OUTPUT_BYTES || values.matches.length === 0) return text
    values.matches.pop()
    values.truncated = true
  }
}
