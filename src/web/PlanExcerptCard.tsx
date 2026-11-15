import { useState, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent, type ReactNode } from 'react'
import { ArrowRight } from 'lucide-react'
import { IconCheckOutlineRegular, IconCopyOutlineRegular, IconPlanOutlineRegular, MarkdownText } from '@deepseek-ai/dsh-client-ui-primitives'
import { markdownLabels, type Translate } from './render-labels.ts'
import css from './QuestionComposer.module.css'

/**
 * 功能：ZCode 风格的计划卡片（对应 `ToolCallBlocks/renderers/switch-mode.tsx`）：
 * 「计划」标题 + 复制按钮、被渐隐裁切的计划 Markdown 摘要，以及居中的
 * 「查看完整计划」胶囊按钮。整卡可点击打开完整计划，但点击真正的子控件时不触发。
 * 输入框旁的评审卡片与会话记录里的 `exit_plan_mode` 行都复用本组件。
 * @param props markdown 计划全文；onOpen 打开完整计划的回调（缺省时卡片不可激活）；
 *              t 双语翻译函数；ariaLabel 卡片无障碍标签；className 外层 section 类名
 *              （评审卡传 composer 卡片类，会话行传自己的类）；dataStatus 附加状态标记；
 *              children 渲染在标题与摘要之间（评审卡的反馈输入行）。
 * 内部逻辑：copied 状态记录复制成功 1.5 秒后复位；onChildControl 用 closest 判断
 * 事件目标是否落在真实子控件（button/a/input…）上，是则不触发卡片激活；
 * onCardClick/onCardKeyDown 分别处理鼠标与 Enter/空格激活；copyPlan 写剪贴板并切图标反馈。
 */
export function PlanExcerptCard({ markdown, onOpen, t, ariaLabel, className, dataStatus, children }: {
  markdown: string
  onOpen?: () => void
  t: Translate
  ariaLabel: string
  /** 外层 section 的类名；评审卡传 composer 卡片类，会话行传自己的类。 */
  className: string
  dataStatus?: string
  /** 渲染在标题与摘要之间（评审卡的反馈行）。 */
  children?: ReactNode
}) {
  const [copied, setCopied] = useState(false)

  /** 判断事件是否来自卡片内的真实子控件（而非卡片本身），用于排除激活误触。 */
  const onChildControl = (event: ReactMouseEvent<HTMLElement> | ReactKeyboardEvent<HTMLElement>): boolean =>
    event.target instanceof Element
    && event.target.closest('button, a, input, textarea, select, [role="button"]') !== event.currentTarget
  /** 卡片点击激活：命中子控件时跳过，否则回调 onOpen。 */
  const onCardClick = (event: ReactMouseEvent<HTMLElement>): void => {
    if (onChildControl(event)) return
    onOpen?.()
  }
  /** 键盘激活：Enter/空格触发 onOpen，其余按键忽略；同样排除子控件。 */
  const onCardKeyDown = (event: ReactKeyboardEvent<HTMLElement>): void => {
    if (event.key !== 'Enter' && event.key !== ' ') return
    if (onChildControl(event)) return
    event.preventDefault()
    onOpen?.()
  }
  /** 复制计划全文到剪贴板，成功后置 copied 为 true，1.5 秒后自动复位。 */
  const copyPlan = (): void => {
    navigator.clipboard?.writeText(markdown).then(() => {
      setCopied(true)
      window.setTimeout(() => { setCopied(false) }, 1500)
    }, () => undefined)
  }

  return <section
    className={className}
    data-plan-card
    {...(dataStatus === undefined ? {} : { 'data-status': dataStatus })}
    aria-label={ariaLabel}
    {...(onOpen === undefined ? {} : { role: 'button' as const, tabIndex: 0, onClick: onCardClick, onKeyDown: onCardKeyDown })}
  >
    <header className={css.planHeader}>
      <span className={css.planGlyph} aria-hidden="true"><IconPlanOutlineRegular size={16} /></span>
      <h3 className={css.planHeading}>{t('计划', 'Plan')}</h3>
      <button type="button" className={css.planIconAction}
        aria-label={copied ? t('计划已复制', 'Plan copied') : t('复制计划', 'Copy plan')}
        onClick={event => { event.stopPropagation(); copyPlan() }}>
        {copied ? <IconCheckOutlineRegular size={14} /> : <IconCopyOutlineRegular size={14} />}
      </button>
    </header>
    {children}
    <div className={css.planClip}>
      <div className={css.planExcerpt} data-plan-body>
        <MarkdownText text={markdown} labels={markdownLabels(t)} />
      </div>
      {onOpen !== undefined && <button type="button" className={css.planPill} data-plan-full
        aria-label={t('在侧边栏打开计划', 'Open plan in sidebar')}
        onClick={event => { event.stopPropagation(); onOpen() }}>
        {t('查看完整计划', 'View full plan')}
        <ArrowRight size={16} aria-hidden="true" />
      </button>}
    </div>
  </section>
}
