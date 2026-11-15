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

/** DSH 目标的阶段；`complete` 是终态，UI 对它隐藏目标条。 */
export type GoalPhase = 'active' | 'paused' | 'blocked' | 'complete'

/** 会话文档中存储的一个目标。用 type alias 而非 interface：受 Pi 的 JsonObject 约束。 */
export type GoalState = {
  id: string
  /** CAS 令牌：每次被接受的内容变更都会加一；自动续跑轮不加。 */
  revision: number
  objective: string
  phase: GoalPhase
  /** 该目标可启动的自动续跑轮数；第一轮人工回合不计入。 */
  maxGoalRounds: number
  /** 已启动的续跑轮数；只有 `applyGoalRound` 会移动它，且只增不减。 */
  roundsStarted: number
  blockedReason?: string
  createdAt: number
  updatedAt: number
}

/** Goals 文档的值形状：当前目标或 null。 */
export type GoalDocValue = { goal: GoalState | null }

/** 自动续跑轮数的默认值。 */
export const DEFAULT_MAX_GOAL_ROUNDS = 10
/** 自动续跑轮数的上限。 */
export const MAX_GOAL_ROUNDS_LIMIT = 50
/** 目标描述文本的最大字符数。 */
const MAX_OBJECTIVE_LENGTH = 2000

/** 三个目标工具名。 */
export const GOAL_TOOL_NAMES = ['get_goal', 'create_goal', 'update_goal'] as const

/** 目标扩展的可选授权门：创建与续跑分别检查。 */
export type GoalToolOptions = {
  canCreate?: (id: ConversationId, context: Context) => Promise<boolean>
  canContinue?: (id: ConversationId, context: Context) => Promise<boolean>
}

/** 计划模式开启时创建目标的报错文案。 */
const PLAN_MODE_ERROR = 'Goal creation is unavailable while plan mode is active.'

/**
 * 会话作用域的目标快照。`projectConversation` 把它读进 `ConversationDetail.goal`；
 * `onYield` 钩子依据它续跑；`update_goal`/`create_goal` 在 CAS 保护下修改它。
 */
export const Goals = defineDoc<GoalDocValue>({
  kind: 'pi-web.goal',
  version: 1,
  scope: 'conversation',
  history: 'latest',
  fork: 'initial', checkpointWhen: () => false,
  initial: () => ({ goal: null }),
})

/** 更新请求的发起方：人类（UI 路由）可编辑/暂停/恢复；模型只能报告完成或受阻。 */
export type GoalActor = 'human' | 'model'

/** 目标路由与工具接受的动作；`clear` 移除目标且仅限人类。 */
export type GoalAction = 'edit' | 'pause' | 'resume' | 'complete' | 'blocked' | 'clear'

/** 本宿主用用户控件处理暂停/恢复/编辑；模型报告完成或阻塞。 */
const MODEL_ACTIONS: readonly GoalAction[] = ['complete', 'blocked']

/** 一次目标更新的输入：目标 id、CAS revision、动作与可选字段。 */
export type GoalUpdateInput = {
  goalId: string
  revision: number
  action: GoalAction
  objective?: string
  blockedReason?: string
  maxGoalRounds?: number
}

/** 目标更新结果：成功带新目标，失败带错误信息。 */
export type GoalUpdateOutcome =
  | { ok: true; goal: GoalState | null }
  | { ok: false; error: string }

/**
 * 功能：规范化目标描述：trim、非空、限长。
 * @param value 原始目标描述。
 * @returns 规范化后的描述；无效（空或超长）时 undefined。
 */
export function cleanObjective(value: string | undefined): string | undefined {
  const objective = (value ?? '').trim()
  if (objective === '' || objective.length > MAX_OBJECTIVE_LENGTH) return undefined
  return objective
}

/** 功能：规范化 `maxGoalRounds`：1 到 {@link MAX_GOAL_ROUNDS_LIMIT} 的正整数，无效时 undefined。 */
export function cleanMaxGoalRounds(value: number | undefined): number | undefined {
  if (value === undefined) return undefined
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_GOAL_ROUNDS_LIMIT) return undefined
  return value
}

/** 创建目标的输入；id 预先生成以保持纯函数确定性，工具侧传 `randomUUID()`。 */
export type GoalCreateInput = {
  id: string
  objective: string
  maxGoalRounds?: number
}

/** 目标创建结果：成功带新目标，失败带错误信息。 */
export type GoalCreateOutcome =
  | { ok: true; goal: GoalState }
  | { ok: false; error: string }

/**
 * 功能：创建目标。存在未完成目标时拒绝，避免目标在推进途中被悄悄替换。
 * 输入校验：objective 经 cleanObjective；maxGoalRounds 经 cleanMaxGoalRounds（缺省用
 * 默认值）；新目标 revision 为 1、phase 为 active。
 * @param current 当前目标（可为 null/undefined）。
 * @param input 创建输入。
 * @param now 当前时间戳。
 * @returns 创建结果。
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
 * 功能：对已提交的目标应用一次更新。每次被接受的变更都会加 `revision`（模型必须回
 * 传的 CAS 令牌）；`clear` 移除目标。权限划分：`edit`/`pause`/`resume`/`clear` 属于
 * 人类请求，`complete`/`blocked` 是模型自己的报告。
 * 输入校验：无目标、goalId 不匹配、revision 过期、模型越权动作分别拒绝；各动作还有
 * 独立的阶段约束（完成的目标不可编辑/暂停/恢复/报阻塞）。
 * @param current 当前目标。
 * @param input 更新输入。
 * @param options actor（human/model）与时间戳。
 * @returns 更新结果。
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
    // 清空的原因字段不留键；文档保持严格 JSON。
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
 * 功能：启动一次自动续跑轮：roundsStarted 加一并刷新 updatedAt。
 * 内部逻辑：`revision` 有意保持不动——轮数计数不是内容变更，模型刚读的 CAS 令牌在
 * 续跑间持续匹配。目标不存在或不是 active 时原样返回输入。
 * @param docValue Goals 文档值。
 * @param now 当前时间戳。
 * @returns 计数后的文档值。
 */
export function applyGoalRound(docValue: GoalDocValue | undefined, now: number): GoalDocValue {
  const goal = docValue?.goal
  if (!docValue || !goal || goal.phase !== 'active') return docValue ?? { goal: null }
  return { goal: { ...goal, roundsStarted: goal.roundsStarted + 1, updatedAt: now } }
}

/**
 * 功能：生成 `onYield` 钩子的续跑提示；必须结束运行时返回 undefined。
 * 内部逻辑：仅在目标 active 且已启动轮数小于 maxGoalRounds 时继续；roundsStartedSoFar
 * 从已提交文档读取（memo 不跨代传递）。文本带轮次编号，让会话记录无需额外状态即可读。
 * @param docValue Goals 文档值。
 * @param roundsStartedSoFar 已提交文档中的已启动轮数。
 * @returns 续跑提示或 undefined。
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

/** 功能：判断共享 interactions 表里是否仍有待用户处理的提问或计划审阅。 */
export function awaitingUser(table: Record<string, unknown> | undefined): boolean {
  return Object.values(table ?? {}).some(record =>
    typeof record === 'object' && record !== null && (record as { status?: unknown }).status === 'pending')
}

/** 解析三个目标工具在当前 agent 下的路由（direct/codemode/unavailable）。 */
function goalToolRoutes(agent: ToolCatalog): Record<(typeof GOAL_TOOL_NAMES)[number], ToolRoute> {
  return Object.fromEntries(GOAL_TOOL_NAMES.map(name => [
    name,
    resolveToolRoute(agent, name),
  ])) as Record<(typeof GOAL_TOOL_NAMES)[number], ToolRoute>
}

/** 生成单个目标工具的路由调用说明；不可调用时 undefined。 */
function goalToolInstruction(name: (typeof GOAL_TOOL_NAMES)[number], route: ToolRoute): string | undefined {
  return toolRouteInstruction(name, route)
}

/**
 * 功能：运行授权检查回调；未配置视为允许，回调抛错视为拒绝。
 * @param check 可选的检查回调。
 * @param id 会话 id。
 * @param context 执行上下文。
 * @returns 是否允许。
 */
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

/**
 * 功能：创建 goal-policy section：按当前路由与权限渲染目标使用指引。
 * 内部逻辑：计划模式开启时只输出规划约束；按目标存在与否/阶段分别给出创建、推进、
 * 更新或等待恢复的指引；create/update 工具不可用或未获授权时明确告知模型不得声称
 * 已设置/更改目标。
 */
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
 * runtime 实际把 `commit` 交给钩子（generation task 传自己的 runtime），而声明的
 * `HookApi` 面只承诺已提交读取与 memo。目标钩子需要原子写来保持轮数精确，因此窄化
 * 成本类型。
 */
type CommittingHookApi = HookApi & {
  commit<T>(change: (tx: Tx) => T | Promise<T>, context: Context): Promise<T>
}

/**
 * 功能：创建目标续跑钩子（DSH 的 goal-round 驱动，作为 Pi 的 `onYield`）：最终答复之后，
 * 目标 active 且未达 maxGoalRounds 时，追加一条续跑用户消息让运行继续。
 * 边界/权限：轮数自增与"决定续跑"在同一个 commit 内，两代进程不可能重复计数；
 * 计划模式或快照后落下的暂停/清除以已提交文档为准并终止续跑；有等待用户的提问/审阅
 * 时不再推进（续跑会在答复后重新评估）。
 * @param canContinue 续跑授权检查。
 * @returns 挂在 GenerationTask 上的 hook。
 */
function createGoalHook(canContinue: GoalToolOptions['canContinue']) {
  return hook(GenerationTask, {
    onYield: async (_answer, api, context) => {
      const plan = await api.snapshot(Plans, api.conversationId, context)
      if (plan?.active === true || !await allowed(canContinue, api.conversationId, context)) return undefined
      // DSH 的 ask_user_question 会阻塞，其驱动不会看到"有空闲 agent + 未决问题"的状态。
      // 这里问题直接结束本轮；此刻续跑会越过用户的答复。
      if (awaitingUser(await api.snapshot(Interactions, api.conversationId, context))) return undefined
      // 先做一次廉价的已提交读取：大多数最终答复就此结束运行，根本不会走到 commit。
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

/** 向后兼容的默认钩子；runtime 工厂提供自己的授权门。 */
export const goalHook = createGoalHook(undefined)

/** 生成工具 details：目标的浅拷贝或 null。 */
const goalDetails = (goal: GoalState | null) => ({ goal: goal ? { ...goal } : null })

/** 目标的一行摘要：id、阶段（含阻塞原因）、轮数与 revision。 */
function goalSummary(goal: GoalState): string {
  const blocked = goal.phase === 'blocked' && goal.blockedReason ? ` (blocked: ${goal.blockedReason})` : ''
  return `id ${goal.id}, ${goal.phase}${blocked}; rounds ${goal.roundsStarted}/${goal.maxGoalRounds}; revision ${goal.revision}`
}

/** DSH 的 `get_goal` 以 Pi 工具呈现：读取会话文档并报告当前状态。 */
const getGoalTool = defineTool({
  name: 'get_goal',
  description: [
    '读取本会话的目标，包括任务内容、阶段、续跑轮数预算和版本号。',
    '用户询问当前目标或其状态时使用。',
    '没有设置目标时，按当前任务和可用的目标规则继续。',
  ].join(' '),
  parameters: Type.Object({}),
  /** 功能：读取当前目标快照；无目标时给出提示文本。 */
  execute: async (_args, api, context) => {
    const doc = await api.snapshot(Goals, api.conversationId, context)
    const goal = doc?.goal ?? null
    const text = goal
      ? `Goal (${goalSummary(goal)}): "${goal.objective}"`
      : '本会话尚未设置目标。按当前任务和可用的目标规则继续。'
    return { output: [{ type: 'text' as const, text }], details: goalDetails(goal) }
  },
})

/** DSH 的 `create_goal` 以 Pi 工具呈现：每会话一个未完成目标，存于文档。 */
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
    /**
     * 功能：创建目标。
     * 输入校验/权限：先过 canCreate 授权门；计划模式开启（快照与事务内各查一次）拒绝；
     * 参数先经 applyGoalCreate 纯校验再开写事务，事务内二次应用以真实文档状态裁决。
     */
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
      // 在打开写事务之前拒绝非法参数。
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

/** DSH 的 `update_goal` 以 Pi 工具呈现：revision 做 CAS、阶段变更，模型仅限 complete/blocked。 */
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
  /**
   * 功能：报告目标完成或受阻（模型专用动作）。
   * 输入校验：事务内经 applyGoalUpdate 以 actor=model 裁决——goalId/revision 不匹配、
   * blocked 缺 reason、越权动作都会被拒绝。
   */
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

/**
 * 功能：装配 goal 扩展（DSH 目标），贡献 3 个工具（get_goal / create_goal /
 * update_goal）、1 个 section（goal-policy 目标使用指引）与 1 个 hook
 * （onYield 自动续跑驱动），授权门由 runtime 注入。
 * @param options 可选的 canCreate / canContinue 授权回调。
 * @returns 名为 `goal` 的扩展。
 */
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

/** 既有的独立默认实例；runtime 集成应改用 `createGoalExtension`。 */
export const GoalExtension: Extension = createGoalExtension()

export default GoalExtension
