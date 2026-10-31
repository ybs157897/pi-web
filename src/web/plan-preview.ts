import type { ChatMessage, InteractionRequest } from '../shared/types.ts'

/** The Markdown a plan preview shows, plus the heading DSH uses as its document title. */
export interface PlanDocument {
  readonly markdown: string
  readonly title?: string
  /** Identity of the submission (`plan.ts:13-15`), used to decide the one automatic open. */
  readonly key?: string
  /** True while this plan is still waiting for the user's decision (`PlanCard.tsx:72-80`). */
  readonly pending?: boolean
}

/**
 * The plan's first level-1 heading, the same title DSH derives from a submitted plan
 * (`packages/client/ui-plan/src/client/plan.ts:46-47`).
 */
export function planTitle(markdown: string): string | undefined {
  const heading = markdown.split(/\r?\n/u).map(line => line.trim()).find(line => line.startsWith('# '))
  const title = heading?.slice(2).trim()
  return title === undefined || title === '' ? undefined : title
}

/**
 * Every plan this conversation has submitted, newest first — the status panel's plan directory.
 * The transcript's `exit_plan_mode` calls are the durable source; a plan-review interaction whose
 * call was compacted away still names its plan and is appended after the transcript rows. The
 * newest plan keeps the latest review's pending flag so the panel can mark the open question.
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
  // A review whose call was compacted away still names its plan; the timestamp decides the order.
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
 * The latest plan of one conversation. DSH reads the immutable plan out of the session log
 * (`plan.ts:32-48`, `plan-resource.ts:37-82`); Pi has the same two sources in one detail:
 * the projected plan-review interaction (newest submission wins, including superseded ones)
 * and, as a fallback, the last `exit_plan_mode` call still present in the transcript.
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
  // The transcript fallback walks backwards so the last submitted plan wins.
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
