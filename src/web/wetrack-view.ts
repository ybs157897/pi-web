import type { WetrackDefectItem } from '../shared/types.ts'

export interface WetrackProjectGroup {
  key: string
  label: string
  items: WetrackDefectItem[]
}

const UNCATEGORIZED = '未分类'

export function fieldText(value: unknown): string {
  if (typeof value === 'string') return value.trim()
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return ''
}

function text(value: string | number | boolean | undefined): string {
  return fieldText(value)
}

/**
 * WeTrack descriptions are HTML. The reader renders text instead of raw HTML, so images become a
 * marker and block boundaries become line breaks — no sanitizer, no innerHTML, no XSS surface.
 */
export function defectDescriptionText(html: string): string {
  return html
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/giu, '')
    .replace(/<img\b[^>]*>/giu, ' [图片] ')
    .replace(/<br\s*\/?>/giu, '\n')
    .replace(/<\/(?:p|div|li|tr|h[1-6]|blockquote)>/giu, '\n')
    .replace(/<li\b[^>]*>/giu, '· ')
    .replace(/<[^>]*>/gu, '')
    .replace(/&nbsp;/giu, ' ')
    .replace(/&lt;/giu, '<')
    .replace(/&gt;/giu, '>')
    .replace(/&quot;/giu, '"')
    .replace(/&#(?:39|x27);/giu, "'")
    .replace(/&amp;/giu, '&')
    .replace(/[ \t\u00a0]+/gu, ' ')
    .replace(/ *\n */gu, '\n')
    .replace(/\n{3,}/gu, '\n\n')
    .trim()
}

/** Group by project number when present; name-only rows still get their own stable bucket. */
export function projectKeyOf(item: WetrackDefectItem): string {
  const number = text(item.projectNumber)
  if (number !== '') return number
  const name = text(item.projectName)
  return name !== '' ? `name:${name}` : 'none'
}

export function projectLabelOf(item: WetrackDefectItem): string {
  const name = text(item.projectName)
  if (name !== '') return name
  const number = text(item.projectNumber)
  return number !== '' ? number : UNCATEGORIZED
}

/** Insertion order follows the CLI, so the tab strip stays stable between refreshes. */
export function groupDefectsByProject(items: readonly WetrackDefectItem[]): WetrackProjectGroup[] {
  const groups = new Map<string, WetrackProjectGroup>()
  for (const item of items) {
    const key = projectKeyOf(item)
    const existing = groups.get(key)
    if (existing === undefined) groups.set(key, { key, label: projectLabelOf(item), items: [item] })
    else existing.items.push(item)
  }
  return [...groups.values()]
}

const FILTER_FIELDS = ['defectNumber', 'simpleDesc', 'defectStatusName', 'severityName', 'projectName', 'projectNumber', 'creatorName'] as const

/** Whitespace-separated terms must all match about any visible column, case-insensitively. */
export function filterDefects(items: readonly WetrackDefectItem[], query: string): WetrackDefectItem[] {
  const terms = query.trim().toLocaleLowerCase().split(/\s+/u).filter(term => term !== '')
  if (terms.length === 0) return [...items]
  return items.filter(item => {
    const haystack = FILTER_FIELDS.map(field => text(item[field])).join('\n').toLocaleLowerCase()
    return terms.every(term => haystack.includes(term))
  })
}

export type WetrackWorkflow = 'development' | 'verification' | 'other'

export function workflowOf(item: WetrackDefectItem): WetrackWorkflow {
  const status = `${text(item.defectStatusName)} ${text(item.defectStep)}`
  if (/自验|verification|verify/iu.test(status)) return 'verification'
  if (/待开发|开发解决|development|待.*解决/iu.test(status)) return 'development'
  return 'other'
}

export function compareDefectsNewest(a: WetrackDefectItem, b: WetrackDefectItem): number {
  const time = (item: WetrackDefectItem): string => text(item.submitTime) || text(item.updateTime) || text(item.createTime)
  return time(b).localeCompare(time(a)) || b.defectNumber.localeCompare(a.defectNumber)
}

export type TagTone = 'red' | 'volcano' | 'gold' | 'blue' | 'cyan' | 'green' | 'default'

const SEVERITY_TONES: ReadonlyArray<readonly [RegExp, TagTone]> = [
  [/致命|阻塞|blocker|critical|fatal/iu, 'red'],
  [/严重|major|high/iu, 'volcano'],
  [/一般|normal|medium/iu, 'blue'],
  [/轻微|minor|low|trivial/iu, 'cyan'],
]

export function severityTone(name: string | undefined): TagTone {
  const value = text(name)
  for (const [pattern, tone] of SEVERITY_TONES) if (pattern.test(value)) return tone
  return 'default'
}

const STATUS_TONES: ReadonlyArray<readonly [RegExp, TagTone]> = [
  [/关闭|closed|已结束/iu, 'default'],
  [/已解决|已修复|已通过|resolved|fixed|passed/iu, 'green'],
  [/拒绝|reject|won.?t/iu, 'default'],
  [/待|挂起|pending|open|todo/iu, 'gold'],
  [/验证|自验|测试|verify|test/iu, 'cyan'],
]

export function statusTone(name: string | undefined): TagTone {
  const value = text(name)
  for (const [pattern, tone] of STATUS_TONES) if (pattern.test(value)) return tone
  return 'blue'
}
