import { randomUUID } from 'node:crypto'
import type { Context } from '@earendil-works/chord/context'
import { Plans } from './plan-tools.ts'
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
  fork: 'initial',
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
      `[goal ${round}/${goal.maxGoalRounds}] Continue the user's objective: "${goal.objective}".`,
      'After the objective is achieved and its requested verification passes, report completion through the callable goal-tool route. If a concrete blocker makes further progress impossible, report that condition through the supported blocked action.',
    ].join('\n'),
  }
}

type GoalToolRoute = 'direct' | 'codemode' | undefined

function goalToolRoutes(input: {
  agent: { tools: readonly { name: string }[]; callable: readonly { name: string }[] }
}): Record<(typeof GOAL_TOOL_NAMES)[number], GoalToolRoute> {
  const offered = new Set(input.agent.tools.map(tool => tool.name))
  const nested = new Set(input.agent.callable.map(tool => tool.name))
  const codemodeAvailable = offered.has('codemode')
  return Object.fromEntries(GOAL_TOOL_NAMES.map(name => [
    name,
    offered.has(name) ? 'direct' : codemodeAvailable && nested.has(name) ? 'codemode' : undefined,
  ])) as Record<(typeof GOAL_TOOL_NAMES)[number], GoalToolRoute>
}

function toolRouteInstruction(name: (typeof GOAL_TOOL_NAMES)[number], route: GoalToolRoute): string | undefined {
  if (route === 'direct') return `Call \`${name}\` directly.`
  if (route === 'codemode') return `Through \`codemode\`, call \`await tools.${name}({ ... })\` inside the script.`
  return undefined
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
    const routes = goalToolRoutes(input)
    const planMode = plan?.active === true
    const createCallable = !planMode
      && routes.create_goal !== undefined
      && await allowed(options.canCreate, input.conversationId, context)
    const updateCallable = !planMode
      && routes.update_goal !== undefined
      && await allowed(options.canContinue, input.conversationId, context)
    const goal = doc?.goal
    const lines = [
      'Use a persistent goal only for a direct human request that needs work across multiple turns. Infer that intent without requiring the word "goal"; do not create one for trivial, single-turn, or unrelated work.',
      ...(planMode ? ['Plan mode is active: do planning work only. Do not create a goal, make implementation progress, or start automatic continuation rounds.'] : []),
      ...(!goal ? ['No goal is currently set for this conversation.'] : []),
    ]

    const getInstruction = toolRouteInstruction('get_goal', routes.get_goal)
    if (getInstruction !== undefined) lines.push(`Read the current goal when the user asks about it. ${getInstruction}`)

    if (!goal || goal.phase === 'complete') {
      if (createCallable) {
        lines.push('For a qualifying long-running objective, create a goal with the user’s direct request as its scope.', toolRouteInstruction('create_goal', routes.create_goal)!)
      } else if (!planMode && routes.create_goal !== undefined) {
        lines.push('Goal creation is unavailable for this conversation in the current request; do not claim to set a goal.')
      }
      if (goal?.phase === 'complete') lines.push(`The previous goal is complete: "${goal.objective}". Treat a new objective as a new goal only when the human asks for long-running work.`)
      return lines.join('\n')
    }

    lines.push(`Current goal (revision ${goal.revision}): "${goal.objective}".`)
    if (goal.phase === 'active') {
      lines.push(`It is active; ${goal.roundsStarted}/${goal.maxGoalRounds} automatic continuation rounds have started.`)
      if (planMode) {
        lines.push('This goal remains active, but do not change its state or advance implementation while plan mode is active.')
      } else {
        lines.push('Work toward this goal within the current request and keep changes scoped to it.')
      }
      if (updateCallable) {
        lines.push(
          'The model may report only action "complete" or "blocked". Report complete only after the objective is achieved and requested verification has passed, with concrete evidence. Report blocked only when a concrete condition makes further progress impossible, and state that condition; difficulty, uncertainty, or remaining work alone is not a blocker.',
          'Editing, pausing, and resuming are user requests handled by the goal controls; do not call update_goal with those actions.',
          toolRouteInstruction('update_goal', routes.update_goal)!,
        )
      } else if (!planMode) {
        lines.push('No goal update action is callable in this request; do not claim to change the goal state or start an automatic continuation.')
      }
    } else {
      lines.push(`The goal is ${goal.phase}${goal.blockedReason ? ` (${goal.blockedReason})` : ''}; automatic continuation rounds will not start.`)
      lines.push('Do not start new work toward this goal until the user uses the goal controls to resume it.')
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
      // Cheap committed read first: most final answers end the run and never commit.
      const snapshot = await api.snapshot(Goals, api.conversationId, context)
      if (goalContinuation(snapshot, snapshot?.goal?.roundsStarted ?? 0) === undefined) return undefined
      let continuation: string | undefined
      await (api as CommittingHookApi).commit(async (tx) => {
        const planDoc = await tx.doc(Plans, api.conversationId)
        if (planDoc.active) return
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
    'Read the goal of this conversation: objective, phase, round budget and revision.',
    'Use it when the user asks about the current goal or its status.',
    'When no goal is set, continue according to the current task and available goal policy.',
  ].join(' '),
  parameters: Type.Object({}),
  execute: async (_args, api, context) => {
    const doc = await api.snapshot(Goals, api.conversationId, context)
    const goal = doc?.goal ?? null
    const text = goal
      ? `Goal (${goalSummary(goal)}): "${goal.objective}"`
      : 'No goal is set for this conversation. Continue according to the current task and available goal policy.'
    return { output: [{ type: 'text' as const, text }], details: goalDetails(goal) }
  },
})

/** DSH's `create_goal` as a Pi tool: one unfinished goal per conversation, stored in the document. */
function createGoalTool(canCreate: Required<GoalToolOptions>['canCreate']) {
  return defineTool({
    name: 'create_goal',
    description: [
      'Create a persisted goal that keeps this conversation working across bounded automatic continuation rounds.',
      'Use it for a direct human request that needs work across multiple turns, even when the user did not say "goal"; do not use it for trivial, single-turn, or unrelated work.',
      'An unfinished goal cannot be replaced; continue its objective or ask the user to use the goal controls. max_goal_rounds caps automatic continuation rounds (default 10).',
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
    'Update the conversation goal. Pass the goal_id and revision shown in the current goal context; a stale revision is rejected.',
    'The model may only report action "complete" or "blocked" (blocked needs blocked_reason).',
    'Only complete and blocked are valid model actions; edit, pause, and resume are user requests handled by the goal controls.',
  ].join(' '),
  parameters: Type.Object({
    goal_id: Type.String(),
    revision: Type.Number(),
    action: Type.Union([Type.Literal('edit'), Type.Literal('pause'), Type.Literal('resume'), Type.Literal('complete'), Type.Literal('blocked')]),
    objective: Type.Optional(Type.String()),
    blocked_reason: Type.Optional(Type.String()),
    max_goal_rounds: Type.Optional(Type.Number()),
  }),
  execute: async (args, api, context) => {
    const goal = await api.commit(async (tx) => {
      const doc = await tx.doc(Goals, api.conversationId)
      const outcome = applyGoalUpdate(doc.goal, {
        goalId: args.goal_id,
        revision: args.revision,
        action: args.action,
        ...(args.objective === undefined ? {} : { objective: args.objective }),
        ...(args.blocked_reason === undefined ? {} : { blockedReason: args.blocked_reason }),
        ...(args.max_goal_rounds === undefined ? {} : { maxGoalRounds: args.max_goal_rounds }),
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
