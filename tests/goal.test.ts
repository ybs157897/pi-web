import { describe, expect, it } from 'vitest'
import {
  DEFAULT_MAX_GOAL_ROUNDS,
  MAX_GOAL_ROUNDS_LIMIT,
  applyGoalCreate,
  applyGoalRound,
  applyGoalUpdate,
  awaitingUser,
  cleanMaxGoalRounds,
  cleanObjective,
  goalContinuation,
  type GoalState,
} from '../src/server/tools/goal.ts'

/**
 * 构造一个 GoalState 测试基底：active 阶段、3 轮预算、0 已开轮次。
 * @param overrides 需要覆盖的字段（phase/roundsStarted/revision 等）
 * @returns 完整的 GoalState
 */
function goal(overrides: Partial<GoalState> = {}): GoalState {
  return {
    id: 'goal-1',
    revision: 1,
    objective: '完成迁移并跑通验证',
    phase: 'active',
    maxGoalRounds: 3,
    roundsStarted: 0,
    createdAt: 1_000,
    updatedAt: 1_000,
    ...overrides,
  }
}

/**
 * 目标创建字段测试。
 *
 * 关键契约：
 * - 新目标 revision=1、roundsStarted=0、目标文本 trim 后存储；
 * - 未显式给预算用 DEFAULT_MAX_GOAL_ROUNDS，显式值必须为 1..LIMIT 的整数，否则创建失败；
 * - 目标文本非空且 ≤2000 字符；
 * - 已有未完成目标时拒绝替换，目标完成后（complete）才允许新建。
 */
describe('goal created fields', () => {
  // 创建成功：目标文本「 发布 0.2.0  」被 trim 存储，revision 默认 1，时间戳取传入的 now。
  it('creates an active goal with revision 1 and no started rounds', () => {
    const outcome = applyGoalCreate(null, { id: 'goal-9', objective: '  发布 0.2.0  ', maxGoalRounds: 5 }, 2_000)
    expect(outcome).toEqual({ ok: true, goal: goal({ id: 'goal-9', objective: '发布 0.2.0', maxGoalRounds: 5, createdAt: 2_000, updatedAt: 2_000 }) })
  })

  // 未指定预算用默认值；cleanMaxGoalRounds 拒绝 0、超上限、非整数；显式给 0 的创建请求整体失败。
  it('applies the default round budget and validates explicit ones', () => {
    const created = applyGoalCreate(null, { id: 'goal-1', objective: '目标' }, 1)
    expect(created.ok && created.goal.maxGoalRounds).toBe(DEFAULT_MAX_GOAL_ROUNDS)
    expect(cleanMaxGoalRounds(0)).toBeUndefined()
    expect(cleanMaxGoalRounds(MAX_GOAL_ROUNDS_LIMIT + 1)).toBeUndefined()
    expect(cleanMaxGoalRounds(2.5)).toBeUndefined()
    expect(applyGoalCreate(null, { id: 'goal-1', objective: '目标', maxGoalRounds: 0 }, 1).ok).toBe(false)
  })

  // 目标文本纯空白或超过 2000 字符均无效，创建返回带明确错误文案的失败结果。
  it('refuses an empty or oversized objective', () => {
    expect(cleanObjective('   ')).toBeUndefined()
    expect(cleanObjective('x'.repeat(2_001))).toBeUndefined()
    expect(applyGoalCreate(null, { id: 'goal-1', objective: '  ' }, 1)).toEqual({ ok: false, error: 'The goal objective must be non-empty, trimmed text.' })
  })

  // 已有 active 目标时再创建被拒（错误提示目标仍在控制中）；目标 complete 之后才允许创建新目标。
  it('refuses to replace an unfinished goal and allows one after completion', () => {
    const refused = applyGoalCreate(goal({ phase: 'active' }), { id: 'goal-2', objective: '另一个目标' }, 2_000)
    expect(refused.ok).toBe(false)
    expect(refused.ok === false && refused.error).toContain('goal controls')
    const replaced = applyGoalCreate(goal({ phase: 'complete' }), { id: 'goal-2', objective: '另一个目标' }, 2_000)
    expect(replaced.ok && replaced.goal.id).toBe('goal-2')
  })
})

/**
 * 目标续跑预算测试。
 *
 * 关键契约：
 * - active 且轮次未到上限时续跑，续跑指令带 [goal n/N] 进度标记与目标文本；
 * - 等待用户答复/批准时指示结束本轮；
 * - awaitingUser 识别 pending 状态的提问与计划评审；
 * - 轮次达到 maxGoalRounds 后停止续跑；
 * - 非 active 阶段、无目标、轮次为负等情况一律不续跑。
 */
describe('goal continuation budget', () => {
  // 轮次从 roundsStarted+1 开始计数：0/3 → [goal 1/3]，2/3 → [goal 3/3]，指令携带目标文本。
  it('continues while active and under maxGoalRounds, carrying the round number', () => {
    const continuation = goalContinuation({ goal: goal({ roundsStarted: 0, maxGoalRounds: 3 }) }, 0)
    expect(continuation?.continue).toContain('[goal 1/3]')
    expect(continuation?.continue).toContain('完成迁移并跑通验证')
    expect(goalContinuation({ goal: goal({ roundsStarted: 2, maxGoalRounds: 3 }) }, 2)?.continue).toContain('[goal 3/3]')
  })

  // 有活跃目标但正在等用户时，续跑指令改为「等待用户的答复或批准，结束本轮」。
  it('tells a continued turn to stop while it waits on the user', () => {
    expect(goalContinuation({ goal: goal() }, 0)?.continue).toContain('等待用户的答复或批准，结束本轮')
  })

  // awaitingUser 判定：answered/cancelled/superseded 都不算等待；pending 提问（即使问题列表为空）与 pending 计划评审算等待。
  it('treats a pending question or plan review as waiting on the user', () => {
    expect(awaitingUser(undefined)).toBe(false)
    expect(awaitingUser({ a: { status: 'answered' }, b: { status: 'cancelled' }, c: { kind: 'plan-review', status: 'superseded' } })).toBe(false)
    expect(awaitingUser({ a: { status: 'answered' }, b: { questions: [], status: 'pending' } })).toBe(true)
    expect(awaitingUser({ review: { kind: 'plan-review', status: 'pending' } })).toBe(true)
  })

  // 已开轮次达到 maxGoalRounds（3/3，甚至 9/3 的超限状态）后不再续跑，返回 undefined。
  it('stops at the round limit', () => {
    expect(goalContinuation({ goal: goal({ roundsStarted: 3, maxGoalRounds: 3 }) }, 3)).toBeUndefined()
    expect(goalContinuation({ goal: goal({ roundsStarted: 9, maxGoalRounds: 3 }) }, 9)).toBeUndefined()
  })

  // paused/blocked/complete 阶段、无目标文档、undefined 文档、负轮次都不产生续跑指令。
  it('never continues a non-active goal or a conversation without one', () => {
    for (const phase of ['paused', 'blocked', 'complete'] as const) {
      expect(goalContinuation({ goal: goal({ phase }) }, 0)).toBeUndefined()
    }
    expect(goalContinuation({ goal: null }, 0)).toBeUndefined()
    expect(goalContinuation(undefined, 0)).toBeUndefined()
    expect(goalContinuation({ goal: goal() }, -1)).toBeUndefined()
  })
})

/**
 * 目标轮次计数器测试。
 *
 * 关键契约：
 * - 每轮开始 roundsStarted+1、updatedAt 前进，但 revision 不动（开轮次不算内容编辑，避免 CAS 冲突）；
 * - 非 active 目标或没有目标的文档保持原样不变。
 */
describe('goal round counter', () => {
  // revision=4 保持不变（开轮次不是内容编辑），roundsStarted 1→2，updatedAt 推进到 5_000。
  it('increments roundsStarted and updatedAt but keeps revision (rounds are not content edits)', () => {
    const next = applyGoalRound({ goal: goal({ revision: 4, roundsStarted: 1 }) }, 5_000)
    expect(next.goal).toEqual(goal({ revision: 4, roundsStarted: 2, updatedAt: 5_000 }))
  })

  // paused 目标、goal=null、无目标文档三种情况 applyGoalRound 都原样返回，不产生任何修改。
  it('leaves a non-active goal or a doc without one unchanged', () => {
    const paused = { goal: goal({ phase: 'paused', roundsStarted: 1 }) }
    expect(applyGoalRound(paused, 9_000)).toEqual(paused)
    expect(applyGoalRound({ goal: null }, 9_000)).toEqual({ goal: null })
    expect(applyGoalRound(undefined, 9_000)).toEqual({ goal: null })
  })
})

/**
 * 目标更新（CAS 保护）测试。
 *
 * 关键契约：
 * - update 必须带当前 revision，过期 revision 与不匹配的 goal_id 都被拒绝；
 * - 无目标时更新被拒并提示让用户设置目标；
 * - 模型只允许 complete / blocked / clear 之外的动作受限：edit/pause/resume 仅限人类，complete 仅限模型；
 * - blocked 必须携带 blocked_reason，resume 会清掉它；
 * - complete 是终态：重复 complete 与后续 edit 都被拒；
 * - clear 只允许人类执行，成功后目标清空为 null。
 */
describe('goal updates under CAS', () => {
  // 传入过期 revision=2 而存储是 3：拒绝并报出当前 revision 3（乐观并发控制）。
  it('rejects a stale revision and names the current one', () => {
    const outcome = applyGoalUpdate(goal({ revision: 3 }), { goalId: 'goal-1', revision: 2, action: 'complete' }, { actor: 'human', now: 1 })
    expect(outcome.ok).toBe(false)
    expect(outcome.ok === false && outcome.error).toContain('revision 3')
  })

  // goal_id 与存储目标不一致（goal-1 vs other）时拒绝更新，错误提示 goal_id。
  it('rejects a goal_id that does not match the stored goal', () => {
    const outcome = applyGoalUpdate(goal(), { goalId: 'other', revision: 1, action: 'complete' }, { actor: 'human', now: 1 })
    expect(outcome.ok).toBe(false)
    expect(outcome.ok === false && outcome.error).toContain('goal_id')
  })

  // 文档里没有目标时任何更新都被拒绝，错误提示让用户先设置目标。
  it('rejects an update without a goal', () => {
    const outcome = applyGoalUpdate(null, { goalId: 'goal-1', revision: 1, action: 'complete' }, { actor: 'human', now: 1 })
    expect(outcome.ok).toBe(false)
    expect(outcome.ok === false && outcome.error).toContain('ask the user to set one')
  })

  // 模型只能 complete；edit/pause/resume 必须由人类发起（错误提示 user request）；clear 对模型直接拒绝。
  it('only lets the model complete or report blocked', () => {
    for (const action of ['edit', 'pause', 'resume'] as const) {
      const outcome = applyGoalUpdate(goal(), { goalId: 'goal-1', revision: 1, action, objective: '新目标' }, { actor: 'model', now: 1 })
      expect(outcome.ok).toBe(false)
      expect(outcome.ok === false && outcome.error).toContain('user request')
    }
    expect(applyGoalUpdate(goal(), { goalId: 'goal-1', revision: 1, action: 'complete' }, { actor: 'model', now: 1 }).ok).toBe(true)
    const cleared = applyGoalUpdate(goal(), { goalId: 'goal-1', revision: 1, action: 'clear' }, { actor: 'model', now: 1 })
    expect(cleared.ok).toBe(false)
  })

  // blocked 不带 blocked_reason 直接拒绝；带 reason 的 blocked 更新成功并存储 phase=blocked、revision+1 与原因文本。
  it('requires a blocked_reason and stores it', () => {
    const missing = applyGoalUpdate(goal(), { goalId: 'goal-1', revision: 1, action: 'blocked' }, { actor: 'model', now: 1 })
    expect(missing).toEqual({ ok: false, error: 'Reporting a blocked goal needs blocked_reason.' })
    const outcome = applyGoalUpdate(goal(), { goalId: 'goal-1', revision: 1, action: 'blocked', blockedReason: '需要用户提供凭据' }, { actor: 'model', now: 4_000 })
    expect(outcome.ok && outcome.goal).toEqual(goal({ phase: 'blocked', revision: 2, blockedReason: '需要用户提供凭据', updatedAt: 4_000 }))
  })

  // edit（人类）可改目标文本（trim 存储）与放宽轮次预算，revision+1；空目标文本的 edit 被拒。
  it('edits the objective and may grow the round budget, bumping revision', () => {
    const outcome = applyGoalUpdate(goal(), { goalId: 'goal-1', revision: 1, action: 'edit', objective: ' 改成新目标 ', maxGoalRounds: 7 }, { actor: 'human', now: 2_000 })
    expect(outcome.ok && outcome.goal?.objective).toBe('改成新目标')
    expect(outcome.ok && outcome.goal).toMatchObject({ revision: 2, maxGoalRounds: 7, phase: 'active', updatedAt: 2_000 })
    expect(applyGoalUpdate(goal(), { goalId: 'goal-1', revision: 1, action: 'edit', objective: '  ' }, { actor: 'human', now: 2_000 }).ok).toBe(false)
  })

  // pause 进入 paused；resume 从 blocked 恢复到 active 且清掉 blockedReason、revision+1；对 active 目标 resume 被拒。
  it('pauses, resumes and clears the blocked reason on resume', () => {
    const paused = applyGoalUpdate(goal(), { goalId: 'goal-1', revision: 1, action: 'pause' }, { actor: 'human', now: 2_000 })
    expect(paused.ok && paused.goal?.phase).toBe('paused')
    const resumed = applyGoalUpdate(goal({ phase: 'blocked', blockedReason: '缺依赖', revision: 5 }), { goalId: 'goal-1', revision: 5, action: 'resume' }, { actor: 'human', now: 6_000 })
    expect(resumed.ok && resumed.goal).toMatchObject({ phase: 'active', revision: 6, updatedAt: 6_000 })
    expect(resumed.ok && 'blockedReason' in (resumed.goal ?? {})).toBe(false)
    expect(applyGoalUpdate(goal({ phase: 'active' }), { goalId: 'goal-1', revision: 1, action: 'resume' }, { actor: 'human', now: 1 }).ok).toBe(false)
  })

  // complete 保留已开轮次计数（roundsStarted=2）并进入终态；对已 complete 的目标再 complete 或 edit 都被拒绝。
  it('completes a goal, keeps its round count, and treats complete as terminal', () => {
    const outcome = applyGoalUpdate(goal({ roundsStarted: 2 }), { goalId: 'goal-1', revision: 1, action: 'complete' }, { actor: 'model', now: 3_000 })
    expect(outcome.ok && outcome.goal).toMatchObject({ phase: 'complete', roundsStarted: 2, revision: 2, updatedAt: 3_000 })
    const again = applyGoalUpdate(goal({ phase: 'complete' }), { goalId: 'goal-1', revision: 1, action: 'complete' }, { actor: 'model', now: 3_000 })
    expect(again.ok).toBe(false)
    expect(applyGoalUpdate(goal({ phase: 'complete' }), { goalId: 'goal-1', revision: 1, action: 'edit', objective: 'x' }, { actor: 'human', now: 3_000 }).ok).toBe(false)
  })

  // clear 只允许人类执行：成功后目标被清空为 null（这是唯一返回 goal=null 的成功分支）。
  it('clears the goal for the human only', () => {
    expect(applyGoalUpdate(goal(), { goalId: 'goal-1', revision: 1, action: 'clear' }, { actor: 'human', now: 3_000 }))
      .toEqual({ ok: true, goal: null })
  })
})
