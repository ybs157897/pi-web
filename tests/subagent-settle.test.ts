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

/**
 * 后台子智能体结算（settlement）机制测试：子会话完成后把结论投递回父会话、
 * 计划模式提醒、request-receipt 幂等、崩溃后对账（reconcile）恰好一次、
 * 无答复运行按失败结算。走真实 Harness + SQLite 存储。
 */
const cleanups: Array<() => Promise<void>> = []
/** 逆序执行登记的清理（关闭 harness、删除临时目录），回收所有 fixture。 */
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

type TestHarness = Awaited<ReturnType<typeof Harness.open>>
type ContextView = Awaited<ReturnType<Conversation['context']>>

/**
 * 构造完整测试环境：临时 workspace + demo 模型 + SQLite 存储的 Harness，
 * 并挂上被测的 settlement 实例。
 * @returns harness / settlement / demo 模型运行时；清理函数已登记进 cleanups
 */
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
 * 创建一个配置了 demo 模型的无主（ownerless）会话，充当测试创建的父/子会话，
 * 代替 runtime create 路径组装出的真实会话。
 */
async function createConversation(harness: TestHarness, demo: ReturnType<typeof createDemoModelRuntime>): Promise<ConversationId> {
  const record = await harness.commit(async (tx) => tx.createConversation({ ownership: { kind: 'ownerless' } }), CTX)
  const handle = await conversation(harness, record.id)
  await handle.configure({ model: { ...demo.defaultModel! } }, CTX)
  return record.id
}

/**
 * 创建没有模型的会话：其任何运行都会确定性地以 `no_model` 结束且不产答复，
 * 用于测试「运行结束但无答案」的失败结算路径。
 */
async function createUnmodeledConversation(harness: TestHarness): Promise<ConversationId> {
  const record = await harness.commit(async (tx) => tx.createConversation({ ownership: { kind: 'ownerless' } }), CTX)
  return record.id
}

/**
 * 取会话句柄，缺失时抛出明确错误。
 */
async function conversation(harness: TestHarness, id: ConversationId): Promise<Conversation> {
  const handle = await harness.conversation(id, CTX)
  if (!handle) throw new Error(`conversation ${String(id)} is missing`)
  return handle
}

/**
 * 按转录顺序取出某个角色的所有可见文本。
 * @param view 会话上下文视图
 * @param role 只取该角色的消息
 * @returns 各消息文本块以换行拼接后的数组
 */
function messageTexts(view: ContextView, role: 'user' | 'assistant'): string[] {
  return view.contributions.flat()
    .filter(message => message.role === role)
    .map(message => typeof message.content === 'string'
      ? message.content
      : message.content.flatMap(part => part?.type === 'text' && typeof part.text === 'string' ? [part.text] : []).join('\n'))
}

/**
 * 轮询会话上下文直到谓词成立。
 * @param predicate 判定 { user, assistant } 文本是否达到期望状态
 * @returns 达到期望状态时的文本集合；超时（默认 20 秒）抛错
 */
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

/**
 * 在子会话的身份记录中植入一条尚未投递的后台委派（模拟崩溃前或运行开始前的状态）。
 * @param requestId 结算用的请求 id
 */
async function plantDelegation(harness: TestHarness, childId: ConversationId, parentId: ConversationId, requestId: string): Promise<void> {
  await harness.commit(async (tx) => {
    const doc = await tx.doc(Subagents, childId)
    const delegation: SubagentDelegation = { background: true, parent: parentId, requestId }
    const record: SubagentIdentity = { label: '机制归纳', createdAt: Date.now(), profile: 'general-purpose', delegation }
    doc.record = record
  }, CTX)
}

/**
 * 读子会话的委派记录。
 * @returns 委派信息（含 deliveredAt 标记），未植入时为 undefined
 */
async function delegationOf(harness: TestHarness, childId: ConversationId): Promise<SubagentDelegation | undefined> {
  return (await harness.snapshot(Subagents, childId, CTX))?.record?.delegation
}

/**
 * 读父会话某请求的投递回执。
 * @returns 含 submissionId 的回执，未投递时为 undefined
 */
async function receiptOf(harness: TestHarness, parentId: ConversationId, requestId: string): Promise<{ submissionId: number | null } | undefined> {
  return (await harness.snapshot(META, parentId, CTX))?.requestReceipts[requestId]
}

/** 一条已完成的结算结果样本，各用例按需覆盖 requestId/childId。 */
const OUTCOME: SettlementOutcome = {
  requestId: 'subagent-settle:42',
  label: '机制归纳',
  childId: '',
  status: 'completed',
  body: '结论已经就绪。',
}

describe('subagent background settlement', () => {
  // 主链路：先武装 watcher（与工具行为一致，任务提交前就绪）→ 子会话运行完成 →
  // drain 投递 → 父会话收到带标记的用户消息（含子答复全文、无计划模式尾巴）、
  // 回执通道有 submissionId、委派记录标记 deliveredAt。
  it('settles a finished delegation into the parent and marks it delivered', async () => {
    const { harness, settlement, demo } = await fixture()
    const parent = await createConversation(harness, demo)
    const child = await createConversation(harness, demo)
    await plantDelegation(harness, child, parent, 'subagent-settle:42')
    // 与工具行为一致：任务提交前先武装 watcher——子会话运行开始与结束时
    // watcher 必须已经挂载。
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
    // 结算经由 request-receipt 通道传输，委派记录标记为已投递。
    expect((await receiptOf(harness, parent, 'subagent-settle:42'))?.submissionId).toBeTypeOf('number')
    expect((await delegationOf(harness, child))?.deliveredAt).toBeTypeOf('number')
  })

  // 边界：父会话处于计划模式时，结算消息要追加「把结论并入计划」的提醒尾巴，
  // 引导模型并入计划而非开始实施。
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

  // 幂等契约：同一 outcome 重复 settleBackground 三次，父会话只落一条结算消息
  // ——由 request receipt 保证。
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

  // 崩溃恢复主路径：子会话先完成运行、委派未投递（模拟结算前的崩溃），
  // reconcile 补投恰好一次并写 deliveredAt；第二次对账看到标记后不再注入。
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

    // 第二次对账看到 deliveredAt 标记后不再注入任何内容。
    await settlement.reconcileBackgroundDelegations()
    const view = await (await conversation(harness, parent)).context(CTX)
    expect(messageTexts(view, 'user').filter(text => text.startsWith(SUBAGENT_SETTLEMENT_MARKER))).toHaveLength(1)
  })

  // 对账的保守面：回执存在但 deliveredAt 标记丢失（模拟 submit 与标记写入之间崩溃）时，
  // 不重发消息，只补回 deliveredAt 标记。
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
    // 模拟在 submit 与 delivered 写入之间发生的崩溃。
    await harness.commit(async (tx) => {
      const doc = await tx.doc(Subagents, child)
      if (doc.record?.delegation) delete doc.record.delegation.deliveredAt
    }, CTX)

    await settlement.reconcileBackgroundDelegations()

    const view = await (await conversation(harness, parent)).context(CTX)
    expect(messageTexts(view, 'user').filter(text => text.startsWith(SUBAGENT_SETTLEMENT_MARKER))).toHaveLength(1)
    expect((await delegationOf(harness, child))?.deliveredAt).toBeTypeOf('number')
  })

  // 边界：子会话尚无最终答复时对账直接跳过，委派保持未投递状态（不预支结论）。
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

  // 失败结算：子会话运行结束但从未产出答复（无模型）时，父会话收到
  // 「未能完成任务 + 未返回答复」的失败结算，且委派照常标记 deliveredAt。
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
    expect(delivered[0]).toContain('未返回答复')
    expect((await delegationOf(harness, child))?.deliveredAt).toBeTypeOf('number')
  })

  // 空转边界：没有任何在途结算时 drain 也能立即返回。
  it('drains with nothing in flight', async () => {
    const { settlement, demo } = await fixture()
    await settlement.drain()
  })
})
