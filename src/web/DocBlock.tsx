import type { ComponentType, ReactElement } from 'react'
import { parse as parseYaml } from 'yaml'
import {
  IconArchiveOutlineRegular,
  IconBranchOutlineRegular,
  IconCheckOutlineRegular,
  IconCloseOutlineRegular,
  IconCodeOutlineRegular,
  IconCompactOutlineRegular,
  IconCompareSplitOutlineRegular,
  IconContextInjectionOutlineRegular,
  IconDarkOutlineRegular,
  IconDatabaseOutlineRegular,
  IconDeliverDocRegular,
  IconEnhanceOutlineRegular,
  IconFolderOpenOutlineRegular,
  IconGaugeOutlineRegular,
  IconGlobeOutlineRegular,
  IconGoalOutlineRegular,
  IconInfoOutlineRegular,
  IconLightOutlineRegular,
  IconListPenOutlineRegular,
  IconPersonalizationOutlineRegular,
  IconPlanOutlineRegular,
  IconQueueOutlineRegular,
  IconSearchOutlineRegular,
  IconSettingsOutlineRegular,
  IconSkillOutlineRegular,
  IconSlidersTwoOutlineRegular,
  IconSparkleRegular,
  IconThinkOutlineRegular,
  IconTreeCornerRegular,
  IconUserOutlineRegular,
  IconWarningTriangleOutlineRegular,
} from '@deepseek-ai/dsh-client-ui-primitives'
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

export type ParsedDocBlock =
  | { readonly type: 'cards'; readonly items: readonly DocCard[] }
  | { readonly type: 'compare'; readonly left: DocPanel; readonly right: DocPanel }
  | { readonly type: 'note'; readonly icon: string | undefined; readonly title: string | undefined
    readonly body: string | undefined; readonly code: string | undefined; readonly label: string | undefined }

/**
 * 语义名到设计稿图标的映射。模型可能写出表外名字，映射查不到时只是不画图标，
 * 不能让整块因为一个图标名丢掉。
 * `doc`/`sparkle`/`tree` 在图标库里没有 Outline 变体，用同族的 Regular 版本。
 */
const ICONS: Record<string, ComponentType<{ size?: number }>> = {
  text: IconListPenOutlineRegular,
  space: IconCompactOutlineRegular,
  color: IconDarkOutlineRegular,
  code: IconCodeOutlineRegular,
  doc: IconDeliverDocRegular,
  compare: IconCompareSplitOutlineRegular,
  sparkle: IconSparkleRegular,
  bulb: IconLightOutlineRegular,
  check: IconCheckOutlineRegular,
  cross: IconCloseOutlineRegular,
  info: IconInfoOutlineRegular,
  warn: IconWarningTriangleOutlineRegular,
  plan: IconPlanOutlineRegular,
  goal: IconGoalOutlineRegular,
  tree: IconTreeCornerRegular,
  search: IconSearchOutlineRegular,
  skill: IconSkillOutlineRegular,
  data: IconDatabaseOutlineRegular,
  layers: IconPersonalizationOutlineRegular,
  chart: IconGaugeOutlineRegular,
  sliders: IconSlidersTwoOutlineRegular,
  globe: IconGlobeOutlineRegular,
  branch: IconBranchOutlineRegular,
  archive: IconArchiveOutlineRegular,
  agent: IconUserOutlineRegular,
  folder: IconFolderOpenOutlineRegular,
  settings: IconSettingsOutlineRegular,
  think: IconThinkOutlineRegular,
  enhance: IconEnhanceOutlineRegular,
  injection: IconContextInjectionOutlineRegular,
  queue: IconQueueOutlineRegular,
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
 * 解析一段围栏里的 YAML。结构不合法时返回 undefined，调用方退回普通 markdown 渲染，
 * 所以这里只认契约里的形状，多余字段忽略、少字段一律判非法。
 */
export function parseDocBlock(source: string): ParsedDocBlock | undefined {
  let document: unknown
  try {
    document = parseYaml(source)
  } catch {
    // YAML 语法错误不是异常路径，而是「这块不是 doc 块」的正常结果。
    return undefined
  }
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

function DocBullets({ items }: { readonly items: readonly string[] }) {
  if (items.length === 0) return null
  return <ul className={css.bullets}>
    {items.map((item, index) => <li key={`${index}:${item}`} className={css.bullet}>{item}</li>)}
  </ul>
}

function CardsBlock({ items }: { readonly items: readonly DocCard[] }): ReactElement {
  return <div className={css.cardGrid}>
    {items.map((item, index) => (
      <section key={`${index}:${item.title}`} className={css.card}>
        <DocBadge icon={iconOf(item.icon)} className={css.cardBadge} size={18} />
        <h3 className={css.cardTitle}>{item.title}</h3>
        {item.body !== undefined && <p className={css.cardBody}>{item.body}</p>}
        <DocBullets items={item.bullets} />
      </section>
    ))}
  </div>
}

/** 对比栏：左栏是弱化版，右栏是强调版；徽章用 ✓/✕ 表达取舍。 */
function ComparePanel({ panel, tone }: { readonly panel: DocPanel; readonly tone: 'muted' | 'accent' }): ReactElement {
  const badge = panel.badge === 'check' ? IconCheckOutlineRegular
    : panel.badge === 'cross' ? IconCloseOutlineRegular : undefined
  return <section className={tone === 'accent' ? css.panelAccent : css.panelMuted} data-badge={panel.badge}>
    <DocBadge icon={badge} className={css.panelBadge} size={12} />
    <h3 className={css.panelTitle}>{panel.title}</h3>
    {panel.subtitle !== undefined && <p className={css.panelSubtitle}>{panel.subtitle}</p>}
    <DocBullets items={panel.bullets} />
    {panel.footer !== undefined && <p className={css.panelFooter}>{panel.footer}</p>}
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

function CompareBlock({ left, right }: { readonly left: DocPanel; readonly right: DocPanel }): ReactElement {
  return <div className={css.compareGrid}>
    <ComparePanel panel={left} tone={compareTone(left, 'muted')} />
    <ComparePanel panel={right} tone={compareTone(right, 'accent')} />
  </div>
}

function NoteBlock({ block }: { readonly block: Extract<ParsedDocBlock, { type: 'note' }> }): ReactElement {
  // 没指定图标时用灯泡，指定了但映射查不到就不画。
  const icon = block.icon === undefined ? IconLightOutlineRegular : iconOf(block.icon)
  return <div className={css.note}>
    <DocBadge icon={icon} className={css.noteBadge} size={16} />
    <div className={css.noteContent}>
      {block.title !== undefined && <div className={css.noteTitleRow}>
        <h3 className={css.noteTitle}>{block.title}</h3>
        {block.code === undefined && block.label !== undefined && <span className={css.noteChip}>{block.label}</span>}
      </div>}
      {block.body !== undefined && <p className={css.noteBody}>{block.body}</p>}
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
export function DocBlockView({ source }: { readonly source: string }): ReactElement | null {
  const block = parseDocBlock(source)
  if (block === undefined) {
    return <div className={css.fallback} data-doc-block="invalid" role="note">
      <span className={css.fallbackLabel}>结构化块格式错误，已按原文显示</span>
      <pre className={css.fallbackCode}>{source.trimEnd()}</pre>
    </div>
  }
  if (block.type === 'cards') {
    return <div className={css.root} data-doc-block="cards"><CardsBlock items={block.items} /></div>
  }
  if (block.type === 'compare') {
    return <div className={css.root} data-doc-block="compare"><CompareBlock left={block.left} right={block.right} /></div>
  }
  return <div className={css.root} data-doc-block="note"><NoteBlock block={block} /></div>
}
