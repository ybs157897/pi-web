import type { ChatMessage, InteractionRequest } from '../shared/types.ts'

/** 计划预览展示的 Markdown，外加 DSH 用作文档标题的标题行。 */
export interface PlanDocument {
  readonly markdown: string
  readonly title?: string
  /** 提交身份（host `plan.ts:13-15`），用于判定唯一一次的自动打开。 */
  readonly key?: string
  /** 该计划仍在等用户决策时为 true（`PlanCard.tsx:72-80`）。 */
  readonly pending?: boolean
}

/**
 * 功能：取计划的第一个一级标题——与 DSH 从已提交计划推导出的标题一致
 * （`packages/client/ui-plan/src/client/plan.ts:46-47`）。
 * @param markdown 计划全文
 * @returns 标题文本；没有 `# ` 行或标题为空时 undefined
 */
export function planTitle(markdown: string): string | undefined {
  const heading = markdown.split(/\r?\n/u).map(line => line.trim()).find(line => line.startsWith('# '))
  const title = heading?.slice(2).trim()
  return title === undefined || title === '' ? undefined : title
}

/**
 * 功能：汇总本会话提交过的所有计划（新的在前），即状态面板的计划目录。
 * @param interactions 会话的 plan-review 交互请求（可能 undefined）
 * @param messages 会话消息
 * @returns PlanDocument 数组，最新的 pending 标记会被保留以标出待决问题
 * 内部逻辑：持久来源是 transcript 里的 `exit_plan_mode` 调用；调用行被压缩掉的 plan-review 交互仍带计划全文，补充在 transcript 行之后。按正文去重（相同计划保留最新时间戳），按时间倒序输出。
 */
export function sessionPlans(
  interactions: readonly InteractionRequest[] | undefined,
  messages: readonly ChatMessage[],
): PlanDocument[] {
  const latest = latestPlan(interactions, messages)
  const byMarkdown = new Map<string, { plan: PlanDocument; timestamp: number }>()
  const add = (markdown: string, key: string | undefined, timestamp: number): void => {
    const text = markdown.trim()
    if (text === '') return
    const existing = byMarkdown.get(text)
    if (existing !== undefined) {
      existing.timestamp = Math.max(existing.timestamp, timestamp)
      return
    }
    const title = planTitle(text)
    byMarkdown.set(text, {
      timestamp,
      plan: { markdown: text, ...(title === undefined ? {} : { title }), ...(key === undefined ? {} : { key }) },
    })
  }
  for (const message of messages) {
    if (message.role !== 'assistant') continue
    for (const block of message.blocks) {
      if (block.type !== 'toolCall' || block.name.toLocaleLowerCase() !== 'exit_plan_mode') continue
      const value = block.arguments.plan
      if (typeof value === 'string') add(value, block.id, message.timestamp)
    }
  }
  // 调用行被压缩掉的评审交互仍指名自己的计划；时间戳决定排序。
  for (const interaction of interactions ?? []) {
    if (interaction.kind !== 'plan-review' || typeof interaction.detail !== 'string') continue
    add(interaction.detail, interaction.id, interaction.createdAt)
  }
  const plans = [...byMarkdown.values()].sort((left, right) => right.timestamp - left.timestamp).map(entry => entry.plan)
  if (latest?.pending === true) {
    const index = plans.findIndex(plan => plan.markdown.trim() === latest.markdown.trim())
    if (index >= 0) plans[index] = { ...plans[index]!, pending: true }
  }
  return plans
}

/**
 * 功能：取一个会话的最新计划。DSH 从会话日志读不可变计划（`plan.ts:32-48`、
 * `plan-resource.ts:37-82`）；Pi 把两个来源合成一份：投影出的 plan-review 交互
 * （最新提交胜出，包括被取代的）优先，transcript 里仍存在的最后一个
 * `exit_plan_mode` 调用做兜底。
 * @param interactions 会话的交互请求（可能 undefined）
 * @param messages 会话消息
 * @returns 最新 PlanDocument；interaction 来源带 pending 标记，transcript 兜底恒为 false；都没有则 undefined
 */
export function latestPlan(
  interactions: readonly InteractionRequest[] | undefined,
  messages: readonly ChatMessage[],
): PlanDocument | undefined {
  let newest: InteractionRequest | undefined
  for (const interaction of interactions ?? []) {
    if (interaction.kind !== 'plan-review') continue
    if (typeof interaction.detail !== 'string' || interaction.detail.trim() === '') continue
    if (newest === undefined || interaction.createdAt >= newest.createdAt) newest = interaction
  }
  if (newest?.detail !== undefined) {
    const title = planTitle(newest.detail)
    return {
      markdown: newest.detail,
      ...(title === undefined ? {} : { title }),
      key: newest.id,
      pending: newest.status === 'pending',
    }
  }
  // transcript 兜底倒着走，保证最后提交的计划胜出。
  for (let messageIndex = messages.length - 1; messageIndex >= 0; messageIndex -= 1) {
    const message = messages[messageIndex]
    if (message?.role !== 'assistant') continue
    for (let blockIndex = message.blocks.length - 1; blockIndex >= 0; blockIndex -= 1) {
      const block = message.blocks[blockIndex]
      if (block?.type !== 'toolCall' || block.name.toLocaleLowerCase() !== 'exit_plan_mode') continue
      const value = block.arguments.plan
      if (typeof value !== 'string' || value.trim() === '') continue
      const title = planTitle(value)
      return { markdown: value, ...(title === undefined ? {} : { title }), key: block.id, pending: false }
    }
  }
  return undefined
}
