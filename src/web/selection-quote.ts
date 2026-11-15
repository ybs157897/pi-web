/** 长引用两端逐字保留的行数，中间省略。 */
const QUOTE_KEEP_LINES = 6
/** 不超过该行数的引用原样进入提示词。 */
const QUOTE_FULL_LINES = QUOTE_KEEP_LINES * 2

/**
 * 功能：按引用来源路径的扩展名推断引用围栏的语言标注（别名表与 `Inspector.tsx` 一致）。
 * @param source 来源文件路径
 * @returns 围栏语言名；无来源、无扩展名或「扩展名等于文件名」（如 dotfile）回落 `text`
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

/**
 * 功能：超过全量上限的长引用保留首尾各 6 行，中间换成「省略 N 行」占位行。
 * @param quote 引用文本
 * @returns 行数组；未超限原样返回
 */
export function quoteBodyLines(quote: string): string[] {
  const lines = quote.split(/\r?\n/u)
  if (lines.length <= QUOTE_FULL_LINES) return lines
  const hidden = lines.length - QUOTE_KEEP_LINES * 2
  return [...lines.slice(0, QUOTE_KEEP_LINES), `…（省略 ${hidden} 行）…`, ...lines.slice(-QUOTE_KEEP_LINES)]
}

/**
 * 功能：把划词引用组装成侧聊提示词：顶部带来源的围栏引用块，下方原样拼接提问。
 * @param quote 选中的引用文本
 * @param question 用户输入的问题
 * @param source 引用来源路径（可选）
 * @returns 提示词全文；问题为空只返回引用块，引用为空只返回问题原文
 */
export function buildSideChatPrompt(quote: string, question: string, source?: string): string {
  const trimmed = quote.trim()
  const questionText = question.trim() === '' ? '' : question
  if (trimmed === '') return questionText
  const header = source === undefined || source === '' ? '引用内容：' : `来自 ${source} 的引用：`
  const block = `${header}\n\n\`\`\`${quoteFenceLanguage(source)}\n${quoteBodyLines(trimmed).join('\n')}\n\`\`\``
  return questionText === '' ? block : `${block}\n\n${questionText}`
}
