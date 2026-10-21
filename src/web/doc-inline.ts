/**
 * 文档块里的行内切分。
 *
 * doc 块的正文不经过 Markdown 渲染器（那会把库的正文样式带进块里），但程序员的
 * 结论里全是路径、命令和提交号，所以只认三种 token：行内代码、加粗和 http(s) 链接。
 * 这里只做切分与分类，不碰 React，方便单测。
 */

export type InlineToken =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'code'; readonly text: string }
  | { readonly kind: 'strong'; readonly text: string }
  | { readonly kind: 'link'; readonly text: string; readonly href: string }

/** 行内代码的用途，决定渲染成可点路径、可复制命令还是普通 chip。 */
export type CodeKind = 'path' | 'command' | 'code'

const INLINE = /`([^`]+)`|\*\*([^*]+)\*\*|https?:\/\/[^\s<>()]+/gu
/** 链接末尾常粘着句读，剥下来还回正文，不能吞掉。 */
const TRAILING_PUNCTUATION = /[.,;:!?。，、；：！？）)】」』》]+$/u

/** 文件名带常见扩展名，或者带目录分隔符且不含空格，视为路径。 */
const FILE_NAME = /^(?:[\w@.-]+\/)*[\w@.-]+\.(?:[cm]?[jt]sx?|jsonc?|mdx?|s?css|less|html?|vue|svelte|py|rs|go|java|kt|kts|sql|ya?ml|toml|ini|sh|bash|zsh|ps1|bat|cmd|lock|txt|csv|xml|proto|gradle|dockerfile)$/iu
const SLASH_PATH = /^(?:\.{1,2}\/|\/)?(?:[\w@.-]+\/)+[\w@.-]+\/?$/u
const COMMAND = /^(?:npm|npx|pnpm|yarn|bun|node|deno|git|docker|kubectl|helm|curl|wget|make|cmake|cargo|go|python3?|pip3?|pytest|uv|poetry|tsx|tsc|vite|vitest|jest|eslint|prettier|pkill|kill|ps|ls|cd|cat|grep|rg|sed|awk|find|mkdir|rm|mv|cp|chmod|ssh|scp|rsync|systemctl|journalctl|source|export|Stop-Process|Start-Process|Get-Location|Get-Content|Set-Location|Test-Path|Write-Output|Select-String)\b/u

/** 把一行块内文本切成行内 token；不配对的反引号/星号保持原样。 */
export function splitInline(text: string): InlineToken[] {
  const tokens: InlineToken[] = []
  let cursor = 0
  for (const match of text.matchAll(INLINE)) {
    const index = match.index ?? 0
    if (index > cursor) tokens.push({ kind: 'text', text: text.slice(cursor, index) })
    if (match[1] !== undefined) {
      tokens.push({ kind: 'code', text: match[1] })
    } else if (match[2] !== undefined) {
      tokens.push({ kind: 'strong', text: match[2] })
    } else {
      const raw = match[0]
      const href = raw.replace(TRAILING_PUNCTUATION, '')
      tokens.push({ kind: 'link', text: href, href })
      const suffix = raw.slice(href.length)
      if (suffix !== '') tokens.push({ kind: 'text', text: suffix })
    }
    cursor = index + match[0].length
  }
  if (cursor < text.length) tokens.push({ kind: 'text', text: text.slice(cursor) })
  return tokens
}

/** 行内代码属于路径、命令还是普通代码。 */
export function classifyCode(text: string): CodeKind {
  const value = text.trim()
  if (value === '') return 'code'
  if (/\s/u.test(value)) {
    // 带空格的仍然可能是命令（带参数的那种）。
    return COMMAND.test(value) || /&&|\|\||\s--?\w/u.test(value) ? 'command' : 'code'
  }
  if (FILE_NAME.test(value) || SLASH_PATH.test(value)) return 'path'
  if (COMMAND.test(value)) return 'command'
  return 'code'
}
