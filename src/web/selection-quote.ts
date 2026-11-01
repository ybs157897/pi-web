/** Lines kept verbatim at each end of a long quote before the middle is elided. */
const QUOTE_KEEP_LINES = 6
/** Quotes up to this many lines go into the prompt unmodified. */
const QUOTE_FULL_LINES = QUOTE_KEEP_LINES * 2

/**
 * One fence language for the quote, inferred from the source path's extension
 * (`Inspector.tsx`'s alias table); sources without an extension fall back to `text`.
 */
export function quoteFenceLanguage(source?: string): string {
  if (source === undefined || source === '') return 'text'
  const extension = source.split('.').at(-1)?.toLocaleLowerCase()
  if (extension === undefined || extension === '' || extension === source.toLocaleLowerCase()) return 'text'
  const aliases: Record<string, string> = {
    cjs: 'javascript', htm: 'html', md: 'markdown', mjs: 'javascript', py: 'python', rs: 'rust', sh: 'bash', tsx: 'tsx', yml: 'yaml',
  }
  return aliases[extension] ?? extension
}

/** A quote past the full-size bound keeps its ends and names the elided middle. */
export function quoteBodyLines(quote: string): string[] {
  const lines = quote.split(/\r?\n/u)
  if (lines.length <= QUOTE_FULL_LINES) return lines
  const hidden = lines.length - QUOTE_KEEP_LINES * 2
  return [...lines.slice(0, QUOTE_KEEP_LINES), `…（省略 ${hidden} 行）…`, ...lines.slice(-QUOTE_KEEP_LINES)]
}

/**
 * The prompt a selection quote turns into: a fenced quotation with its source on top,
 * the question verbatim below. An empty question returns just the quote block; an empty
 * quote returns the question untouched.
 */
export function buildSideChatPrompt(quote: string, question: string, source?: string): string {
  const trimmed = quote.trim()
  const questionText = question.trim() === '' ? '' : question
  if (trimmed === '') return questionText
  const header = source === undefined || source === '' ? '引用内容：' : `来自 ${source} 的引用：`
  const block = `${header}\n\n\`\`\`${quoteFenceLanguage(source)}\n${quoteBodyLines(trimmed).join('\n')}\n\`\`\``
  return questionText === '' ? block : `${block}\n\n${questionText}`
}
