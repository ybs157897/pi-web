import { defineDoc, type ConversationId } from '@earendil-works/pi-durable'

/** 子智能体档案：`general-purpose` 通用执行档（继承父会话工具集）或 `Explore` 只读检索档。 */
export type SubagentProfile = 'general-purpose' | 'Explore'

/**
 * 后台委派记录：子会话由某次后台委派产生时携带的回执信息。
 * 功能：委派方凭它向子会话投递后续消息、记录交付时间。
 */
export type SubagentDelegation = {
  background: true
  parent: ConversationId
  requestId: string
  deliveredAt?: number
}

/**
 * 子会话身份记录，存于每个任务拥有的一次性子会话的 Subagents 文档；旧记录无此字段也无需迁移。
 * 功能：标记子会话的标签、创建时间、档案与委派回执，供工具限制与目录展示读取。
 */
export type SubagentIdentity = {
  label: string
  createdAt: number
  profile?: SubagentProfile
  delegation?: SubagentDelegation
}

/** 子会话身份文档定义：每个会话一份（scope: conversation），fork 时不继承（取 initial），不参与 checkpoint。 */
export const Subagents = defineDoc<{ record: SubagentIdentity | null }>({
  kind: 'pi-web.subagent',
  version: 1,
  scope: 'conversation',
  history: 'latest',
  fork: 'initial', checkpointWhen: () => false,
  initial: () => ({ record: null }),
})

/** Explore 档案允许使用的只读检索工具白名单，被工具限制与 builtins 档案定义共同引用。 */
export const EXPLORE_TOOLS = ['read', 'glob', 'grep', 'list_files', 'search_files'] as const

/** 所有子会话一律禁用的工具（无论档案）：会改变父/委派方状态或产生递归委派的工具，以及团队任务与定时任务管理。 */
const CHILD_FORBIDDEN_TOOLS = new Set([
  'enter_plan_mode', 'exit_plan_mode', 'ask_user_question',
  'get_goal', 'create_goal', 'update_goal', 'subagent', 'spawn_teammate',
  'send_message', 'list_agents', 'wait_agent', 'interrupt_agent',
  'schedule_create', 'schedule_edit', 'schedule_list', 'schedule_view',
])

/**
 * 功能：判定某个子会话身份能否调用某工具；该限制同时作用于工具暴露（提示词渲染）与执行两处，含被恢复的旧子会话。
 * @param identity 子会话身份快照；null/undefined 表示非子会话（或旧记录），不做限制。
 * @param name 工具名。
 * @returns true 允许调用；false 拒绝（执行时抛错、渲染时过滤）。
 * 内部逻辑：非子会话直接放行；禁止清单命中或 team_task_ 前缀一律拒绝；Explore 档案仅放行 codemode 与 EXPLORE_TOOLS 白名单。
 */
export function subagentToolAllowed(identity: SubagentIdentity | null | undefined, name: string): boolean {
  if (!identity) return true
  if (CHILD_FORBIDDEN_TOOLS.has(name) || name.startsWith('team_task_')) return false
  return identity.profile !== 'Explore' || name === 'codemode' || EXPLORE_TOOLS.some(tool => tool === name)
}
