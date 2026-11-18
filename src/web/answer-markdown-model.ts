export interface AnswerFileReference {
  path: string
  line?: number
}

const windowsPath = /^[a-z]:[\\/]/iu
const scheme = /^[a-z][a-z\d+.-]*:/iu
const lineFragment = /^L(\d+)(?:-L?(\d+))?$/iu
const lineSuffix = /^(.*?):(\d+)(?:([:-])(\d+))?$/u
const sourceLocation = /^(?:#L\d+(?:-L?\d+)?|:\d+(?:[:-]\d+)?)(?![\w:#-])/iu
const standardFilename = /^(?:Dockerfile|Makefile|Gemfile|Rakefile|Justfile|README|LICENSE|\.[a-z][\w.-]*)$/iu
const commonExtension = /\.(?:[cm]?[jt]sx?|jsonc?|ya?ml|toml|ini|xml|html?|s?css|vue|svelte|mdx?|rst|txt|csv|py|rb|go|rs|java|kt|swift|[ch]|cpp|hpp|sh|ps1|sql|lock|pdf|docx?|xlsx?|pptx?|png|jpe?g|svg|webp|gif|log)$/iu
const extension = /\.[\p{L}][\p{L}\p{N}_-]*$/u

/** 解析链接目标。行区间及行列坐标统一导航到起始行。 */
export function parseAnswerFileLink(value: string): AnswerFileReference | undefined {
  return parseFileDestination(value, true)
}

function parseFileDestination(value: string, decode: boolean): AnswerFileReference | undefined {
  if (/^file:\/\//iu.test(value)) {
    try {
      const url = new URL(value)
      if ((url.hostname && url.hostname !== 'localhost') || url.search) return undefined
      value = url.pathname.replace(/^\/([a-z]:\/)/iu, '$1') + url.hash
      decode = true
    } catch { return undefined }
  }
  if (value.includes('?')) return undefined
  const hash = value.indexOf('#')
  let destination = value
  let line: number | undefined
  if (hash >= 0) {
    const match = lineFragment.exec(value.slice(hash + 1))
    if (!match) return undefined
    destination = value.slice(0, hash)
    line = Number(match[1])
    const end = Number(match[2] ?? match[1])
    if (!Number.isSafeInteger(end) || end < line) return undefined
  } else {
    const match = lineSuffix.exec(value)
    if (match) {
      destination = match[1]!
      // Bare names such as README.md:12 can be treated as schemes by the HTML sanitizer.
      // Require a recognizable filename before interpreting an apparent scheme as a line suffix.
      if (scheme.test(value) && !windowsPath.test(value) && !extension.test(destination) && !standardFilename.test(destination)) return undefined
      line = Number(match[2])
      if (match[4] !== undefined) {
        const endOrColumn = Number(match[4])
        if (!Number.isSafeInteger(endOrColumn) || endOrColumn < 1 || (match[3] === '-' && endOrColumn < line)) return undefined
      }
    }
  }
  if (line !== undefined && (!Number.isSafeInteger(line) || line < 1)) return undefined
  let path: string
  try { path = decode ? decodeURIComponent(destination) : destination } catch { return undefined }
  if (!path.trim() || /[\u0000-\u001f\u007f]/u.test(path) || /^[\\/]{2}/u.test(path)
    || (scheme.test(path) && !windowsPath.test(path))) return undefined
  return line === undefined ? { path } : { path, line }
}

/** 整段行内代码或已分词的正文候选；先匹配当前回合已知路径，再处理明显的路径形态。 */
export function resolveAnswerFileReference(value: string, paths: readonly string[] = [], knownOnly = false): AnswerFileReference | undefined {
  value = value.trim()
  if (!value) return undefined
  const raw = parseFileDestination(value, false)
  const decoded = value.includes('%') ? parseAnswerFileLink(value) : raw
  for (const reference of [raw, decoded]) {
    if (!reference) continue
    const normalized = normalizedReferencePath(reference.path)
    const exact = paths.find(path => normalizedReferencePath(path) === normalized)
    if (exact !== undefined) return { ...reference, path: exact }
    // A short name can refer to an artifact only when it identifies a single file in the turn.
    if (!/[\\/]/u.test(reference.path)) {
      const matches = paths.filter(path => normalizedReferencePath(path).split('/').at(-1) === normalized)
      if (matches.length === 1) return { ...reference, path: matches[0]! }
      if (matches.length > 1) return undefined
    }
  }
  if (knownOnly) return undefined
  const reference = decoded ?? raw
  if (!reference || /^(?:~[^\\/]*[\\/]|[\\/]?$)/u.test(reference.path)
    || !/^[\p{L}\p{N}\p{M}\p{S}_.@()%+ ,/\\:-]+$/u.test(reference.path)) return undefined
  const basename = reference.path.split(/[\\/]/u).at(-1)!
  if (standardFilename.test(basename) || commonExtension.test(basename)) return reference
  const qualified = basename !== reference.path
  return (qualified && extension.test(basename)) || (reference.line !== undefined && (qualified || extension.test(basename))) ? reference : undefined
}

function normalizedReferencePath(path: string): string {
  return path.replace(/\\/gu, '/').replace(/^(?:\.\/)+/u, '')
}

/** 捕获 `file.ts`:12 形式中位于反引号外的行号。 */
export function followingFileLocation(text: string): string {
  return sourceLocation.exec(text)?.[0] ?? ''
}

interface TextFileReference {
  start: number
  end: number
  target: string
  label: string
  markdown: boolean
  knownOnly?: boolean
}

// Only scan Markdown text nodes. Explicit quoting separates paths containing spaces from prose.
const textFileCandidate = /(?:^|[\s([{<"'“‘，。！？；：、,;])(?:\[([^\]\n]+)\]\(([^()\n]+)\)|"([^"\n]+)"|'([^'\n]+)'|“([^”\n]+)”|‘([^’\n]+)’|([\p{L}\p{N}\p{M}\p{S}_.%@+~\/\\#:-]+))/gu

export function textFileReferences(text: string): TextFileReference[] {
  const references: TextFileReference[] = []
  for (const match of text.matchAll(textFileCandidate)) {
    const [full, markdownLabel, markdownTarget, double, single, smartDouble, smartSingle, token] = match
    if (markdownTarget !== undefined) {
      // CommonMark falls back to text when models omit angle brackets around a destination with spaces.
      if (!/[ \t]/u.test(markdownTarget) || !resolveAnswerFileReference(markdownTarget)) continue
      const start = match.index + full.indexOf('[')
      references.push({ start, end: match.index + full.length, target: markdownTarget, label: markdownLabel!, markdown: true })
      continue
    }
    const quoted = double ?? single ?? smartDouble ?? smartSingle
    const value = quoted ?? token?.replace(/[.:]+$/u, '')
    if (!value || (!/[.\\/#:]/u.test(value) && !standardFilename.test(value))) continue
    const reference = resolveAnswerFileReference(value)
    if (!reference) continue
    // A bare filename in prose needs a position, a directory, or a matching artifact.
    const knownOnly = quoted === undefined && reference.line === undefined && !/[\\/]/u.test(value)
    const start = match.index + full.lastIndexOf(quoted ?? token!)
    references.push({ start, end: start + value.length, target: value, label: value, markdown: false, knownOnly })
  }
  return references
}

/**
 * 功能：判断 URL 是否允许作为外链打开（仅 http/https/mailto 三种协议，杜绝 javascript: 等注入）。
 * @param value 任意字符串
 * @returns 协议安全返回 true，解析失败或协议不在白名单返回 false
 */
export function safeAnswerUrl(value: string): boolean {
  try { return ['http:', 'https:', 'mailto:'].includes(new URL(value).protocol) } catch { return false }
}

/**
 * 功能：把二维字符串数组渲染成 Markdown 表格文本（第一行作表头，第二行补 `---` 分隔）。
 * @param rows 行数据，各行长度可以不齐
 * @returns 完整 Markdown 表格字符串；rows 为空返回空串
 * 内部逻辑：列数取所有行的最大值，缺的单元格补空；单元格内的 `\` `|` 转义，换行替换为 `<br>`。
 */
export function tableMarkdown(rows: readonly (readonly string[])[]): string {
  if (!rows.length) return ''
  const cols = Math.max(...rows.map(row => row.length))
  const cell = (s: string) => s.replace(/\\/gu, '\\\\').replace(/\|/gu, '\\|').replace(/\r?\n/gu, '<br>')
  const line = (r: readonly string[]) => `| ${Array.from({ length: cols }, (_, i) => cell(r[i] ?? '')).join(' | ')} |`
  return [line(rows[0] ?? []), line(Array(cols).fill('---')), ...rows.slice(1).map(line)].join('\n')
}

/**
 * 功能：把二维数组导出为 CSV 文本（带 BOM，Excel 打开不乱码）。
 * @param rows 行数据
 * @returns CRLF 分隔、双引号包裹的 CSV 字符串
 * 内部逻辑：以空白或控制字符开头的 `= + - @` 公式前缀会额外前置单引号，防止电子表格应用执行公式注入；值内 `"` 转义为 `""`。
 */
export function tableCsv(rows: readonly (readonly string[])[]): string {
  return '\uFEFF' + rows.map(row => row.map(value => {
    const safe = /^(?:[ \u00a0]*[\t\r\n]|[\s\u0000-\u001f]*[=+\-@])/u.test(value) ? `'${value}` : value
    return `"${safe.replace(/"/gu, '""')}"`
  }).join(',')).join('\r\n')
}

/**
 * 功能：把模型写出的图片地址收敛为可实际加载的 src。
 * @param authored 模型写出的图片链接
 * @param resolve 把工作区路径解析为本机可访问地址的回调
 * @returns 可直接赋给 `<img src>` 的地址；解析不出来返回 undefined（不渲染）
 * 内部逻辑：绝对 http(s) 链接直接放行（须过 safeAnswerUrl）；其余按工作区文件链接解析，解析结果仅接受 /api/workspaces 资产、blob:、data:image 三类本地形式。
 */
export function resolvedImageSource(authored: string, resolve?: (value: string) => string | undefined): string | undefined {
  if (/^https?:\/\//iu.test(authored) && safeAnswerUrl(authored)) return authored
  const destination = authored.split(/[?#]/u)[0] ?? ''
  const file = parseAnswerFileLink(destination)
  if (!file || !resolve) return undefined
  const target = resolve(destination)
  if (!target) return undefined
  if (/^https?:\/\//iu.test(target) && safeAnswerUrl(target)) return target
  if (/^\/api\/workspaces\/[^/]+\/asset\?/u.test(target) || /^blob:https?:\/\//iu.test(target) || /^data:image\/(?:png|jpeg|gif|webp);base64,/iu.test(target)) return target
  return undefined
}

/**
 * 功能：把相邻的独立成行图片之间的空行去掉，让多张图合并进同一个段落（Streamdown 才能整块布局）。
 * @param text 原始 Markdown 文本
 * @returns 处理后的文本，围栏代码块内部原样保留
 * 内部逻辑：用 fence 状态机跟踪 ``` / ~~~ 围栏的开合（要求闭合标记长度不小于开启标记）；仅在围栏外、当前行与下一非空行都是独立图片行时跳过中间空行。
 */
export function normalizeImageParagraphs(text: string): string {
  const lines = text.split('\n'), out: string[] = []
  let fence: { marker: string; size: number } | undefined
  const onlyImage = (line: string) => /^\s*!\[[^\]]*\]\([^\n]+\)\s*$/u.test(line)
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    const match = /^ {0,3}(`{3,}|~{3,})(.*)$/u.exec(line)
    if (match) {
      const marker = match[1]![0]!, size = match[1]!.length
      if (fence?.marker === marker && size >= fence.size && !match[2]!.trim()) fence = undefined
      else if (!fence && (marker === '~' || !match[2]!.includes('`'))) fence = { marker, size }
      out.push(line); continue
    }
    out.push(line)
    if (!fence && onlyImage(line)) {
      let next = i + 1
      while (next < lines.length && !lines[next]!.trim()) next++
      if (next > i + 1 && next < lines.length && onlyImage(lines[next]!)) i = next - 1
    }
  }
  return out.join('\n')
}
