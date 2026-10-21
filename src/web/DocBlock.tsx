import type { ComponentType, ReactElement } from 'react'
import { parse as parseYaml } from 'yaml'
import {
  IconAgentPresetOutlineRegular,
  IconAlarmClockOutlineRegular,
  IconApiOutlineRegular,
  IconArchiveOutlineRegular,
  IconBranchOutlineRegular,
  IconBrowseOutlineRegular,
  IconCheckCircleOutlineRegular,
  IconChecklistOutlineRegular,
  IconCheckOutlineRegular,
  IconClockOutlineRegular,
  IconCloseCircleFillRegular,
  IconCloseOutlineRegular,
  IconCodeOutlineRegular,
  IconCompactOutlineRegular,
  IconCompareSplitOutlineRegular,
  IconContextInjectionOutlineRegular,
  IconCopyOutlineRegular,
  IconDarkOutlineRegular,
  IconDatabaseOutlineRegular,
  IconDeliverDocRegular,
  IconDownloadOutlineRegular,
  IconEditOutlineRegular,
  IconEnhanceOutlineRegular,
  IconFlatListOutlineRegular,
  IconFolderOpenOutlineRegular,
  IconFullscreenOutlineRegular,
  IconGaugeOutlineRegular,
  IconGlobeOutlineRegular,
  IconGoalOutlineRegular,
  IconInfoOutlineRegular,
  IconInspectOutlineRegular,
  IconLightOutlineRegular,
  IconLinkOutlineRegular,
  IconListPenOutlineRegular,
  IconLoadingOutlineRegular,
  IconNewChatOutlineRegular,
  IconPaperclipOutlineRegular,
  IconPaperPlaneOutlineRegular,
  IconPauseOutlineRegular,
  IconPersonalizationOutlineRegular,
  IconPinOutlineRegular,
  IconPlanOutlineRegular,
  IconPlayOutlineRegular,
  IconPluginPinwheelOutlineRegular,
  IconPlusOutlineRegular,
  IconQuestionOutlineRegular,
  IconQueueOutlineRegular,
  IconRefreshOutlineRegular,
  IconSearchOutlineRegular,
  IconSettingsOutlineRegular,
  IconShareOutlineRegular,
  IconShieldOutlineRegular,
  IconSkillOutlineRegular,
  IconSlidersTwoOutlineRegular,
  IconSparkleRegular,
  IconStopFillRegular,
  IconThinkOutlineRegular,
  IconTrashOutlineRegular,
  IconTreeCornerRegular,
  IconUnarchiveOutlineRegular,
  IconUserOutlineRegular,
  IconUsersOutlineRegular,
  IconWarningTriangleOutlineRegular,
  IconWorkspaceTreeOutlineRegular,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { FileArtifact } from '../shared/types.ts'
import { DocInline } from './DocInline.tsx'
import { classifyCode } from './doc-inline.ts'
import { fileStats, formatFileStats } from './file-stats.ts'
import css from './DocBlock.module.css'

export interface DocCard {
  readonly icon: string | undefined
  readonly title: string
  readonly body: string | undefined
  readonly bullets: readonly string[]
}

export interface DocPanel {
  readonly badge: 'check' | 'cross' | 'none'
  readonly title: string
  readonly subtitle: string | undefined
  readonly bullets: readonly string[]
  readonly footer: string | undefined
}

/** 一条验证结果：构建通过、测试未跑这类「做了什么验证」的条目。 */
export interface DocCheck {
  readonly status: 'pass' | 'fail' | 'skip'
  readonly label: string
  readonly detail: string | undefined
}

/** 一条改动：文件路径 + 一句说明 + 增删统计，交付说明和 Code Review 用。 */
export interface DocChange {
  readonly path: string
  readonly summary: string | undefined
  readonly stats: string | undefined
}

export type ParsedDocBlock =
  | { readonly type: 'cards'; readonly items: readonly DocCard[] }
  | { readonly type: 'compare'; readonly left: DocPanel; readonly right: DocPanel }
  | { readonly type: 'checks'; readonly items: readonly DocCheck[] }
  | { readonly type: 'changes'; readonly items: readonly DocChange[] }
  | { readonly type: 'note'; readonly icon: string | undefined; readonly title: string | undefined
    readonly body: string | undefined; readonly code: string | undefined; readonly label: string | undefined }

/**
 * 语义名到设计稿图标的映射。模型可能写出表外名字，映射查不到时只是不画图标，
 * 不能让整块因为一个图标名丢掉。
 * `doc`/`sparkle`/`tree` 在图标库里没有 Outline 变体，用同族的 Regular 版本。
 */
const ICONS: Record<string, ComponentType<{ size?: number }>> = {
  // 内容与文字
  text: IconListPenOutlineRegular,
  doc: IconDeliverDocRegular,
  file: IconBrowseOutlineRegular,
  code: IconCodeOutlineRegular,
  list: IconFlatListOutlineRegular,
  todo: IconChecklistOutlineRegular,
  edit: IconEditOutlineRegular,
  copy: IconCopyOutlineRegular,
  compare: IconCompareSplitOutlineRegular,
  // 结构与流程
  plan: IconPlanOutlineRegular,
  goal: IconGoalOutlineRegular,
  tree: IconTreeCornerRegular,
  branch: IconBranchOutlineRegular,
  queue: IconQueueOutlineRegular,
  api: IconApiOutlineRegular,
  link: IconLinkOutlineRegular,
  injection: IconContextInjectionOutlineRegular,
  // 时间
  time: IconClockOutlineRegular,
  deadline: IconAlarmClockOutlineRegular,
  // 状态
  check: IconCheckOutlineRegular,
  cross: IconCloseOutlineRegular,
  done: IconCheckCircleOutlineRegular,
  failed: IconCloseCircleFillRegular,
  info: IconInfoOutlineRegular,
  warn: IconWarningTriangleOutlineRegular,
  question: IconQuestionOutlineRegular,
  loading: IconLoadingOutlineRegular,
  pause: IconPauseOutlineRegular,
  stop: IconStopFillRegular,
  run: IconPlayOutlineRegular,
  refresh: IconRefreshOutlineRegular,
  pin: IconPinOutlineRegular,
  add: IconPlusOutlineRegular,
  // 人与组织
  agent: IconUserOutlineRegular,
  team: IconUsersOutlineRegular,
  folder: IconFolderOpenOutlineRegular,
  workspace: IconWorkspaceTreeOutlineRegular,
  chat: IconNewChatOutlineRegular,
  preset: IconAgentPresetOutlineRegular,
  // 系统与配置
  settings: IconSettingsOutlineRegular,
  sliders: IconSlidersTwoOutlineRegular,
  shield: IconShieldOutlineRegular,
  plugin: IconPluginPinwheelOutlineRegular,
  skill: IconSkillOutlineRegular,
  data: IconDatabaseOutlineRegular,
  globe: IconGlobeOutlineRegular,
  chart: IconGaugeOutlineRegular,
  layers: IconPersonalizationOutlineRegular,
  space: IconCompactOutlineRegular,
  color: IconDarkOutlineRegular,
  sparkle: IconSparkleRegular,
  think: IconThinkOutlineRegular,
  enhance: IconEnhanceOutlineRegular,
  bulb: IconLightOutlineRegular,
  search: IconSearchOutlineRegular,
  inspect: IconInspectOutlineRegular,
  archive: IconArchiveOutlineRegular,
  restore: IconUnarchiveOutlineRegular,
  share: IconShareOutlineRegular,
  download: IconDownloadOutlineRegular,
  attach: IconPaperclipOutlineRegular,
  send: IconPaperPlaneOutlineRegular,
  expand: IconFullscreenOutlineRegular,
  delete: IconTrashOutlineRegular,
}

type DocIcon = ComponentType<{ size?: number }>

function iconOf(name: string | undefined): DocIcon | undefined {
  if (name === undefined) return undefined
  return ICONS[name]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 必填文本：只有非空字符串算通过，缺省和空串都算结构不合法。 */
function requiredText(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed === '' ? undefined : trimmed
}

/** 可选文本：`null` 与缺省等价，类型不符时交给调用方判非法。 */
function optionalText(value: unknown): { readonly ok: boolean; readonly value: string | undefined } {
  if (value === undefined || value === null) return { ok: true, value: undefined }
  if (typeof value !== 'string') return { ok: false, value: undefined }
  const trimmed = value.trim()
  return { ok: true, value: trimmed === '' ? undefined : trimmed }
}

/** 列表缺省是空数组；出现但不是字符串数组时结构不合法。 */
function readBullets(value: unknown): readonly string[] | undefined {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) return undefined
  const items: string[] = []
  for (const entry of value) {
    const line = requiredText(entry)
    if (line === undefined) return undefined
    items.push(line)
  }
  return items
}

function readCard(value: unknown): DocCard | undefined {
  if (!isRecord(value)) return undefined
  const title = requiredText(value.title)
  if (title === undefined) return undefined
  const bullets = readBullets(value.bullets)
  if (bullets === undefined) return undefined
  const icon = optionalText(value.icon)
  const body = optionalText(value.body)
  if (!icon.ok || !body.ok) return undefined
  return { icon: icon.value, title, body: body.value, bullets }
}

function readPanel(value: unknown): DocPanel | undefined {
  if (!isRecord(value)) return undefined
  const title = requiredText(value.title)
  if (title === undefined) return undefined
  const bullets = readBullets(value.bullets)
  if (bullets === undefined) return undefined
  const subtitle = optionalText(value.subtitle)
  const footer = optionalText(value.footer)
  if (!subtitle.ok || !footer.ok) return undefined
  // 徽章只认三种写法；写成别的值算类型不符，而不是默默当成 none。
  if (value.badge !== undefined && value.badge !== null
    && value.badge !== 'check' && value.badge !== 'cross' && value.badge !== 'none') return undefined
  const badge = value.badge === 'check' || value.badge === 'cross' ? value.badge : 'none'
  return { badge, title, subtitle: subtitle.value, bullets, footer: footer.value }
}

/**
 * YAML 的保留字符：值以它们开头时，要么报错，要么把后面的内容悄悄吃掉。
 * 反引号（行内代码）、`#`（注释）、`*`（别名）、`&`/`!`（锚点/标签）、
 * `@`/`%`（保留）、`[`/`{`（流式集合）都在此列。
 */
const RESERVED_START = /^[`#&!*@%[{]/u

/**
 * 先按原样解析，不行再修两遍：保守修复 → 保守 + 激进修复。
 *
 * 保守修复每次都做（包括解析本来会成功的情况），因为有一类错误 YAML 不会报：
 * `title: 修复 #123` 会被当成注释，解析成「修复」——不报错、不丢块，只是内容
 * 悄悄少半句。激进修复只在解析失败后做（tab 缩进、没闭合的引号）。
 */
function parseLoose(source: string): unknown {
  const preserved = preserveScalars(source)
  try {
    return parseYaml(preserved)
  } catch {
    try {
      return parseYaml(repairScalars(preserved))
    } catch {
      // 修不回来才当作「这块不是 doc 块」。
      return undefined
    }
  }
}

/**
 * 保守修复：给会被 YAML 吃坏的值加单引号。
 * - 值以保留字符开头：`- \`a.md\``、`title: **结论**`、`title: #123`；
 * - 值里出现「空格 + #」：`修复 #123` 会被截成「修复」；
 * - 值里出现「冒号 + 空格」：`code: create({ tab: 1 })` 整块解析失败。
 * 已带引号的值、以及块标量（`|` / `>`）的内容原样跳过，避免二次引用或改坏代码。
 */
function preserveScalars(source: string): string {
  const out: string[] = []
  let blockIndent: number | undefined
  for (const line of source.split('\n')) {
    const indent = line.length - line.trimStart().length
    if (blockIndent !== undefined && line.trim() !== '') {
      if (indent > blockIndent) {
        out.push(line)
        continue
      }
      blockIndent = undefined
    }
    if (/^\s*(?:-\s+)?[\w-]+:[ \t]*[|>][+-]?\s*$/u.test(line)) {
      blockIndent = indent
      out.push(line)
      continue
    }
    out.push(preserveValueLine(line))
  }
  return out.join('\n')
}

const MAPPING_LINE = /^(\s*)((?:-\s+)?[\w-]+:[ \t]+)(.*)$/u
const ITEM_LINE = /^(\s*-[ \t]+)(.*)$/u

function preserveValueLine(line: string): string {
  const mapping = MAPPING_LINE.exec(line)
  if (mapping !== null) return mapping[1] + mapping[2] + preserveValue(mapping[3])
  const item = ITEM_LINE.exec(line)
  if (item === null) return line
  const rest = item[2]
  // `- key: value` 是映射项，继续按值处理；`- 纯文本` 才当标量。
  const nested = MAPPING_LINE.exec(rest)
  if (nested !== null) return item[1] + nested[1] + nested[2] + preserveValue(nested[3])
  return item[1] + preserveValue(rest)
}

function preserveValue(value: string): string {
  const trimmed = value.trimEnd()
  if (trimmed === '') return value
  const first = trimmed[0]
  if (first === "'" || first === '"' || first === '|' || first === '>') return value
  if (RESERVED_START.test(trimmed) || / #/u.test(trimmed) || /: /u.test(trimmed)) return quoteScalar(trimmed)
  return value
}

/** 激进修复：tab 缩进换成两空格；值以引号开头却没闭合时在行尾补上。 */
function repairScalars(source: string): string {
  return source.split('\n').map((line) => {
    const expanded = line.replace(/^\t+/u, (tabs) => ' '.repeat(tabs.length * 2))
    const mapping = MAPPING_LINE.exec(expanded)
    if (mapping !== null) return mapping[1] + mapping[2] + closeQuoted(mapping[3])
    const item = ITEM_LINE.exec(expanded)
    if (item !== null) return item[1] + closeQuoted(item[2])
    return expanded
  }).join('\n')
}

function closeQuoted(value: string): string {
  const trimmed = value.trimEnd()
  for (const quote of ["'", '"'] as const) {
    if (!trimmed.startsWith(quote)) continue
    // `'a''b'` 这种以成对引号结尾的也算闭合。
    if (trimmed.length > 1 && trimmed.endsWith(quote)) return value
    return `${trimmed}${quote}`
  }
  return value
}

function quoteScalar(value: string): string {
  return `'${value.replaceAll("'", "''")}'`
}

function readCheck(value: unknown): DocCheck | undefined {
  if (!isRecord(value)) return undefined
  const label = requiredText(value.label)
  if (label === undefined) return undefined
  if (value.status !== 'pass' && value.status !== 'fail' && value.status !== 'skip') return undefined
  const detail = optionalText(value.detail)
  if (!detail.ok) return undefined
  return { status: value.status, label, detail: detail.value }
}

function readChange(value: unknown): DocChange | undefined {
  if (!isRecord(value)) return undefined
  const path = requiredText(value.path)
  if (path === undefined) return undefined
  const summary = optionalText(value.summary)
  const stats = optionalText(value.stats)
  if (!summary.ok || !stats.ok) return undefined
  return { path, summary: summary.value, stats: stats.value }
}

/**
 * 解析一段围栏里的 YAML。结构不合法时返回 undefined，调用方退回普通 markdown 渲染，
 * 所以这里只认契约里的形状，多余字段忽略、少字段一律判非法。
 */
export function parseDocBlock(source: string): ParsedDocBlock | undefined {
  const document = parseLoose(source)
  if (!isRecord(document)) return undefined
  if (document.type === 'cards') {
    const items = document.items
    if (!Array.isArray(items) || items.length === 0) return undefined
    const cards: DocCard[] = []
    for (const entry of items) {
      const card = readCard(entry)
      if (card === undefined) return undefined
      cards.push(card)
    }
    return { type: 'cards', items: cards }
  }
  if (document.type === 'compare') {
    const left = readPanel(document.left)
    const right = readPanel(document.right)
    if (left === undefined || right === undefined) return undefined
    return { type: 'compare', left, right }
  }
  if (document.type === 'checks') {
    const items = document.items
    if (!Array.isArray(items) || items.length === 0) return undefined
    const checks: DocCheck[] = []
    for (const entry of items) {
      const check = readCheck(entry)
      if (check === undefined) return undefined
      checks.push(check)
    }
    return { type: 'checks', items: checks }
  }
  if (document.type === 'changes') {
    const items = document.items
    if (!Array.isArray(items) || items.length === 0) return undefined
    const changes: DocChange[] = []
    for (const entry of items) {
      const change = readChange(entry)
      if (change === undefined) return undefined
      changes.push(change)
    }
    return { type: 'changes', items: changes }
  }
  if (document.type === 'note') return readNote(document)
  return undefined
}

/** 提示块的字段校验，整块解析与流式宽松解析共用。 */
function readNote(document: Record<string, unknown>): ParsedDocBlock | undefined {
  const icon = optionalText(document.icon)
  const title = optionalText(document.title)
  const body = optionalText(document.body)
  const code = optionalText(document.code)
  const label = optionalText(document.label)
  if (!icon.ok || !title.ok || !body.ok || !code.ok || !label.ok) return undefined
  // 标题和正文都没有的话，这块没有可读内容。
  if (title.value === undefined && body.value === undefined) return undefined
  return {
    type: 'note', icon: icon.value, title: title.value,
    body: body.value, code: code.value, label: label.value,
  }
}

/**
 * 圆形描边徽章。卡片和提示块的徽章占着固定的一行高度，模型没写图标（或写了
 * 表外名字）时不能直接消失——那样标题会比其他卡片高一截。这类位置传
 * `placeholder`，用一个小圆点占住徽章位。
 */
function DocBadge({ icon, className, size, placeholder = false }: {
  readonly icon: DocIcon | undefined
  readonly className: string
  readonly size: number
  readonly placeholder?: boolean
}) {
  const Glyph = icon
  return <span className={className} aria-hidden="true">
    {Glyph === undefined ? (placeholder ? <span className={css.badgeDot} /> : null) : <Glyph size={size} />}
  </span>
}

function DocBullets({ items, onOpenFile }: {
  readonly items: readonly string[]
  readonly onOpenFile?: ((path: string) => void) | undefined
}) {
  if (items.length === 0) return null
  return <ul className={css.bullets}>
    {items.map((item, index) => <li key={`${index}:${item}`} className={css.bullet}>
      <DocInline text={item} onOpenFile={onOpenFile} />
    </li>)}
  </ul>
}

function CardsBlock({ items, onOpenFile }: {
  readonly items: readonly DocCard[]
  readonly onOpenFile?: ((path: string) => void) | undefined
}): ReactElement {
  // 列数由卡片数量决定：3 张一排是设计稿的基准，更多就固定两列并给第二行加顶线。
  const count = items.length > 3 ? 'many' : String(items.length)
  return <div className={css.cardGrid} data-count={count}>
    {items.map((item, index) => (
      <section key={`${index}:${item.title}`} className={css.card}>
        <DocBadge icon={iconOf(item.icon)} className={css.cardBadge} size={18} placeholder />
        <h3 className={css.cardTitle}>{item.title}</h3>
        {item.body !== undefined && <p className={css.cardBody}><DocInline text={item.body} onOpenFile={onOpenFile} /></p>}
        <DocBullets items={item.bullets} onOpenFile={onOpenFile} />
      </section>
    ))}
  </div>
}

/** 对比栏：左栏是弱化版，右栏是强调版；徽章用 ✓/✕ 表达取舍。 */
function ComparePanel({ panel, tone, onOpenFile }: {
  readonly panel: DocPanel
  readonly tone: 'muted' | 'accent'
  readonly onOpenFile?: ((path: string) => void) | undefined
}): ReactElement {
  const badge = panel.badge === 'check' ? IconCheckOutlineRegular
    : panel.badge === 'cross' ? IconCloseOutlineRegular : undefined
  return <section className={tone === 'accent' ? css.panelAccent : css.panelMuted} data-badge={panel.badge}>
    <DocBadge icon={badge} className={css.panelBadge} size={12} />
    <h3 className={css.panelTitle}>{panel.title}</h3>
    {panel.subtitle !== undefined && <p className={css.panelSubtitle}><DocInline text={panel.subtitle} onOpenFile={onOpenFile} /></p>}
    <DocBullets items={panel.bullets} onOpenFile={onOpenFile} />
    {panel.footer !== undefined && <p className={css.panelFooter}><DocInline text={panel.footer} onOpenFile={onOpenFile} /></p>}
  </section>
}

/**
 * 强调跟着徽章走，而不是跟着左右位置走：模型可能把推荐项放在左边，
 * 只按位置写死会让「✓ 推荐」拿到灰底、「✗ 不推荐」拿到白底加边框，
 * 视觉语义正好反过来。两侧徽章相同时才退回左弱右强的排法。
 */
function compareTone(panel: DocPanel, fallback: 'muted' | 'accent'): 'muted' | 'accent' {
  if (panel.badge === 'check') return 'accent'
  if (panel.badge === 'cross') return 'muted'
  return fallback
}

function CompareBlock({ left, right, onOpenFile }: {
  readonly left: DocPanel
  readonly right: DocPanel
  readonly onOpenFile?: ((path: string) => void) | undefined
}): ReactElement {
  return <div className={css.compareGrid}>
    <ComparePanel panel={left} tone={compareTone(left, 'muted')} onOpenFile={onOpenFile} />
    <ComparePanel panel={right} tone={compareTone(right, 'accent')} onOpenFile={onOpenFile} />
  </div>
}

/** 验证结果：✓ 通过 / ✗ 失败 / – 未执行，右侧是可复制的命令或说明。 */
function ChecksBlock({ items, onOpenFile }: {
  readonly items: readonly DocCheck[]
  readonly onOpenFile?: ((path: string) => void) | undefined
}): ReactElement {
  return <ul className={css.checkList}>
    {items.map((item, index) => (
      <li key={`${index}:${item.label}`} className={css.checkRow} data-status={item.status}>
        <span className={css.checkMark} aria-hidden="true">
          {item.status === 'pass' ? <IconCheckCircleOutlineRegular size={15} />
            : item.status === 'fail' ? <IconCloseCircleFillRegular size={15} />
              : <span className={css.checkSkip}>–</span>}
        </span>
        <span className={css.checkLabel}>{item.label}</span>
        {item.detail !== undefined && <span className={css.checkDetail}><DocInline text={item.detail} onOpenFile={onOpenFile} /></span>}
      </li>
    ))}
  </ul>
}

/**
 * 改动清单：文件行，路径可点开 Inspector，右侧显示增删统计。
 *
 * 统计优先用本轮真实的产物算（模型写的不一定准，也可能漏）；这一行不是本轮
 * 改过的文件时，才退回模型自己写的数字。
 */
function ChangesBlock({ items, artifacts, onOpenFile }: {
  readonly items: readonly DocChange[]
  readonly artifacts?: readonly FileArtifact[] | undefined
  readonly onOpenFile?: ((path: string) => void) | undefined
}): ReactElement {
  return <ul className={css.changeList}>
    {items.map((item, index) => {
      const stats = formatFileStats(fileStats(artifacts ?? [], item.path)) ?? item.stats
      return <li key={`${index}:${item.path}`} className={css.changeRow}>
        <span className={css.changeIcon} aria-hidden="true"><IconDeliverDocRegular size={15} /></span>
        <span className={css.changeBody}>
          {/* 模型偶尔把「3 个测试文件」这种说明写进 path；不像路径的就别做成可点按钮。 */}
          <button type="button" className={`${css.inlineCode} ${css.inlinePath} ${css.changePath}`}
            disabled={onOpenFile === undefined || classifyCode(item.path) !== 'path'} title={item.path}
            onClick={() => { onOpenFile?.(item.path) }}>{item.path}</button>
          {item.summary !== undefined && <span className={css.changeSummary}><DocInline text={item.summary} onOpenFile={onOpenFile} /></span>}
        </span>
        {stats !== undefined && <span className={css.changeStats}>{stats}</span>}
      </li>
    })}
  </ul>
}

function NoteBlock({ block, onOpenFile }: {
  readonly block: Extract<ParsedDocBlock, { type: 'note' }>
  readonly onOpenFile?: ((path: string) => void) | undefined
}): ReactElement {
  // 没指定图标时用灯泡，指定了但映射查不到就不画。
  const icon = block.icon === undefined ? IconLightOutlineRegular : iconOf(block.icon)
  return <div className={css.note}>
    <DocBadge icon={icon} className={css.noteBadge} size={16} placeholder />
    <div className={css.noteContent}>
      {block.title !== undefined && <div className={css.noteTitleRow}>
        <h3 className={css.noteTitle}>{block.title}</h3>
        {block.code === undefined && block.label !== undefined && <span className={css.noteChip}>{block.label}</span>}
      </div>}
      {block.body !== undefined && <p className={css.noteBody}><DocInline text={block.body} onOpenFile={onOpenFile} /></p>}
      {block.code !== undefined && <div className={css.noteCodeWrap} data-label={block.label !== undefined}>
        {block.label !== undefined && <span className={css.noteChip}>{block.label}</span>}
        <pre className={css.noteCode}>{block.code}</pre>
      </div>}
    </div>
  </div>
}

/**
 * 流式期间的宽松解析：模型还没写完时，按「最长可解析前缀 + 完整条目」渲染已经
 * 写好的部分。
 *
 * 先整块解析（围栏没闭合时内容也可能已经完整）；不行就按行往回退，找到能解析的
 * 最长前缀，再丢掉末尾字段不全的条目——卡片随字数增长逐张出现，而不是先显示一坨
 * 原始 YAML、最后再跳一下。
 */
export function parseDocBlockPartial(source: string): ParsedDocBlock | undefined {
  const lines = source.split('\n')
  for (let end = lines.length; end > 0; end -= 1) {
    const document = parseLoose(lines.slice(0, end).join('\n'))
    if (!isRecord(document)) continue
    const block = lenientBlock(document)
    if (block !== undefined) return block
  }
  return undefined
}

/** 只保留结构完整的条目；末尾半截的条目丢掉，整块没有完整内容时返回 undefined。 */
function lenientBlock(document: Record<string, unknown>): ParsedDocBlock | undefined {
  if (document.type === 'cards') {
    const items = Array.isArray(document.items) ? document.items : []
    const cards: DocCard[] = []
    for (const entry of items) {
      const card = readCard(entry)
      if (card === undefined) break
      cards.push(card)
    }
    return cards.length === 0 ? undefined : { type: 'cards', items: cards }
  }
  if (document.type === 'checks') {
    const items = Array.isArray(document.items) ? document.items : []
    const checks: DocCheck[] = []
    for (const entry of items) {
      const check = readCheck(entry)
      if (check === undefined) break
      checks.push(check)
    }
    return checks.length === 0 ? undefined : { type: 'checks', items: checks }
  }
  if (document.type === 'changes') {
    const items = Array.isArray(document.items) ? document.items : []
    const changes: DocChange[] = []
    for (const entry of items) {
      const change = readChange(entry)
      if (change === undefined) break
      changes.push(change)
    }
    return changes.length === 0 ? undefined : { type: 'changes', items: changes }
  }
  if (document.type === 'compare') {
    const left = readPanel(document.left)
    const right = readPanel(document.right)
    return left === undefined || right === undefined ? undefined : { type: 'compare', left, right }
  }
  if (document.type === 'note') return readNote(document)
  return undefined
}

/**
 * 渲染一个 doc 块。
 *
 * 解析失败时按原文显示而不是返回 null：模型偶尔会在值里写出未加引号的
 * `: `（例如 `code: const s = create(({ tab: 'x' }))`），YAML 解析器会整块
 * 拒绝。整块消失比显示得不好更糟——读者会以为这一节本来就不存在。
 */
export function DocBlockView({ source, partial, streaming, artifacts, onOpenFile }: {
  readonly source: string
  /** The fence is still open, so render the entries that are already complete. */
  readonly partial?: boolean
  /** The message is still streaming; an unformed partial block stays invisible. */
  readonly streaming?: boolean
  /** This run's file changes; the changes block derives its diff stats from them. */
  readonly artifacts?: readonly FileArtifact[] | undefined
  /** Opens a workspace file from a path chip; absent on surfaces without an inspector. */
  readonly onOpenFile?: ((path: string) => void) | undefined
}): ReactElement | null {
  const block = parseDocBlock(source) ?? (partial === true ? parseDocBlockPartial(source) : undefined)
  if (block === undefined) {
    // 还在写、又没成形：先不显示，免得闪一坨原始 YAML 再跳成卡片。
    if (partial === true && streaming === true) return null
    return <div className={css.fallback} data-doc-block="invalid" role="note">
      <span className={css.fallbackLabel}>结构化块格式错误，已按原文显示</span>
      <pre className={css.fallbackCode}>{source.trimEnd()}</pre>
    </div>
  }
  const partialAttr = partial === true ? '' : undefined
  if (block.type === 'cards') {
    return <div className={css.root} data-doc-block="cards" data-doc-partial={partialAttr}><CardsBlock items={block.items} onOpenFile={onOpenFile} /></div>
  }
  if (block.type === 'compare') {
    return <div className={css.root} data-doc-block="compare" data-doc-partial={partialAttr}><CompareBlock left={block.left} right={block.right} onOpenFile={onOpenFile} /></div>
  }
  if (block.type === 'checks') {
    return <div className={css.root} data-doc-block="checks" data-doc-partial={partialAttr}><ChecksBlock items={block.items} onOpenFile={onOpenFile} /></div>
  }
  if (block.type === 'changes') {
    return <div className={css.root} data-doc-block="changes" data-doc-partial={partialAttr}><ChangesBlock items={block.items} artifacts={artifacts} onOpenFile={onOpenFile} /></div>
  }
  return <div className={css.root} data-doc-block="note" data-doc-partial={partialAttr}><NoteBlock block={block} onOpenFile={onOpenFile} /></div>
}
