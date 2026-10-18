/** Browser-facing values. Provider credentials never enter this protocol. */
export type ThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'
export type AccessMode = 'readOnly' | 'workspaceWrite' | 'fullAccess'
export type MessageStatus = 'running' | 'completed' | 'error' | 'cancelled'

export interface ModelRef { provider: string; modelId: string }
export interface ModelOption extends ModelRef { name: string; reasoning: boolean; available: boolean; contextWindow?: number; thinkingLevels?: ThinkingLevel[] }
export interface ProviderSummary { id: string; name: string; configured: boolean; custom: boolean; source: 'builtin' | 'pi' | 'project'; baseUrl?: string }
export interface ProviderModelInput {
  id: string
  name: string
  reasoning?: boolean
  contextWindow?: number
  api?: string
  baseUrl?: string
  input?: Array<'text' | 'image'>
  maxTokens?: number
  type?: string
  headers?: Record<string, string>
  compat?: Record<string, unknown>
  cost?: Record<string, unknown>
  inputLimits?: Record<string, unknown>
  thinkingLevelMap?: Record<string, unknown>
  promptCache?: Record<string, unknown>
  samplingParams?: Record<string, unknown>
  samplingParamsByThinkingLevel?: Record<string, unknown>
  [key: string]: unknown
}
export interface ProviderInput {
  id: string
  name: string
  baseUrl: string
  apiKey?: string
  models: ProviderModelInput[]
  api?: string
  headers?: Record<string, string>
  compat?: Record<string, unknown>
}
export interface ProviderConfigSummary extends ProviderSummary {
  api: string
  models: ProviderModelInput[]
  headers?: Record<string, string>
  compat?: Record<string, unknown>
  credentialConfigured: boolean
}
export interface ProviderTestResult {
  providerId: string
  modelId: string
  status: 'connected' | 'failed'
  checkedAt: number
  message?: string
}
export interface ModelCatalog { models: ModelOption[]; providers: ProviderSummary[]; defaultModel?: ModelRef; thinkingLevels: ThinkingLevel[] }

export interface AppSettings {
  theme: 'system' | 'light' | 'dark'
  locale: 'zh' | 'en'
  fontSize: number
  codeFontSize: number
  terminalFontSize: number
  processDisplay: 'detailed' | 'compact'
  collapseProcess: 'afterResponse' | 'always' | 'never'
  codingViews: boolean
  busySendMode: 'followUp' | 'steer'
  defaultModel?: ModelRef
  defaultThinkingLevel: ThinkingLevel
  defaultAccessMode: AccessMode
  defaultPresetId?: string
  defaultWorkspaceId?: string
  shortcuts?: Partial<Record<'newConversation' | 'search' | 'settings' | 'toggleSidebar' | 'send' | 'newline' | 'alternateSend', string>>
}
export type UpdateAppSettingsInput = Omit<Partial<AppSettings>, 'defaultModel' | 'defaultPresetId' | 'defaultWorkspaceId' | 'shortcuts'> & {
  defaultModel?: ModelRef | null
  defaultPresetId?: string | null
  defaultWorkspaceId?: string | null
  shortcuts?: AppSettings['shortcuts'] | null
}

export interface WorkspaceSummary { id: string; name: string; path: string; createdAt: number; updatedAt: number }
export interface WorkspaceFileEntry { name: string; path: string; type: 'file' | 'directory'; size?: number; modifiedAt?: number; mimeType?: string }
export interface WorkspaceFile {
  path: string
  kind: 'text' | 'image' | 'binary'
  mimeType: string
  size: number
  modifiedAt: number
  content?: string
  data?: string
}
export interface AddWorkspaceInput { path: string; name?: string }
export interface RenameWorkspaceInput { name: string }

export interface PluginToolSummary { name: string; description?: string; enabled: boolean }
export interface PluginSummary { id: string; name: string; description?: string; builtin: boolean; enabled: boolean; tools: PluginToolSummary[] }
export interface UpdatePluginInput { enabled?: boolean; tools?: Record<string, boolean> }
export interface AgentPreset {
  id: string
  name: string
  description?: string
  instructions: string
  extensions: string[]
  tools: string[]
  model?: ModelRef
  thinkingLevel?: ThinkingLevel
  accessMode: AccessMode
}
export type CreateAgentPresetInput = Omit<AgentPreset, 'id'> & { id?: string }
export type UpdateAgentPresetInput = Partial<Omit<AgentPreset, 'id'>>

export interface AutomationRun {
  id: string
  status: 'running' | 'completed' | 'failed' | 'interrupted'
  conversationId?: string
  startedAt: number
  finishedAt?: number
  error?: string
}
export interface Automation {
  id: string
  name: string
  prompt: string
  enabled: boolean
  intervalMs?: number
  nextRunAt?: number
  createdAt: number
  updatedAt: number
  lastRun?: AutomationRun
  model?: ModelRef
  workspaceId?: string
  presetId?: string
}
export type CreateAutomationInput = Pick<Automation, 'name' | 'prompt'> & Partial<Pick<Automation, 'enabled' | 'intervalMs'>> & {
  model?: ModelRef
  workspaceId?: string
  presetId?: string
}
export type UpdateAutomationInput = Omit<Partial<CreateAutomationInput>, 'intervalMs'> & { intervalMs?: number | null }

export interface ConversationSummary {
  id: string
  title: string
  createdAt: number
  updatedAt: number
  archived: boolean
  pinned: boolean
  busy: boolean
  model?: ModelRef
  thinkingLevel: ThinkingLevel
  cwd: string
  workspaceId?: string
  presetId?: string
  accessMode?: AccessMode
  runId?: string
  runStartedAt?: number
  durationMs?: number
  status?: MessageStatus
}

export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'thinking'; text: string; redacted?: boolean }
  | { type: 'image'; url: string; mimeType: string }
  | { type: 'file'; name: string; path: string; mimeType: string; size: number }
  | { type: 'toolCall'; id: string; name: string; arguments: Record<string, unknown> }
export interface MessageUsage {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  totalTokens: number
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number }
}
export interface FileArtifact {
  kind: 'read' | 'write' | 'edit' | 'nativeEdit'
  path: string
  before?: string
  after?: string
  diff?: string
  lineStart?: number
  lineEnd?: number
}
export interface ChatMessage {
  id: string
  entryId?: string
  role: 'user' | 'assistant' | 'tool' | 'system'
  blocks: ContentBlock[]
  streaming?: boolean
  timestamp: number
  toolCallId?: string
  parentToolCallId?: string
  toolName?: string
  isError?: boolean
  details?: unknown
  requestId?: string
  runId?: string
  durationMs?: number
  status?: MessageStatus
  usage?: MessageUsage
  artifacts?: FileArtifact[]
  feedback?: 'up' | 'down' | null
}
export interface QueueItem {
  id: string
  text: string
  mode: 'steer' | 'followUp'
  createdAt: number
  images?: Array<{ data: string; mimeType: string }>
  files?: Array<{ name: string; mimeType: string; size: number; path: string }>
}
export interface ConversationDetail {
  conversation: ConversationSummary
  messages: ChatMessage[]
  queue: QueueItem[]
  error?: string
  usage?: { input: number; output: number; totalCost: number }
}
export interface SubmitInput {
  text: string
  requestId: string
  whenBusy?: 'steer' | 'followUp' | 'reject'
  images?: Array<{ data: string; mimeType: string }>
  files?: Array<{ name: string; mimeType: string; data: string }>
}
export interface CreateConversationInput {
  title?: string
  model?: ModelRef
  thinkingLevel?: ThinkingLevel
  workspaceId?: string
  presetId?: string
  accessMode?: AccessMode
}
export interface UpdateConversationInput {
  title?: string
  archived?: boolean
  pinned?: boolean
  model?: ModelRef
  thinkingLevel?: ThinkingLevel
  workspaceId?: string
  presetId?: string | null
  accessMode?: AccessMode
}
export interface EditQueueInput extends SubmitInput { whenBusy: 'steer' | 'followUp' }
export type QueueActionInput = EditQueueInput
export interface RetryInput { entryId: string; requestId: string }
export interface RetryResult { conversationId: string; submissionId: string }
export interface FeedbackInput { entryId: string; rating: 'up' | 'down' | null }
export interface ApiError { error: string; code?: string }
