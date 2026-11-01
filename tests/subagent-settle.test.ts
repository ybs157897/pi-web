import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { BACKGROUND_CONTEXT, type Context } from '@earendil-works/chord/context'
import { Harness, createRegistry, type Conversation, type ConversationId } from '@earendil-works/pi-durable'
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node'
import { createDemoModelRuntime } from '../src/server/model/demo.ts'
import { CodingTools } from '../src/server/tools/shell/tools.ts'
import { Plans } from '../src/server/tools/plan.ts'
import { Subagents, type SubagentDelegation, type SubagentIdentity } from '../src/server/tools/subagent.ts'
import { CTX, META } from '../src/server/runtime/helpers.ts'
import {
  createSubagentSettlement,
  SUBAGENT_SETTLEMENT_MARKER,
  type SettlementOutcome,
} from '../src/server/runtime/subagent-settle.ts'
import { createExecutionEnv } from '../src/server/conversation/execution-env.ts'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

type TestHarness = Awaited<ReturnType<typeof Harness.open>>
type ContextView = Awaited<ReturnType<Conversation['context']>>

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'pi-web-subagent-settle-'))
  const workspace = join(root, 'workspace')
  await mkdir(workspace, { recursive: true })
  const demo = createDemoModelRuntime()
  const registry = createRegistry()
  registry.install(CodingTools)
  const storage = await openNodeSqliteStorage(join(root, 'state.sqlite'))
  const harness = await Harness.open(storage, {
    models: demo.models,
    registry,
    env: async () => await createExecutionEnv(workspace, 'fullAccess'),
  }, CTX)
  harness.resume()
  const settlement = createSubagentSettlement({ harness: () => harness })
  cleanups.push(async () => {
    await harness.close(CTX)
    await rm(root, { recursive: true, force: true })
  })
  return { root, workspace, harness, settlement, demo }
}

/**
 * One ownerless conversation with the demo model configured, the way a test-created parent or
 * child stands in for what the runtime's create path assembles.
 */
async function createConversation(harness: TestHarness, demo: ReturnType<typeof createDemoModelRuntime>): Promise<ConversationId> {
  const record = await harness.commit(async (tx) => tx.createConversation({ ownership: { kind: 'ownerless' } }), CTX)
  const handle = await conversation(harness, record.id)
  await handle.configure({ model: { ...demo.defaultModel! } }, CTX)
  return record.id
}

/** A conversation with no model: any run settles unanswered (`no_model`), deterministically. */
async function createUnmodeledConversation(harness: TestHarness): Promise<ConversationId> {
  const record = await harness.commit(async (tx) => tx.createConversation({ ownership: { kind: 'ownerless' } }), CTX)
  return record.id
}

async function conversation(harness: TestHarness, id: ConversationId): Promise<Conversation> {
  const handle = await harness.conversation(id, CTX)
  if (!handle) throw new Error(`conversation ${String(id)} is missing`)
  return handle
}

/** The visible text of every message of one role, in transcript order. */
function messageTexts(view: ContextView, role: 'user' | 'assistant'): string[] {
  return view.contributions.flat()
    .filter(message => message.role === role)
    .map(message => typeof message.content === 'string'
      ? message.content
      : message.content.flatMap(part => part?.type === 'text' && typeof part.text === 'string' ? [part.text] : []).join('\n'))
}

/** Poll one conversation's context until the predicate holds. */
async function waitForContext(
  harness: TestHarness,
  id: ConversationId,
  predicate: (texts: { user: string[]; assistant: string[] }) => boolean,
  timeoutMs = 20_000,
): Promise<{ user: string[]; assistant: string[] }> {
  const handle = await conversation(harness, id)
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const view = await handle.context(CTX)
    const texts = { user: messageTexts(view, 'user'), assistant: messageTexts(view, 'assistant') }
    if (predicate(texts)) return texts
    if (Date.now() > deadline) throw new Error(`conversation ${String(id)} did not reach the expected state within ${timeoutMs} ms`)
    await new Promise(resolve => setTimeout(resolve, 25))
  }
}

/** Plant the child's identity record with an undelivered background delegation. */
async function plantDelegation(harness: TestHarness, childId: ConversationId, parentId: ConversationId, requestId: string): Promise<void> {
  await harness.commit(async (tx) => {
    const doc = await tx.doc(Subagents, childId)
    const delegation: SubagentDelegation = { background: true, parent: parentId, requestId }
    const record: SubagentIdentity = { label: '机制归纳', createdAt: Date.now(), profile: 'general-purpose', delegation }
    doc.record = record
  }, CTX)
}

async function delegationOf(harness: TestHarness, childId: ConversationId): Promise<SubagentDelegation | undefined> {
  return (await harness.snapshot(Subagents, childId, CTX))?.record?.delegation
}

async function receiptOf(harness: TestHarness, parentId: ConversationId, requestId: string): Promise<{ submissionId: number | null } | undefined> {
  return (await harness.snapshot(META, parentId, CTX))?.requestReceipts[requestId]
}

const OUTCOME: SettlementOutcome = {
  requestId: 'subagent-settle:42',
  label: '机制归纳',
  childId: '',
  status: 'completed',
  body: '结论已经就绪。',
}

describe('subagent background settlement', () => {
  it('settles a finished delegation into the parent and marks it delivered', async () => {
    const { harness, settlement, demo } = await fixture()
    const parent = await createConversation(harness, demo)
    const child = await createConversation(harness, demo)
    await plantDelegation(harness, child, parent, 'subagent-settle:42')
    // Armed before the task is submitted, like the tool does: the watcher must already be attached
    // when the child's run starts and ends.
    settlement.settleWhenAnswered({ parent, child, label: '机制归纳', settleRequestId: 'subagent-settle:42' })
    await (await conversation(harness, child)).submit({
      type: 'input',
      content: '[subagent-child] 归纳一期机制',
      requestId: 'child-run',
    }, CTX)

    await settlement.drain()

    const texts = await waitForContext(harness, parent, value => value.user.some(text => text.startsWith(SUBAGENT_SETTLEMENT_MARKER)))
    const childAnswer = (await waitForContext(harness, child, value => value.assistant.length > 0)).assistant.at(-1)!
    const delivered = texts.user.filter(text => text.startsWith(SUBAGENT_SETTLEMENT_MARKER))
    expect(delivered).toHaveLength(1)
    expect(delivered[0]).toContain('子智能体「机制归纳」已完成任务')
    expect(delivered[0]).toContain(childAnswer)
    expect(delivered[0]).not.toContain('计划模式仍在开启')
    // The settlement traveled on the request-receipt channel, and the record marks it delivered.
    expect((await receiptOf(harness, parent, 'subagent-settle:42'))?.submissionId).toBeTypeOf('number')
    expect((await delegationOf(harness, child))?.deliveredAt).toBeTypeOf('number')
  })

  it('appends the plan-mode reminder while the parent is still planning', async () => {
    const { harness, settlement, demo } = await fixture()
    const parent = await createConversation(harness, demo)
    const child = await createConversation(harness, demo)
    await plantDelegation(harness, child, parent, 'subagent-settle:7')
    await harness.commit(async (tx) => {
      const plan = await tx.doc(Plans, parent)
      plan.active = true
      plan.updatedAt = Date.now()
    }, CTX)
    await settlement.settleBackground(parent, { ...OUTCOME, requestId: 'subagent-settle:7', childId: String(child) })
    const texts = await waitForContext(harness, parent, value => value.user.some(text => text.includes('计划模式仍在开启')))
    const delivered = texts.user.filter(text => text.startsWith(SUBAGENT_SETTLEMENT_MARKER))
    expect(delivered).toHaveLength(1)
    expect(delivered[0]).toContain('把结论并入计划，不要开始实施')
  })

  it('keeps the settlement idempotent under its request receipt', async () => {
    const { harness, settlement, demo } = await fixture()
    const parent = await createConversation(harness, demo)
    const child = await createConversation(harness, demo)
    const outcome = { ...OUTCOME, childId: String(child) }
    await settlement.settleBackground(parent, outcome)
    await waitForContext(harness, parent, value => value.user.some(text => text.startsWith(SUBAGENT_SETTLEMENT_MARKER)))
    await settlement.settleBackground(parent, outcome)
    await settlement.settleBackground(parent, outcome)
    const view = await (await conversation(harness, parent)).context(CTX)
    expect(messageTexts(view, 'user').filter(text => text.startsWith(SUBAGENT_SETTLEMENT_MARKER))).toHaveLength(1)
  })

  it('reconciles an undelivered delegation whose child already answered, exactly once', async () => {
    const { harness, settlement, demo } = await fixture()
    const parent = await createConversation(harness, demo)
    const child = await createConversation(harness, demo)
    // The child finished its run before the crash; the settlement never reached the parent.
    await (await conversation(harness, child)).submit({
      type: 'input',
      content: '[subagent-child] 归纳一期机制',
      requestId: 'child-run',
    }, CTX)
    await waitForContext(harness, child, value => value.assistant.length > 0)
    await plantDelegation(harness, child, parent, 'subagent-settle:42')

    await settlement.reconcileBackgroundDelegations()

    const texts = await waitForContext(harness, parent, value => value.user.some(text => text.startsWith(SUBAGENT_SETTLEMENT_MARKER)))
    expect(texts.user.filter(text => text.startsWith(SUBAGENT_SETTLEMENT_MARKER))).toHaveLength(1)
    expect(texts.user.find(text => text.startsWith(SUBAGENT_SETTLEMENT_MARKER))).toContain('子智能体一期机制小结')
    expect((await delegationOf(harness, child))?.deliveredAt).toBeTypeOf('number')

    // A second reconciliation sees the deliveredAt marker and injects nothing further.
    await settlement.reconcileBackgroundDelegations()
    const view = await (await conversation(harness, parent)).context(CTX)
    expect(messageTexts(view, 'user').filter(text => text.startsWith(SUBAGENT_SETTLEMENT_MARKER))).toHaveLength(1)
  })

  it('does not resend when the receipt exists but the delivered marker was lost', async () => {
    const { harness, settlement, demo } = await fixture()
    const parent = await createConversation(harness, demo)
    const child = await createConversation(harness, demo)
    await (await conversation(harness, child)).submit({
      type: 'input',
      content: '[subagent-child] 归纳一期机制',
      requestId: 'child-run',
    }, CTX)
    await waitForContext(harness, child, value => value.assistant.length > 0)
    await plantDelegation(harness, child, parent, 'subagent-settle:42')
    await settlement.settleBackground(parent, { ...OUTCOME, childId: String(child) })
    await waitForContext(harness, parent, value => value.user.some(text => text.startsWith(SUBAGENT_SETTLEMENT_MARKER)))
    // Simulate the crash between submit and the delivered write.
    await harness.commit(async (tx) => {
      const doc = await tx.doc(Subagents, child)
      if (doc.record?.delegation) delete doc.record.delegation.deliveredAt
    }, CTX)

    await settlement.reconcileBackgroundDelegations()

    const view = await (await conversation(harness, parent)).context(CTX)
    expect(messageTexts(view, 'user').filter(text => text.startsWith(SUBAGENT_SETTLEMENT_MARKER))).toHaveLength(1)
    expect((await delegationOf(harness, child))?.deliveredAt).toBeTypeOf('number')
  })

  it('skips a delegation whose child holds no final answer yet', async () => {
    const { harness, settlement, demo } = await fixture()
    const parent = await createConversation(harness, demo)
    const child = await createConversation(harness, demo)
    await plantDelegation(harness, child, parent, 'subagent-settle:42')

    await settlement.reconcileBackgroundDelegations()

    const view = await (await conversation(harness, parent)).context(CTX)
    expect(messageTexts(view, 'user').filter(text => text.startsWith(SUBAGENT_SETTLEMENT_MARKER))).toHaveLength(0)
    expect((await delegationOf(harness, child))?.deliveredAt).toBeUndefined()
  })

  it('settles an unfinished delegation as a failure when its run ends without an answer', async () => {
    const { harness, settlement, demo } = await fixture()
    const parent = await createConversation(harness, demo)
    // No model on the child: its run ends without ever producing an answer.
    const child = await createUnmodeledConversation(harness)
    await plantDelegation(harness, child, parent, 'subagent-settle:42')
    settlement.settleWhenAnswered({ parent, child, label: '机制归纳', settleRequestId: 'subagent-settle:42' })
    await (await conversation(harness, child)).submit({
      type: 'input',
      content: '[subagent-child] 归纳一期机制',
      requestId: 'child-run',
    }, CTX)

    await settlement.drain()

    const texts = await waitForContext(harness, parent, value => value.user.some(text => text.startsWith(SUBAGENT_SETTLEMENT_MARKER)))
    const delivered = texts.user.filter(text => text.startsWith(SUBAGENT_SETTLEMENT_MARKER))
    expect(delivered).toHaveLength(1)
    expect(delivered[0]).toContain('子智能体「机制归纳」未能完成任务')
    expect(delivered[0]).toContain('without an answer')
    expect((await delegationOf(harness, child))?.deliveredAt).toBeTypeOf('number')
  })

  it('drains with nothing in flight', async () => {
    const { settlement, demo } = await fixture()
    await settlement.drain()
  })
})
