import { defineDoc, defineExtension, defineTool, section, type ConversationId, type Extension, type Tx } from '@earendil-works/pi-durable'
import { Type } from '@earendil-works/pi-ai'
import type { AccessMode, AskUserQuestionAnswerItem } from '../../shared/types.ts'
import { Interactions } from './interaction.ts'
import { Goals } from './goal.ts'
import { resolveToolRoute, toolRouteInstruction } from '../conversation/tool-routing.ts'
import { Subagents } from '../conversation/subagent-policy.ts'

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
export const READ_ONLY_PLAN_APPROVE_LABEL = '确认方案'
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
    throw new Error('计划为空。请将计划写成 Markdown 文本，并通过 plan 参数传入。')
  }
  if (!plan.startsWith(HEADING_PREFIX)) {
    throw new Error('计划必须是以一级标题开头的 Markdown：首行写作 "# <标题>"，再调用 exit_plan_mode。')
  }
  if (plan.split('\n', 1)[0]?.slice(HEADING_PREFIX.length).trim() === '') {
    throw new Error('计划标题为空：在 "# " 后写一个简短标题（例如 "# 迁移计划"）。')
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
  '本会话未开启计划模式，因此没有可提交的计划。',
  '仅使用当前请求提供的计划工具；没有可用工具时，在答复中直接给出计划。',
  '若请求已经批准，仅在当前访问权限范围内继续。',
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
  const [doc, identity] = await Promise.all([
    input.read.snapshot(Plans, input.conversationId, context),
    input.read.snapshot(Subagents, input.conversationId, context),
  ])
  if (doc?.active !== true) return undefined
  if (identity?.record != null) return [
    '计划模式已开启：本子会话只读调研，不实施改动。',
    '完成委派范围内的研究后，将结论、证据和未决事项交给委派方；不要向用户提问、提交计划或等待用户确认。',
  ].join('\n')
  const route = resolveToolRoute(input.agent, 'exit_plan_mode')
  const submission = toolRouteInstruction('exit_plan_mode', route, '{ plan: "<plan markdown>" }', 'zh')
  const questions = toolRouteInstruction('ask_user_question', resolveToolRoute(input.agent, 'ask_user_question'), undefined, 'zh')
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
    '宿主会拒绝写入、shell 和外部 MCP 调用；当前请求可能只列出只读工具。这些计划模式规则优先于后续任何建议使用写入工具的说明。',
    submission === undefined
      ? '不要用 `todo_write` 跟踪计划阶段：它跟踪批准后的实施；计划直接在最终回复里给出。'
      : '不要用 `todo_write` 跟踪计划阶段：它跟踪批准后的实施，计划本身属于 `exit_plan_mode`。',
    questions === undefined
      ? '能通过检查确定的事实自己去查。用户才有权决定的重大分歧无法自行解决时，在回复中说明并询问，不要编造决定或提交未决计划。'
      : `能通过检查确定的事实自己去查。只有用户拥有的选择或检查无法回答的重大歧义才${questions}；不要问代码在哪、当前行为是什么。`,
    '计划定稿前如仍有重大未决的需求或方案分歧，先问清再成稿；提交计划本身就是请求批准，不要用提问征求"计划可以吗"。',
    '计划要决策完整：写明目标与验收标准；按子系统分组改动；列出公共 API、schema 和数据流变化；覆盖边界情况、失败模式、测试、验收标准和显式假设。简洁到可审阅，详细到另一位工程师不用再做设计决策。',
    `把计划写成 Markdown，第一行是一级标题（"${HEADING_PREFIX}<标题>"），后面是步骤和要执行的验证。`,
    ...(submission === undefined
      ? ['本请求没有可调用的计划提交工具。把计划放在最终回复里并结束本轮；不要声称已提交，也不要等待工具结果。']
      : [
          `准备好后${submission}，并让该调用成为这次回复唯一且最后一个工具调用；不要把计划当普通回复粘贴，也不要用提问代替提交。`,
          '计划待审期间不要执行；结束本轮。',
          '用户要求修改时，吸收反馈并重新提交；用户批准后计划模式关闭，在当前权限内按后续消息处理已批准的方案。',
        ]),
  ].join('\n')
})

/**
 * DSH's exit_plan_mode in its non-blocking form: validate the plan, store a plan-review interaction
 * in `pi-web.interactions`, and report the plan as pending. The user's decision arrives later through
 * `POST /api/conversations/:id/interactions/:callId/answer` and turns plan mode off when approved.
 */
export type PlanExtensionOptions = {
  readAccessMode?: (tx: Tx, conversationId: ConversationId) => Promise<AccessMode | undefined>
}

const exitPlanModeTool = (options: PlanExtensionOptions) => defineTool({
  name: 'exit_plan_mode',
  description: [
    '将你在计划模式下编写的计划提交给用户批准，然后结束本轮，不等待审阅。',
    '仅用于实施步骤需要规划的代码编写任务；调研任务（收集信息、搜索或读取文件、理解代码库）应直接回答，不提交计划。',
    '调用前，确保计划完整且无歧义：先解决需求或方案中必须由用户决定的重要问题，再提交。',
    '不要另外询问“这个计划可以吗”或“是否继续”；提交计划本身就是批准请求。',
    `这是该助手回复中唯一且最后一次工具调用。计划使用 Markdown，以一级标题（"${HEADING_PREFIX}<标题>"）开头，随后列出步骤及将执行的验证。`,
    '仅在计划模式已开启时调用。',
    '用户在对话中审阅计划；批准后关闭计划模式，确认内容以跟进消息送达。',
    '若用户要求修改，修订计划并再次调用 exit_plan_mode，不要开始实施。',
    '示例：“搜索并理解 vim 模式如何实现”→ 报告发现，不提交计划；“为 vim 实现 yank 模式”→ 提交实施计划；“添加认证，认证方式未定”→ 先询问认证方式，再提交。',
  ].join(' '),
  parameters: Type.Object({ plan: Type.String() }),
  execute: async (args, api, context) => {
    const state = await api.snapshot(Plans, api.conversationId, context)
    if (state?.active !== true) {
      const route = resolveToolRoute(await api.agent(context), 'enter_plan_mode')
      const entry = toolRouteInstruction('enter_plan_mode', route, '{}')
      throw new Error(entry === undefined ? PLAN_INACTIVE_ERROR : `${PLAN_INACTIVE_ERROR} 需要进入计划模式进行审阅时：${entry}。`)
    }
    const plan = cleanPlan(args.plan)
    let approveLabel = PLAN_APPROVE_LABEL
    await api.commit(async (tx) => {
      if (options.readAccessMode !== undefined) {
        const accessMode = await options.readAccessMode(tx, api.conversationId)
        if (accessMode === 'readOnly' || accessMode === undefined) approveLabel = READ_ONLY_PLAN_APPROVE_LABEL
      }
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
        approveLabel,
        askedAt: Date.now(),
        status: 'pending',
      } satisfies StoredPlanReview
    }, context)
    return {
      output: [{
        type: 'text' as const,
        text: '计划已在对话中等待用户审阅。不要开始执行，也不要在本轮等待：结束本轮，待用户的决定作为跟进消息送达后再继续。',
      }],
      details: {
        requestKey: api.callId,
        kind: 'plan-review',
        status: 'pending' as const,
        approveLabel,
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
    '自行将本会话切换为计划模式，无须询问用户或等待确认。',
    '非简单的实施任务优先进入计划模式，例如新功能、有多种可行方案的工作、多文件重构、架构决策或验收标准不明确的任务。',
    '简单查询、单行修复、明显的缺陷修复、直接回答，以及用户已给出明确详细指令的任务，无须进入计划模式。',
    '计划模式开启时，仅研究仓库和设计计划，不做改动；最后用 exit_plan_mode 提交计划，等待用户批准。',
    '计划模式已经开启时，无须重复调用。',
  ].join(' '),
  parameters: Type.Object({}),
  execute: async (_args, api, context) => {
    const goal = await api.snapshot(Goals, api.conversationId, context)
    if (goal?.goal?.phase === 'active') {
      throw new Error('计划和目标不能同时处于活动状态：进入计划模式前，先暂停或完成目标。')
    }
    const state = await api.snapshot(Plans, api.conversationId, context)
    if (state?.active === true) {
      return {
        output: [{
          type: 'text' as const,
          text: '计划模式已经开启。先调研，再用 exit_plan_mode 提交计划。',
        }],
      }
    }
    if (resolveToolRoute(await api.agent(context), 'exit_plan_mode') === 'unavailable') {
      throw new Error('本请求没有可调用的计划提交工具，无法进入计划模式。请先调研，再直接在答复中给出计划。')
    }
    await api.commit(async (tx) => {
      const doc = await tx.doc(Plans, api.conversationId)
      doc.active = true
      doc.updatedAt = Date.now()
    }, context)
    return {
      output: [{
        type: 'text' as const,
        text: '计划模式已开启。先调研、设计计划，再用 exit_plan_mode 提交；用户批准前不得实施。',
      }],
      details: { kind: 'plan-mode' as const, status: 'active' as const },
    }
  },
})

/** DSH's plan mode: the document, the policy section and `exit_plan_mode`; register it in the runtime. */
export function createPlanExtension(options: PlanExtensionOptions = {}): Extension {
  return defineExtension({
    name: 'plan',
    tools: [enterPlanModeTool, exitPlanModeTool(options)],
    sections: [planSection],
  })
}

export const PlanExtension: Extension = createPlanExtension()
