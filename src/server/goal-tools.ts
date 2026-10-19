import { randomUUID } from 'node:crypto'
import type { Context } from '@earendil-works/chord/context'
import {
  defineDoc,
  defineExtension,
  defineTool,
  GenerationTask,
  hook,
  section,
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

/** The model is allowed exactly these two: pausing/resuming/editing are human requests (DSH's rule). */
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
 * Create a goal. Refused while an unfinished goal exists: the model must `update_goal` (or the human
 * must clear it) instead of silently replacing the objective mid-flight.
 */
export function applyGoalCreate(current: GoalState | null | undefined, input: GoalCreateInput, now: number): GoalCreateOutcome {
  if (current && current.phase !== 'complete') {
    return {
      ok: false,
      error: `A goal is already ${current.phase}: "${current.objective}". Use update_goal to edit or complete it, or ask the user to clear it first.`,
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
  if (!current) return { ok: false, error: 'No goal is set in this conversation. Use create_goal first.' }
  if (input.goalId !== current.id) {
    return { ok: false, error: `goal_id does not match the current goal (${current.id}). Call get_goal to re-read it.` }
  }
  if (input.revision !== current.revision) {
    return {
      ok: false,
      error: `Stale revision ${input.revision}: the goal is at revision ${current.revision}. Call get_goal and retry with the current revision.`,
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
      `[goal ${round}/${goal.maxGoalRounds}] 继续推进目标：「${goal.objective}」。`,
      '完成后立即用 update_goal(action="complete") 报告；受阻则用 update_goal(action="blocked", blocked_reason="…") 说明原因，不要静默停止。',
    ].join('\n'),
  }
}

/** The policy section: how the model should treat an existing goal, injected while it is not complete. */
const goalSection = section('goal-policy', async (input, context) => {
  const doc = await input.read.snapshot(Goals, input.conversationId, context)
  const goal = doc?.goal
  if (!goal || goal.phase === 'complete') return undefined
  const head = `The user set a goal for this conversation (revision ${goal.revision}): "${goal.objective}".`
  if (goal.phase === 'active') {
    return [
      head,
      `It is active, and continuation rounds started so far: ${goal.roundsStarted}/${goal.maxGoalRounds}.`,
      'Work toward this goal in every turn; keep changes scoped to it.',
      'Pausing, resuming and editing the goal are user requests: never call update_goal with those actions.',
      'When the goal is achieved, call update_goal with action "complete"; when genuinely stuck, call it with "blocked" and a blocked_reason.',
      'Report progress honestly; do not mark the goal complete unless the objective is met.',
    ].join('\n')
  }
  return [
    head,
    `The goal is ${goal.phase}${goal.blockedReason ? ` (${goal.blockedReason})` : ''}; automatic continuation rounds will not start.`,
    'Finish the current request, but do not start new work toward this goal.',
    'Only the user can resume or edit it; if the user asks to continue, the goal controls will resume it.',
  ].join('\n')
})

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
export const goalHook = hook(GenerationTask, {
  onYield: async (_answer, api, context) => {
    // Cheap committed read first: most final answers end the run and never commit.
    const snapshot = await api.snapshot(Goals, api.conversationId, context)
    if (goalContinuation(snapshot, snapshot?.goal?.roundsStarted ?? 0) === undefined) return undefined
    let continuation: string | undefined
    await (api as CommittingHookApi).commit(async (tx) => {
      const doc = await tx.doc(Goals, api.conversationId)
      const fresh = goalContinuation(doc, doc.goal?.roundsStarted ?? 0)
      if (fresh === undefined) return
      doc.goal = applyGoalRound(doc, Date.now()).goal
      continuation = fresh.continue
    }, context)
    return continuation === undefined ? undefined : { continue: continuation }
  },
})

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
    'Call it before update_goal so the revision you pass is current, and when the user asks about the goal.',
    'When there is no goal, say so and suggest the user set one with "/goal <objective>".',
  ].join(' '),
  parameters: Type.Object({}),
  execute: async (_args, api, context) => {
    const doc = await api.snapshot(Goals, api.conversationId, context)
    const goal = doc?.goal ?? null
    const text = goal
      ? `Goal (${goalSummary(goal)}): "${goal.objective}"`
      : 'No goal is set in this conversation. The user can set one with "/goal <objective>".'
    return { output: [{ type: 'text' as const, text }], details: goalDetails(goal) }
  },
})

/** DSH's `create_goal` as a Pi tool: one unfinished goal per conversation, stored in the document. */
const createGoalTool = defineTool({
  name: 'create_goal',
  description: [
    'Set a goal for this conversation: the objective the user wants carried through several turns.',
    'Refused while an unfinished goal exists; edit that one with update_goal or ask the user to clear it.',
    'max_goal_rounds caps the automatic continuation rounds (default 10); the goal stays active until completed or blocked.',
  ].join(' '),
  parameters: Type.Object({
    objective: Type.String(),
    max_goal_rounds: Type.Optional(Type.Number()),
  }),
  execute: async (args, api, context) => {
    const input: GoalCreateInput = {
      id: randomUUID(),
      objective: args.objective,
      ...(args.max_goal_rounds === undefined ? {} : { maxGoalRounds: args.max_goal_rounds }),
    }
    // Rejected before the commit when the arguments themselves are invalid, so no write is attempted.
    const validated = applyGoalCreate(null, input, Date.now())
    if (!validated.ok) throw new Error(validated.error)
    const goal = await api.commit(async (tx) => {
      const doc = await tx.doc(Goals, api.conversationId)
      // Re-validated against the committed document so two create calls cannot race past each other.
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

/** DSH's `update_goal` as a Pi tool: CAS on revision, phase changes, model limited to complete/blocked. */
const updateGoalTool = defineTool({
  name: 'update_goal',
  description: [
    'Update the conversation goal. Pass the goal_id and the revision from get_goal; a stale revision is rejected.',
    'The model may only report action "complete" or "blocked" (blocked needs blocked_reason).',
    'edit, pause, resume and clear are user requests: never call them yourself, ask the user instead.',
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

/** DSH's goal tools, policy section and continuation hook; register it like `TodoTools` in the runtime. */
export const GoalExtension: Extension = defineExtension({
  name: 'goal',
  tools: [getGoalTool, createGoalTool, updateGoalTool],
  sections: [goalSection],
  hooks: [goalHook],
})
