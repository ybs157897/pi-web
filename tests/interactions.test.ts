import { describe, expect, it } from 'vitest'
import { foldInteractions, validateAnswers, type QuestionCall, type QuestionReply } from '../src/server/conversation/interactions.ts'
import { cleanPlan, decidePlanReview, planReviewOf, planTitle, PLAN_APPROVE_LABEL, type StoredPlanReview } from '../src/server/tools/plan.ts'
import type { AskUserQuestionItem } from '../src/shared/types.ts'

/** 三个问题夹具：单选（带选项）、自由文本、多选。 */
const questions: AskUserQuestionItem[] = [
  { id: 'scope', question: 'Which scope?', options: [{ label: 'Small' }, { label: 'Large' }] },
  { id: 'notes', question: 'Anything else?' },
  { id: 'tags', question: 'Pick tags', multiSelect: true, options: [{ label: 'ui' }, { label: 'api' }] },
]

/**
 * 交互答案校验测试。
 *
 * 关键契约：
 * - 每个问题恰好一个答案，且选中的选项必须来自该问题提供的选项（自由文本问题允许 custom）；
 * - 重复回答、未知选项、缺答、单选题多选各返回专属错误文案；
 * - 所有答案为空视为整体跳过，校验通过。
 */
describe('interaction answers', () => {
  // 合法形态：单选选提供的选项、文本题只留 custom、多选可选多个，全部通过返回 undefined。
  it('accepts one answer per question with offered options only', () => {
    expect(validateAnswers(questions, [
      { id: 'scope', selected: ['Small'] },
      { id: 'notes', selected: [], custom: 'keep it simple' },
      { id: 'tags', selected: ['ui', 'api'] },
    ])).toBeUndefined()
  })

  // 四类失败各有错误文案：重复回答同一题、选了未提供的选项、漏掉某题、单选题选多个。
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

  // 所有答案 selected 都为空时视为用户跳过整组问题，校验通过。
  it('treats an empty answer as a skip', () => {
    expect(validateAnswers(questions, [
      { id: 'scope', selected: [] },
      { id: 'notes', selected: [] },
      { id: 'tags', selected: [] },
    ])).toBeUndefined()
  })
})

/**
 * 交互折叠测试。
 *
 * 关键契约：
 * - 未回复的调用保持 pending、已回复的标记 answered；
 * - 迟到的 reply 能结算 pending 调用（记录答案与时间）；
 * - 工具 errored 无回复 → expired；有迟到回复则仍算 answered；
 * - cancelled 的调用保持 cancelled，但迟到回复仍可把它结算为 answered；
 * - 折叠结果按提问时间排序。
 */
describe('interaction folding', () => {
  /** call-1 是待结算的提问调用；call-2 用来测排序。 */
  const call: QuestionCall = { callId: 'call-1', questions, askedAt: 10, result: 'pending' }
  const other: QuestionCall = { callId: 'call-2', questions, askedAt: 20 }

  // 调用状态原样保留：无 reply 时 pending/call 与 answered/call-2 各自维持。
  it('keeps an unanswered call pending and an answered one answered', () => {
    const fold = foldInteractions([call, { ...other, result: 'answered' }], [])
    expect(fold.map(item => [item.id, item.status])).toEqual([['call-1', 'pending'], ['call-2', 'answered']])
  })

  // 迟到的 reply 把 pending 调用结算为 answered，答案内容与 repliedAt 正确落到 item 上。
  it('settles a pending call with its late reply', () => {
    const reply: QuestionReply = { callId: 'call-1', answers: [{ id: 'scope', selected: ['Small'] }], repliedAt: 30 }
    const [item] = foldInteractions([call], [reply])
    expect(item?.status).toBe('answered')
    expect(item?.answer?.answers).toEqual([{ id: 'scope', selected: ['Small'] }])
    expect(item?.answeredAt).toBe(30)
  })

  // 工具报错且无回复 → expired；之后若迟到回复到达，仍按 answered 结算。
  it('expires a call whose tool errored without a reply', () => {
    expect(foldInteractions([{ ...call, result: 'errored' }], [])[0]?.status).toBe('expired')
    const reply: QuestionReply = { callId: 'call-1', answers: [{ id: 'scope', selected: ['Large'] }], repliedAt: 31 }
    expect(foldInteractions([{ ...call, result: 'errored' }], [reply])[0]?.status).toBe('answered')
  })

  // 用户关闭（cancelled）时保持 cancelled；但迟到回复仍能把它结算为 answered。
  it('cancels a dismissed call, and lets a reply that still arrived settle it', () => {
    expect(foldInteractions([{ ...call, result: 'cancelled' }], [])[0]?.status).toBe('cancelled')
    const reply: QuestionReply = { callId: 'call-1', answers: [{ id: 'scope', selected: ['Small'] }], repliedAt: 31 }
    expect(foldInteractions([{ ...call, result: 'cancelled' }], [reply])[0]?.status).toBe('answered')
  })

  // 输入顺序无关：结果按提问时间 askedAt 排序（call-1 在 call-2 前）。
  it('orders by when the question was asked', () => {
    expect(foldInteractions([other, call], []).map(item => item.id)).toEqual(['call-1', 'call-2'])
  })
})

/**
 * 计划评审测试。
 *
 * 关键契约：
 * - cleanPlan 只接受以一级标题开头的非空 Markdown（空计划/无标题/二级标题/空标题文本都报中文错误）；
 * - planTitle 取一级标题文本为标题，忽略后续标题；
 * - planReviewOf 用结构判别把计划评审与普通提问分开（kind/detail/status 不合法或超期都不算）；
 * - decidePlanReview 按批准标签（含别名「同意」/「Approve」）判定批准；要求修改时把选项与 custom 拼成反馈；
 *   带批准标签即使附带文本也算批准（附带文本作为反馈保留）。
 */
describe('plan reviews', () => {
  /** 一份待评审的迁移计划（pending 状态，带批准按钮标签）。 */
  const review: StoredPlanReview = {
    kind: 'plan-review',
    detail: '# 迁移计划\n\n1. 调研\n2. 提交',
    approveLabel: PLAN_APPROVE_LABEL,
    askedAt: 10,
    status: 'pending',
  }

  // 只有以一级标题开头的非空 Markdown 合法：无标题、二级标题开头、空串、undefined、空标题文本分别报对应中文错误。
  it('accepts only Markdown that starts with a level-1 heading', () => {
    expect(cleanPlan('# 迁移计划\n\n步骤')).toBe('# 迁移计划\n\n步骤')
    expect(() => cleanPlan('  迁移计划：无标题  ')).toThrow(/一级标题/)
    expect(() => cleanPlan('## 二级标题')).toThrow(/一级标题/)
    expect(() => cleanPlan('')).toThrow(/计划为空/)
    expect(() => cleanPlan(undefined)).toThrow(/计划为空/)
    expect(() => cleanPlan('# \n\n正文')).toThrow(/标题为空/)
  })

  // 标题取一级标题文本（忽略后面的二级标题）；只有二级标题或空标题文本时返回 undefined。
  it('reads the heading as the call title and ignores later headings', () => {
    expect(planTitle('# 演示计划：分三步\n\n## 步骤')).toBe('演示计划：分三步')
    expect(planTitle('## 只有二级')).toBeUndefined()
    expect(planTitle('#   ')).toBeUndefined()
  })

  // planReviewOf 判别规则：合法计划评审原样返回；superseded 保留；question 类调用、kind 不符、detail 非字符串、expired、undefined 都返回 undefined。
  it('tells a plan review apart from a question call', () => {
    expect(planReviewOf(review)).toBe(review)
    expect(planReviewOf({ ...review, status: 'superseded' })).toMatchObject({ status: 'superseded' })
    expect(planReviewOf({ questions: [], askedAt: 1, status: 'pending' })).toBeUndefined()
    expect(planReviewOf({ ...review, kind: 'question' })).toBeUndefined()
    expect(planReviewOf({ ...review, detail: 7 })).toBeUndefined()
    expect(planReviewOf({ ...review, status: 'expired' })).toBeUndefined()
    expect(planReviewOf(undefined)).toBeUndefined()
  })

  // 批准标签与别名（同意/Approve）都判批准；要求修改时选项+custom 拼成反馈；批准标签 + 附带文本 = 批准且文本进反馈。
  it('approves on the approve label and keeps the feedback that asks for changes', () => {
    expect(decidePlanReview(review, [{ id: 'plan-review', selected: [PLAN_APPROVE_LABEL] }]))
      .toEqual({ approved: true })
    expect(decidePlanReview(review, [{ id: 'plan-review', selected: ['同意'] }]))
      .toEqual({ approved: true })
    expect(decidePlanReview(review, [{ id: 'plan-review', selected: ['要求修改'], custom: '补上回滚说明' }]))
      .toEqual({ approved: false, feedback: '要求修改; 补上回滚说明' })
    expect(decidePlanReview(review, [{ id: 'plan-review', selected: ['Approve'] }]))
      .toEqual({ approved: true })
    // 即使答案还带了额外文本，批准依然生效。
    expect(decidePlanReview(review, [{ id: 'plan-review', selected: [PLAN_APPROVE_LABEL], custom: '开始吧' }]))
      .toEqual({ approved: true, feedback: '开始吧' })
  })
})

/**
 * 交互折叠矩阵测试：穷举工具结果状态 × 迟到回复的所有组合。
 */
describe('interaction folding matrix', () => {
  /** 完整的 工具结果 × 迟到回复 交叉积：折叠后卡片读取的线上状态。 */
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

  // 每个组合折叠到唯一状态；除 pending 外的状态都必须让浮层卡片离开输入框上方（回归判据）。
  it('folds every result and reply combination to exactly one status', () => {
    for (const cell of matrix) {
      const calls: QuestionCall[] = [{ callId: 'call-1', questions, askedAt: 10, ...(cell.result === undefined ? {} : { result: cell.result }) }]
      const replies: QuestionReply[] = cell.reply ? [{ callId: 'call-1', answers: [], repliedAt: 30 }] : []
      const [item] = foldInteractions(calls, replies)
      // 浮层卡片只渲染 pending 的交互；因此这里除 `pending` 之外的每个折叠状态都必须离开输入框。
      expect(item?.status, `${cell.result ?? 'none'}/${cell.reply ? 'reply' : 'no-reply'}`).toBe(cell.status)
    }
  })
})
