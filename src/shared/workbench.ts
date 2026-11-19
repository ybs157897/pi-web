import type { AccessMode, ConversationDetail, ModelRef, SubmitInput, ThinkingLevel } from './types.ts'
import type { ConversationFailure } from './conversation-failure.ts'

export type WorkItemType = 'build' | 'investigate' | 'decide'
export type WorkItemStatus = 'clarifying' | 'ready' | 'running' | 'pending_review' | 'needs_human' | 'ended'

export type WorkItemWaitingOn = {
  kind: 'lead' | 'dependencies' | 'scheduler' | 'agent' | 'human' | 'none'
  detail?: string
}

export type WorkItemEvidence = {
  kind: 'validation' | 'artifact' | 'response'
  label: string
  status: 'passed' | 'failed' | 'recorded' | 'insufficient'
  path?: string
  entryId?: string
}

export type WorkItem = {
  id: string
  requestId: string
  workspaceId: string
  parentId: string
  childId?: string
  title: string
  objective: string
  constraints: string[]
  acceptance: string[]
  type: WorkItemType
  status: WorkItemStatus
  waitingOn: WorkItemWaitingOn
  /** 对应 WorkbenchAgent.id。 */
  assignee: string
  /** 本轮启用的访问权限。工作项就绪时为待启动的预计权限。 */
  accessMode?: AccessMode
  /** 有专用续聊限制时设置，否则使用 Bot 的当前有效权限。 */
  replyAccessMode?: AccessMode
  dependencies: string[]
  evidence: WorkItemEvidence[]
  verification: 'pending' | 'recorded' | 'insufficient' | 'failed'
  attempt: number
  outcome?: { summary: string; decision?: 'accepted' | 'revise'; at: number }
  error?: string
  failure?: ConversationFailure
  createdAt: number
  updatedAt: number
}

export const WORKBENCH_BOT_ICONS = ['bot', 'activity', 'database', 'clock', 'sparkles', 'code', 'search', 'book', 'chart', 'shield', 'palette'] as const
export type WorkbenchBotIcon = typeof WORKBENCH_BOT_ICONS[number]

export type CreateWorkbenchBotInput = {
  name: string
  role?: string
  description?: string
  instructions?: string
  model?: ModelRef | null
  accessMode?: AccessMode
  /** null or omitted means all available skills. An empty array enables none. */
  skillIds?: string[] | null
  icon?: WorkbenchBotIcon
}

export type UpdateWorkbenchBotInput = Partial<CreateWorkbenchBotInput>

export type WorkbenchBotConfig = {
  instructions: string
  model?: ModelRef
  accessMode: AccessMode
  skillIds: string[] | null
  icon: WorkbenchBotIcon
  origin: 'builtin' | 'user' | 'agent'
}

export type WorkbenchAgent = {
  id: string
  name: string
  role: string
  description: string
  status: 'idle' | 'running'
  conversationId?: string
  model?: ModelRef
  /** 按当前 Bot 配置和平台能力，新对话可使用的权限。 */
  accessMode?: AccessMode
  skills: string[]
  config?: WorkbenchBotConfig
}

export type WorkbenchMessage = {
  requestId: string
  text: string
  mention?: string
  at: number
  createdBotId?: string
  error?: string
  failure?: ConversationFailure
  failureAttempt?: number
}

export type WorkbenchView = {
  main: ConversationDetail
  items: WorkItem[]
  agents: WorkbenchAgent[]
  messages: WorkbenchMessage[]
}

export type WorkbenchSubmitInput = SubmitInput & {
  mention?: string
  model?: ModelRef
  thinkingLevel?: ThinkingLevel
  /** 本次派发及其重试的显式权限上限。 */
  accessMode?: AccessMode
}

export type WorkbenchReplyInput = SubmitInput & {
  model?: ModelRef
  thinkingLevel?: ThinkingLevel
}

export type WorkbenchRetryInput = {
  attempt: number
  model?: ModelRef
  thinkingLevel?: ThinkingLevel
} & ({ requestId: string } | { itemId: string })
