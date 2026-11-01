import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { PlanExcerptCard } from './PlanExcerptCard.tsx'
import type { AskUserQuestionAnswerItem, AskUserQuestionItem, InteractionRequest, InteractionStatus } from '../shared/types.ts'
import { ApiFailure, api } from './api.ts'
import { planTitle as planHeadingOf } from './plan-preview.ts'
import { useUiPreferences } from './ui-preferences.tsx'
import css from './QuestionComposer.module.css'

/** DSH's "(Recommended)" / "（推荐）" suffix renders as a badge instead of part of the label. */
const RECOMMENDED_SUFFIX = /\s*[（(]\s*(?:recommended|推荐)\s*[)）]\s*$/iu
/** Answer id the plan-review card submits; the route only inspects the selected labels. */
const PLAN_REVIEW_ANSWER_ID = 'plan-review'
/** The approve option the decision card shows, matching ZCode's plan-approval elicitation. */
const PLAN_APPROVE_OPTION = '批准'

type DraftAnswer = { selected: string[]; custom: string }
type AnsweredLocally = { answers: AskUserQuestionAnswerItem[] }
type PlanDecisionLocally = { approved: boolean }

function initialDrafts(questions: readonly AskUserQuestionItem[]): Record<string, DraftAnswer> {
  return Object.fromEntries(questions.map(question => [question.id, { selected: [], custom: '' }]))
}

function questionInteraction(interaction: InteractionRequest | undefined): interaction is InteractionRequest & { questions: AskUserQuestionItem[] } {
  return interaction !== undefined && interaction.kind === 'question' && (interaction.questions?.length ?? 0) > 0
}

function planReviewInteraction(interaction: InteractionRequest | undefined): interaction is InteractionRequest & { detail: string } {
  return interaction !== undefined && interaction.kind === 'plan-review' && (interaction.detail ?? '').trim() !== ''
}

function renderable(interaction: InteractionRequest): boolean {
  return questionInteraction(interaction) || planReviewInteraction(interaction)
}

/** The newest pending interaction, so a fresh request always wins over an older one. */
function newest(interactions: readonly InteractionRequest[] | undefined): InteractionRequest | undefined {
  return (interactions ?? []).filter(interaction => interaction.status === 'pending' && renderable(interaction))
    .sort((left, right) => right.createdAt - left.createdAt)[0]
}

function splitRecommended(label: string): { text: string; recommended: boolean } {
  const match = RECOMMENDED_SUFFIX.exec(label)
  return match ? { text: label.slice(0, match.index).trimEnd(), recommended: true } : { text: label, recommended: false }
}

/**
 * DSH's interaction card above the composer: the newest pending question or plan review, one at a
 * time. Questions keep per-question navigation and option/custom answers; a plan review renders the
 * submitted plan and offers "request changes" (dismiss and hand focus back to the composer) or the
 * server-provided approve label. A settled interaction leaves the card for good — the transcript's
 * tool row keeps the read-only record.
 */
export default function QuestionComposer({ conversationId, interactions, onAnswered, onDismiss, onOpenPlan }: {
  conversationId: string
  interactions?: readonly InteractionRequest[]
  onAnswered?: (detail: Awaited<ReturnType<typeof api.answerInteraction>>) => void
  /** Plan review only: the user wants changes, so collapse the card and focus the composer. */
  onDismiss?: () => void
  /** Plan review only: open the full plan in the inspector (DSH's 「查看全文」, `PlanCard.tsx:81-83`). */
  onOpenPlan?: (plan: { markdown: string; title?: string }) => void
}) {
  const { t } = useUiPreferences()
  const interaction = useMemo(() => newest(interactions), [interactions])
  const planReview = planReviewInteraction(interaction) ? interaction : undefined
  const questions = planReview === undefined ? interaction?.questions ?? [] : []
  const interactionId = interaction?.id ?? ''
  const [index, setIndex] = useState(0)
  const [drafts, setDrafts] = useState<Record<string, DraftAnswer>>(() => initialDrafts(questions))
  const [collapsed, setCollapsed] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [cancelling, setCancelling] = useState(false)
  const [error, setError] = useState('')
  const [answeredLocally, setAnsweredLocally] = useState<AnsweredLocally | null>(null)

  useEffect(() => {
    setIndex(0)
    setDrafts(initialDrafts(questions))
    setCollapsed(false)
    setSubmitting(false)
    setCancelling(false)
    setError('')
    setAnsweredLocally(null)
    // The interaction id is the identity: a new question set resets the whole card.
  }, [interactionId])

  if (planReview !== undefined) {
    return <PlanReviewCard key={planReview.id} conversationId={conversationId} review={planReview}
      onAnswered={onAnswered} onOpenPlan={onOpenPlan} />
  }
  if (!interaction || questions.length === 0) return null

  // A submitted answer hides the card immediately; the SSE snapshot settles the record in
  // the transcript's tool row.
  const readOnly = answeredLocally !== null
  const question = questions[Math.min(index, questions.length - 1)]!
  const draft = drafts[question.id] ?? { selected: [], custom: '' }

  const updateDraft = (id: string, update: Partial<DraftAnswer>): void => {
    setDrafts(current => ({ ...current, [id]: { selected: update.selected ?? current[id]?.selected ?? [], custom: update.custom ?? current[id]?.custom ?? '' } }))
  }

  const toggleOption = (label: string): void => {
    if (readOnly) return
    if (question.multiSelect) {
      const selected = draft.selected.includes(label) ? draft.selected.filter(item => item !== label) : [...draft.selected, label]
      updateDraft(question.id, { selected })
    } else {
      updateDraft(question.id, { selected: [label] })
    }
  }

  const collectAnswers = (source: Record<string, DraftAnswer>): AskUserQuestionAnswerItem[] => questions.map(item => {
    const value = source[item.id] ?? { selected: [], custom: '' }
    const custom = value.custom.trim()
    return { id: item.id, selected: [...value.selected], ...(custom ? { custom } : {}) }
  })

  const submit = async (source: Record<string, DraftAnswer> = drafts): Promise<void> => {
    if (readOnly || submitting) return
    const answers = collectAnswers(source)
    setSubmitting(true)
    setError('')
    try {
      const detail = await api.answerInteraction(conversationId, interaction.id, answers)
      setAnsweredLocally({ answers })
      onAnswered?.(detail)
    } catch (cause) {
      setError(cause instanceof ApiFailure ? cause.message : t('提交回答失败', 'Could not submit the answers'))
    } finally {
      setSubmitting(false)
    }
  }

  const advance = (): void => {
    if (index < questions.length - 1) setIndex(index + 1)
    else void submit()
  }

  /**
   * DSH's 「放弃整组问题」: end the whole request without answering. The server settles
   * the call as cancelled and steers the dismissal, so the card leaves the composer and
   * the tool row keeps a read-only cancelled record.
   */
  const cancelSet = async (): Promise<void> => {
    if (readOnly || submitting || cancelling) return
    setCancelling(true)
    setError('')
    try {
      const detail = await api.cancelInteraction(conversationId, interaction.id)
      onAnswered?.(detail)
    } catch (cause) {
      setError(cause instanceof ApiFailure ? cause.message : t('放弃整组问题失败', 'Could not dismiss the questions'))
    } finally {
      setCancelling(false)
    }
  }

  const skipCurrent = (): void => {
    const next = { ...drafts, [question.id]: { selected: [], custom: '' } }
    setDrafts(next)
    if (index < questions.length - 1) setIndex(index + 1)
    else void submit(next)
  }

  if (readOnly) return null

  if (collapsed) {
    return <section className={css.card} data-question-card data-status="pending">
      <button type="button" className={css.collapsedBar} onClick={() => setCollapsed(false)}>
        <span className={css.eyebrow}>{t('问答', 'Questions')}</span>
        <span className={css.collapsedText}>{t('问题待回答', 'Question waiting')}</span>
        <span className={css.counter}>{index + 1} / {questions.length}</span>
        <span className={css.expand}>{t('展开', 'Open')}</span>
      </button>
    </section>
  }

  return <section className={css.card} data-question-card data-status="pending" aria-label={t('问题', 'Question')}    onKeyDown={event => {
      if (event.key === 'Escape') {
        event.stopPropagation()
        setCollapsed(true)
        return
      }
      if (event.key === 'Enter' && !event.shiftKey) {
        const tag = (event.target as HTMLElement | null)?.tagName
        if (tag === 'TEXTAREA' || tag === 'BUTTON' || tag === 'INPUT') return
        event.preventDefault()
        advance()
      }
    }}>
    <header className={css.header}>
      <span className={css.eyebrow}>{t('问答', 'Questions')}</span>
      {question.header && <span className={css.chip}>{question.header}</span>}
      <span className={css.counter} data-question-progress>{index + 1} / {questions.length}</span>
      <button type="button" className={css.collapseButton} onClick={() => setCollapsed(true)} aria-label={t('收起', 'Collapse')}>
        {t('收起', 'Collapse')}
      </button>
      {interaction.status === 'pending' && (
        <button type="button" className={css.cancelButton} data-question-cancel disabled={submitting || cancelling}
          onClick={() => { void cancelSet() }}>
          {cancelling ? t('放弃中…', 'Dismissing…') : t('放弃整组问题', 'Dismiss all questions')}
        </button>
      )}
    </header>
    <div className={css.question} data-question-id={question.id}>{question.question}</div>
    {question.options && question.options.length > 0 && <div className={css.options} role={question.multiSelect ? 'group' : 'radiogroup'}
      aria-label={question.question}>
      {question.options.map((option) => {
        const { text, recommended: isRecommended } = splitRecommended(option.label)
        const checked = draft.selected.includes(option.label)
        return <button key={option.label} type="button" role={question.multiSelect ? 'checkbox' : 'radio'}
          aria-checked={checked} className={css.option} data-selected={checked || undefined} data-option-label={option.label}
          onClick={() => toggleOption(option.label)}>
          <span className={css.optionMark} aria-hidden="true">{checked ? '✓' : ''}</span>
          <span className={css.optionBody}>
            <span className={css.optionLabel}>{text}{isRecommended && <span className={css.recommended}>{t('推荐', 'Recommended')}</span>}</span>
            {option.description && <span className={css.optionDescription}>{option.description}</span>}
          </span>
        </button>
      })}
    </div>}
    <textarea className={css.custom} rows={1} value={draft.custom} placeholder={t('输入自定义答案（可选）', 'Type a custom answer (optional)')}
      data-question-custom
      onChange={event => updateDraft(question.id, { custom: event.target.value })}
      onKeyDown={event => {
        if (event.key === 'Escape') {
          event.preventDefault()
          event.stopPropagation()
          setCollapsed(true)
          return
        }
        if (event.key === 'Enter' && !event.shiftKey) {
          event.preventDefault()
          advance()
        }
      }} />
    {error !== '' && <div className={css.error} role="alert" data-question-error>{error}</div>}
    <footer className={css.footer}>
      <button type="button" className={css.secondary} disabled={index === 0} onClick={() => setIndex(index - 1)}>{t('上一题', 'Previous')}</button>
      <span className={css.footerSpacer} />
      <button type="button" className={css.secondary} data-question-skip onClick={skipCurrent}>{t('跳过', 'Skip')}</button>
      {index < questions.length - 1 && <button type="button" className={css.secondary} onClick={() => setIndex(index + 1)}>{t('下一题', 'Next')}</button>}
      <button type="button" className={css.submit} data-question-submit disabled={submitting} onClick={() => { void submit() }}>
        {submitting ? t('提交中…', 'Submitting…') : t('提交', 'Submit')}
      </button>
    </footer>
  </section>
}

/**
 * ZCode's plan review pair (`switch-mode.tsx` card + `ElicitationDialog`): a "计划" header with a
 * copy action, the plan markdown clipped to a fading excerpt with a centered "查看完整计划" pill,
 * and below it the permission card that carries the decision — "需要权限 · 实施计划" with the
 * numbered approve option, a free-form answer line, and 忽略/提交. Both cards are clickable like
 * ZCode's, with real child controls excluded from the activation.
 */
function PlanReviewCard({ conversationId, review, onAnswered, onOpenPlan }: {
  conversationId: string
  review: InteractionRequest & { detail: string }
  onAnswered?: (detail: Awaited<ReturnType<typeof api.answerInteraction>>) => void
  onOpenPlan?: (plan: { markdown: string; title?: string }) => void
}) {
  const { t } = useUiPreferences()
  const [submitting, setSubmitting] = useState(false)
  const [dismissing, setDismissing] = useState(false)
  const [error, setError] = useState('')
  const [decided, setDecided] = useState<PlanDecisionLocally | null>(null)
  const [approveSelected, setApproveSelected] = useState(false)
  const [feedbackText, setFeedbackText] = useState('')
  const composing = useRef(false)
  const status: InteractionStatus = decided !== null ? 'answered' : review.status
  const readOnly = status !== 'pending'
  const heading = planHeadingOf(review.detail)
  const openPlan = (): void => {
    onOpenPlan?.({ markdown: review.detail, ...(heading === undefined ? {} : { title: heading }) })
  }

  // A decided plan leaves the composer like an answered question; the transcript's
  // plan tool row keeps the record.
  if (readOnly) return null

  /**
   * ZCode's `continueOrSubmit`: selecting the approve option (or leaving everything empty — an
   * empty answer on a plan approval is an explicit approval, never a skip) approves the plan;
   * typed text alone travels back as the requested changes.
   */
  const submitDecision = async (): Promise<void> => {
    if (readOnly || submitting) return
    const feedback = feedbackText.trim()
    const selected = approveSelected || feedback === '' ? [PLAN_APPROVE_OPTION] : []
    setSubmitting(true)
    setError('')
    try {
      const detail = await api.answerInteraction(conversationId, review.id, [
        { id: PLAN_REVIEW_ANSWER_ID, selected, ...(feedback === '' ? {} : { custom: feedback }) },
      ])
      setDecided({ approved: selected.length > 0 })
      onAnswered?.(detail)
    } catch (cause) {
      setError(cause instanceof ApiFailure ? cause.message : t('提交计划决定失败', 'Could not submit the plan decision'))
    } finally {
      setSubmitting(false)
    }
  }

  const ignore = async (): Promise<void> => {
    if (readOnly || dismissing) return
    setDismissing(true)
    setError('')
    try {
      const detail = await api.cancelInteraction(conversationId, review.id)
      onAnswered?.(detail)
    } catch (cause) {
      setError(cause instanceof ApiFailure ? cause.message : t('放弃计划审阅失败', 'Could not dismiss the plan review'))
    } finally {
      setDismissing(false)
    }
  }

  // 上下键在批准选项与回答输入行之间移动（ZCode 的 keyboardHint 所指的行为）。
  const moveDecisionFocus = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
    const rows = [...event.currentTarget.querySelectorAll<HTMLElement>('[data-decision-row]')]
    const index = rows.indexOf(document.activeElement as HTMLElement)
    if (index === -1) return
    const next = rows[event.key === 'ArrowDown' ? index + 1 : index - 1]
    if (next !== undefined) {
      event.preventDefault()
      next.focus()
    }
  }

  const planCard = <PlanExcerptCard
    className={css.card}
    dataStatus={status}
    markdown={review.detail}
    onOpen={onOpenPlan === undefined ? undefined : openPlan}
    t={t}
    ariaLabel={t('计划待审', 'Plan review')}
  >
    {review.feedback !== undefined && review.feedback !== '' && <div className={css.planFeedback} data-plan-feedback>
      {t(`修改要求：${review.feedback}`, `Requested changes: ${review.feedback}`)}
    </div>}
  </PlanExcerptCard>

  const decisionCard = <section className={css.decisionCard} data-plan-decision aria-label={t('审批计划', 'Approve plan')}>
    <header className={css.decisionHeader}>
      <span className={css.permissionChip}>{t('需要权限', 'Permission needed')}</span>
      <h3 className={css.decisionTitle}>{t('实施计划', 'Implement the plan')}</h3>
    </header>
    <div className={css.decisionOptions} role="radiogroup" aria-label={t('计划决定', 'Plan decision')}
      onKeyDown={moveDecisionFocus}>
      <button type="button" className={css.decisionOption} role="radio" aria-checked={approveSelected}
        data-selected={approveSelected || undefined} data-decision-row
        onClick={() => { setApproveSelected(current => !current) }}>
        <span className={css.decisionIndex} aria-hidden="true">1.</span>
        <span className={css.decisionBody}>
          <span className={css.decisionLabel}>{t('批准', 'Approve')}</span>
          <span className={css.decisionDescription}>{t('退出计划模式并开始实施。', 'Exit plan mode and start implementation.')}</span>
        </span>
      </button>
      <div className={css.decisionCustomRow}>
        <span className={css.decisionIndex} aria-hidden="true">2.</span>
        <textarea className={css.decisionCustom} rows={1} value={feedbackText} data-decision-row tabIndex={-1}
          placeholder={t('输入你的回答…', 'Type your answer…')} aria-label={t('输入你的回答', 'Type your answer')}
          onChange={event => setFeedbackText(event.target.value)}
          onCompositionStart={() => { composing.current = true }}
          onCompositionEnd={() => { composing.current = false }}
          onKeyDown={event => {
            if (event.key === 'Enter' && !event.shiftKey && !composing.current) {
              event.preventDefault()
              void submitDecision()
            }
          }} />
      </div>
    </div>
    {error !== '' && <div className={css.error} role="alert" data-plan-error>{error}</div>}
    <footer className={css.decisionFooter}>
      <span className={css.decisionHint}>{t('ⓘ 使用 Tab / 上下键选择，回车或空格选中', 'ⓘ Tab / arrow keys to choose, Enter or Space to select')}</span>
      <span className={css.decisionSpacer} />
      <button type="button" className={css.secondary} data-plan-ignore disabled={dismissing} onClick={() => { void ignore() }}>
        {dismissing ? t('提交中…', 'Submitting…') : t('忽略', 'Ignore')}
      </button>
      <button type="button" className={css.decisionSubmit} data-plan-submit disabled={submitting} onClick={() => { void submitDecision() }}>
        {submitting ? t('提交中…', 'Submitting…') : t('提交', 'Submit')}
      </button>
    </footer>
  </section>

  return <>{planCard}{decisionCard}</>
}
