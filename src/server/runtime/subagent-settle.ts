/**
 * 后台子智能体结算：把后台委派的结果送达其父会话。
 *
 * 后台委派的工具调用已先行返回激活回执，子会话的答案无法经由工具结果传递。
 * 结算改为从运行时侧监听子会话——工具 `api` 能拿到的每个句柄都绑定在工具调用上
 * 并随之消亡，因此监视器从 harness 重新解析子会话，并挂在永不中止的后台上下文上。
 * 子会话运行结束时，以 `whenBusy: 'followUp'` 向父会话注入一条 `[subagent-settlement]`
 * 消息——与手打回复相同的请求回执通道，重启重试不会重复注入。结算因崩溃而丢失的
 * 委派由 `reconcileBackgroundDelegations` 在启动时补投一次。
 */
import { createHash } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import type { ConversationId, Cursor, Harness } from '@earendil-works/pi-durable'
import { answerText, Subagents, type SubagentSettlementInput } from '../tools/subagent.ts'
import { Plans } from '../tools/plan.ts'
import { CTX, liveRunTaskId, META } from './helpers.ts'

/** `drain` 等待在途结算的时长上限，超过后运行时关闭流程继续。 */
export const SUBAGENT_SETTLE_DRAIN_MS = 60_000

/** 每条结算消息的首行标记；父会话记录里以带标签的送达形式展示。 */
export const SUBAGENT_SETTLEMENT_MARKER = '[subagent-settlement]'

/** 注入父会话的一次结算，以其幂等 request id 为键。 */
export type SettlementOutcome = {
  requestId: string
  label: string
  childId: string
  status: 'completed' | 'failed'
  /** 子会话完成时的最终回答文本；失败时说明委派为何没有答案。 */
  body: string
}

/** 结算 feature 的依赖注入契约：harness 迟绑定，工厂可在 harness 打开前构建。 */
export interface SubagentSettlementDeps {
  /** 迟绑定，让工厂在 harness 打开前就能创建。 */
  harness: () => Harness
}

/**
 * 功能：创建后台子智能体结算服务——监听后台委派的子会话并在其结束后向父会话注入结果。
 * @param deps harness 迟绑定句柄
 * 职责边界：只处理后台委派的结算；前台委派在 subagent 工具调用内同步等待。
 */
export function createSubagentSettlement(deps: SubagentSettlementDeps) {
  const harness = (): Harness => deps.harness()
  /** 已启动但未完成的结算；运行时关闭时 drain 会等待它们。 */
  const inFlight = new Set<Promise<void>>()

  /**
   * 功能：按 request id 向父会话注入一次结算。
   * @param parentId 父会话 ID
   * @param outcome 结算内容（requestId、标签、状态、正文）
   * @returns 无返回；父会话不存在时静默丢弃
   * 内部逻辑：回执检查保证幂等——已接受的结算（实时重试、重放、或提交与回执之间
   * 崩溃后的对账）直接返回，不再发第二条消息；计划模式仍在开启时附提示，让模型
   * 把结论并入计划而不开始实施。
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

  /** 在子会话记录上标记委派已送达，让对账跳过它。 */
  const markDelivered = async (childId: ConversationId): Promise<void> => {
    await harness().commit(async (tx) => {
      const doc = await tx.doc(Subagents, childId)
      if (doc.record?.delegation?.background !== true) return
      doc.record.delegation.deliveredAt = Date.now()
    }, CTX)
  }

  /** 注入一次已结算的结果，并在子会话记录上标记委派已送达。 */
  const settleOne = async (input: SubagentSettlementInput, outcome: Omit<SettlementOutcome, 'requestId' | 'label' | 'childId'>): Promise<void> => {
    await settleBackground(input.parent, { requestId: input.settleRequestId, label: input.label, childId: String(input.child), ...outcome })
    await markDelivered(input.child)
  }

  /**
   * 功能：为一个后台委派布防结算。刻意分离执行：工具调用已经返回。
   * @param input 委派信息（父/子会话、结算 requestId、标签）
   * @returns 无返回；失败静默（结算可由启动对账兜底）
   * 内部逻辑：子会话从运行时侧监听——这里创建的 watch 能活过工具调用，
   * 工具 `api` 交出的任何东西都不行；在途 promise 记入 inFlight 供 drain 等待。
   */
  const settleWhenAnswered = (input: SubagentSettlementInput): void => {
    const pending = armSettlement(input).catch(() => undefined)
    inFlight.add(pending)
    void pending.then(() => { inFlight.delete(pending) })
  }

  /**
   * 功能：监听子会话直到其首次运行结束，然后结算。
   * @param input 委派信息
   * @returns 无返回；监听在结算或子会话消失后停止
   * 内部逻辑：watch 只负责标记时机，答案从运行时级上下文读取（watch 视图带原始
   * 条目而非消息）。空闲即有最终回答 → 结算完成；运行过但没说话 → 等 400ms 重读
   * 一次（运行结束的发布可能先于答案条目可读）后按失败结算；从未显示运行的空闲
   * 子会话视为任务尚未开始，继续监听。
   */
  const armSettlement = async (input: SubagentSettlementInput): Promise<void> => {
    const conversation = await harness().conversation(input.child, CTX)
    if (conversation === undefined) return
    const watch = await conversation.watch(CTX)
    let settledNow = false
    let sawRun = false
    // watch 只标记时机；答案从运行时级上下文读取，它反映已提交的记录
    //（watch 视图携带的是原始条目而非消息）。
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
      // 运行开始又结束但什么都没说：报告失败。运行结束的发布可能先于答案条目
      // 可读落地，因此失败的判定先等一拍再重读；从未显示运行的空闲子会话是
      // 尚未开始的任务，继续监听。
      if (sawRun) {
        await delay(400)
        const late = await finalChildAnswer(input.child)
        if (settledNow) return
        settledNow = true
        await watch.stop().catch(() => undefined)
        await settleOne(input, late !== '' ? { status: 'completed', body: late } : { status: 'failed', body: '后台运行结束，未返回答复' })
      }
    }
    void check().catch(() => undefined)
    // harness 关闭后（运行时拆除）到来的 watch 事件不得以 rejection 浮出。
    watch.start(() => check().catch(() => undefined))
  }

  /** 子会话最后一条助手回答；没有（仍在运行或什么都没说）时返回 ''。 */
  const finalChildAnswer = async (childId: ConversationId): Promise<string> => {
    const conversation = await harness().conversation(childId, CTX)
    if (conversation === undefined) return ''
    const view = await conversation.context(CTX)
    return answerText(view.contributions.flat())
  }

  /**
   * 功能：重新投递所有因崩溃而丢失结算的后台委派。
   * @returns 无返回；单条记录畸形静默跳过
   * 内部逻辑：分页扫描全部会话，找未送达的委派记录；子会话已有最终回答的立即
   * 结算（其余等下一次对账）。结算 request id 的回执检查保证已送达的消息不会
   * 被注入两次。
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
          // 一条畸形记录不得阻止其余委派继续被结算。
        }
      }
      cursor = page.next
    } while (cursor)
  }

  /** 等待在途结算落地，有界等待保证运行时关闭不会挂在单个结算上。 */
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
