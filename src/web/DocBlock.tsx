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
 * 先按原样解析；失败时把「以反引号开头的值」整体加引号再试一次。
 *
 * YAML 把反引号列为保留字符，`- \`a.md\` (12 KB)` 这种写法整块非法——而契约恰好
 * 要求模型在块内用反引号包路径和命令，所以这个错误会反复出现。这不是「这块不是
 * doc 块」，而是模型写得不够严谨，值得救一次。
 */
function parseLoose(source: string): unknown {
  try {
    return parseYaml(source)
  } catch {
    try {
      return parseYaml(quoteReservedStarts(source))
    } catch {
      // 修不回来才当作「这块不是 doc 块」。
      return undefined
    }
  }
}

/** 给以反引号开头的映射值和序列项加单引号，其余行原样保留。 */
function quoteReservedStarts(source: string): string {
  return source.split('\n').map((line) => {
    const mapping = /^(\s*[\w-]+:[ \t]+)(`.*)$/u.exec(line)
    if (mapping !== null) return mapping[1] + quoteScalar(mapping[2])
    const item = /^(\s*-[ \t]+)(`.*)$/u.exec(line)
    if (item !== null) return item[1] + quoteScalar(item[2])
    return line
  }).join('\n')
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
  if (document.type === 'note') {
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
  return undefined
}

/** 圆形描边徽章；没有图标就整块不渲染，不留空壳。 */
function DocBadge({ icon, className, size }: { readonly icon: DocIcon | undefined; readonly className: string; readonly size: number }) {
  if (icon === undefined) return null
  const Glyph = icon
  return <span className={className} aria-hidden="true"><Glyph size={size} /></span>
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
        <DocBadge icon={iconOf(item.icon)} className={css.cardBadge} size={18} />
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
    <DocBadge icon={icon} className={css.noteBadge} size={16} />
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
 * 渲染一个 doc 块。
 *
 * 解析失败时按原文显示而不是返回 null：模型偶尔会在值里写出未加引号的
 * `: `（例如 `code: const s = create(({ tab: 'x' }))`），YAML 解析器会整块
 * 拒绝。整块消失比显示得不好更糟——读者会以为这一节本来就不存在。
 */
export function DocBlockView({ source, artifacts, onOpenFile }: {
  readonly source: string
  /** This run's file changes; the changes block derives its diff stats from them. */
  readonly artifacts?: readonly FileArtifact[] | undefined
  /** Opens a workspace file from a path chip; absent on surfaces without an inspector. */
  readonly onOpenFile?: ((path: string) => void) | undefined
}): ReactElement | null {
  const block = parseDocBlock(source)
  if (block === undefined) {
    return <div className={css.fallback} data-doc-block="invalid" role="note">
      <span className={css.fallbackLabel}>结构化块格式错误，已按原文显示</span>
      <pre className={css.fallbackCode}>{source.trimEnd()}</pre>
    </div>
  }
  if (block.type === 'cards') {
    return <div className={css.root} data-doc-block="cards"><CardsBlock items={block.items} onOpenFile={onOpenFile} /></div>
  }
  if (block.type === 'compare') {
    return <div className={css.root} data-doc-block="compare"><CompareBlock left={block.left} right={block.right} onOpenFile={onOpenFile} /></div>
  }
  if (block.type === 'checks') {
    return <div className={css.root} data-doc-block="checks"><ChecksBlock items={block.items} onOpenFile={onOpenFile} /></div>
  }
  if (block.type === 'changes') {
    return <div className={css.root} data-doc-block="changes"><ChangesBlock items={block.items} artifacts={artifacts} onOpenFile={onOpenFile} /></div>
  }
  return <div className={css.root} data-doc-block="note"><NoteBlock block={block} onOpenFile={onOpenFile} /></div>
}
