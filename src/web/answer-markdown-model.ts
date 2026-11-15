/**
 * 解析回答里的工作区文件链接，支持 GitHub 风格的 `#L12` / `#L12-L34` 行号。
 * @param value 链接原文，可能是 `file://` 形式或裸路径
 * @returns 成功返回 `{ path, line? }`（line 为起始行，range 时同时表示区间端点）；含 query、控制字符、未知协议等一律 undefined
 * 内部逻辑：file:// 先转普通路径（剥 IPv4 映射前导斜杠）；`?` 视为非法；行号必须是 L 开头的正整数且区间不倒序。
 */
export function parseAnswerFileLink(value: string): { path: string; line?: number } | undefined {
  if (/^file:\/\//iu.test(value)) {
    try {
      const url = new URL(value)
      if (url.hostname && url.hostname !== 'localhost' || url.search) return undefined
      value = url.pathname.replace(/^\/([a-z]:\/)/iu, '$1') + url.hash
    } catch { return undefined }
  }
  const hash = value.indexOf('#')
  const destination = hash < 0 ? value : value.slice(0, hash)
  if (destination.includes('?')) return undefined
  let path: string
  try { path = decodeURIComponent(destination) } catch { return undefined }
  if (!path || /[\u0000-\u001f\u007f]/u.test(path) || /^[\\/]{2}/u.test(path)
    || (/^[a-z][a-z\d+.-]*:/iu.test(path) && !/^[a-z]:[\\/]/iu.test(path))) return undefined
  if (hash < 0) return { path }
  const match = /^L([1-9]\d*)(?:-L([1-9]\d*))?$/u.exec(value.slice(hash + 1))
  if (!match) return undefined
  const line = Number(match[1]); const end = Number(match[2] ?? match[1])
  if (!Number.isSafeInteger(line) || !Number.isSafeInteger(end) || end < line) return undefined
  return { path, line }
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
