import { randomUUID } from 'node:crypto'
import type { Context } from '@earendil-works/chord/context'
import { Plans } from './plan.ts'
import { Interactions } from './interaction.ts'
import {
  defineDoc,
  defineExtension,
  defineTool,
  GenerationTask,
  hook,
  section,
  type ConversationId,
  type Extension,
  type HookApi,
  type Tx,
} from '@earendil-works/pi-durable'
import { Type } from '@earendil-works/pi-ai'
import { resolveToolRoute, toolRouteInstruction, type ToolCatalog, type ToolRoute } from '../conversation/tool-routing.ts'

/** DSH phases of one goal; `complete` is terminal and the UI hides the bar for it. */
export type GoalPhase = 'active' | 'paused' | 'blocked' | 'complete'

/** One goal as the conversation document stores it. Type alias, not interface: Pi's JsonObject constraint. */
export type GoalState = {
  id: string
  /** CAS token: every accepted content mutation bumps it; automatic goal rounds do not. */
  revision: number
  objective: string
  phase: GoalPhase
  /** Automatic continuation rounds this goal may start; the first human turn does not count. */
  maxGoalRounds: number
  /** Continuation rounds already started; only `applyGoalRound` moves it, and only forward. */
  roundsStarted: number
  blockedReason?: string
  createdAt: number
  updatedAt: number
}

export type GoalDocValue = { goal: GoalState | null }

export const DEFAULT_MAX_GOAL_ROUNDS = 10
export const MAX_GOAL_ROUNDS_LIMIT = 50
const MAX_OBJECTIVE_LENGTH = 2000

export const GOAL_TOOL_NAMES = ['get_goal', 'create_goal', 'update_goal'] as const

export type GoalToolOptions = {
  canCreate?: (id: ConversationId, context: Context) => Promise<boolean>
  canContinue?: (id: ConversationId, context: Context) => Promise<boolean>
}

const PLAN_MODE_ERROR = 'Goal creation is unavailable while plan mode is active.'

/**
 * Conversation-scoped goal snapshot. `projectConversation` reads it into `ConversationDetail.goal`;
 * the `onYield` hook continues the run from it; `update_goal`/`create_goal` mutate it under CAS.
 */
export const Goals = defineDoc<GoalDocValue>({
  kind: 'pi-web.goal',
  version: 1,
  scope: 'conversation',
  history: 'latest',
  fork: 'initial', checkpointWhen: () => false,
  initial: () => ({ goal: null }),
})

/** Who asks for an update: the human (UI route) may edit/pause/resume; the model may only complete/report-blocked. */
export type GoalActor = 'human' | 'model'

/** Actions the goal routes and tools accept; `clear` removes the goal and is human-only. */
export type GoalAction = 'edit' | 'pause' | 'resume' | 'complete' | 'blocked' | 'clear'

/** This host handles pause/resume/edit through user controls; the model reports completion or blockers. */
const MODEL_ACTIONS: readonly GoalAction[] = ['complete', 'blocked']

export type GoalUpdateInput = {
  goalId: string
  revision: number
  action: GoalAction
  objective?: string
  blockedReason?: string
  maxGoalRounds?: number
}

export type GoalUpdateOutcome =
  | { ok: true; goal: GoalState | null }
  | { ok: false; error: string }

/** Normalize an objective: trimmed, non-empty, bounded. `undefined` means invalid. */
export function cleanObjective(value: string | undefined): string | undefined {
  const objective = (value ?? '').trim()
  if (objective === '' || objective.length > MAX_OBJECTIVE_LENGTH) return undefined
  return objective
}

/** Normalize `maxGoalRounds`: a positive integer up to {@link MAX_GOAL_ROUNDS_LIMIT}. */
export function cleanMaxGoalRounds(value: number | undefined): number | undefined {
  if (value === undefined) return undefined
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_GOAL_ROUNDS_LIMIT) return undefined
  return value
}

export type GoalCreateInput = {
  /** Pre-generated so the pure helper stays deterministic; the tool passes `randomUUID()`. */
  id: string
  objective: string
  maxGoalRounds?: number
}

export type GoalCreateOutcome =
  | { ok: true; goal: GoalState }
  | { ok: false; error: string }

/**
 * Create a goal. Refused while an unfinished goal exists so an objective cannot be silently replaced mid-flight.
 */
export function applyGoalCreate(current: GoalState | null | undefined, input: GoalCreateInput, now: number): GoalCreateOutcome {
  if (current && current.phase !== 'complete') {
    return {
      ok: false,
      error: `A goal is already ${current.phase}: "${current.objective}". Continue its objective or ask the user to change it in the goal controls first.`,
    }
  }
  const objective = cleanObjective(input.objective)
  if (objective === undefined) return { ok: false, error: 'The goal objective must be non-empty, trimmed text.' }
  const maxGoalRounds = input.maxGoalRounds === undefined ? DEFAULT_MAX_GOAL_ROUNDS : cleanMaxGoalRounds(input.maxGoalRounds)
  if (maxGoalRounds === undefined) {
    return { ok: false, error: `max_goal_rounds must be an integer between 1 and ${MAX_GOAL_ROUNDS_LIMIT}.` }
  }
  return {
    ok: true,
    goal: {
      id: input.id,
      revision: 1,
      objective,
      phase: 'active',
      maxGoalRounds,
      roundsStarted: 0,
      createdAt: now,
      updatedAt: now,
    },
  }
}

/**
 * Apply one update against the committed goal. Every accepted mutation bumps `revision` (the CAS
 * token the model must echo); `clear` removes the goal. Permission split: `edit`, `pause`, `resume`
 * and `clear` are human requests, `complete` and `blocked` are the model's own reports.
 */
export function applyGoalUpdate(
  current: GoalState | null | undefined,
  input: GoalUpdateInput,
  options: { actor: GoalActor; now: number },
): GoalUpdateOutcome {
  if (!current) return { ok: false, error: 'No goal is set in this conversation; ask the user to set one first.' }
  if (input.goalId !== current.id) {
    return { ok: false, error: `goal_id does not match the current goal (${current.id}). Refresh the current goal context and retry.` }
  }
  if (input.revision !== current.revision) {
    return {
      ok: false,
      error: `Stale revision ${input.revision}: the goal is at revision ${current.revision}. Refresh the current goal context and retry with its revision.`,
    }
  }
  if (options.actor === 'model' && !MODEL_ACTIONS.includes(input.action)) {
    return {
      ok: false,
      error: `The model may only report "complete" or "blocked"; "${input.action}" is a user request. Ask the user to use the goal controls instead.`,
    }
  }
  const mutate = (patch: Partial<GoalState>): { ok: true; goal: GoalState } => {
    const next: GoalState = { ...current, ...patch, revision: current.revision + 1, updatedAt: options.now }
    // Cleared reasons leave no key behind; the document stays strict JSON.
    if (next.blockedReason === undefined) delete next.blockedReason
    return { ok: true, goal: next }
  }
  switch (input.action) {
    case 'edit': {
      if (current.phase === 'complete') return { ok: false, error: 'A completed goal cannot be edited; clear it or create a new goal.' }
      const objective = cleanObjective(input.objective)
      if (objective === undefined) return { ok: false, error: 'Editing a goal needs a non-empty objective.' }
      const maxGoalRounds = input.maxGoalRounds === undefined ? current.maxGoalRounds : cleanMaxGoalRounds(input.maxGoalRounds)
      if (maxGoalRounds === undefined) {
        return { ok: false, error: `max_goal_rounds must be an integer between 1 and ${MAX_GOAL_ROUNDS_LIMIT}.` }
      }
      return mutate({ objective, maxGoalRounds })
    }
    case 'pause':
      if (current.phase === 'complete') return { ok: false, error: 'A completed goal cannot be paused.' }
      return mutate({ phase: 'paused' })
    case 'resume':
      if (current.phase === 'active') return { ok: false, error: 'The goal is already active.' }
      if (current.phase === 'complete') return { ok: false, error: 'A completed goal cannot be resumed; create a new goal instead.' }
      return mutate({ phase: 'active', blockedReason: undefined })
    case 'complete':
      if (current.phase === 'complete') return { ok: false, error: 'The goal is already complete.' }
      return mutate({ phase: 'complete', blockedReason: undefined })
    case 'blocked': {
      const reason = (input.blockedReason ?? '').trim()
      if (reason === '') return { ok: false, error: 'Reporting a blocked goal needs blocked_reason.' }
      if (current.phase === 'complete') return { ok: false, error: 'A completed goal cannot be reported blocked.' }
      return mutate({ phase: 'blocked', blockedReason: reason })
    }
    case 'clear':
      if (options.actor === 'model') return { ok: false, error: 'The model cannot clear a goal; only the user can.' }
      return { ok: true, goal: null }
  }
}

/**
 * Start one automatic goal round: increments `roundsStarted` by one and refreshes `updatedAt`.
 * `revision` deliberately stays put — round counting is not a content mutation, so a model's
 * just-read CAS token keeps matching across continuations. Not `active`, or a doc without a goal:
 * the input is returned unchanged.
 */
export function applyGoalRound(docValue: GoalDocValue | undefined, now: number): GoalDocValue {
  const goal = docValue?.goal
  if (!docValue || !goal || goal.phase !== 'active') return docValue ?? { goal: null }
  return { goal: { ...goal, roundsStarted: goal.roundsStarted + 1, updatedAt: now } }
}

/**
 * The continuation prompt for the `onYield` hook, or `undefined` when the run must end.
 * Continues only while the goal is `active` and fewer than `maxGoalRounds` rounds have started;
 * `roundsStartedSoFar` is read from the committed document (memos do not cross generations).
 * The text carries the round number so the transcript stays legible without extra state.
 */
export function goalContinuation(docValue: GoalDocValue | undefined, roundsStartedSoFar: number): { continue: string } | undefined {
  const goal = docValue?.goal
  if (!goal || goal.phase !== 'active') return undefined
  if (!Number.isSafeInteger(roundsStartedSoFar) || roundsStartedSoFar < 0) return undefined
  if (roundsStartedSoFar >= goal.maxGoalRounds) return undefined
  const round = roundsStartedSoFar + 1
  return {
    continue: [
      `[goal ${round}/${goal.maxGoalRounds}] 继续完成用户的目标：“${goal.objective}”。`,
      '以当前工作区、工具结果和目标状态为准；实际检查它们，不要假设先前的描述仍然有效，并取得具体、经过验证的进展。',
      '整个目标达成且用户要求的验证通过后，通过当前可调用的目标工具报告完成。若具体阻塞使后续工作无法推进，通过支持的 blocked 操作报告该情况。',
      '如果正在等待用户的答复或批准，结束本轮，不再改动。',
    ].join('\n'),
  }
}

/** A question or plan review still waiting for the user, in the shared interactions table. */
export function awaitingUser(table: Record<string, unknown> | undefined): boolean {
  return Object.values(table ?? {}).some(record =>
    typeof record === 'object' && record !== null && (record as { status?: unknown }).status === 'pending')
}

function goalToolRoutes(agent: ToolCatalog): Record<(typeof GOAL_TOOL_NAMES)[number], ToolRoute> {
  return Object.fromEntries(GOAL_TOOL_NAMES.map(name => [
    name,
    resolveToolRoute(agent, name),
  ])) as Record<(typeof GOAL_TOOL_NAMES)[number], ToolRoute>
}

function goalToolInstruction(name: (typeof GOAL_TOOL_NAMES)[number], route: ToolRoute): string | undefined {
  return toolRouteInstruction(name, route)
}

async function allowed(
  check: GoalToolOptions['canCreate'] | GoalToolOptions['canContinue'] | undefined,
  id: ConversationId,
  context: Context,
): Promise<boolean> {
  if (check === undefined) return true
  try {
    return await check(id, context) === true
  } catch {
    return false
  }
}

/** Render goal guidance for every request, limited to the routes currently exposed to the model. */
function createGoalSection(options: Required<GoalToolOptions>) {
  return section('goal-policy', async (input, context) => {
    const [doc, plan] = await Promise.all([
      input.read.snapshot(Goals, input.conversationId, context),
      input.read.snapshot(Plans, input.conversationId, context),
    ])
    const routes = goalToolRoutes(input.agent)
    const planMode = plan?.active === true
    const createCallable = !planMode
      && routes.create_goal !== 'unavailable'
      && await allowed(options.canCreate, input.conversationId, context)
    const updateCallable = !planMode
      && routes.update_goal !== 'unavailable'
      && await allowed(options.canContinue, input.conversationId, context)
    const goal = doc?.goal
    if (!goal && Object.values(routes).every(route => route === 'unavailable')) return undefined
    const lines = [
      '仅为用户直接提出、需要跨多轮推进的请求创建持久目标。根据意图判断，无须用户说出“目标”一词；简单、单轮或无关工作不要创建目标。',
      ...(planMode ? ['计划模式已开启：只做规划，不创建目标、不推进实施，也不启动自动续跑。'] : []),
      ...(!goal ? ['当前会话尚未设置目标。'] : []),
    ]

    const getInstruction = goalToolInstruction('get_goal', routes.get_goal)
    if (getInstruction !== undefined) lines.push(`用户询问当前目标时读取它。${getInstruction}。`)

    if (!goal || goal.phase === 'complete') {
      if (createCallable) {
        lines.push('对于符合条件的长期任务，以用户直接提出的请求为范围创建目标。', goalToolInstruction('create_goal', routes.create_goal)!)
      } else if (!planMode && routes.create_goal !== 'unavailable') {
        lines.push('当前请求不允许为本会话创建目标；不要声称已设置目标。')
      }
      if (goal?.phase === 'complete') lines.push(`上一个目标已完成：“${goal.objective}”。只有用户提出长期任务时，才将新任务设为新目标。`)
      return lines.join('\n')
    }

    lines.push(`当前目标：goal_id "${goal.id}"，revision ${goal.revision}，objective "${goal.objective}"。`)
    if (goal.phase === 'active') {
      lines.push(`目标处于 active 状态；已启动 ${goal.roundsStarted}/${goal.maxGoalRounds} 轮自动续跑。`)
      if (planMode) {
        lines.push('该目标仍处于 active 状态，但计划模式开启时不得改变目标状态或推进实施。')
      } else {
        lines.push('在本请求中推进该目标，改动范围限于此目标。')
        if (resolveToolRoute(input.agent, 'ask_user_question') !== 'unavailable') {
          lines.push('需要用户作决定时，用 ask_user_question 提问；自动续跑会等待答复。')
        }
      }
      if (updateCallable) {
        lines.push(
          '模型只能报告 action "complete" 或 "blocked"。只有目标达成且所要求的验证通过，并有具体证据时，才报告 complete。只有具体条件使后续工作无法推进时，才报告 blocked，并说明该条件；困难、不确定性或仍有剩余工作本身不构成阻塞。',
          '编辑、暂停和恢复由用户通过目标控件操作；不要用 update_goal 执行这些动作。',
          goalToolInstruction('update_goal', routes.update_goal)!,
        )
      } else if (!planMode) {
        lines.push('本请求没有可调用的目标更新操作；不要声称已更改目标状态或启动自动续跑。')
      }
    } else {
      lines.push(`目标状态为 ${goal.phase}${goal.blockedReason ? ` (${goal.blockedReason})` : ''}；不会启动自动续跑。`)
      lines.push('用户通过目标控件恢复之前，不要为此目标开始新的工作。')
    }
    return lines.join('\n')
  })
}

/**
 * The hook runtime actually hands `commit` to hooks (the generation task passes its own runtime),
 * while the declared `HookApi` surface only promises committed reads and memos. The goal hook needs
 * the atomic write to keep the round count exact, so it narrow-casts to this shape.
 */
type CommittingHookApi = HookApi & {
  commit<T>(change: (tx: Tx) => T | Promise<T>, context: Context): Promise<T>
}

/**
 * DSH's goal-round driver as Pi's `onYield` hook: after a final answer, while the goal is active and
 * under `maxGoalRounds`, append one continuation user message and keep the run going. The round is
 * bumped inside the same commit that decides to continue, so two generations can never double-count;
 * a pause/clear that landed since the snapshot wins and stops the continuation.
 */
function createGoalHook(canContinue: GoalToolOptions['canContinue']) {
  return hook(GenerationTask, {
    onYield: async (_answer, api, context) => {
      const plan = await api.snapshot(Plans, api.conversationId, context)
      if (plan?.active === true || !await allowed(canContinue, api.conversationId, context)) return undefined
      // DSH's ask_user_question blocks, so its driver never sees an idle agent with an open question.
      // Here the question ends the turn instead; continuing now would push past the user's answer.
      if (awaitingUser(await api.snapshot(Interactions, api.conversationId, context))) return undefined
      // Cheap committed read first: most final answers end the run and never commit.
      const snapshot = await api.snapshot(Goals, api.conversationId, context)
      if (goalContinuation(snapshot, snapshot?.goal?.roundsStarted ?? 0) === undefined) return undefined
      let continuation: string | undefined
      await (api as CommittingHookApi).commit(async (tx) => {
        const planDoc = await tx.doc(Plans, api.conversationId)
        if (planDoc.active) return
        if (awaitingUser(await tx.doc(Interactions, api.conversationId))) return
        const doc = await tx.doc(Goals, api.conversationId)
        const fresh = goalContinuation(doc, doc.goal?.roundsStarted ?? 0)
        if (fresh === undefined) return
        doc.goal = applyGoalRound(doc, Date.now()).goal
        continuation = fresh.continue
      }, context)
      return continuation === undefined ? undefined : { continue: continuation }
    },
  })
}

/** Backwards-compatible default hook; the runtime factory supplies its own authorization gate. */
export const goalHook = createGoalHook(undefined)

const goalDetails = (goal: GoalState | null) => ({ goal: goal ? { ...goal } : null })

function goalSummary(goal: GoalState): string {
  const blocked = goal.phase === 'blocked' && goal.blockedReason ? ` (blocked: ${goal.blockedReason})` : ''
  return `id ${goal.id}, ${goal.phase}${blocked}; rounds ${goal.roundsStarted}/${goal.maxGoalRounds}; revision ${goal.revision}`
}

/** DSH's `get_goal` as a Pi tool: read the conversation document and report the current state. */
const getGoalTool = defineTool({
  name: 'get_goal',
  description: [
    '读取本会话的目标，包括任务内容、阶段、续跑轮数预算和版本号。',
    '用户询问当前目标或其状态时使用。',
    '没有设置目标时，按当前任务和可用的目标规则继续。',
  ].join(' '),
  parameters: Type.Object({}),
  execute: async (_args, api, context) => {
    const doc = await api.snapshot(Goals, api.conversationId, context)
    const goal = doc?.goal ?? null
    const text = goal
      ? `Goal (${goalSummary(goal)}): "${goal.objective}"`
      : '本会话尚未设置目标。按当前任务和可用的目标规则继续。'
    return { output: [{ type: 'text' as const, text }], details: goalDetails(goal) }
  },
})

/** DSH's `create_goal` as a Pi tool: one unfinished goal per conversation, stored in the document. */
function createGoalTool(canCreate: Required<GoalToolOptions>['canCreate']) {
  return defineTool({
    name: 'create_goal',
    description: [
      '创建持久目标，让本会话在有轮数上限的自动续跑中持续工作。',
      '用于用户直接提出、需要跨多轮推进的请求，即使用户没有说“目标”；简单、单轮或无关工作不要使用。',
      '未完成的目标不能被替换；继续该目标，或请用户使用目标控件调整。max_goal_rounds 限制自动续跑轮数，默认 10。',
    ].join(' '),
    parameters: Type.Object({
      objective: Type.String(),
      max_goal_rounds: Type.Optional(Type.Number()),
    }),
    execute: async (args, api, context) => {
      if (!await allowed(canCreate, api.conversationId, context)) {
        throw new Error('Goal creation is unavailable for this conversation.')
      }
      const plan = await api.snapshot(Plans, api.conversationId, context)
      if (plan?.active === true) throw new Error(PLAN_MODE_ERROR)
      const input: GoalCreateInput = {
        id: randomUUID(),
        objective: args.objective,
        ...(args.max_goal_rounds === undefined ? {} : { maxGoalRounds: args.max_goal_rounds }),
      }
      // Reject invalid arguments before opening a write transaction.
      const validated = applyGoalCreate(null, input, Date.now())
      if (!validated.ok) throw new Error(validated.error)
      const goal = await api.commit(async (tx) => {
        const currentPlan = await tx.doc(Plans, api.conversationId)
        if (currentPlan.active) throw new Error(PLAN_MODE_ERROR)
        const doc = await tx.doc(Goals, api.conversationId)
        const outcome = applyGoalCreate(doc.goal, input, Date.now())
        if (!outcome.ok) throw new Error(outcome.error)
        doc.goal = outcome.goal
        return outcome.goal
      }, context)
      return {
        output: [{ type: 'text' as const, text: `Goal created (${goalSummary(goal)}): "${goal.objective}"` }],
        details: goalDetails(goal),
      }
    },
  })
}

/** DSH's `update_goal` as a Pi tool: CAS on revision, phase changes, model limited to complete/blocked. */
const updateGoalTool = defineTool({
  name: 'update_goal',
  description: [
    '报告当前目标已完成或受阻。从当前目标规则中准确复制 goal_id 和 revision；过期版本会被拒绝。',
    '模型仅可执行 "complete" 和 "blocked"；blocked 必须提供 blocked_reason。编辑、暂停和恢复由用户控件处理。',
  ].join(' '),
  parameters: Type.Object({
    goal_id: Type.String(),
    revision: Type.Number(),
    action: Type.Union([Type.Literal('complete'), Type.Literal('blocked')]),
    blocked_reason: Type.Optional(Type.String()),
  }),
  execute: async (args, api, context) => {
    const goal = await api.commit(async (tx) => {
      const doc = await tx.doc(Goals, api.conversationId)
      const outcome = applyGoalUpdate(doc.goal, {
        goalId: args.goal_id,
        revision: args.revision,
        action: args.action,
        ...(args.blocked_reason === undefined ? {} : { blockedReason: args.blocked_reason }),
      }, { actor: 'model', now: Date.now() })
      if (!outcome.ok) throw new Error(outcome.error)
      doc.goal = outcome.goal
      return outcome.goal
    }, context)
    const text = goal === null
      ? 'Goal cleared.'
      : `Goal updated (${goalSummary(goal)}): "${goal.objective}"`
    return { output: [{ type: 'text' as const, text }], details: goalDetails(goal) }
  },
})

/** DSH's goal tools, policy section and continuation hook with runtime-owned authorization gates. */
export function createGoalExtension(options: GoalToolOptions = {}): Extension {
  const activeOptions: Required<GoalToolOptions> = {
    canCreate: options.canCreate ?? (async () => true),
    canContinue: options.canContinue ?? (async () => true),
  }
  const createTool = createGoalTool(activeOptions.canCreate)
  return defineExtension({
    name: 'goal',
    tools: [getGoalTool, createTool, updateGoalTool],
    sections: [createGoalSection(activeOptions)],
    hooks: [createGoalHook(activeOptions.canContinue)],
  })
}

/** Existing standalone default; runtime integrations should use `createGoalExtension`. */
export const GoalExtension: Extension = createGoalExtension()

export default GoalExtension
