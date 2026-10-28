/** Parse workspace links with optional GitHub-style line numbers. */
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

export function safeAnswerUrl(value: string): boolean {
  try { return ['http:', 'https:', 'mailto:'].includes(new URL(value).protocol) } catch { return false }
}

export function tableMarkdown(rows: readonly (readonly string[])[]): string {
  if (!rows.length) return ''
  const cols = Math.max(...rows.map(row => row.length))
  const cell = (s: string) => s.replace(/\\/gu, '\\\\').replace(/\|/gu, '\\|').replace(/\r?\n/gu, '<br>')
  const line = (r: readonly string[]) => `| ${Array.from({ length: cols }, (_, i) => cell(r[i] ?? '')).join(' | ')} |`
  return [line(rows[0] ?? []), line(Array(cols).fill('---')), ...rows.slice(1).map(line)].join('\n')
}

/** Quote every value and neutralize spreadsheet formula prefixes, including whitespace. */
export function tableCsv(rows: readonly (readonly string[])[]): string {
  return '\uFEFF' + rows.map(row => row.map(value => {
    const safe = /^(?:[ \u00a0]*[\t\r\n]|[\s\u0000-\u001f]*[=+\-@])/u.test(value) ? `'${value}` : value
    return `"${safe.replace(/"/gu, '""')}"`
  }).join(',')).join('\r\n')
}

/** Only owner-resolved local media can use app/blob/data URLs; authored media needs absolute HTTP(S). */
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

/** Keep adjacent standalone images in one Streamdown block, while leaving fenced source untouched. */
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
