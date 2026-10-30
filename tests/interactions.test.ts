import { describe, expect, it } from 'vitest'
import { foldInteractions, validateAnswers, type QuestionCall, type QuestionReply } from '../src/server/conversation/interactions.ts'
import { cleanPlan, decidePlanReview, planReviewOf, planTitle, PLAN_APPROVE_LABEL, type StoredPlanReview } from '../src/server/tools/plan.ts'
import type { AskUserQuestionItem } from '../src/shared/types.ts'

const questions: AskUserQuestionItem[] = [
  { id: 'scope', question: 'Which scope?', options: [{ label: 'Small' }, { label: 'Large' }] },
  { id: 'notes', question: 'Anything else?' },
  { id: 'tags', question: 'Pick tags', multiSelect: true, options: [{ label: 'ui' }, { label: 'api' }] },
]

describe('interaction answers', () => {
  it('accepts one answer per question with offered options only', () => {
    expect(validateAnswers(questions, [
      { id: 'scope', selected: ['Small'] },
      { id: 'notes', selected: [], custom: 'keep it simple' },
      { id: 'tags', selected: ['ui', 'api'] },
    ])).toBeUndefined()
  })

  it('rejects duplicates, unknown options, missing questions and multi-select on single questions', () => {
    expect(validateAnswers(questions, [
      { id: 'scope', selected: ['Small'] },
      { id: 'scope', selected: ['Large'] },
      { id: 'tags', selected: [] },
    ])).toBe('Each question can be answered only once')
    expect(validateAnswers(questions, [
      { id: 'scope', selected: ['Huge'] },
      { id: 'notes', selected: [] },
      { id: 'tags', selected: [] },
    ])).toBe('Selected option "Huge" was not offered for question "scope"')
    expect(validateAnswers(questions, [{ id: 'scope', selected: ['Small'] }])).toBe('Missing an answer for question "notes"')
    expect(validateAnswers(questions, [
      { id: 'scope', selected: ['Small', 'Large'] },
      { id: 'notes', selected: [] },
      { id: 'tags', selected: [] },
    ])).toBe('Question "scope" accepts a single choice')
  })

  it('treats an empty answer as a skip', () => {
    expect(validateAnswers(questions, [
      { id: 'scope', selected: [] },
      { id: 'notes', selected: [] },
      { id: 'tags', selected: [] },
    ])).toBeUndefined()
  })
})

describe('interaction folding', () => {
  const call: QuestionCall = { callId: 'call-1', questions, askedAt: 10, result: 'pending' }
  const other: QuestionCall = { callId: 'call-2', questions, askedAt: 20 }

  it('keeps an unanswered call pending and an answered one answered', () => {
    const fold = foldInteractions([call, { ...other, result: 'answered' }], [])
    expect(fold.map(item => [item.id, item.status])).toEqual([['call-1', 'pending'], ['call-2', 'answered']])
  })

  it('settles a pending call with its late reply', () => {
    const reply: QuestionReply = { callId: 'call-1', answers: [{ id: 'scope', selected: ['Small'] }], repliedAt: 30 }
    const [item] = foldInteractions([call], [reply])
    expect(item?.status).toBe('answered')
    expect(item?.answer?.answers).toEqual([{ id: 'scope', selected: ['Small'] }])
    expect(item?.answeredAt).toBe(30)
  })

  it('expires a call whose tool errored without a reply', () => {
    expect(foldInteractions([{ ...call, result: 'errored' }], [])[0]?.status).toBe('expired')
    const reply: QuestionReply = { callId: 'call-1', answers: [{ id: 'scope', selected: ['Large'] }], repliedAt: 31 }
    expect(foldInteractions([{ ...call, result: 'errored' }], [reply])[0]?.status).toBe('answered')
  })

  it('cancels a dismissed call, and lets a reply that still arrived settle it', () => {
    expect(foldInteractions([{ ...call, result: 'cancelled' }], [])[0]?.status).toBe('cancelled')
    const reply: QuestionReply = { callId: 'call-1', answers: [{ id: 'scope', selected: ['Small'] }], repliedAt: 31 }
    expect(foldInteractions([{ ...call, result: 'cancelled' }], [reply])[0]?.status).toBe('answered')
  })

  it('orders by when the question was asked', () => {
    expect(foldInteractions([other, call], []).map(item => item.id)).toEqual(['call-1', 'call-2'])
  })
})

describe('plan reviews', () => {
  const review: StoredPlanReview = {
    kind: 'plan-review',
    detail: '# 迁移计划\n\n1. 调研\n2. 提交',
    approveLabel: PLAN_APPROVE_LABEL,
    askedAt: 10,
    status: 'pending',
  }

  it('accepts only Markdown that starts with a level-1 heading', () => {
    expect(cleanPlan('# 迁移计划\n\n步骤')).toBe('# 迁移计划\n\n步骤')
    expect(() => cleanPlan('  迁移计划：无标题  ')).toThrow(/level-1 heading/)
    expect(() => cleanPlan('## 二级标题')).toThrow(/level-1 heading/)
    expect(() => cleanPlan('')).toThrow(/empty/)
    expect(() => cleanPlan(undefined)).toThrow(/empty/)
    expect(() => cleanPlan('# \n\n正文')).toThrow(/heading is empty/)
  })

  it('reads the heading as the call title and ignores later headings', () => {
    expect(planTitle('# 演示计划：分三步\n\n## 步骤')).toBe('演示计划：分三步')
    expect(planTitle('## 只有二级')).toBeUndefined()
    expect(planTitle('#   ')).toBeUndefined()
  })

  it('tells a plan review apart from a question call', () => {
    expect(planReviewOf(review)).toBe(review)
    expect(planReviewOf({ ...review, status: 'superseded' })).toMatchObject({ status: 'superseded' })
    expect(planReviewOf({ questions: [], askedAt: 1, status: 'pending' })).toBeUndefined()
    expect(planReviewOf({ ...review, kind: 'question' })).toBeUndefined()
    expect(planReviewOf({ ...review, detail: 7 })).toBeUndefined()
    expect(planReviewOf({ ...review, status: 'expired' })).toBeUndefined()
    expect(planReviewOf(undefined)).toBeUndefined()
  })

  it('approves on the approve label and keeps the feedback that asks for changes', () => {
    expect(decidePlanReview(review, [{ id: 'plan-review', selected: [PLAN_APPROVE_LABEL] }]))
      .toEqual({ approved: true })
    expect(decidePlanReview(review, [{ id: 'plan-review', selected: ['同意'] }]))
      .toEqual({ approved: true })
    expect(decidePlanReview(review, [{ id: 'plan-review', selected: ['要求修改'], custom: '补上回滚说明' }]))
      .toEqual({ approved: false, feedback: '要求修改; 补上回滚说明' })
    expect(decidePlanReview(review, [{ id: 'plan-review', selected: ['Approve'] }]))
      .toEqual({ approved: true })
    // An approval wins even when the answer carries extra text.
    expect(decidePlanReview(review, [{ id: 'plan-review', selected: [PLAN_APPROVE_LABEL], custom: '开始吧' }]))
      .toEqual({ approved: true, feedback: '开始吧' })
  })
})

describe('interaction folding matrix', () => {
  /** The full tool-result × late-reply cross product: the wire status the card reads. */
  const matrix = [
    { result: undefined, reply: false, status: 'pending' },
    { result: undefined, reply: true, status: 'answered' },
    { result: 'pending', reply: false, status: 'pending' },
    { result: 'pending', reply: true, status: 'answered' },
    { result: 'answered', reply: false, status: 'answered' },
    { result: 'answered', reply: true, status: 'answered' },
    { result: 'cancelled', reply: false, status: 'cancelled' },
    { result: 'cancelled', reply: true, status: 'answered' },
    { result: 'errored', reply: false, status: 'expired' },
    { result: 'errored', reply: true, status: 'answered' },
  ] as const

  it('folds every result and reply combination to exactly one status', () => {
    for (const cell of matrix) {
      const calls: QuestionCall[] = [{ callId: 'call-1', questions, askedAt: 10, ...(cell.result === undefined ? {} : { result: cell.result }) }]
      const replies: QuestionReply[] = cell.reply ? [{ callId: 'call-1', answers: [], repliedAt: 30 }] : []
      const [item] = foldInteractions(calls, replies)
      // The floating card renders pending interactions only; every folded status here
      // except `pending` must therefore leave the composer.
      expect(item?.status, `${cell.result ?? 'none'}/${cell.reply ? 'reply' : 'no-reply'}`).toBe(cell.status)
    }
  })
})
