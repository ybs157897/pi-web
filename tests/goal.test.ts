import { describe, expect, it } from 'vitest'
import {
  DEFAULT_MAX_GOAL_ROUNDS,
  MAX_GOAL_ROUNDS_LIMIT,
  applyGoalCreate,
  applyGoalRound,
  applyGoalUpdate,
  cleanMaxGoalRounds,
  cleanObjective,
  goalContinuation,
  type GoalState,
} from '../src/server/goal-tools.ts'

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

describe('goal created fields', () => {
  it('creates an active goal with revision 1 and no started rounds', () => {
    const outcome = applyGoalCreate(null, { id: 'goal-9', objective: '  发布 0.2.0  ', maxGoalRounds: 5 }, 2_000)
    expect(outcome).toEqual({ ok: true, goal: goal({ id: 'goal-9', objective: '发布 0.2.0', maxGoalRounds: 5, createdAt: 2_000, updatedAt: 2_000 }) })
  })

  it('applies the default round budget and validates explicit ones', () => {
    const created = applyGoalCreate(null, { id: 'goal-1', objective: '目标' }, 1)
    expect(created.ok && created.goal.maxGoalRounds).toBe(DEFAULT_MAX_GOAL_ROUNDS)
    expect(cleanMaxGoalRounds(0)).toBeUndefined()
    expect(cleanMaxGoalRounds(MAX_GOAL_ROUNDS_LIMIT + 1)).toBeUndefined()
    expect(cleanMaxGoalRounds(2.5)).toBeUndefined()
    expect(applyGoalCreate(null, { id: 'goal-1', objective: '目标', maxGoalRounds: 0 }, 1).ok).toBe(false)
  })

  it('refuses an empty or oversized objective', () => {
    expect(cleanObjective('   ')).toBeUndefined()
    expect(cleanObjective('x'.repeat(2_001))).toBeUndefined()
    expect(applyGoalCreate(null, { id: 'goal-1', objective: '  ' }, 1)).toEqual({ ok: false, error: 'The goal objective must be non-empty, trimmed text.' })
  })

  it('refuses to replace an unfinished goal and allows one after completion', () => {
    const refused = applyGoalCreate(goal({ phase: 'active' }), { id: 'goal-2', objective: '另一个目标' }, 2_000)
    expect(refused.ok).toBe(false)
    expect(refused.ok === false && refused.error).toContain('goal controls')
    const replaced = applyGoalCreate(goal({ phase: 'complete' }), { id: 'goal-2', objective: '另一个目标' }, 2_000)
    expect(replaced.ok && replaced.goal.id).toBe('goal-2')
  })
})

describe('goal continuation budget', () => {
  it('continues while active and under maxGoalRounds, carrying the round number', () => {
    const continuation = goalContinuation({ goal: goal({ roundsStarted: 0, maxGoalRounds: 3 }) }, 0)
    expect(continuation?.continue).toContain('[goal 1/3]')
    expect(continuation?.continue).toContain('完成迁移并跑通验证')
    expect(goalContinuation({ goal: goal({ roundsStarted: 2, maxGoalRounds: 3 }) }, 2)?.continue).toContain('[goal 3/3]')
  })

  it('stops at the round limit', () => {
    expect(goalContinuation({ goal: goal({ roundsStarted: 3, maxGoalRounds: 3 }) }, 3)).toBeUndefined()
    expect(goalContinuation({ goal: goal({ roundsStarted: 9, maxGoalRounds: 3 }) }, 9)).toBeUndefined()
  })

  it('never continues a non-active goal or a conversation without one', () => {
    for (const phase of ['paused', 'blocked', 'complete'] as const) {
      expect(goalContinuation({ goal: goal({ phase }) }, 0)).toBeUndefined()
    }
    expect(goalContinuation({ goal: null }, 0)).toBeUndefined()
    expect(goalContinuation(undefined, 0)).toBeUndefined()
    expect(goalContinuation({ goal: goal() }, -1)).toBeUndefined()
  })
})

describe('goal round counter', () => {
  it('increments roundsStarted and updatedAt but keeps revision (rounds are not content edits)', () => {
    const next = applyGoalRound({ goal: goal({ revision: 4, roundsStarted: 1 }) }, 5_000)
    expect(next.goal).toEqual(goal({ revision: 4, roundsStarted: 2, updatedAt: 5_000 }))
  })

  it('leaves a non-active goal or a doc without one unchanged', () => {
    const paused = { goal: goal({ phase: 'paused', roundsStarted: 1 }) }
    expect(applyGoalRound(paused, 9_000)).toEqual(paused)
    expect(applyGoalRound({ goal: null }, 9_000)).toEqual({ goal: null })
    expect(applyGoalRound(undefined, 9_000)).toEqual({ goal: null })
  })
})

describe('goal updates under CAS', () => {
  it('rejects a stale revision and names the current one', () => {
    const outcome = applyGoalUpdate(goal({ revision: 3 }), { goalId: 'goal-1', revision: 2, action: 'complete' }, { actor: 'human', now: 1 })
    expect(outcome.ok).toBe(false)
    expect(outcome.ok === false && outcome.error).toContain('revision 3')
  })

  it('rejects a goal_id that does not match the stored goal', () => {
    const outcome = applyGoalUpdate(goal(), { goalId: 'other', revision: 1, action: 'complete' }, { actor: 'human', now: 1 })
    expect(outcome.ok).toBe(false)
    expect(outcome.ok === false && outcome.error).toContain('goal_id')
  })

  it('rejects an update without a goal', () => {
    const outcome = applyGoalUpdate(null, { goalId: 'goal-1', revision: 1, action: 'complete' }, { actor: 'human', now: 1 })
    expect(outcome.ok).toBe(false)
    expect(outcome.ok === false && outcome.error).toContain('ask the user to set one')
  })

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

  it('requires a blocked_reason and stores it', () => {
    const missing = applyGoalUpdate(goal(), { goalId: 'goal-1', revision: 1, action: 'blocked' }, { actor: 'model', now: 1 })
    expect(missing).toEqual({ ok: false, error: 'Reporting a blocked goal needs blocked_reason.' })
    const outcome = applyGoalUpdate(goal(), { goalId: 'goal-1', revision: 1, action: 'blocked', blockedReason: '需要用户提供凭据' }, { actor: 'model', now: 4_000 })
    expect(outcome.ok && outcome.goal).toEqual(goal({ phase: 'blocked', revision: 2, blockedReason: '需要用户提供凭据', updatedAt: 4_000 }))
  })

  it('edits the objective and may grow the round budget, bumping revision', () => {
    const outcome = applyGoalUpdate(goal(), { goalId: 'goal-1', revision: 1, action: 'edit', objective: ' 改成新目标 ', maxGoalRounds: 7 }, { actor: 'human', now: 2_000 })
    expect(outcome.ok && outcome.goal?.objective).toBe('改成新目标')
    expect(outcome.ok && outcome.goal).toMatchObject({ revision: 2, maxGoalRounds: 7, phase: 'active', updatedAt: 2_000 })
    expect(applyGoalUpdate(goal(), { goalId: 'goal-1', revision: 1, action: 'edit', objective: '  ' }, { actor: 'human', now: 2_000 }).ok).toBe(false)
  })

  it('pauses, resumes and clears the blocked reason on resume', () => {
    const paused = applyGoalUpdate(goal(), { goalId: 'goal-1', revision: 1, action: 'pause' }, { actor: 'human', now: 2_000 })
    expect(paused.ok && paused.goal?.phase).toBe('paused')
    const resumed = applyGoalUpdate(goal({ phase: 'blocked', blockedReason: '缺依赖', revision: 5 }), { goalId: 'goal-1', revision: 5, action: 'resume' }, { actor: 'human', now: 6_000 })
    expect(resumed.ok && resumed.goal).toMatchObject({ phase: 'active', revision: 6, updatedAt: 6_000 })
    expect(resumed.ok && 'blockedReason' in (resumed.goal ?? {})).toBe(false)
    expect(applyGoalUpdate(goal({ phase: 'active' }), { goalId: 'goal-1', revision: 1, action: 'resume' }, { actor: 'human', now: 1 }).ok).toBe(false)
  })

  it('completes a goal, keeps its round count, and treats complete as terminal', () => {
    const outcome = applyGoalUpdate(goal({ roundsStarted: 2 }), { goalId: 'goal-1', revision: 1, action: 'complete' }, { actor: 'model', now: 3_000 })
    expect(outcome.ok && outcome.goal).toMatchObject({ phase: 'complete', roundsStarted: 2, revision: 2, updatedAt: 3_000 })
    const again = applyGoalUpdate(goal({ phase: 'complete' }), { goalId: 'goal-1', revision: 1, action: 'complete' }, { actor: 'model', now: 3_000 })
    expect(again.ok).toBe(false)
    expect(applyGoalUpdate(goal({ phase: 'complete' }), { goalId: 'goal-1', revision: 1, action: 'edit', objective: 'x' }, { actor: 'human', now: 3_000 }).ok).toBe(false)
  })

  it('clears the goal for the human only', () => {
    expect(applyGoalUpdate(goal(), { goalId: 'goal-1', revision: 1, action: 'clear' }, { actor: 'human', now: 3_000 }))
      .toEqual({ ok: true, goal: null })
  })
})
