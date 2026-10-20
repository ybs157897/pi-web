import { defineDoc, defineExtension, defineTool, section, type Extension } from '@earendil-works/pi-durable'
import { Type } from '@earendil-works/pi-ai'
import type { AskUserQuestionAnswerItem } from '../shared/types.ts'
import { Interactions } from './interaction-tools.ts'
import { resolveToolRoute, toolRouteInstruction } from './tool-routing.ts'

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
  fork: 'initial',
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
  status: 'pending' | 'answered' | 'superseded'
  /** Only set once answered: true approved the plan, false asked for changes. */
  approved?: boolean
  /** What the user wants changed, echoed to the model in the reply message. */
  feedback?: string
  answers?: AskUserQuestionAnswerItem[]
  answeredAt?: number
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
  'Ask the user to turn plan mode on first (the composer plan chip or the /plan command), then write the plan and call exit_plan_mode again.',
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

const REVIEW_STATUSES = new Set<StoredPlanReview['status']>(['pending', 'answered', 'superseded'])

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
  return [
    'Plan mode is on for this conversation: produce a plan, not changes.',
    'The host enforces read-only planning: workspace mutation, bash, and external MCP calls are unavailable. Research with available file reads and safe metadata tools; do not start implementation.',
    `Write the plan as Markdown whose first line is a level-1 heading ("${HEADING_PREFIX}"), followed by the steps and the verification you will run.`,
    ...(submission === undefined
      ? ['No plan-submission tool is callable in this request. Put the plan in your final response; do not claim that it was submitted for review or wait for a tool result.']
      : [
          `Submit it with ${submission} and end the turn without waiting; the user reviews it in the transcript.`,
          'While the plan is pending, do not execute it; end the turn instead.',
          'When the user asks for changes, revise and resubmit the plan. When the user approves, plan mode turns off and their confirmation arrives as a follow-up message; execute the approved plan then.',
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
    'Submit the plan you wrote in plan mode and end this turn without waiting for the review.',
    `The plan must be Markdown starting with a level-1 heading ("${HEADING_PREFIX}<title>"), followed by the steps and the verification you will run.`,
    'Only call this while plan mode is active: the user turns it on with the composer plan chip or the /plan command.',
    'The user reviews the plan in the transcript; approval turns plan mode off and their confirmation arrives as a follow-up message.',
    'If they ask for changes, revise the plan and call exit_plan_mode again instead of starting the work.',
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

/** DSH's plan mode: the document, the policy section and `exit_plan_mode`; register it in the runtime. */
export const PlanExtension: Extension = defineExtension({
  name: 'plan',
  tools: [exitPlanModeTool],
  sections: [planSection],
})
