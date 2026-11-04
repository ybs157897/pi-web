import { defineDoc, type ConversationId } from '@earendil-works/pi-durable'

export type SubagentProfile = 'general-purpose' | 'Explore'

export type SubagentDelegation = {
  background: true
  parent: ConversationId
  requestId: string
  deliveredAt?: number
}

/** Stored on task-owned one-shot children; older records need no migration. */
export type SubagentIdentity = {
  label: string
  createdAt: number
  profile?: SubagentProfile
  delegation?: SubagentDelegation
}

export const Subagents = defineDoc<{ record: SubagentIdentity | null }>({
  kind: 'pi-web.subagent',
  version: 1,
  scope: 'conversation',
  history: 'latest',
  fork: 'initial', checkpointWhen: () => false,
  initial: () => ({ record: null }),
})

export const EXPLORE_TOOLS = ['read', 'glob', 'grep', 'list_files', 'search_files'] as const

const CHILD_FORBIDDEN_TOOLS = new Set([
  'enter_plan_mode', 'exit_plan_mode', 'ask_user_question',
  'get_goal', 'create_goal', 'update_goal', 'subagent', 'spawn_teammate',
  'send_message', 'list_agents', 'wait_agent', 'interrupt_agent',
])

/** This restriction applies at both exposure and execution, including older resumed children. */
export function subagentToolAllowed(identity: SubagentIdentity | null | undefined, name: string): boolean {
  if (!identity) return true
  if (CHILD_FORBIDDEN_TOOLS.has(name) || name.startsWith('team_task_')) return false
  return identity.profile !== 'Explore' || name === 'codemode' || EXPLORE_TOOLS.some(tool => tool === name)
}
