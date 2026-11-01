import { useState, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent, type ReactNode } from 'react'
import { ArrowRight } from 'lucide-react'
import { IconCheckOutlineRegular, IconCopyOutlineRegular, IconPlanOutlineRegular, MarkdownText } from '@deepseek-ai/dsh-client-ui-primitives'
import { markdownLabels, type Translate } from './render-labels.ts'
import css from './QuestionComposer.module.css'

/**
 * ZCode's plan card (`ToolCallBlocks/renderers/switch-mode.tsx`): a "计划" header with a copy
 * action, the markdown clipped to a fading excerpt, and a centered "查看完整计划" pill that
 * opens the full plan. The whole card is clickable like ZCode's, with real child controls
 * excluded from the activation. Both the composer-adjacent review card and the transcript's
 * `exit_plan_mode` row render this component.
 */
export function PlanExcerptCard({ markdown, onOpen, t, ariaLabel, className, dataStatus, children }: {
  markdown: string
  onOpen?: () => void
  t: Translate
  ariaLabel: string
  /** The section class; the review card passes its composer card, the transcript row its own. */
  className: string
  dataStatus?: string
  /** Rendered between the header and the excerpt (the review card's feedback line). */
  children?: ReactNode
}) {
  const [copied, setCopied] = useState(false)

  const onChildControl = (event: ReactMouseEvent<HTMLElement> | ReactKeyboardEvent<HTMLElement>): boolean =>
    event.target instanceof Element
    && event.target.closest('button, a, input, textarea, select, [role="button"]') !== event.currentTarget
  const onCardClick = (event: ReactMouseEvent<HTMLElement>): void => {
    if (onChildControl(event)) return
    onOpen?.()
  }
  const onCardKeyDown = (event: ReactKeyboardEvent<HTMLElement>): void => {
    if (event.key !== 'Enter' && event.key !== ' ') return
    if (onChildControl(event)) return
    event.preventDefault()
    onOpen?.()
  }
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
