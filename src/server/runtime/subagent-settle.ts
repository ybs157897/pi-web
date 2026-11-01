/**
 * Background subagent settlement: delivering a background delegation's result to its parent.
 *
 * A background delegation's tool call has already returned an activation, so the child's answer
 * cannot travel on the tool result. Instead the settlement watches the child conversation from the
 * runtime — every handle reachable from the tool's `api` is bound to the tool invocation and dies
 * with it, so the watcher resolves the child afresh from the harness and rides the never-aborting
 * background context. When the child's run ends, it injects a `[subagent-settlement]` message into
 * the parent with `whenBusy: 'followUp'` — the same request-receipt channel typed replies use, so
 * a retry after a restart never injects it twice. A delegation whose settlement was lost to a
 * crash is re-injected once at startup by `reconcileBackgroundDelegations`.
 */
import { createHash } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import type { ConversationId, Cursor, Harness } from '@earendil-works/pi-durable'
import { answerText, Subagents, type SubagentSettlementInput } from '../tools/subagent.ts'
import { Plans } from '../tools/plan.ts'
import { CTX, liveRunTaskId, META } from './helpers.ts'

/** How long `drain` waits for in-flight settlements before runtime close proceeds. */
export const SUBAGENT_SETTLE_DRAIN_MS = 60_000

/** First line of every settlement message; the parent's transcript shows it as a tagged delivery. */
export const SUBAGENT_SETTLEMENT_MARKER = '[subagent-settlement]'

/** One settlement as it is injected into the parent, keyed by its idempotent request id. */
export type SettlementOutcome = {
  requestId: string
  label: string
  childId: string
  status: 'completed' | 'failed'
  /** The child's final assistant text when completed, otherwise why the delegation has no answer. */
  body: string
}

export interface SubagentSettlementDeps {
  /** Late-bound so the factory can be built before the harness is opened. */
  harness: () => Harness
}

export function createSubagentSettlement(deps: SubagentSettlementDeps) {
  const harness = (): Harness => deps.harness()
  /** Settlements started but not yet finished; `drain` waits for them at runtime close. */
  const inFlight = new Set<Promise<void>>()

  /**
   * Inject one settlement into the parent under its request id. The receipt check makes it
   * idempotent — an already-accepted settlement (live retry, replay, or reconcile after a crash
   * between submit and receipt) resolves without a second message. A parent that no longer exists
   * has nobody to report to, so the settlement is dropped silently.
   */
  const settleBackground = async (parentId: ConversationId, outcome: SettlementOutcome): Promise<void> => {
    const conversation = await harness().conversation(parentId, CTX)
    if (conversation === undefined) return
    const existing = await harness().snapshot(META, parentId, CTX)
    const receipt = existing?.requestReceipts[outcome.requestId]
    if (receipt?.submissionId !== null && receipt?.submissionId !== undefined) return
    const plan = await harness().snapshot(Plans, parentId, CTX)
    const planNote = plan?.active === true ? '\n\n计划模式仍在开启：把结论并入计划，不要开始实施' : ''
    const content = outcome.status === 'completed'
      ? `${SUBAGENT_SETTLEMENT_MARKER}\n子智能体「${outcome.label}」已完成任务，以下是它的最终回答：\n\n${outcome.body}${planNote}`
      : `${SUBAGENT_SETTLEMENT_MARKER}\n子智能体「${outcome.label}」未能完成任务：${outcome.body}${planNote}`
    const request = await conversation.submit({
      type: 'input',
      content,
      requestId: outcome.requestId,
      entry: {
        kind: 'pi-web.subagent-settlement',
        data: { label: outcome.label, conversationId: outcome.childId, status: outcome.status },
      },
      whenBusy: 'followUp',
    }, CTX)
    const status = await request.status(CTX)
    await harness().commit(async (tx) => {
      const metadata = await tx.doc(META, parentId)
      metadata.requestReceipts[outcome.requestId] = {
        fingerprint: createHash('sha256').update(content).digest('hex'),
        status: 'accepted',
        submissionId: Number(request.id),
      }
      if (status.status === 'queued') metadata.queueCreatedAt[String(request.id)] = Date.now()
      metadata.updatedAt = Date.now()
    }, CTX)
  }

  /** Mark one delegation delivered on the child's record, so reconciliation skips it. */
  const markDelivered = async (childId: ConversationId): Promise<void> => {
    await harness().commit(async (tx) => {
      const doc = await tx.doc(Subagents, childId)
      if (doc.record?.delegation?.background !== true) return
      doc.record.delegation.deliveredAt = Date.now()
    }, CTX)
  }

  /** Inject one settled outcome and mark the delegation delivered on the child's record. */
  const settleOne = async (input: SubagentSettlementInput, outcome: Omit<SettlementOutcome, 'requestId' | 'label' | 'childId'>): Promise<void> => {
    await settleBackground(input.parent, { requestId: input.settleRequestId, label: input.label, childId: String(input.child), ...outcome })
    await markDelivered(input.child)
  }

  /**
   * Arm the settlement for one background delegation. Detached on purpose: the tool call has
   * already returned. The child is watched from the runtime — a watch created here survives the
   * tool invocation, unlike anything the call's `api` handed out.
   */
  const settleWhenAnswered = (input: SubagentSettlementInput): void => {
    const pending = armSettlement(input).catch(() => undefined)
    inFlight.add(pending)
    void pending.then(() => { inFlight.delete(pending) })
  }

  const armSettlement = async (input: SubagentSettlementInput): Promise<void> => {
    const conversation = await harness().conversation(input.child, CTX)
    if (conversation === undefined) return
    const watch = await conversation.watch(CTX)
    let settledNow = false
    let sawRun = false
    // The watch only marks the moments; the answer is read from the runtime-level context, which
    // reflects the committed transcript (the watch view carries raw entries, not messages).
    const check = async (): Promise<void> => {
      if (settledNow) return
      if (liveRunTaskId(watch.value) !== undefined) {
        sawRun = true
        return
      }
      const answer = await finalChildAnswer(input.child)
      if (answer !== '') {
        settledNow = true
        await watch.stop().catch(() => undefined)
        await settleOne(input, { status: 'completed', body: answer })
        return
      }
      // The run started and ended without saying anything: report the failure. The run-end
      // publication can land before the answer entries are readable, so a failed verdict waits one
      // beat and re-reads before it fires. An idle child with no answer that never showed a run is
      // a task not started yet, so keep watching.
      if (sawRun) {
        await delay(400)
        const late = await finalChildAnswer(input.child)
        if (settledNow) return
        settledNow = true
        await watch.stop().catch(() => undefined)
        await settleOne(input, late !== '' ? { status: 'completed', body: late } : { status: 'failed', body: 'the background run ended without an answer' })
      }
    }
    void check().catch(() => undefined)
    // A watch event after the harness closed (runtime teardown) must not surface as a rejection.
    watch.start(() => check().catch(() => undefined))
  }

  /** The child's final assistant text, or '' while it holds none (still running, or nothing said). */
  const finalChildAnswer = async (childId: ConversationId): Promise<string> => {
    const conversation = await harness().conversation(childId, CTX)
    if (conversation === undefined) return ''
    const view = await conversation.context(CTX)
    return answerText(view.contributions.flat())
  }

  /**
   * Re-deliver every background delegation whose settlement was lost to a crash: scan all
   * conversations for undelivered delegation records and settle the ones whose child already
   * holds a final answer (the rest wait for the next reconciliation). The settle request id's
   * receipt check keeps an already-delivered message from being injected twice.
   */
  const reconcileBackgroundDelegations = async (): Promise<void> => {
    let cursor: Cursor | undefined
    do {
      const page = await harness().commit((tx) => tx.scanConversations({ order: 'ascending' }, 250, cursor), CTX)
      for (const record of page.items) {
        try {
          const doc = await harness().snapshot(Subagents, record.id, CTX)
          const delegation = doc?.record?.delegation
          if (doc === undefined || doc.record === null || delegation === undefined) continue
          if (delegation.background !== true || delegation.deliveredAt !== undefined) continue
          const text = await finalChildAnswer(record.id)
          if (text === '') continue
          await settleBackground(delegation.parent, {
            requestId: delegation.requestId,
            label: doc.record.label,
            childId: String(record.id),
            status: 'completed',
            body: text,
          })
          await markDelivered(record.id)
        } catch {
          // One malformed record must not stop the remaining delegations from being settled.
        }
      }
      cursor = page.next
    } while (cursor)
  }

  /** Wait for the in-flight settlements to land, bounded so runtime close cannot hang on one. */
  const drain = async (): Promise<void> => {
    const pending = [...inFlight]
    if (pending.length === 0) return
    await Promise.race([
      Promise.all(pending),
      new Promise<void>(resolveTimer => {
        const timer = setTimeout(resolveTimer, SUBAGENT_SETTLE_DRAIN_MS)
        timer.unref?.()
      }),
    ])
  }

  return { settleWhenAnswered, settleBackground, reconcileBackgroundDelegations, drain }
}
