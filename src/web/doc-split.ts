/**
 * 「文档排版」的结构块切分。
 *
 * 模型在正文里用三反引号 + `doc` 的围栏输出一段 YAML，前端把它渲染成卡片、
 * 对比面板或提示块；围栏之外的文字照旧走 Markdown。这份切分只认顶层围栏，
 * 围栏里的内容（含嵌套围栏）整体属于代码块，不会被误认成 doc 块。
 */

export type DocSegment =
  | { readonly kind: 'markdown'; readonly text: string }
  | { readonly kind: 'doc'; readonly text: string }

interface SourceLine {
  /** The line's first character offset in the source. */
  readonly start: number
  /** The offset of the line's line break, or the source length at the last line. */
  readonly end: number
  readonly text: string
}

interface Fence {
  readonly marker: '`' | '~'
  /** The fence's run length; a closing fence must be at least this long. */
  readonly length: number
  /** The info string's first word, lowercased. */
  readonly info: string
}

/** The info string that marks a fence as a doc block. */
const DOC_INFO = 'doc'

/**
 * Split assistant text into plain Markdown and doc blocks.
 *
 * An unterminated fence is left inside the Markdown segment: while the model is
 * still writing, the half-open fence is an ordinary code block, and it turns into
 * a doc block once the closing fence arrives.
 */
export function splitDocBlocks(text: string): DocSegment[] {
  if (text === '') return []
  const lines = sourceLines(text)
  const segments: DocSegment[] = []
  let markdownStart = 0
  let index = 0
  while (index < lines.length) {
    const line = lines[index]
    const fence = fenceOf(line.text)
    if (fence === undefined) {
      index += 1
      continue
    }
    const close = closingFence(lines, index + 1, fence)
    if (close === undefined) break
    if (fence.info !== DOC_INFO) {
      index = close + 1
      continue
    }
    if (line.start > markdownStart) segments.push({ kind: 'markdown', text: text.slice(markdownStart, line.start) })
    const bodyStart = line.end + 1
    const bodyEnd = lines[close].start
    segments.push({ kind: 'doc', text: text.slice(bodyStart, bodyEnd) })
    markdownStart = lines[close].end + 1
    index = close + 1
  }
  if (markdownStart < text.length) segments.push({ kind: 'markdown', text: text.slice(markdownStart) })
  return segments
}

/** The source's lines with their offsets, so a segment can be sliced from the original text. */
function sourceLines(text: string): SourceLine[] {
  const lines: SourceLine[] = []
  let start = 0
  while (start < text.length) {
    const breakIndex = text.indexOf('\n', start)
    if (breakIndex === -1) {
      lines.push({ start, end: text.length, text: text.slice(start) })
      break
    }
    lines.push({ start, end: breakIndex, text: text.slice(start, breakIndex) })
    start = breakIndex + 1
  }
  return lines
}

/** The fence a line opens, or undefined when the line is ordinary text. */
function fenceOf(line: string): Fence | undefined {
  const match = /^ {0,3}(`{3,}|~{3,})[ \t]*(.*)$/u.exec(line)
  if (match === null) return undefined
  const run = match[1]
  const info = match[2].trim()
  // A backtick fence's info string may not contain a backtick, so such a line opens nothing.
  if (run.startsWith('`') && info.includes('`')) return undefined
  return { marker: run.startsWith('`') ? '`' : '~', length: run.length, info: info.split(/\s+/u)[0].toLowerCase() }
}

/** The index of the fence that closes the one opened at `from - 1`, or undefined when it stays open. */
function closingFence(lines: readonly SourceLine[], from: number, fence: Fence): number | undefined {
  const pattern = fence.marker === '`' ? /^ {0,3}(`{3,})[ \t]*$/u : /^ {0,3}(~{3,})[ \t]*$/u
  for (let index = from; index < lines.length; index += 1) {
    const match = pattern.exec(lines[index].text)
    if (match === null) continue
    if ((match[1].length ?? 0) >= fence.length) return index
  }
  return undefined
}
