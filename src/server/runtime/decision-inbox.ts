import { createHash } from 'node:crypto'
import { copyJson } from '@earendil-works/chord'
import { defineDoc, type ConversationId, type ConversationRecord, type Cursor, type Harness, type Tx } from '@earendil-works/pi-durable'
import type {
  DecisionInboxPresence, DecisionMail, DecisionMailKind, DecisionMailSummary, EscalationReason, ResultVerdict, UpdateDecisionMail,
  WorkItemVerdict,
} from '../../shared/decision-inbox.ts'
import type { WorkItem, WorkItemEvidence } from '../../shared/workbench.ts'
import { RuntimeError } from '../runtime-errors.ts'
import { Interactions, type StoredInteraction } from '../tools/interaction.ts'
import { planReviewOf, planTitle } from '../tools/plan.ts'
import { CTX, META, parseConversationId } from './helpers.ts'

type MailDisposition = { archived?: boolean; snoozedUntil?: number }
type MailDelivery = 'conversation' | 'inbox'
type MailLedger = {
  presentation: Record<string, MailDisposition>
  results: Record<string, DecisionMail>
  delivery?: Record<string, MailDelivery>
  verdicts?: Record<string, 'accepted' | 'revise'>
}

// Questions and plan reviews stay in Interactions. Only presentation choices
// and immutable copies of results displaced by a revision belong in this doc.
const DecisionMailLedger = defineDoc<MailLedger>({
  kind: 'pi-web.decision-inbox',
  version: 1,
  scope: 'conversation',
  history: 'latest',
  fork: 'initial',
  checkpointWhen: () => false,
  initial: () => ({ presentation: {}, results: {} }),
})

type DecisionInboxDeps = {
  harness(): Harness
  listWorkItems(workspaceId: string): Promise<WorkItem[]>
  decideWorkItem(
    workspaceId: string, itemId: string, action: ResultVerdict['action'], attempt: number, feedback: string | undefined,
    recordVerdict: (tx: Tx, item: Readonly<WorkItem>) => Promise<boolean>,
  ): Promise<void>
}

type InboxSource = { id: ConversationId; record: ConversationRecord; workspaceId: string | null; title: string }
type ConversationLease = {
  workspaceId: string
  conversationId: string
  sequence: number
  startedAt: number
  expiresAt: number
  active: boolean
}
const PRESENCE_LEASE_MS = 12_000

const mailKind: Record<EscalationReason, DecisionMailKind> = {
  requirement_ambiguity: 'choice',
  high_impact: 'confirmation',
  scope_conflict: 'confirmation',
  cannot_verify: 'exception',
}

function mailId(...parts: Array<string | number>): string {
  return createHash('sha256').update(JSON.stringify(parts)).digest('base64url')
}

function excerpt(body: string): string {
  return body.replace(/\s+/gu, ' ').trim().slice(0, 220)
}

function synopsis(mail: DecisionMail): DecisionMailSummary {
  const {
    id, kind, reason, link, conversationTitle, groupId, groupTitle, subject, snippet,
    createdAt, settledAt, folder, actionable, snoozedUntil, resolution,
  } = mail
  return { id, kind, reason, link, conversationTitle, groupId, groupTitle, subject, snippet, createdAt, folder, actionable,
    ...(snoozedUntil === undefined ? {} : { snoozedUntil }), ...(resolution === undefined ? {} : { resolution }),
    ...(settledAt === undefined ? {} : { settledAt }) }
}

function presentation(
  mail: DecisionMail,
  preferences: MailDisposition | undefined,
  now: number,
): DecisionMail {
  if (!mail.actionable || preferences?.archived) return { ...mail, folder: 'archived' }
  if (preferences?.snoozedUntil && preferences.snoozedUntil > now) {
    return { ...mail, folder: 'snoozed', snoozedUntil: preferences.snoozedUntil }
  }
  return { ...mail, folder: 'pending' }
}

function interactionMail(
  source: InboxSource,
  callId: string,
  record: StoredInteraction,
  item?: WorkItem,
): DecisionMail | undefined {
  const plan = planReviewOf(record)
  const status = plan?.status ?? record.status
  const settledAt = record.answeredAt ?? record.cancelledAt
  const base = {
    id: mailId('interaction', String(source.id), callId),
    link: {
      conversationId: String(source.id),
      interactionId: callId,
      ...(item ? { parentConversationId: item.parentId, workItemId: item.id } : {}),
    },
    conversationTitle: source.title,
    groupId: String(source.id),
    groupTitle: source.title,
    createdAt: record.askedAt,
    actionable: status === 'pending',
    folder: 'pending' as const,
    ...(status === 'pending' ? {} : { resolution: status }),
    ...(settledAt === undefined ? {} : { settledAt }),
  }
  if (plan) return {
    ...base,
    kind: 'review',
    reason: 'cannot_verify',
    why: 'Agent 已提交计划。需要你判断计划是否符合目标和约束，才能按当前权限继续。',
    subject: planTitle(plan.detail) ?? '计划待审阅',
    snippet: excerpt(plan.detail.replace(/^#[^\n]+\n?/u, '')),
    body: plan.detail,
    approveLabel: plan.approveLabel,
    evidence: [],
    ...(plan.answers ? { answers: plan.answers } : {}),
  }
  const question = record.questions?.[0]
  const escalation = record.escalation
  if (!question || !escalation) return undefined
  const evidence: WorkItemEvidence[] = (escalation.evidence ?? []).map(label => ({
    kind: 'response', label, status: 'recorded',
  }))
  return {
    ...base,
    kind: mailKind[escalation.reason],
    reason: escalation.reason,
    why: escalation.why,
    subject: excerpt(question.header ?? question.question),
    snippet: excerpt(question.question),
    questions: record.questions,
    evidence,
    ...(record.answers ? { answers: record.answers } : {}),
  }
}

function workItemMail(item: WorkItem): DecisionMail | undefined {
  const needsReview = item.status === 'pending_review'
  const accepted = item.status === 'ended' && item.outcome?.decision === 'accepted'
  const failure = item.status === 'needs_human' && item.failure?.code !== 'CONVERSATION_INTERRUPTED' ? item.error : undefined
  if (!(needsReview || accepted || failure)) return undefined

  const conversationId = item.childId ?? item.parentId
  const body = failure ?? item.outcome?.summary ?? ''
  const evidence = [...item.evidence]
  if (!failure && !evidence.some(item => item.kind === 'validation' && item.status !== 'recorded')) {
    evidence.push({ kind: 'validation', label: '未记录可核验的检查结果', status: 'insufficient' })
  }
  return {
    id: mailId(failure ? 'failure' : 'result', item.parentId, item.id, item.attempt),
    link: { conversationId, parentConversationId: item.parentId, workItemId: item.id },
    conversationTitle: item.title,
    groupId: conversationId,
    groupTitle: item.title,
    subject: failure ? `${item.title} · 执行异常` : item.title,
    snippet: excerpt(body),
    body,
    ...(failure && item.failure ? { failure: item.failure } : {}),
    kind: failure ? 'exception' : 'result',
    reason: failure ? 'cannot_verify' : 'accept_result',
    why: failure
      ? '任务执行遇到阻塞，Agent 无法独立确认下一步。你可以回到任务查看过程或回复补充信息。'
      : 'Agent 已交付结果。请结合验收条件和现有证据决定通过或退回修改。',
    evidence,
    ...(item.acceptance.length > 0 && !failure ? { acceptance: item.acceptance } : {}),
    attempt: item.attempt,
    createdAt: (failure ? undefined : item.outcome?.at) ?? item.updatedAt,
    actionable: !accepted,
    folder: accepted ? 'archived' : 'pending',
    ...(accepted ? { resolution: 'accepted' as const, settledAt: item.updatedAt } : {}),
  }
}

export function createDecisionInbox({ harness, listWorkItems, decideWorkItem }: DecisionInboxDeps) {
  const views = new Map<string, ConversationLease>()

  function pruneViews(now: number): void {
    for (const [id, view] of views) {
      if (view.expiresAt + PRESENCE_LEASE_MS <= now) views.delete(id)
    }
  }

  function viewing(workspaceId: string, conversationId: string, now: number, createdAt?: number): boolean {
    for (const view of views.values()) {
      if (view.active && view.workspaceId === workspaceId && view.conversationId === conversationId
        && view.expiresAt > now && (createdAt === undefined || view.startedAt < createdAt)) return true
    }
    return false
  }

  function delivered(ledger: Readonly<MailLedger> | undefined, id: string): boolean {
    return ledger?.delivery?.[id] === 'inbox' || ledger?.presentation[id] !== undefined || ledger?.results[id] !== undefined
  }

  async function presence(workspaceId: string, value: string, input: DecisionInboxPresence): Promise<void> {
    const id = parseConversationId(value)
    const conversationId = String(id)
    const key = JSON.stringify([workspaceId, conversationId, input.viewId])
    const previous = views.get(key)
    if (previous && input.sequence <= previous.sequence) return
    const now = Date.now()
    pruneViews(now)

    if (!input.active) {
      views.set(key, { workspaceId, conversationId, sequence: input.sequence, startedAt: now, expiresAt: now, active: false })
      return
    }
    // Resolve the same workspace ownership as the inbox. Most conversations carry metadata directly.
    if (!previous?.active || previous.expiresAt <= now) {
      const belongs = await harness().commit(async tx => {
        let current = await tx.conversation(id)
        while (current !== undefined) {
          const metadata = await tx.doc(META, current.id)
          if (metadata.workspaceId !== null) return metadata.workspaceId === workspaceId
          current = current.owner ? await tx.conversation(current.owner.conversationId) : undefined
        }
        return false
      }, CTX)
      if (!belongs) throw new RuntimeError('NOT_FOUND', '当前工作空间中没有这个会话')
    }
    // A closing request or a newer heartbeat can arrive during ownership validation.
    const latest = views.get(key)
    if (latest && latest.sequence >= input.sequence) return
    const registeredAt = Date.now()
    const startedAt = latest?.active && latest.expiresAt > registeredAt ? latest.startedAt : registeredAt
    const lease = { workspaceId, conversationId, sequence: input.sequence, startedAt, expiresAt: registeredAt + PRESENCE_LEASE_MS, active: true }
    views.set(key, lease)
    if (input.observed.length === 0) return

    const observedInteraction = input.observed.find(entry => entry.kind === 'interaction')
    const observedWorkItem = input.observed.find(entry => entry.kind !== 'interaction')
    const [interactions, items] = await Promise.all([
      observedInteraction ? harness().snapshot(Interactions, id, CTX) : undefined,
      observedWorkItem ? listWorkItems(workspaceId) : [],
    ])
    const candidates: Array<{ id: string; ledgerId: ConversationId; at: number }> = []
    if (observedInteraction) {
      const request = interactions?.[observedInteraction.id]
      if (request && (planReviewOf(request) || request.escalation)) {
        candidates.push({ id: mailId('interaction', conversationId, observedInteraction.id), ledgerId: id, at: request.askedAt })
      }
    }
    if (observedWorkItem) {
      const item = items.find(item => item.id === observedWorkItem.itemId && item.attempt === observedWorkItem.attempt)
      const mail = item && workItemMail(item)
      if (mail && mail.link.conversationId === conversationId
        && (observedWorkItem.kind === 'result' ? mail.kind === 'result' : mail.kind === 'exception')) {
        candidates.push({ id: mail.id, ledgerId: ledgerConversation(mail), at: mail.createdAt })
      }
    }
    const fresh = candidates.filter(candidate => candidate.at > startedAt)
    if (fresh.length === 0) return
    await harness().commit(async tx => {
      for (const candidate of fresh) {
        const current = views.get(key)
        if (!current?.active || current.startedAt !== startedAt || current.expiresAt <= Date.now()) return
        const ledger = await tx.doc(DecisionMailLedger, candidate.ledgerId)
        if (!delivered(ledger, candidate.id)) {
          ledger.delivery ??= {}
          ledger.delivery[candidate.id] = 'conversation'
        }
      }
    }, CTX)
  }

  async function sourcesInWorkspace(workspaceId: string): Promise<InboxSource[]> {
    const sources = new Map<string, InboxSource>()
    let cursor: Cursor | undefined
    do {
      const page = await harness().commit(tx => tx.scanConversations({ order: 'descending' }, 250, cursor), CTX)
      const chunk = await Promise.all(page.items.map(async record => {
        const metadata = await harness().snapshot(META, record.id, CTX)
        return {
          id: record.id,
          record,
          workspaceId: metadata?.workspaceId ?? null,
          title: metadata?.title ?? '未命名会话',
        }
      }))
      for (const source of chunk) sources.set(String(source.id), source)
      cursor = page.next
    } while (cursor)

    return [...sources.values()].filter(source => {
      let owner: InboxSource | undefined = source
      while (owner && owner.workspaceId === null && owner.record.owner) {
        owner = sources.get(String(owner.record.owner.conversationId))
      }
      return owner?.workspaceId === workspaceId
    })
  }

  async function read(workspaceId: string): Promise<DecisionMail[]> {
    const items = await listWorkItems(workspaceId)
    const sources = await sourcesInWorkspace(workspaceId)
    const itemsByChild = new Map(items.filter(item => item.childId).map(item => [item.childId, item]))
    const ledgers = new Map<string, Readonly<MailLedger>>()
    const mails = new Map<string, DecisionMail>()
    const now = Date.now()
    for (let start = 0; start < sources.length; start += 64) {
      await Promise.all(sources.slice(start, start + 64).map(async source => {
        const [interactions, ledger] = await Promise.all([
          harness().snapshot(Interactions, source.id, CTX),
          harness().snapshot(DecisionMailLedger, source.id, CTX),
        ])
        if (ledger) ledgers.set(String(source.id), ledger)
        for (const [callId, request] of Object.entries(interactions ?? {})) {
          const mail = interactionMail(source, callId, request, itemsByChild.get(String(source.id)))
          if (mail) mails.set(mail.id, presentation(mail, ledger?.presentation[mail.id], now))
        }
      }))
    }
    const childWithOpenInteraction = new Set([...mails.values()]
      .filter(mail => mail.actionable)
      .map(mail => mail.link.conversationId))
    for (const item of items) {
      const mail = workItemMail(item)
      if (mail && !(mail.kind === 'exception' && childWithOpenInteraction.has(mail.link.conversationId))) {
        mails.set(mail.id, presentation(mail, ledgers.get(item.parentId)?.presentation[mail.id], now))
      }
    }
    for (const ledger of ledgers.values()) {
      for (const mail of Object.values(ledger.results)) {
        if (mails.has(mail.id)) continue
        mails.set(mail.id, { ...mail, actionable: false, folder: 'archived' })
      }
    }
    const deliveryTime = Date.now()
    pruneViews(deliveryTime)
    const visible = [...mails.values()].filter(mail => {
      const ledger = ledgers.get(String(ledgerConversation(mail)))
      if (delivered(ledger, mail.id)) return true
      const inline = ledger?.delivery?.[mail.id] === 'conversation'
      if (viewing(workspaceId, mail.link.conversationId, deliveryTime, inline ? undefined : mail.createdAt)) return false
      return mail.actionable || !inline
    })
    return visible.sort((a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id))
  }

  async function detail(workspaceId: string, mailId: string): Promise<DecisionMail> {
    const mail = (await read(workspaceId)).find(candidate => candidate.id === mailId)
    if (!mail) throw new RuntimeError('NOT_FOUND', '收件箱中没有这封信')
    return mail
  }

  function ledgerConversation(mail: DecisionMail): ConversationId {
    return parseConversationId(mail.link.interactionId ? mail.link.conversationId : mail.link.parentConversationId ?? mail.link.conversationId)
  }

  async function updateMany(workspaceId: string, ids: string[], input: UpdateDecisionMail): Promise<void> {
    const byId = new Map((await read(workspaceId)).map(mail => [mail.id, mail]))
    const mails = [...new Set(ids)].map(id => {
      const mail = byId.get(id)
      if (!mail) throw new RuntimeError('NOT_FOUND', '收件箱中没有这封信')
      return mail
    })
    const now = Date.now()
    if (input.action === 'snooze' && (
      mails.some(mail => !mail.actionable) || input.until <= now || input.until > now + 30 * 24 * 60 * 60 * 1_000
    )) {
      throw new RuntimeError('INVALID_INPUT', '稍后提醒只能为待处理邮件设置，时间须在未来 30 天内')
    }
    await harness().commit(async tx => {
      for (const mail of mails) {
        const ledger = await tx.doc(DecisionMailLedger, ledgerConversation(mail))
        if (ledger.delivery?.[mail.id] === 'conversation') ledger.delivery[mail.id] = 'inbox'
        if (mail.kind === 'result') ledger.results[mail.id] ??= mail
        if (input.action === 'restore') delete ledger.presentation[mail.id]
        else ledger.presentation[mail.id] = input.action === 'archive' ? { archived: true } : { snoozedUntil: input.until }
      }
    }, CTX)
  }

  async function applyVerdict(workspaceId: string, itemId: string, input: WorkItemVerdict, fromInbox: boolean): Promise<DecisionMail | undefined> {
    const resolution = input.action === 'accept' ? 'accepted' : 'revise'
    let settled: DecisionMail | undefined
    await decideWorkItem(workspaceId, itemId, input.action, input.attempt, input.feedback, async (tx, stored) => {
      const id = mailId('result', stored.parentId, itemId, input.attempt)
      const ledger = await tx.doc(DecisionMailLedger, parseConversationId(stored.parentId))
      const previous = ledger.verdicts?.[id] ?? ledger.results[id]?.resolution
      if (previous !== undefined) {
        if (previous !== resolution) throw new RuntimeError('CONFLICT', '这次结果已经处理')
        const existing = ledger.results[id]
        if (existing) settled = copyJson(existing) as DecisionMail
        return true
      }
      const mail = workItemMail(copyJson(stored) as WorkItem)
      if (mail?.kind !== 'result' || mail.attempt !== input.attempt) {
        throw new RuntimeError('CONFLICT', '该轮结果已处理，请刷新后查看')
      }
      if (!mail.actionable && mail.resolution !== resolution) throw new RuntimeError('CONFLICT', '这次结果已经处理')
      const keepMail = fromInbox || delivered(ledger, id)
        || (ledger.delivery?.[id] !== 'conversation' && !viewing(workspaceId, mail.link.conversationId, Date.now(), mail.createdAt))
      if (keepMail) {
        settled = { ...mail, resolution, actionable: false, folder: 'archived', settledAt: mail.settledAt ?? Date.now() }
        ledger.results[id] = settled
      } else {
        ledger.delivery ??= {}
        ledger.delivery[id] = 'conversation'
      }
      ledger.verdicts ??= {}
      ledger.verdicts[id] = resolution
      delete ledger.presentation[id]
      return !mail.actionable
    })
    return settled
  }

  return {
    async list(workspaceId: string): Promise<{ mails: DecisionMailSummary[]; pendingCount: number }> {
      const mails = await read(workspaceId)
      return {
        mails: mails.map(synopsis),
        pendingCount: mails.filter(mail => mail.actionable && mail.folder === 'pending').length,
      }
    },
    detail,
    async opened(workspaceId: string, id: string): Promise<void> {
      const mail = await detail(workspaceId, id)
      if (!mail.actionable) return
      const conversationId = ledgerConversation(mail)
      await harness().commit(async tx => {
        const ledger = await tx.doc(DecisionMailLedger, conversationId)
        if (ledger.delivery?.[id] !== 'conversation' || ledger.verdicts?.[id]
          || viewing(workspaceId, mail.link.conversationId, Date.now())) return
        if (mail.link.interactionId) {
          const interactions = await tx.doc(Interactions, conversationId)
          if (interactions[mail.link.interactionId]?.status !== 'pending') return
        }
        ledger.delivery[id] = 'inbox'
      }, CTX)
    },
    presence,
    async recordInteractionSettlement(tx: Tx, conversationId: ConversationId, callId: string, askedAt: number): Promise<void> {
      const now = Date.now()
      if (![...views.values()].some(view => view.active && view.conversationId === String(conversationId)
        && view.expiresAt > now && view.startedAt < askedAt)) return
      const id = mailId('interaction', String(conversationId), callId)
      const ledger = await tx.doc(DecisionMailLedger, conversationId)
      if (!delivered(ledger, id)) {
        ledger.delivery ??= {}
        ledger.delivery[id] = 'conversation'
      }
    },
    updateMany,
    async update(workspaceId: string, id: string, input: UpdateDecisionMail): Promise<DecisionMail> {
      await updateMany(workspaceId, [id], input)
      return detail(workspaceId, id)
    },
    async verdict(workspaceId: string, id: string, input: ResultVerdict): Promise<DecisionMail> {
      const mail = await detail(workspaceId, id)
      if (mail.kind !== 'result' || mail.link.workItemId === undefined || mail.attempt === undefined) {
        throw new RuntimeError('INVALID_INPUT', '这封信不支持结果验收')
      }
      const resolution = input.action === 'accept' ? 'accepted' : 'revise'
      if (!mail.actionable) {
        if (mail.resolution === resolution) return mail
        throw new RuntimeError('CONFLICT', '这次结果已经处理')
      }
      const result = await applyVerdict(workspaceId, mail.link.workItemId, { ...input, attempt: mail.attempt }, true)
      if (!result) throw new RuntimeError('NOT_FOUND', '收件箱中没有这封信')
      return result
    },
    async verdictWorkItem(workspaceId: string, itemId: string, input: WorkItemVerdict): Promise<void> {
      await applyVerdict(workspaceId, itemId, input, false)
    },
  }
}

export type DecisionInbox = ReturnType<typeof createDecisionInbox>
