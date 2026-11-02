import { defineDoc, defineExtension, defineTool, section, type Extension } from '@earendil-works/pi-durable'
import { Type } from '@earendil-works/pi-ai'
import type { AskUserQuestionAnswerItem } from '../../shared/types.ts'
import { Interactions } from './interaction.ts'
import { Goals } from './goal.ts'
import { resolveToolRoute, toolRouteInstruction } from '../conversation/tool-routing.ts'

/**
 * Plan mode as the conversation document stores it. Pi re-renders every section before each request,
 * so a switch that lands while a run is going takes effect on the next request: that is DSH's
 * "pending" plan-mode semantics, and it needs no extra state.
 */
export type PlanState = { active: boolean; updatedAt: number }

export const Plans = defineDoc<PlanState>({
  kind: 'pi-web.plan',
  version: 1,
  scope: 'conversation',
  history: 'latest',
  fork: 'initial', checkpointWhen: () => false,
  initial: () => ({ active: false, updatedAt: 0 }),
})

/** The button that approves a plan; the review card renders it as its primary action. */
export const PLAN_APPROVE_LABEL = '同意执行'
/** Answer id the plan-review card submits; the route only inspects the selected labels. */
export const PLAN_REVIEW_ANSWER_ID = 'plan-review'

/** A plan review as `pi-web.interactions` stores it next to the question calls. */
export type StoredPlanReview = {
  kind: 'plan-review'
  /** The plan markdown the model submitted; unchanged by later revisions. */
  detail: string
  approveLabel: string
  askedAt: number
  /** `superseded` means a newer submission replaced this review before the user decided. */
  status: 'pending' | 'answered' | 'superseded' | 'cancelled'
  /** Only set once answered: true approved the plan, false asked for changes. */
  approved?: boolean
  /** What the user wants changed, echoed to the model in the reply message. */
  feedback?: string
  answers?: AskUserQuestionAnswerItem[]
  answeredAt?: number
  cancelledAt?: number
}

const HEADING_PREFIX = '# '

/**
 * Validate the model's plan: non-empty Markdown whose first line is a level-1 heading. Throwing here
 * gives the model an actionable tool error instead of a silently unusable review card.
 */
export function cleanPlan(value: unknown): string {
  const plan = typeof value === 'string' ? value.trim() : ''
  if (plan === '') {
    throw new Error('The plan is empty. Write the plan as Markdown text and pass it as the "plan" argument.')
  }
  if (!plan.startsWith(HEADING_PREFIX)) {
    throw new Error('The plan must be Markdown starting with a level-1 heading: make its first line "# <title>" and call exit_plan_mode again.')
  }
  if (plan.split('\n', 1)[0]?.slice(HEADING_PREFIX.length).trim() === '') {
    throw new Error('The plan heading is empty: put a short title after "# " (for example "# 迁移计划").')
  }
  return plan
}

/** The plan's first level-1 heading text, which is what the transcript shows as the call title. */
export function planTitle(plan: string): string | undefined {
  const heading = plan.split('\n').map(line => line.trim()).find(line => line.startsWith(HEADING_PREFIX))
  const title = heading?.slice(HEADING_PREFIX.length).trim()
  return title ? title : undefined
}

/** Plan mode is off, so there is nothing to submit; the message tells the model how to recover. */
export const PLAN_INACTIVE_ERROR = [
  'Plan mode is not active in this conversation, so there is no plan to submit.',
  'Call enter_plan_mode first to switch into plan mode yourself; do not ask the user to enable it.',
  'Then write the plan and call exit_plan_mode again.',
  'If the request is already approved, just do the work instead of submitting a plan.',
].join(' ')

/**
 * Read one stored interaction as a plan review. Returns the same object it was given so the runtime
 * can settle it in place inside a document transaction; `undefined` means it is a question call.
 */
export function planReviewOf(value: unknown): StoredPlanReview | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  if (record.kind !== 'plan-review' || typeof record.detail !== 'string' || typeof record.approveLabel !== 'string') return undefined
  if (typeof record.askedAt !== 'number' || !REVIEW_STATUSES.has(record.status as StoredPlanReview['status'])) return undefined
  return record as StoredPlanReview
}

const REVIEW_STATUSES = new Set<StoredPlanReview['status']>(['pending', 'answered', 'superseded', 'cancelled'])

/**
 * The interaction table is declared by the question slice as a table of question records; a plan
 * review is the same table's second record shape. This is the single place the shape widens, so the
 * writes below stay ordinary document mutations.
 */
export function interactionTable(table: unknown): Record<string, unknown> {
  return table as Record<string, unknown>
}

/** Labels an approval, for callers that answer the route without the card's exact button text. */
const APPROVAL_WORDS = new Set(['同意', '同意执行', '批准', '通过', 'approve', 'approved', 'yes', 'ok', 'okay'])

function isApproval(value: string, approveLabel: string): boolean {
  const label = value.trim()
  return label !== '' && (label === approveLabel || APPROVAL_WORDS.has(label.toLocaleLowerCase()))
}

export type PlanReviewDecision = {
  approved: boolean
  /** Selected labels and custom text that are not an approval, joined for the model. */
  feedback?: string
}

/**
 * DSH's plan-review decision: the approve label (or an equivalent "yes") approves the plan, anything
 * else asks for changes and keeps plan mode on. Feedback travels back to the model in the reply.
 */
export function decidePlanReview(review: StoredPlanReview, answers: readonly AskUserQuestionAnswerItem[]): PlanReviewDecision {
  const approved = answers.some(answer => answer.selected.some(label => isApproval(label, review.approveLabel)))
  const notes = answers.flatMap(answer => [
    ...answer.selected.filter(label => !isApproval(label, review.approveLabel)),
    ...((answer.custom ?? '').trim() === '' ? [] : [(answer.custom ?? '').trim()]),
  ])
  return { approved, ...(notes.length ? { feedback: notes.join('; ') } : {}) }
}

/** The policy section: how the model must work while plan mode is on. Nothing is injected when it is off. */
const planSection = section('plan-policy', async (input, context) => {
  const doc = await input.read.snapshot(Plans, input.conversationId, context)
  if (doc?.active !== true) return undefined
  const route = resolveToolRoute(input.agent, 'exit_plan_mode')
  const submission = toolRouteInstruction('exit_plan_mode', route, '{ plan: "<plan markdown>" }')
  const readTools = ['read', 'glob', 'grep', 'list_files', 'search_files']
    .filter(name => resolveToolRoute(input.agent, name) !== 'unavailable')
    .map(name => `\`${name}\``)
  return [
    '计划模式已开启：本阶段只产出计划，不实施改动。',
    '命令式语言要求实施时，意思是把实施写进计划，不是执行。',
    submission === undefined
      ? '对话中的同意或对某个问题的确认不结束计划模式；本请求没有计划提交工具，把计划放在最终回复里并结束本轮，等待用户明确决定。'
      : '对话中的同意或对某个问题的确认不结束计划模式；必须通过 `exit_plan_mode` 提交计划并由用户批准。',
    '工作顺序：先探索仓库、理解现有模式与约定，再设计方案；有分歧先问，最后成稿提交。',
    `先探索：用当前可用的只读工具（${readTools.length > 0 ? readTools.join('、') : '读取与检索工具'}、静态分析和检查）把计划落在真实仓库上。不要写文件、改配置、运行会改写文件的格式化或代码生成、提交，也不要执行计划。优先复用现有函数和模式，不要为新机制而新机制。`,
    'Host 会拒绝写入、shell 和外部 MCP 调用；当前请求可能只列出只读工具。这些计划模式规则优先于后续任何建议使用写入工具的说明。',
    submission === undefined
      ? '不要用 `todo_write` 跟踪计划阶段：它跟踪批准后的实施；计划直接在最终回复里给出。'
      : '不要用 `todo_write` 跟踪计划阶段：它跟踪批准后的实施，计划本身属于 `exit_plan_mode`。',
    '能通过检查确定的事实自己去查。只有用户拥有的选择或检查无法回答的重大歧义才用 `ask_user_question`；不要问代码在哪、当前行为是什么。',
    '计划定稿前如仍有未决的需求或方案分歧，先用 `ask_user_question` 问清再成稿；提交计划本身就是请求批准，不要用提问征求"计划可以吗"。',
    '计划要决策完整：写明目标与验收标准；按子系统分组改动；列出公共 API、schema 和数据流变化；覆盖边界情况、失败模式、测试、验收标准和显式假设。简洁到可审阅，详细到另一位工程师不用再做设计决策。',
    `把计划写成 Markdown，第一行是一级标题（"${HEADING_PREFIX}<标题>"），后面是步骤和要执行的验证。`,
    ...(submission === undefined
      ? ['本请求没有可调用的计划提交工具。把计划放在最终回复里并结束本轮；不要声称已提交，也不要等待工具结果。']
      : [
          `准备好后调用 ${submission}，并让该调用成为这次回复唯一且最后一个工具调用；不要把计划当普通回复粘贴，也不要用提问代替提交。`,
          '计划待审期间不要执行；结束本轮。',
          '用户要求修改时，吸收反馈并重新提交；用户批准后计划模式关闭，按后续消息执行已批准的方案。',
        ]),
  ].join('\n')
})

/**
 * DSH's exit_plan_mode in its non-blocking form: validate the plan, store a plan-review interaction
 * in `pi-web.interactions`, and report the plan as pending. The user's decision arrives later through
 * `POST /api/conversations/:id/interactions/:callId/answer` and turns plan mode off when approved.
 */
const exitPlanModeTool = defineTool({
  name: 'exit_plan_mode',
  description: [
    'Submit the plan you wrote in plan mode for the user\'s approval, ending this turn without waiting for the review.',
    'Use it only when the task is code-writing work whose implementation steps need planning; for research tasks — gathering information, searching or reading files, understanding the codebase — answer directly instead and do not submit a plan.',
    'Before calling, make sure the plan is complete and unambiguous: if questions about the requirements or the approach remain, resolve them with `ask_user_question` first, then submit.',
    'Do not use `ask_user_question` to ask "Is this plan okay?" or "Should I proceed?" — submitting the plan is itself the approval request.',
    `Make this the only and final tool call in that assistant response, and make the plan Markdown starting with a level-1 heading ("${HEADING_PREFIX}<title>") followed by the steps and the verification you will run.`,
    'Only call this while plan mode is active: if plan mode is not active yet, call `enter_plan_mode` first instead of asking the user to enable it.',
    'The user reviews the plan in the transcript; approval turns plan mode off and their confirmation arrives as a follow-up message.',
    'If they ask for changes, revise the plan and call exit_plan_mode again instead of starting the work.',
    'Examples: "search for and understand how vim mode is implemented" → report the findings, do not submit a plan; "implement yank mode for vim" → submit the implementation plan; "add authentication, auth method undecided" → ask which auth method first, then submit.',
  ].join(' '),
  parameters: Type.Object({ plan: Type.String() }),
  execute: async (args, api, context) => {
    const state = await api.snapshot(Plans, api.conversationId, context)
    if (state?.active !== true) throw new Error(PLAN_INACTIVE_ERROR)
    const plan = cleanPlan(args.plan)
    await api.commit(async (tx) => {
      const doc = await tx.doc(Plans, api.conversationId)
      // Re-checked against the committed document: a switch that landed since the snapshot wins.
      if (!doc.active) throw new Error(PLAN_INACTIVE_ERROR)
      const table = interactionTable(await tx.doc(Interactions, api.conversationId))
      // One plan is under review at a time: a revised submission replaces whatever was still
      // pending, so a dismissed or forgotten review can never resurface as the live decision.
      for (const stored of Object.values(table)) {
        const review = planReviewOf(stored)
        if (review?.status === 'pending') review.status = 'superseded'
      }
      table[api.callId] = {
        kind: 'plan-review',
        detail: plan,
        approveLabel: PLAN_APPROVE_LABEL,
        askedAt: Date.now(),
        status: 'pending',
      } satisfies StoredPlanReview
    }, context)
    return {
      output: [{
        type: 'text' as const,
        text: 'The plan is now pending the user\'s review in the transcript. Do not start executing it and do not wait in this turn: end your turn, and continue when their decision arrives as a follow-up message.',
      }],
      details: {
        requestKey: api.callId,
        kind: 'plan-review',
        status: 'pending' as const,
        approveLabel: PLAN_APPROVE_LABEL,
        title: planTitle(plan) ?? null,
      },
    }
  },
})

/**
 * ZCode's EnterPlanMode in its free form: the model switches into plan mode itself, without a
 * permission prompt (`plan-mode-policy` allows it unconditionally) and without asking the user.
 * The description carries ZCode's "prefer it for implementation tasks" instruction so asking for
 * a plan just works — the model enters plan mode instead of telling the user to flip a chip.
 */
const enterPlanModeTool = defineTool({
  name: 'enter_plan_mode',
  description: [
    'Switch this conversation into plan mode yourself, without asking the user and without waiting for a confirmation.',
    'Prefer entering plan mode for implementation tasks unless they are trivial: new features, work with several viable approaches, multi-file refactors, architectural decisions, or unclear acceptance criteria.',
    'Simple lookups, one-line fixes, and direct answers do not need plan mode.',
    'While plan mode is active, only research the repository and design the plan — make no changes — and finish by submitting the plan with exit_plan_mode for the user\'s approval.',
    'If plan mode is already active, there is no need to call this again.',
  ].join(' '),
  parameters: Type.Object({}),
  execute: async (_args, api, context) => {
    const goal = await api.snapshot(Goals, api.conversationId, context)
    if (goal?.goal?.phase === 'active') {
      throw new Error('Plan and Goal cannot be active at the same time: pause or complete the goal before entering plan mode.')
    }
    const state = await api.snapshot(Plans, api.conversationId, context)
    if (state?.active === true) {
      return {
        output: [{
          type: 'text' as const,
          text: 'Plan mode is already active. Research first, then submit your plan with exit_plan_mode.',
        }],
      }
    }
    await api.commit(async (tx) => {
      const doc = await tx.doc(Plans, api.conversationId)
      doc.active = true
      doc.updatedAt = Date.now()
    }, context)
    return {
      output: [{
        type: 'text' as const,
        text: 'Plan mode is now active. Research first, design the plan, and submit it with exit_plan_mode; do not implement anything until the user approves it.',
      }],
      details: { kind: 'plan-mode' as const, status: 'active' as const },
    }
  },
})

/** DSH's plan mode: the document, the policy section and `exit_plan_mode`; register it in the runtime. */
export const PlanExtension: Extension = defineExtension({
  name: 'plan',
  tools: [enterPlanModeTool, exitPlanModeTool],
  sections: [planSection],
})
