/** Browser-facing values. Provider credentials never enter this protocol. */
export type ThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'
export type AccessMode = 'readOnly' | 'workspaceWrite' | 'fullAccess'
export type MessageStatus = 'running' | 'completed' | 'error' | 'cancelled'

/** Commands with user-configurable keyboard bindings. Shared by the browser and persisted settings validators. */
export const SHORTCUT_COMMANDS = [
  'newConversation', 'search', 'settings', 'toggleSidebar', 'rename', 'fork', 'archive', 'send', 'newline', 'alternateSend',
] as const
export type ShortcutCommand = typeof SHORTCUT_COMMANDS[number]

export interface ModelRef { provider: string; modelId: string }
export interface ModelOption extends ModelRef { name: string; reasoning: boolean; available: boolean; contextWindow?: number; thinkingLevels?: ThinkingLevel[] }
export interface ProviderSummary {
  id: string
  name: string
  configured: boolean
  custom: boolean
  source: 'builtin' | 'pi' | 'project'
  baseUrl?: string
  /** Environment variables this provider consults for authentication, in its own resolution order. Names only, never values. */
  envVars?: string[]
  /** The subset of `envVars` present in the server environment. */
  envConfigured?: string[]
  /** A credential for this provider is stored in auth.json. */
  storedCredential?: boolean
}
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
  /** Empty means "provider default": models keep their own resolved endpoint. */
  baseUrl?: string
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
  /** Catalog this provider ships with, offered as "restore default models". */
  defaults?: ProviderModelInput[]
}
export interface ProviderTestResult {
  providerId: string
  modelId: string
  status: 'connected' | 'failed'
  checkedAt: number
  message?: string
}
export interface ModelCatalog { models: ModelOption[]; providers: ProviderSummary[]; defaultModel?: ModelRef; thinkingLevels: ThinkingLevel[] }

/** Work-details presentation modes, mirroring DSH's four-step choice. */
export const TRANSCRIPT_VIEW_MODES = ['compact', 'standard', 'detailed', 'verbose'] as const
export type TranscriptViewMode = typeof TRANSCRIPT_VIEW_MODES[number]
/** When a completed turn returns to its historical presentation. */
export const COLLAPSE_TIMINGS = ['completion', 'next-input'] as const
export type CollapseTiming = typeof COLLAPSE_TIMINGS[number]
/** Detail level for composer statistics and completed-turn usage. */
export const PERFORMANCE_USAGE_MODES = ['compact', 'detailed'] as const
export type PerformanceUsageMode = typeof PERFORMANCE_USAGE_MODES[number]
/**
 * Pi's code-mode presentation: `off` installs nothing, `on` offers `codemode` beside the
 * native tools, `only` offers the model just `codemode` and reaches every other tool from a
 * script. Mirrors the coding agent's `codemode.mode` / MCP exposure.
 */
export const CODEMODE_MODES = ['off', 'on', 'only'] as const
export type CodemodeMode = typeof CODEMODE_MODES[number]

export interface AppSettings {
  theme: 'system' | 'light' | 'dark'
  locale: 'zh' | 'en'
  fontSize: number
  codeFontSize: number
  terminalFontSize: number
  transcriptView: TranscriptViewMode
  collapseTiming: CollapseTiming
  performanceUsage: PerformanceUsageMode
  codingViews: boolean
  busySendMode: 'followUp' | 'steer'
  defaultModel?: ModelRef
  /**
   * Models this project may use: `provider/modelId` entries, or `provider/prefix*`
   * prefix patterns. Empty means no filtering. Only affects this project's model
   * directory and selection; the Pi configuration is never rewritten.
   */
  modelAllowlist: string[]
  defaultThinkingLevel: ThinkingLevel
  defaultAccessMode: AccessMode
  /** Pi code mode for agents built from these settings; `only` hides the native tools from the model. */
  codemodeMode: CodemodeMode
  defaultPresetId?: string
  defaultWorkspaceId?: string
  shortcuts?: Partial<Record<ShortcutCommand, string>>
}
export type UpdateAppSettingsInput = Omit<Partial<AppSettings>, 'defaultModel' | 'defaultPresetId' | 'defaultWorkspaceId' | 'shortcuts'> & {
  defaultModel?: ModelRef | null
  defaultPresetId?: string | null
  defaultWorkspaceId?: string | null
  shortcuts?: AppSettings['shortcuts'] | null
}

/** How one MCP server's tools reach the model, matching Pi's `exposure` vocabulary. */
export const MCP_EXPOSURES = ['codemode', 'deferred', 'direct', 'hidden'] as const
export type McpExposure = typeof MCP_EXPOSURES[number]
export interface McpToolView { name: string; title?: string; description?: string; exposure: McpExposure }
/**
 * One server in the user-level `mcp.json` this runtime imported (read-only). The browser never
 * receives credentials: `headers`/`env` stay on the server and only a boolean connection state
 * plus the tool catalog cross the protocol.
 */
export interface McpServerView {
  name: string
  transport: 'stdio' | 'http'
  enabled: boolean
  description?: string
  exposure: McpExposure
  status: 'connected' | 'error' | 'disabled'
  tools: McpToolView[]
  error?: string
}
/** The Pi MCP configuration as the browser sees it. */
export interface McpView {
  /** Absolute path of the user-level Pi MCP file the runtime imported. */
  configPath: string
  /** False when the file does not exist; the catalog is then empty. */
  configExists: boolean
  servers: McpServerView[]
  /** File-level problem (invalid JSON or entries): the runtime stays up and the catalog is empty. */
  error?: string
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

/** `branch` when HEAD points at a local branch, `detached` for a bare commit (ZCode `GitHeadRefType`). */
export type GitHeadRefType = 'branch' | 'detached'
export interface GitLocalBranch {
  name: string
  isCurrent: boolean
  upstreamName: string | null
  commitHash: string | null
  commitTimestampMs: number | null
}
/** One repository snapshot: the local branches plus where HEAD currently points. */
export interface GitBranchSnapshot {
  isGitAvailable: boolean
  isRepository: boolean
  repoRoot: string | null
  headRefType: GitHeadRefType
  currentBranchName: string | null
  branches: GitLocalBranch[]
}
/** ZCode's branch-blocking vocabulary (`packages/shared/src/git.ts`), minus the codes pi cannot reach. */
export type GitBranchIssueCode =
  | 'invalid-branch-name'
  | 'branch-already-exists'
  | 'target-branch-not-found'
  | 'tracked-changes-would-be-overwritten'
  | 'untracked-changes-would-be-overwritten'
  | 'conflicts-present'
  | 'operation-in-progress'
  | 'branch-in-other-worktree'
  | 'not-a-repository'
  | 'unknown'
export interface GitBranchIssue {
  code: GitBranchIssueCode
  message: string
  /** Workspace-relative files Git named as blocking the switch. */
  paths?: string[]
  detail?: string | null
}
export interface GitBranchMutation {
  ok: boolean
  action: 'switch' | 'create-and-switch'
  branchName: string | null
  didChange: boolean
  created: boolean
  snapshot: GitBranchSnapshot
  issues: GitBranchIssue[]
}
export interface SwitchGitBranchInput { branchName: string }
export interface CreateGitBranchInput { branchName: string }

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

export interface DirectoryEntry { name: string; path: string; hidden: boolean }
export interface DirectoryListing {
  path: string
  home: string
  crumbs: Array<{ name: string; path: string }>
  entries: DirectoryEntry[]
  truncated: boolean
}
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
  /** DSH's session origin: `subagent` marks a conversation another conversation's task created. */
  origin?: 'subagent'
  /** The parent conversation of a subagent session; the owner edge the control routes check. */
  parentId?: string
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
  /** Stable identity for host status rows, so the client can coordinate them with live state. */
  systemKind?: 'compaction' | 'reset'
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
export interface CompactionView {
  /** True while at least one compaction task is running. */
  running: boolean
  reason?: 'manual' | 'threshold' | 'overflow'
  /** A blocking compaction is one the next generation waits for. */
  blocking?: boolean
  attempt?: number
  /** Newest failure since the last placed summary, when there is one. */
  failure?: string
}

export interface ConversationDetail {
  conversation: ConversationSummary
  messages: ChatMessage[]
  queue: QueueItem[]
  /** Latest `todo_write` snapshot; null means the list was cleared without a new write. */
  todos?: TodoItem[] | null
  /** Question calls paired with their late answers, oldest first. */
  interactions?: InteractionRequest[]
  /** Current goal snapshot; null when the conversation has none. */
  goal?: GoalView | null
  /** Plan mode state; a conversation without the document projects as `{ active: false }`. */
  plan?: PlanView
  /** Direct subagent conversations, oldest first; absent when this conversation delegated nothing. */
  subagents?: SubagentSummary[]
  /** The agent team this conversation leads (or belongs to); absent until it has a teammate or task. */
  team?: TeamView
  compaction?: CompactionView
  error?: string
  usage?: { input: number; output: number; totalCost: number }
}
/** One direct child conversation: DSH's `subagentCatalog` row plus the child's latest answer. */
export type SubagentSummary = {
  id: string
  /** Delegation label recorded when the child was created; falls back to its title. */
  label: string
  title: string
  /** `running` while the child has a live run, `inactive` otherwise — DSH's `list_agents` vocabulary. */
  status: 'running' | 'inactive'
  /** Collapsed latest assistant text; empty when the child has not answered yet. */
  answer: string
  /**
   * The child's cumulative spend, summed over its `pi.usage` buckets. DSH sums the same four
   * disjoint provider buckets (`SubagentHeaderLineage.tsx:67-75`); Pi's `totalTokens` already
   * equals input + output + cacheRead + cacheWrite, so summing it is the same caliber.
   */
  tokens?: number
  /**
   * Total active time: the sum of the child's finished run durations plus the elapsed part of a
   * live run. Idle gaps between runs are not counted (DSH's `settledMs` + `active` interval).
   */
  durationMs?: number
  /**
   * Server time at which `tokens` / `durationMs` were sampled. While the child runs, the panel
   * advances `durationMs` by `now - metricsAt` on each one-second tick, mirroring DSH's
   * `settledMs + (now - active.since)` (`SubagentHeaderLineage.tsx:77-90`).
   */
  metricsAt?: number
  createdAt: number
  updatedAt: number
}
export type ChildMessageInput = { text: string; requestId: string }
/** DSH's durable teammate lifecycle; `active` rows carry the live turn status. */
export type TeamMemberPhase = 'provisioning' | 'active' | 'failed'
export type TeamMemberStatus = 'running' | 'inactive' | 'provisioning' | 'failed'
/** One roster row: the synthetic `lead` row plus every durable teammate. */
export type TeamMemberView = {
  name: string
  role: 'lead' | 'teammate'
  phase: TeamMemberPhase
  status: TeamMemberStatus
  /** The member's conversation, which the panel opens. */
  conversationId?: string
  label?: string
  /** `provider/modelId` of the model the member's child conversation runs. */
  model?: string
  error?: string
}
export type TeamTaskStatus = 'pending' | 'in_progress' | 'completed' | 'deleted'
/** DSH's `TeamTaskView`, plus the durable timestamps the panel orders by. */
export type TeamTaskView = {
  id: string
  revision: number
  subject: string
  description: string
  status: TeamTaskStatus
  ownerName?: string
  blockedBy: string[]
  writeScopes: string[]
  /** Pending and every blocker completed: the task the model may claim. */
  ready: boolean
  /** Pending but at least one blocker is unfinished. */
  blocked: boolean
  /** Advisory overlaps with other in-progress tasks, never a lock (DSH: `writeScopeWarnings`). */
  writeScopeWarnings: string[]
  createdAt: number
  updatedAt: number
}
export type TeamView = { members: TeamMemberView[]; tasks: TeamTaskView[] }
/** Plan mode as the browser sees it; the switch is a write, so the projected value is read-only. */
export type PlanView = { active: boolean }
export type GoalPhase = 'active' | 'paused' | 'blocked' | 'complete'
export type GoalView = {
  id: string
  revision: number
  objective: string
  phase: GoalPhase
  maxGoalRounds: number
  roundsStarted: number
  blockedReason?: string
  createdAt: number
  updatedAt: number
}
export type GoalUpdateRequest = {
  action: 'create' | 'edit' | 'pause' | 'resume' | 'complete' | 'clear'
  objective?: string
  maxGoalRounds?: number
  blockedReason?: string
}
export type TodoStatus = 'pending' | 'in_progress' | 'completed'
/** Type aliases, not interfaces: they must satisfy Pi's `JsonValue` index-signature constraint. */
export type TodoItem = { content: string; status: TodoStatus }
export type InteractionKind = 'question' | 'plan-review' | 'approval'
export type InteractionStatus = 'pending' | 'continued' | 'answered' | 'expired' | 'cancelled'
export type AskUserQuestionOption = { label: string; description?: string }
export type AskUserQuestionItem = { id: string; header?: string; question: string; options?: AskUserQuestionOption[]; multiSelect?: boolean }
export type AskUserQuestionAnswerItem = { id: string; selected: string[]; custom?: string }
export type InteractionRequest = {
  /** The tool call id that asked; also the answer route's idempotency key. */
  id: string
  kind: InteractionKind
  status: InteractionStatus
  questions?: AskUserQuestionItem[]
  /** Plan markdown or approval body for the non-question kinds. */
  detail?: string
  approveLabel?: string
  /** Plan reviews only: true approved the plan, false asked for changes. */
  approved?: boolean
  /** Plan reviews only: what the user wants changed, echoed to the model. */
  feedback?: string
  answer?: { answers: AskUserQuestionAnswerItem[] }
  createdAt: number
  answeredAt?: number
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
