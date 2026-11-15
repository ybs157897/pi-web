import type { WetrackDefectItem } from '../shared/types.ts'

/** 缺陷按项目聚合后的分组。 */
export interface WetrackProjectGroup {
  key: string
  label: string
  items: WetrackDefectItem[]
}

const UNCATEGORIZED = '未分类'

/**
 * 功能：把任意字段值归一成展示文本：字符串去首尾空白，数字/布尔转字符串，其余空串。
 * @param value 字段原始值（来自 CLI 的 JSON）
 * @returns 展示文本
 */
export function fieldText(value: unknown): string {
  if (typeof value === 'string') return value.trim()
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return ''
}

function text(value: string | number | boolean | undefined): string {
  return fieldText(value)
}

/**
 * 功能：把 WeTrack 的 HTML 描述转成纯文本。阅读器只渲染文本不渲染 HTML——
 * 图片替换为标记、块边界转为换行；全程不经过 sanitizer、不碰 innerHTML，没有 XSS 面。
 * @param html 原始 HTML 描述
 * @returns 清洗后的纯文本（空白与连续换行已规整）
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

/**
 * 功能：推导缺陷的项目分组键：有项目编号用编号；只有项目名的行用 `name:名字` 稳定入桶；两者皆无归 `none`。
 */
export function projectKeyOf(item: WetrackDefectItem): string {
  const number = text(item.projectNumber)
  if (number !== '') return number
  const name = text(item.projectName)
  return name !== '' ? `name:${name}` : 'none'
}

/**
 * 功能：取缺陷的项目展示名：优先项目名，其次项目编号，都空显示「未分类」。
 */
export function projectLabelOf(item: WetrackDefectItem): string {
  const name = text(item.projectName)
  if (name !== '') return name
  const number = text(item.projectNumber)
  return number !== '' ? number : UNCATEGORIZED
}

/**
 * 功能：把缺陷列表按项目聚成分组，组序遵循 CLI 输出的插入序，刷新之间 tab 条保持稳定。
 * @param items 缺陷列表
 * @returns 按首次出现顺序排列的分组数组
 */
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

/**
 * 功能：按空格分词的多关键词过滤——所有词都要命中任一可见列，大小写不敏感。
 * @param items 缺陷列表
 * @param query 查询串
 * @returns 过滤结果；空查询原样返回副本
 */
export function filterDefects(items: readonly WetrackDefectItem[], query: string): WetrackDefectItem[] {
  const terms = query.trim().toLocaleLowerCase().split(/\s+/u).filter(term => term !== '')
  if (terms.length === 0) return [...items]
  return items.filter(item => {
    const haystack = FILTER_FIELDS.map(field => text(item[field])).join('\n').toLocaleLowerCase()
    return terms.every(term => haystack.includes(term))
  })
}

/** 缺陷工作流三态：待开发处理 / 待验证自验 / 其他。 */
export type WetrackWorkflow = 'development' | 'verification' | 'other'

/**
 * 功能：由状态名与步骤推导缺陷所处的工作流阶段。
 * @param item 缺陷条目
 * @returns verification 命中「自验/verification」；development 命中「待开发/开发解决」等；其余 other
 */
export function workflowOf(item: WetrackDefectItem): WetrackWorkflow {
  const status = `${text(item.defectStatusName)} ${text(item.defectStep)}`
  if (/自验|verification|verify/iu.test(status)) return 'verification'
  if (/待开发|开发解决|development|待.*解决/iu.test(status)) return 'development'
  return 'other'
}

/**
 * 功能：缺陷按最新排序的比较器：优先提交时间，其次更新时间、创建时间；时间相同按缺陷号倒序。
 * @returns 新的在前为负（可用于 sort）
 */
export function compareDefectsNewest(a: WetrackDefectItem, b: WetrackDefectItem): number {
  const time = (item: WetrackDefectItem): string => text(item.submitTime) || text(item.updateTime) || text(item.createTime)
  return time(b).localeCompare(time(a)) || b.defectNumber.localeCompare(a.defectNumber)
}

/** antd Tag 语气色板子集，用于严重度/状态徽标。 */
export type TagTone = 'red' | 'volcano' | 'gold' | 'blue' | 'cyan' | 'green' | 'default'

const SEVERITY_TONES: ReadonlyArray<readonly [RegExp, TagTone]> = [
  [/致命|阻塞|blocker|critical|fatal/iu, 'red'],
  [/严重|major|high/iu, 'volcano'],
  [/一般|normal|medium/iu, 'blue'],
  [/轻微|minor|low|trivial/iu, 'cyan'],
]

/**
 * 功能：把严重度名称映射为标签语气色（致命红、严重 volcano、一般蓝、轻微青）。
 * @returns 命中的 tone；无法识别回落 default
 */
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

/**
 * 功能：把缺陷状态名称映射为标签语气色（关闭灰、已解决绿、待处理金、验证中青）。
 * @returns 命中的 tone；无法识别回落 blue
 */
export function statusTone(name: string | undefined): TagTone {
  const value = text(name)
  for (const [pattern, tone] of STATUS_TONES) if (pattern.test(value)) return tone
  return 'blue'
}
