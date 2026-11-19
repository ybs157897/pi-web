import { createRegistry, Harness, MemoryStorage, type ConversationId } from '@earendil-works/pi-durable'
import { describe, expect, it, vi } from 'vitest'
import type { WorkItem } from '../src/shared/workbench.ts'
import type { DecisionInboxPresence } from '../src/shared/decision-inbox.ts'
import { createDemoModelRuntime } from '../src/server/model/demo.ts'
import { createDecisionInbox } from '../src/server/runtime/decision-inbox.ts'
import { CTX, META } from '../src/server/runtime/helpers.ts'
import { createInteractionReplies } from '../src/server/runtime/interactions.ts'
import { createExecutionEnv } from '../src/server/conversation/execution-env.ts'
import { Interactions } from '../src/server/tools/interaction.ts'
import { interactionTable } from '../src/server/tools/plan.ts'
import type { ConversationDetail } from '../src/shared/types.ts'

async function fixture() {
  const demo = createDemoModelRuntime()
  const harness = await Harness.open(new MemoryStorage(), {
    models: demo.models, registry: createRegistry(), env: async () => createExecutionEnv(process.cwd(), 'readOnly'),
  }, CTX)
  harness.resume()
  async function conversation(workspaceId: string, title: string) {
    const session = await harness.createConversation({
      ownership: { kind: 'ownerless' }, agent: { model: { ...demo.defaultModel! } },
    }, CTX)
    await harness.commit(async tx => {
      const metadata = await tx.doc(META, session.id)
      metadata.workspaceId = workspaceId
      metadata.title = title
    }, CTX)
    return session
  }
  return { harness, conversation }
}

async function seedQuestion(harness: Harness, id: ConversationId, call: string, escalate = true) {
  await harness.commit(async tx => {
    const doc = await tx.doc(Interactions, id)
    doc[call] = {
      askedAt: Date.now(),
      status: 'pending',
      questions: [{ id: 'retry', question: '重试预算是否可以增加？', options: [{ label: '维持当前预算' }] }],
      ...(escalate ? { escalation: { reason: 'high_impact', why: '提高预算会延长超时窗口。', evidence: ['目前超时窗口 12 秒'] } } : {}),
    }
  }, CTX)
}

describe('decision inbox', () => {
  it('reserves fresh decisions for their foreground conversation and keeps old mail and other conversations in the inbox', async () => {
    const { harness, conversation } = await fixture()
    let now = Date.now()
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now)
    const view = (viewId: string, sequence: number, active: boolean, id?: string): DecisionInboxPresence => ({
      viewId, sequence, active, observed: id ? [{ kind: 'interaction', id }] : [],
    })
    try {
      const target = await conversation('alpha', '网关')
      const other = await conversation('alpha', '另一个会话')
      const dependencies = { harness: () => harness, listWorkItems: async () => [], decideWorkItem: async () => undefined }
      const inbox = createDecisionInbox(dependencies)
      const id = String(target.id)
      await seedQuestion(harness, target.id, 'already-sent')
      ++now
      await expect(inbox.presence('wrong-workspace', id, view('wrong', 1, true))).rejects.toMatchObject({ code: 'NOT_FOUND' })
      await inbox.presence('alpha', id, view('first-tab', 1, true))
      await inbox.presence('alpha', id, view('second-tab', 1, true))
      ++now
      await seedQuestion(harness, target.id, 'inline-handled')
      await seedQuestion(harness, target.id, 'leave-pending')
      await seedQuestion(harness, other.id, 'other-conversation')
      expect((await inbox.list('alpha')).mails.map(mail => mail.link.interactionId).sort()).toEqual(['already-sent', 'other-conversation'])
      await inbox.presence('alpha', id, view('first-tab', 2, true, 'leave-pending'))
      await inbox.presence('alpha', id, view('first-tab', 3, false))
      expect((await inbox.list('alpha')).pendingCount).toBe(2)

      // Settlement is recorded in the same transaction as the interaction result, even before its display receipt returns.
      await harness.commit(async tx => {
        const records = await tx.doc(Interactions, target.id)
        const item = records['inline-handled']!
        await inbox.recordInteractionSettlement(tx, target.id, 'inline-handled', item.askedAt)
        item.status = 'answered'
        item.answeredAt = now
      }, CTX)
      await inbox.presence('alpha', id, view('second-tab', 3, false))
      await inbox.presence('alpha', id, view('second-tab', 2, true, 'leave-pending'))
      const waiting = (await inbox.list('alpha')).mails
      expect(waiting.map(mail => mail.link.interactionId).sort()).toEqual(['already-sent', 'leave-pending', 'other-conversation'])
      await inbox.opened('alpha', waiting.find(mail => mail.link.interactionId === 'leave-pending')!.id)
      const afterRestart = createDecisionInbox(dependencies)
      ++now
      await afterRestart.presence('alpha', id, view('return-to-chat', 1, true))
      await harness.commit(async tx => {
        const records = await tx.doc(Interactions, target.id)
        records['leave-pending']!.status = 'answered'
      }, CTX)
      expect((await afterRestart.list('alpha')).mails.filter(mail => mail.link.interactionId === 'leave-pending')).toMatchObject([
        { folder: 'archived', actionable: false },
      ])
      expect((await afterRestart.list('alpha')).mails.some(mail => mail.link.interactionId === 'inline-handled')).toBe(false)
    } finally {
      clock.mockRestore()
      await harness.close(CTX)
    }
  })

  it('keeps a temporary blur and passive inbox polling from producing a duplicate after the original conversation handles it', async () => {
    const { harness, conversation } = await fixture()
    let now = Date.now()
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now)
    try {
      const target = await conversation('alpha', '网关')
      const deps = { harness: () => harness, listWorkItems: async () => [], decideWorkItem: async () => undefined }
      const inbox = createDecisionInbox(deps)
      const id = String(target.id)
      const viewId = 'tab'
      await inbox.presence('alpha', id, { viewId, sequence: 1, active: true, observed: [] })
      ++now
      await seedQuestion(harness, target.id, 'observed')
      await inbox.presence('alpha', id, { viewId, sequence: 2, active: true,
        observed: [{ kind: 'interaction', id: 'observed' }] })
      expect((await inbox.list('alpha')).mails).toEqual([])

      await inbox.presence('alpha', id, { viewId, sequence: 3, active: false, observed: [] })
      expect((await inbox.list('alpha')).pendingCount).toBe(1)
      ++now
      await inbox.presence('alpha', id, { viewId, sequence: 4, active: true, observed: [] })
      expect((await inbox.list('alpha')).mails).toEqual([])

      await harness.commit(async tx => {
        const record = (await tx.doc(Interactions, target.id)).observed!
        await inbox.recordInteractionSettlement(tx, target.id, 'observed', record.askedAt)
        record.status = 'answered'
      }, CTX)
      await inbox.presence('alpha', id, { viewId, sequence: 5, active: false, observed: [] })
      expect((await createDecisionInbox(deps).list('alpha')).mails).toEqual([])
    } finally {
      clock.mockRestore()
      await harness.close(CTX)
    }
  })

  it('releases unread decisions when a view disappears without a closing request', async () => {
    const { harness, conversation } = await fixture()
    let now = Date.now()
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now)
    try {
      const target = await conversation('alpha', '网关')
      const inbox = createDecisionInbox({ harness: () => harness, listWorkItems: async () => [], decideWorkItem: async () => undefined })
      await inbox.presence('alpha', String(target.id), { viewId: 'tab', sequence: 1, active: true, observed: [] })
      ++now
      await seedQuestion(harness, target.id, 'missed')
      expect((await inbox.list('alpha')).pendingCount).toBe(0)
      now += 13_000
      expect((await inbox.list('alpha')).pendingCount).toBe(1)
    } finally {
      clock.mockRestore()
      await harness.close(CTX)
    }
  })

  it('settles an inline result once without creating an archived copy when its view closes', async () => {
    const { harness, conversation } = await fixture()
    let now = Date.now()
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now)
    try {
      const parent = await conversation('alpha', 'Agent 对话')
      const child = await conversation('alpha', '分析网关')
      let item: WorkItem = {
        id: 'item1', requestId: 'req1', workspaceId: 'alpha', parentId: String(parent.id), childId: String(child.id),
        title: '分析网关', objective: '调查超时', constraints: [], acceptance: [], assignee: 'investigator',
        type: 'investigate', status: 'pending_review', waitingOn: { kind: 'human' }, dependencies: [], evidence: [],
        verification: 'insufficient', attempt: 1, createdAt: now, updatedAt: now,
      }
      let applications = 0
      const inbox = createDecisionInbox({
        harness: () => harness, listWorkItems: async () => [item],
        decideWorkItem: async (_workspaceId, _id, _action, _attempt, _feedback, recordVerdict) => {
          if (await harness.commit(tx => recordVerdict(tx, item), CTX)) return
          ++applications
          const { outcome: _outcome, ...remaining } = item
          item = { ...remaining, attempt: item.attempt + 1, status: 'running', waitingOn: { kind: 'agent' } }
        },
      })
      const viewId = 'tab'
      await inbox.presence('alpha', String(child.id), { viewId, sequence: 1, active: true, observed: [] })
      ++now
      item = { ...item, outcome: { at: now, summary: '提交验证报告' }, updatedAt: now }
      await inbox.presence('alpha', String(child.id), { viewId, sequence: 2, active: true,
        observed: [{ kind: 'result', itemId: item.id, attempt: 1 }] })
      expect((await inbox.list('alpha')).mails).toEqual([])
      await inbox.verdictWorkItem('alpha', item.id, { action: 'revise', attempt: 1, feedback: '重做' })
      await inbox.presence('alpha', String(child.id), { viewId, sequence: 3, active: false, observed: [] })
      await inbox.verdictWorkItem('alpha', item.id, { action: 'revise', attempt: 1, feedback: '重做' })
      await expect(inbox.verdictWorkItem('alpha', item.id, { action: 'accept', attempt: 1 })).rejects.toMatchObject({ code: 'CONFLICT' })
      expect(applications).toBe(1)
      expect((await inbox.list('alpha')).mails).toEqual([])
    } finally {
      clock.mockRestore()
      await harness.close(CTX)
    }
  })

  it('admits only explicitly escalated questions and plan reviews in the selected workspace', async () => {
    const { harness, conversation } = await fixture()
    try {
      const target = await conversation('alpha', '网关')
      const other = await conversation('beta', '另一个项目')
      await seedQuestion(harness, target.id, 'important')
      await seedQuestion(harness, target.id, 'ordinary', false)
      await seedQuestion(harness, other.id, 'elsewhere')
      await harness.commit(async tx => {
        const doc = interactionTable(await tx.doc(Interactions, target.id))
        doc.plan = { kind: 'plan-review', status: 'pending', askedAt: Date.now(),
          detail: '# 网关改造方案\n\n调整 timeout 配置。', approveLabel: '同意执行' }
      }, CTX)
      const inbox = createDecisionInbox({ harness: () => harness, listWorkItems: async () => [], decideWorkItem: async () => undefined })
      const list = await inbox.list('alpha')
      expect(list.pendingCount).toBe(2)
      expect(list.mails.map(mail => mail.link.interactionId).sort()).toEqual(['important', 'plan'])
      const questionId = list.mails.find(mail => mail.kind === 'confirmation')!.id
      const question = await inbox.detail('alpha', questionId)
      expect(question.why).toBe('提高预算会延长超时窗口。')
      expect(question.evidence.map(item => item.label)).toEqual(['目前超时窗口 12 秒'])
      await expect(inbox.detail('beta', questionId)).rejects.toMatchObject({ code: 'NOT_FOUND' })

      expect(await inbox.update('alpha', questionId, { action: 'snooze', until: Date.now() + 10_000 })).toMatchObject({
        folder: 'snoozed', actionable: true,
      })
      expect(await inbox.update('alpha', questionId, { action: 'archive' })).toMatchObject({ folder: 'archived', actionable: true })
      expect(await inbox.update('alpha', questionId, { action: 'restore' })).toMatchObject({ folder: 'pending', actionable: true })
      const reviewId = list.mails.find(mail => mail.kind === 'review')!.id
      await expect(inbox.updateMany('alpha', [questionId, 'missing'], { action: 'archive' })).rejects.toMatchObject({ code: 'NOT_FOUND' })
      expect((await inbox.detail('alpha', questionId)).folder).toBe('pending')
      await inbox.updateMany('alpha', [questionId, reviewId], { action: 'archive' })
      expect((await inbox.list('alpha')).mails).toMatchObject([
        { folder: 'archived', actionable: true },
        { folder: 'archived', actionable: true },
      ])
    } finally {
      await harness.close(CTX)
    }
  })

  it('uses first accepted interaction reply across concurrent inbox and conversation actions', async () => {
    const { harness, conversation } = await fixture()
    try {
      const target = await conversation('alpha', '网关')
      await seedQuestion(harness, target.id, 'shared-call')
      const replies = createInteractionReplies({
        harness: () => harness,
        requireConversation: async () => target,
        currentDetail: async (): Promise<ConversationDetail> => ({
          conversation: {
            id: String(target.id), title: '网关', createdAt: 0, updatedAt: 0, archived: false, pinned: false,
            busy: false, thinkingLevel: 'off', cwd: process.cwd(),
          },
          messages: [], queue: [],
        }),
        assertConversationModelAllowed: async () => undefined,
      })
      const [answer, cancel] = await Promise.allSettled([
        replies.answerInteraction(String(target.id), 'shared-call', [{ id: 'retry', selected: ['维持当前预算'] }]),
        replies.cancelInteraction(`0${target.id}`, 'shared-call'),
      ])
      expect(answer.status).toBe('fulfilled')
      expect(cancel.status).toBe('rejected')
      expect(await harness.commit(tx => tx.submissionByRequest(target.id, 'question-dismiss:shared-call'), CTX)).toBeUndefined()

      const inbox = createDecisionInbox({ harness: () => harness, listWorkItems: async () => [], decideWorkItem: async () => undefined })
      const list = await inbox.list('alpha')
      expect(list.pendingCount).toBe(0)
      expect(list.mails).toMatchObject([{ folder: 'archived', actionable: false, resolution: 'answered' }])
    } finally {
      await harness.close(CTX)
    }
  })

  it('preserves a returned result while waiting for the next result attempt', async () => {
    const { harness, conversation } = await fixture()
    try {
      const parent = await conversation('alpha', 'Agent 对话')
      const child = await conversation('alpha', '分析网关')
      let item: WorkItem = {
        id: 'item1', requestId: 'req1', workspaceId: 'alpha', parentId: String(parent.id), childId: String(child.id),
        title: '分析网关', objective: '调查超时', constraints: [], acceptance: [], assignee: 'investigator',
        type: 'investigate', status: 'pending_review', waitingOn: { kind: 'human' }, dependencies: [],
        evidence: [{ kind: 'response', label: '分析正文', status: 'recorded' }], verification: 'insufficient',
        attempt: 1, outcome: { summary: '第一次提交', at: Date.now() }, createdAt: Date.now(), updatedAt: Date.now(),
      }
      const inbox = createDecisionInbox({
        harness: () => harness,
        listWorkItems: async () => [item],
        decideWorkItem: async (_workspaceId, _itemId, action, attempt, _feedback, recordVerdict) => {
          if (await harness.commit(tx => recordVerdict(tx, item), CTX)) return
          expect(action).toBe('revise')
          expect(attempt).toBe(1)
          const { outcome: _outcome, ...next } = item
          item = { ...next, attempt: 2, status: 'running', waitingOn: { kind: 'agent' } }
        },
      })
      const first = (await inbox.list('alpha')).mails[0]!
      expect((await inbox.detail('alpha', first.id)).evidence.map(entry => entry.status)).toEqual(['recorded', 'insufficient'])
      expect(await inbox.verdict('alpha', first.id, { action: 'revise', feedback: '补上验证' })).toMatchObject({
        folder: 'archived', resolution: 'revise',
      })
      item = { ...item, status: 'pending_review', waitingOn: { kind: 'human' }, outcome: { summary: '第二次提交', at: Date.now() } }
      const list = await inbox.list('alpha')
      expect(list.pendingCount).toBe(1)
      expect(list.mails.find(mail => mail.id === first.id)).toMatchObject({ folder: 'archived', resolution: 'revise' })
      expect(list.mails.find(mail => mail.id !== first.id)).toMatchObject({ folder: 'pending', actionable: true })
      await expect(inbox.verdict('alpha', first.id, { action: 'accept' })).rejects.toMatchObject({ code: 'CONFLICT' })
    } finally {
      await harness.close(CTX)
    }
  })
})
