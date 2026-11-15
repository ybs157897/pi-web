/** 字面量与正则两种工作区搜索共用的结果排版逻辑。 */

/** 单条搜索命中：所在文件路径、行号（1 起）与清洗后的行内容摘录。 */
export interface SearchMatch {
  path: string
  line: number
  excerpt: string
}

/** 单条摘录的最大字符数。 */
export const MAX_EXCERPT_LENGTH = 200
/** 工具输出总字节数上限（48 KiB）。 */
export const MAX_TOOL_OUTPUT_BYTES = 48 * 1_024

/**
 * 功能：清洗一行文本用作摘录。
 * 内部逻辑：把控制字符（除制表符/换行等少数可显示外，含 DEL）替换为空格，再折叠
 * 连续空白并去掉首尾空白。
 * @param value 原始行文本。
 * @returns 清洗后的单行摘录文本。
 */
export function cleanExcerpt(value: string): string {
  return value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim()
}

/**
 * 功能：生成不超过 MAX_EXCERPT_LENGTH 的摘录，超长时以命中位置为中心截取并加省略号。
 * 内部逻辑：先清洗整行；超长时用"清洗后的命中索引"把原行命中点映射到清洗文本中的位置，
 * 以该点为中心取窗（不足时回退到末尾对齐），两侧按截断情况补 `…`。
 * @param line 命中所在的原始行文本。
 * @param matchIndex 命中在原行中的字符索引，用于定位截取窗口。
 * @returns 居中截取、可能带省略号的摘录文本。
 */
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
 * 功能：在工具输出字节预算（MAX_TOOL_OUTPUT_BYTES）内渲染搜索结果。
 * 内部逻辑：循环从尾部逐条丢弃命中并重排，直到文本落入预算（或已无可丢弃）；
 * 发生丢弃或输入本就截断时标记 truncated，保证面向模型的输出永不超限。
 * @param values 搜索汇总：范围、查询词、类型、include 过滤、扫描/跳过统计、命中列表与截断标记。
 * @returns 汇总行 + 命中行 + 可选 TRUNCATED 提示组成的完整工具输出文本。
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
