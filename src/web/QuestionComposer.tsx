import { useEffect, useMemo, useState } from 'react'
import { MarkdownText } from '@deepseek-ai/dsh-client-ui-primitives'
import type { AskUserQuestionAnswerItem, AskUserQuestionItem, InteractionRequest, InteractionStatus } from '../shared/types.ts'
import { ApiFailure, api } from './api.ts'
import { planTitle as planHeadingOf } from './plan-preview.ts'
import { markdownLabels } from './render-labels.ts'
import { useUiPreferences } from './ui-preferences.tsx'
import css from './QuestionComposer.module.css'

/** DSH's "(Recommended)" / "（推荐）" suffix renders as a badge instead of part of the label. */
const RECOMMENDED_SUFFIX = /\s*[（(]\s*(?:recommended|推荐)\s*[)）]\s*$/iu
/** Answer id the plan-review card submits; the runtime reads the selected labels, not this id. */
const PLAN_REVIEW_ANSWER_ID = 'plan-review'
const DEFAULT_APPROVE_LABEL = '同意执行'

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
  // A cancelled question set left the answerable state for good: DSH settles it as
  // ASK_CANCELLED and only the tool row keeps its record, so the composer drops it.
  if (interaction.status === 'cancelled') return false
  return questionInteraction(interaction) || planReviewInteraction(interaction)
}

/** The newest interaction matching `status`, so a fresh request always wins over an older record. */
function newest(interactions: readonly InteractionRequest[] | undefined, status: 'pending' | 'settled'): InteractionRequest | undefined {
  const candidates = (interactions ?? []).filter(interaction => renderable(interaction)
    && (status === 'pending' ? interaction.status === 'pending' : interaction.status !== 'pending'))
  return candidates.sort((left, right) => right.createdAt - left.createdAt)[0]
}

function splitRecommended(label: string): { text: string; recommended: boolean } {
  const match = RECOMMENDED_SUFFIX.exec(label)
  return match ? { text: label.slice(0, match.index).trimEnd(), recommended: true } : { text: label, recommended: false }
}

function statusText(status: InteractionStatus, t: (chinese: string, english: string) => string): string {
  switch (status) {
    case 'pending': return t('待回答', 'Waiting for your answer')
    case 'answered': return t('已回答', 'Answered')
    case 'expired': return t('已过期', 'Expired')
    case 'continued': return t('已继续', 'Continued')
    case 'cancelled': return t('已取消', 'Cancelled')
  }
}

/** The plan review's own status wording: `approved` separates an approval from a change request. */
function planStatusText(status: InteractionStatus, approved: boolean | undefined, t: (chinese: string, english: string) => string): string {
  if (status === 'pending') return t('待审批', 'Waiting for review')
  if (status === 'continued') return t('已被新计划取代', 'Superseded by a newer plan')
  if (approved === false) return t('已要求修改', 'Changes requested')
  return t('已批准', 'Approved')
}

function answerSummary(answer: AskUserQuestionAnswerItem | undefined, t: (chinese: string, english: string) => string): { text: string; skipped: boolean } {
  if (!answer) return { text: t('已跳过', 'Skipped'), skipped: true }
  const custom = answer.custom?.trim() ?? ''
  const parts = [...answer.selected, ...(custom ? [custom] : [])]
  return parts.length ? { text: parts.join(t('、', ', ')), skipped: false } : { text: t('已跳过', 'Skipped'), skipped: true }
}

/**
 * DSH's interaction card above the composer: the newest pending question or plan review, one at a
 * time. Questions keep per-question navigation and option/custom answers; a plan review renders the
 * submitted plan and offers "request changes" (dismiss and hand focus back to the composer) or the
 * server-provided approve label. Once settled, either kind falls back to a read-only record.
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
  const interaction = useMemo(() => newest(interactions, 'pending') ?? newest(interactions, 'settled'), [interactions])
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
      onAnswered={onAnswered} onDismiss={onDismiss} onOpenPlan={onOpenPlan} />
  }
  if (!interaction || questions.length === 0) return null

  const readOnly = interaction.status !== 'pending' || answeredLocally !== null
  const status = answeredLocally !== null ? 'answered' : interaction.status
  const shownAnswers = answeredLocally?.answers ?? interaction.answer?.answers
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

  if (readOnly) {
    const entries = questions.map(item => {
      const answer = shownAnswers?.find(candidate => candidate.id === item.id)
      return { question: item, answer }
    })
    return <section className={css.card} data-question-card data-status={status} aria-label={t('问答记录', 'Question record')}>
      <header className={css.header}>
        <span className={css.eyebrow}>{t('问答', 'Questions')}</span>
        <span className={css.status} data-question-status={status}>{statusText(status as InteractionStatus, t)}</span>
      </header>
      <ol className={css.summaryList} data-question-summary>
        {entries.map(({ question: item, answer }) => {
          const summary = answerSummary(answer, t)
          return <li key={item.id} className={css.summaryRow}>
            <span className={css.summaryQuestion}>{item.question}</span>
            <span className={css.summaryAnswer} data-skipped={summary.skipped || undefined}>{summary.text}</span>
          </li>
        })}
      </ol>
    </section>
  }

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
 * DSH's plan review card: the submitted plan plus the two decisions. "Request changes" only collapses
 * the card and returns focus to the composer, so the user's next message is their feedback; the
 * approve button posts the decision, and the server turns plan mode off when it lands.
 */
function PlanReviewCard({ conversationId, review, onAnswered, onDismiss, onOpenPlan }: {
  conversationId: string
  review: InteractionRequest & { detail: string }
  onAnswered?: (detail: Awaited<ReturnType<typeof api.answerInteraction>>) => void
  onDismiss?: () => void
  onOpenPlan?: (plan: { markdown: string; title?: string }) => void
}) {
  const { t } = useUiPreferences()
  const [dismissed, setDismissed] = useState(false)
  const [expanded, setExpanded] = useState(review.status === 'pending')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')
  const [decided, setDecided] = useState<PlanDecisionLocally | null>(null)
  const status: InteractionStatus = decided !== null ? 'answered' : review.status
  const approved = decided?.approved ?? review.approved
  const approveLabel = review.approveLabel ?? DEFAULT_APPROVE_LABEL
  const readOnly = status !== 'pending'
  if (dismissed && !readOnly) return null

  const approve = async (): Promise<void> => {
    if (readOnly || submitting || dismissed) return
    setSubmitting(true)
    setError('')
    try {
      const detail = await api.answerInteraction(conversationId, review.id, [{ id: PLAN_REVIEW_ANSWER_ID, selected: [approveLabel] }])
      setDecided({ approved: true })
      onAnswered?.(detail)
    } catch (cause) {
      setError(cause instanceof ApiFailure ? cause.message : t('提交计划决定失败', 'Could not submit the plan decision'))
    } finally {
      setSubmitting(false)
    }
  }

  if (readOnly && !expanded) {
    return <section className={css.card} data-plan-card data-status={status} aria-label={t('计划记录', 'Plan record')}>
      <button type="button" className={css.collapsedBar} onClick={() => setExpanded(true)}>
        <span className={css.eyebrow}>{t('计划', 'Plan')}</span>
        <span className={css.status} data-plan-status={status}>{planStatusText(status, approved, t)}</span>
        <span className={css.collapsedText}>{t('查看计划内容', 'View the plan')}</span>
        <span className={css.expand}>{t('展开', 'Open')}</span>
      </button>
    </section>
  }

  return <section className={css.card} data-plan-card data-status={status} aria-label={t('计划待审', 'Plan review')}>
    <header className={css.header}>
      <span className={css.eyebrow}>{readOnly ? t('计划', 'Plan') : t('计划待审', 'Plan review')}</span>
      <span className={css.status} data-plan-status={status}>{planStatusText(status, approved, t)}</span>
      {/* DSH's plan-review actions slot: the "查看全文" link opens the same plan in the sidebar
          (`ui-plan/src/client/PlanCard.tsx:81-83`, copy `locales.ts:10`). */}
      {onOpenPlan !== undefined && <button type="button" className={css.reviewLink} data-plan-full
        title={t('在侧边栏打开计划', 'Open plan in sidebar')}
        aria-label={t('在侧边栏打开计划', 'Open plan in sidebar')}
        onClick={() => { onOpenPlan({ markdown: review.detail, ...(planHeadingOf(review.detail) === undefined ? {} : { title: planHeadingOf(review.detail) }) }) }}>
        {t('查看全文', 'View full plan')}
      </button>}
      <button type="button" className={css.collapseButton} data-plan-toggle onClick={() => setExpanded(false)}>
        {t('收起', 'Collapse')}
      </button>
    </header>
    {review.feedback !== undefined && review.feedback !== '' && <div className={css.planFeedback} data-plan-feedback>
      {t(`修改要求：${review.feedback}`, `Requested changes: ${review.feedback}`)}
    </div>}
    <div className={css.planBody} data-plan-body>
      <MarkdownText text={review.detail} labels={markdownLabels(t)} />
    </div>
    {error !== '' && <div className={css.error} role="alert" data-plan-error>{error}</div>}
    {!readOnly && <footer className={css.footer}>
      <span className={css.footerSpacer} />
      <button type="button" className={css.secondary} data-plan-revise onClick={() => { setDismissed(true); onDismiss?.() }}>
        {t('要求修改', 'Request changes')}
      </button>
      <button type="button" className={css.submit} data-plan-approve disabled={submitting} onClick={() => { void approve() }}>
        {submitting ? t('提交中…', 'Submitting…') : approveLabel}
      </button>
    </footer>}
  </section>
}
