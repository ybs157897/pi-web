import { describe, expect, it } from 'vitest'
import type { Context } from '@earendil-works/chord/context'
import type { ConversationId, Tx } from '@earendil-works/pi-durable'
import {
  MAX_TEAM_MEMBERS,
  MAX_TEAM_TASKS,
  claimTask,
  completeTask,
  createTask,
  deleteTask,
  detectCycle,
  editTask,
  memberViews,
  normalizeMemberName,
  normalizeWriteScope,
  normalizeWriteScopes,
  planSpawnReplay,
  reassignTask,
  reconcileProvisioning,
  releaseTask,
  reopenTask,
  setDependencies,
  taskReady,
  taskView,
  type TeamActor,
  type TeamDocAccess,
  type TeamDocValue,
  type TeamMemberRecord,
  type MemberSessionState,
  type TeamTaskRecord,
} from '../src/server/team-tools.ts'

const NOW = 1_800_000_000_000
const LEAD: TeamActor = { lead: true, name: 'lead' }
const OWNER: TeamActor = { lead: false, name: 'researcher' }
const STRANGER: TeamActor = { lead: false, name: 'writer' }

function doc(tasks: TeamTaskRecord[] = [], members: TeamMemberRecord[] = []): TeamDocValue {
  return { members, tasks }
}

function task(overrides: Partial<TeamTaskRecord> = {}): TeamTaskRecord {
  return {
    id: 'task-1',
    revision: 1,
    subject: 'Subject',
    description: 'Description',
    status: 'pending',
    blockedBy: [],
    writeScopes: [],
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  }
}

function added(base: TeamDocValue, input: Parameters<typeof createTask>[1]): { doc: TeamDocValue; task: TeamTaskRecord } {
  return createTask(base, input, NOW)
}

describe('team task board', () => {
  it('creates revision-one pending tasks, normalized and de-duplicated', () => {
    const first = added(doc(), {
      subject: '  调研面板  ',
      description: ' 核对字段 ',
      writeScopes: ['src\\web', './src/web/', 'src/web'],
    })
    expect(first.task).toMatchObject({
      id: 'task-1',
      revision: 1,
      subject: '调研面板',
      description: '核对字段',
      status: 'pending',
      blockedBy: [],
      writeScopes: ['src/web'],
      createdAt: NOW,
      updatedAt: NOW,
    })
    expect(first.doc.tasks).toHaveLength(1)

    const second = added(first.doc, { subject: 'Second', description: 'Another' })
    expect(second.task.id).toBe('task-2')
    expect(second.doc.tasks.map(item => item.id)).toEqual(['task-1', 'task-2'])
    expect(detectCycle(second.doc.tasks)).toBeUndefined()
  })

  it('rejects empty text, unknown, duplicate, self and cyclic dependencies', () => {
    expect(() => added(doc(), { subject: '   ', description: 'x' })).toThrow(/subject must be non-empty/)
    expect(() => added(doc(), { subject: 'x', description: '  ' })).toThrow(/description must be non-empty/)
    expect(() => added(doc(), { subject: 'x', description: 'y', blockedBy: ['task-9'] })).toThrow(/blocker task "task-9" not found/)

    const base = doc([task({ id: 'task-1' }), task({ id: 'task-2' })])
    expect(() => added(base, { subject: 'x', description: 'y', blockedBy: ['task-1', 'task-1'] })).toThrow(/duplicate blocker/)
    expect(() => added(base, { subject: 'x', description: 'y', blockedBy: ['task-3'] })).toThrow(/not found/)

    const chained = added(base, { subject: 'x', description: 'y', blockedBy: ['task-1'] })
    expect(() => setDependencies(chained.doc, chained.task.id, 1, LEAD, [chained.task.id], NOW)).toThrow(/cannot block itself/)
    expect(() => setDependencies(chained.doc, 'task-1', 1, LEAD, ['task-9'], NOW)).toThrow(/not found/)
    expect(() => setDependencies(chained.doc, 'task-1', 1, LEAD, ['task-3'], NOW)).toThrow(/dependency cycle/)
    expect(() => setDependencies(chained.doc, 'task-1', 1, LEAD, ['task-1'], NOW)).toThrow(/cannot block itself/)

    // task-1 depends on task-3; task-3 depends back on task-1: the candidate graph has a cycle.
    const acyclic = added(base, { subject: 'x', description: 'y' })
    const cycle = setDependencies(acyclic.doc, 'task-1', 1, LEAD, ['task-3'], NOW)
    expect(() => setDependencies(cycle.doc, 'task-3', 1, LEAD, ['task-1'], NOW)).toThrow(/dependency cycle/)
    expect(detectCycle([task({ id: 'task-1', blockedBy: ['task-2'] }), task({ id: 'task-2', blockedBy: ['task-1'] })])).toBe('task-1')
  })

  it('derives readiness, the blocked flag and advisory write-scope warnings', () => {
    const tasks = [
      task({ id: 'task-1', status: 'in_progress', owner: 'lead', writeScopes: ['src/web'] }),
      task({ id: 'task-2', writeScopes: ['src/web/TeamPanel.tsx'] }),
      task({ id: 'task-3', blockedBy: ['task-2'] }),
    ]
    expect(taskReady(tasks, tasks[2]!)).toBe(false)
    expect(taskView(tasks, tasks[1]!)).toMatchObject({
      ready: true,
      blocked: false,
      // The in-progress task's `src/web` contains this task's scope: advisory warning, not a lock.
      writeScopeWarnings: ['write scopes overlap with task-1'],
    })
    expect(taskView(tasks, tasks[2]!)).toMatchObject({ ready: false, blocked: true })
    expect(taskView(tasks, task({ id: 'task-4', status: 'completed' })).ready).toBe(false)
    expect(taskView(tasks, task({ id: 'task-5', status: 'in_progress', owner: 'researcher' }))).toMatchObject({
      ownerName: 'researcher',
      writeScopeWarnings: [],
    })
  })

  it('normalizes advisory write scopes and refuses absolute or traversing ones', () => {
    expect(normalizeWriteScope('src\\web\\TeamPanel.tsx')).toBe('src/web/TeamPanel.tsx')
    expect(normalizeWriteScope('./src/web/')).toBe('src/web')
    expect(normalizeWriteScopes(['src/web', 'src/web', './docs'])).toEqual(['src/web', 'docs'])
    for (const invalid of ['', '/etc', 'C:/windows', 'c:\\temp', '..', 'a/../b', 'a/./b', 'a//b', './']) {
      expect(() => normalizeWriteScope(invalid), invalid).toThrow(/invalid workspace-relative write scope/)
    }
  })

  it('enforces the member-name rules including the reserved lead name', () => {
    expect(normalizeMemberName('researcher-2')).toBe('researcher-2')
    expect(() => normalizeMemberName('lead')).toThrow(/not "lead"/)
    expect(() => normalizeMemberName('Researcher')).toThrow(/lower-kebab-case/)
    expect(() => normalizeMemberName('a_b')).toThrow(/lower-kebab-case/)
    expect(() => normalizeMemberName(`a${'b'.repeat(64)}`)).toThrow(/at most 64 characters/)
  })

  it('compare-and-sets claim, release, complete and reopen', () => {
    const created = added(doc(), { subject: 'Task', description: 'Work' })
    const claimed = claimTask(created.doc, 'task-1', 1, 'researcher', NOW + 1)
    expect(claimed.task).toMatchObject({ status: 'in_progress', owner: 'researcher', revision: 2, updatedAt: NOW + 1 })
    expect(() => claimTask(claimed.doc, 'task-1', 2, 'writer', NOW + 2)).toThrow(/owned by another member/)
    expect(() => claimTask(created.doc, 'task-1', 9, 'researcher', NOW + 2)).toThrow(/stale team task "task-1" revision 9; current revision is 1/)
    expect(() => claimTask(claimed.doc, 'task-1', 2, 'researcher', NOW + 2)).toThrow(/not ready to claim/)

    const released = releaseTask(claimed.doc, 'task-1', 2, OWNER, NOW + 2)
    expect(released.task).toMatchObject({ status: 'pending', revision: 3 })
    expect(released.task.owner).toBeUndefined()
    expect(() => releaseTask(claimed.doc, 'task-1', 2, STRANGER, NOW + 2)).toThrow(/requires its owner or Team Lead/)
    expect(() => releaseTask(released.doc, 'task-1', 3, LEAD, NOW + 3)).toThrow(/only an in-progress task/)

    const completed = completeTask(claimed.doc, 'task-1', 2, OWNER, NOW + 4)
    expect(completed.task).toMatchObject({ status: 'completed', owner: 'researcher', revision: 3 })
    expect(() => completeTask(released.doc, 'task-1', 3, LEAD, NOW + 4)).toThrow(/only an in-progress task can complete/)
    const reopened = reopenTask(completed.doc, 'task-1', 3, OWNER, NOW + 5)
    expect(reopened.task).toMatchObject({ status: 'pending', revision: 4 })
    expect(reopened.task.owner).toBeUndefined()
    expect(() => reopenTask(released.doc, 'task-1', 3, LEAD, NOW + 5)).toThrow(/only a completed task can reopen/)
  })

  it('unblocks dependents only after their blocker completes', () => {
    const first = added(doc(), { subject: 'First', description: 'Do first' })
    const second = added(first.doc, { subject: 'Second', description: 'Do second', blockedBy: ['task-1'] })
    expect(() => claimTask(second.doc, 'task-2', 1, 'writer', NOW)).toThrow(/not ready to claim/)
    expect(taskView(second.doc.tasks, second.doc.tasks[1]!).blocked).toBe(true)

    const claimed = claimTask(second.doc, 'task-1', 1, 'researcher', NOW)
    const done = completeTask(claimed.doc, 'task-1', 2, OWNER, NOW)
    expect(taskReady(done.doc.tasks, done.doc.tasks[1]!)).toBe(true)
    expect(taskView(done.doc.tasks, done.doc.tasks[1]!)).toMatchObject({ ready: true, blocked: false })
    expect(claimTask(done.doc, 'task-2', 1, 'writer', NOW).task).toMatchObject({ status: 'in_progress', owner: 'writer' })
  })

  it('moves blockers with set_dependencies and rejects duplicate or self references', () => {
    const first = added(doc(), { subject: 'First', description: 'Do first' })
    const second = added(first.doc, { subject: 'Second', description: 'Do second' })
    const third = added(second.doc, { subject: 'Third', description: 'Do third' })
    const linked = setDependencies(third.doc, 'task-3', 1, LEAD, ['task-1', 'task-2'], NOW + 1)
    expect(linked.task).toMatchObject({ blockedBy: ['task-1', 'task-2'], revision: 2 })
    expect(linked.doc.tasks[0]?.blockedBy).toEqual([])
    expect(() => setDependencies(linked.doc, 'task-3', 2, LEAD, ['task-1', 'task-1'], NOW + 2)).toThrow(/duplicate blocker/)
  })

  it('authorizes mutation to the owner or the Lead, and reassignment to the Lead only', () => {
    const created = added(doc([], [{ name: 'researcher', role: 'teammate', phase: 'active', conversationId: '17' }]), {
      subject: 'Task',
      description: 'Work',
    })
    const owned = claimTask(created.doc, 'task-1', 1, 'researcher', NOW)
    expect(() => completeTask(owned.doc, 'task-1', 2, STRANGER, NOW)).toThrow(/requires its owner or Team Lead/)
    expect(completeTask(owned.doc, 'task-1', 2, LEAD, NOW).task.status).toBe('completed')
    expect(() => editTask(owned.doc, 'task-1', 2, STRANGER, { subject: 'Hijacked' }, NOW)).toThrow(/requires its owner or Team Lead/)
    expect(editTask(owned.doc, 'task-1', 2, OWNER, { subject: 'Edited', writeScopes: ['docs'] }, NOW).task)
      .toMatchObject({ subject: 'Edited', writeScopes: ['docs'], revision: 3 })
    expect(() => editTask(owned.doc, 'task-1', 2, OWNER, {}, NOW)).toThrow(/requires subject, description, or write_scopes/)

    const pending = added(created.doc.tasks.length ? created.doc : doc(), { subject: 'Second', description: 'Work' })
    expect(() => reassignTask(pending.doc, 'task-2', 1, OWNER, 'writer', NOW)).toThrow(/only the Team Lead can reassign/)
    expect(() => reassignTask(pending.doc, 'task-2', 1, LEAD, 'writer', NOW)).toThrow(/active teammate "writer" not found/)
    expect(reassignTask(pending.doc, 'task-2', 1, LEAD, 'researcher', NOW).task)
      .toMatchObject({ status: 'in_progress', owner: 'researcher', revision: 2 })
    expect(reassignTask(pending.doc, 'task-2', 1, LEAD, undefined, NOW).task).toMatchObject({ status: 'pending' })
    expect(reassignTask(pending.doc, 'task-2', 1, LEAD, '', NOW).task.owner).toBeUndefined()

    const blocked = added(pending.doc, { subject: 'Third', description: 'Work', blockedBy: ['task-2'] })
    expect(() => reassignTask(blocked.doc, 'task-3', 1, LEAD, 'researcher', NOW)).toThrow(/is blocked/)
  })

  it('deletes only dependency-free tasks and never mutates a tombstone', () => {
    const first = added(doc(), { subject: 'First', description: 'Do first' })
    const second = added(first.doc, { subject: 'Second', description: 'Do second', blockedBy: ['task-1'] })
    expect(() => deleteTask(second.doc, 'task-1', 1, LEAD, NOW)).toThrow(/still blocks "task-2"/)
    const removed = deleteTask(second.doc, 'task-2', 1, LEAD, NOW)
    expect(removed.task).toMatchObject({ status: 'deleted', revision: 2 })
    expect(removed.doc.tasks).toHaveLength(2)
    expect(() => deleteTask(removed.doc, 'task-2', 2, LEAD, NOW)).toThrow(/is deleted/)
    expect(() => claimTask(removed.doc, 'task-2', 2, 'researcher', NOW)).toThrow(/is deleted/)
    expect(() => editTask(removed.doc, 'task-2', 2, LEAD, { subject: 'x' }, NOW)).toThrow(/is deleted/)
    expect(taskView(removed.doc.tasks, removed.doc.tasks[1]!)).toMatchObject({ status: 'deleted', ready: false })
    // A deleted blocker no longer counts as a resolvable dependency.
    expect(() => added(removed.doc, { subject: 'Third', description: 'x', blockedBy: ['task-2'] })).toThrow(/not found/)
    expect(deleteTask(removed.doc, 'task-1', 1, LEAD, NOW).task.status).toBe('deleted')
  })

  it('enforces the deployment limits for tasks and members', () => {
    let state = doc()
    for (let index = 0; index < MAX_TEAM_TASKS; index += 1) {
      state = added(state, { subject: `Task ${index}`, description: 'Work' }).doc
    }
    expect(state.tasks).toHaveLength(MAX_TEAM_TASKS)
    expect(() => added(state, { subject: 'Overflow', description: 'Work' })).toThrow(`Team task limit ${MAX_TEAM_TASKS} reached`)
    // A deleted task frees the budget without reusing its id.
    const deleted = deleteTask(state, 'task-1', 1, LEAD, NOW)
    const replacement = added(deleted.doc, { subject: 'Replacement', description: 'Work' })
    expect(replacement.task.id).toBe(`task-${MAX_TEAM_TASKS + 1}`)

    const members: TeamMemberRecord[] = Array.from({ length: MAX_TEAM_MEMBERS }, (_, index) => ({
      name: `member-${index}`,
      role: 'teammate' as const,
      phase: 'active' as const,
      conversationId: String(100 + index),
    }))
    expect(members).toHaveLength(MAX_TEAM_MEMBERS)
  })

  it('projects member rows with the Lead first and the durable phases preserved', async () => {
    const members: TeamMemberRecord[] = [
      { name: 'lead', role: 'lead', phase: 'active', conversationId: '2', label: 'Lead' },
      { name: 'researcher', role: 'teammate', phase: 'active', conversationId: '17', label: '资料调研' },
      { name: 'writer', role: 'teammate', phase: 'active', conversationId: '35', label: '面板实现' },
      { name: 'ghost', role: 'teammate', phase: 'failed', label: '失败成员', error: 'child creation failed' },
      { name: 'slow', role: 'teammate', phase: 'provisioning', label: '准备中' },
    ]
    const info = async (id: string) => ({
      status: id === '17' ? 'running' as const : 'inactive' as const,
      model: `demo/${id}`,
    })
    const rows = await memberViews(doc([], members), '2', info)
    expect(rows.map(row => [row.name, row.role, row.status])).toEqual([
      ['lead', 'lead', 'inactive'],
      ['researcher', 'teammate', 'running'],
      ['writer', 'teammate', 'inactive'],
      ['ghost', 'teammate', 'failed'],
      ['slow', 'teammate', 'provisioning'],
    ])
    expect(rows[1]).toMatchObject({ conversationId: '17', label: '资料调研', model: 'demo/17' })
    expect(rows[3]?.error).toBe('child creation failed')
    expect(rows[3]?.model).toBeUndefined()
  })
})

describe('team spawn replay and provisioning reconciliation', () => {
  it('plans create, reuse, and taken from the durable roster by member name', () => {
    expect(planSpawnReplay(doc(), 'researcher')).toEqual({ kind: 'create' })
    // A replayed call finds the child its first attempt created and reuses it.
    expect(planSpawnReplay(doc([], [{ name: 'researcher', role: 'teammate', phase: 'provisioning', conversationId: '17' }]), 'researcher'))
      .toEqual({ kind: 'reuse', conversationId: '17' })
    expect(planSpawnReplay(doc([], [{ name: 'researcher', role: 'teammate', phase: 'active', conversationId: '17' }]), 'researcher'))
      .toEqual({ kind: 'reuse', conversationId: '17' })
    // A failed or childless row keeps the name burned: DSH never reuses a teammate name.
    expect(planSpawnReplay(doc([], [{ name: 'researcher', role: 'teammate', phase: 'failed' }]), 'researcher'))
      .toEqual({ kind: 'taken' })
    expect(planSpawnReplay(doc([], [{ name: 'researcher', role: 'teammate', phase: 'provisioning' }]), 'researcher'))
      .toEqual({ kind: 'taken' })
    // The Lead row is not a teammate and never blocks a teammate name.
    expect(planSpawnReplay(doc([], [{ name: 'lead', role: 'lead', phase: 'active', conversationId: '2' }]), 'researcher'))
      .toEqual({ kind: 'create' })
  })

  it('settles provisioning rows from their child session, matching DSH roster.ts:375-417', async () => {
    const members: TeamMemberRecord[] = [
      { name: 'lead', role: 'lead', phase: 'active', conversationId: '2' },
      { name: 'lost-child', role: 'teammate', phase: 'provisioning', conversationId: '40' },
      { name: 'no-child', role: 'teammate', phase: 'provisioning' },
      { name: 'rejected', role: 'teammate', phase: 'provisioning', conversationId: '41' },
      { name: 'unlinked', role: 'teammate', phase: 'provisioning', conversationId: '42' },
      { name: 'still-running', role: 'teammate', phase: 'provisioning', conversationId: '43' },
      { name: 'healthy', role: 'teammate', phase: 'provisioning', conversationId: '44' },
      { name: 'already-failed', role: 'teammate', phase: 'failed', conversationId: '45', error: 'kept' },
      { name: 'already-active', role: 'teammate', phase: 'active', conversationId: '46' },
    ]
    const states: Record<string, MemberSessionState> = {
      '40': { exists: false, linked: false, promptRejected: false, running: false },
      '41': { exists: true, linked: true, promptRejected: true, running: false },
      '42': { exists: true, linked: false, promptRejected: false, running: false },
      '43': { exists: true, linked: true, promptRejected: false, running: true },
      '44': { exists: true, linked: true, promptRejected: false, running: false },
    }
    let stored: TeamDocValue = doc([], members)
    const access: TeamDocAccess = {
      read: async () => stored,
      commit: async (change) => {
        const draft = structuredClone(stored)
        const tx = { doc: async () => draft } as unknown as Tx
        await change(tx)
        stored = draft
      },
    }
    await reconcileProvisioning(access, {
      memberSession: async (conversationId) => states[conversationId]!,
    }, 2 as ConversationId, {} as Context)

    expect(stored.members.map(member => [member.name, member.phase, member.error])).toEqual([
      ['lead', 'active', undefined],
      ['lost-child', 'failed', 'provisioning did not leave a resumable child conversation'],
      ['no-child', 'failed', 'provisioning did not leave a resumable child conversation'],
      ['rejected', 'failed', 'the initial prompt was not accepted'],
      ['unlinked', 'failed', "the child conversation is no longer this member's continuation"],
      ['still-running', 'provisioning', undefined],
      ['healthy', 'active', undefined],
      ['already-failed', 'failed', 'kept'],
      ['already-active', 'active', undefined],
    ])
  })

  it('records a probe failure as the failed reason instead of throwing', async () => {
    let stored: TeamDocValue = doc([], [{ name: 'broken', role: 'teammate', phase: 'provisioning', conversationId: '50' }])
    await reconcileProvisioning({
      read: async () => stored,
      commit: async (change) => {
        const draft = structuredClone(stored)
        const tx = { doc: async () => draft } as unknown as Tx
        await change(tx)
        stored = draft
      },
    }, {
      memberSession: async () => { throw new Error('storage offline') },
    }, 2 as ConversationId, {} as Context)
    expect(stored.members[0]).toMatchObject({
      name: 'broken',
      phase: 'failed',
      error: 'child conversation recovery failed: storage offline',
    })
  })
})
