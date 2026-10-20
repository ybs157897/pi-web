import type { GoalUpdateRequest } from '../shared/types.ts'
import type { SkillCatalog, SkillContent, SkillValidation } from '../shared/skills.ts'
import type {
  AddWorkspaceInput,
  AccessMode,
  AgentPreset,
  AppSettings,
  AskUserQuestionAnswerItem,
  Automation,
  ChildMessageInput,
  ConversationDetail,
  ConversationSummary,
  CreateAgentPresetInput,
  CreateAutomationInput,
  CreateConversationInput,
  CreateGitBranchInput,
  DirectoryListing,
  EditQueueInput,
  GitBranchMutation,
  GitBranchSnapshot,
  McpView,
  ModelCatalog,
  ProviderConfigSummary,
  ProviderInput,
  ProviderTestResult,
  RenameWorkspaceInput,
  SubmitInput,
  SubagentSummary,
  SwitchGitBranchInput,
  TeamView,
  UpdateAgentPresetInput,
  UpdateAppSettingsInput,
  UpdateAutomationInput,
  UpdateConversationInput,
  WorkspaceFile,
  WorkspaceFileEntry,
  WorkspaceSummary,
} from '../shared/types.ts'

/** Runtime operations used by HTTP and deterministic integration tests. */
export interface Runtime {
  list(): Promise<ConversationSummary[]>
  create(input: CreateConversationInput): Promise<ConversationDetail>
  detail(id: string): Promise<ConversationDetail>
  update(id: string, input: UpdateConversationInput): Promise<ConversationDetail>
  submit(id: string, input: SubmitInput): Promise<{ submissionId: string }>
  /** Answer one pending question call; settles the conversation document and steers the reply message. */
  answerInteraction(id: string, callId: string, answers: AskUserQuestionAnswerItem[]): Promise<ConversationDetail>
  /** Dismiss a pending question call without answering; steers the dismissal and settles it as cancelled. */
  cancelInteraction(id: string, callId: string): Promise<ConversationDetail>
  editQueued(id: string, submissionId: string, input: EditQueueInput): Promise<{ submissionId: string }>
  stop(id: string): Promise<void>
  compact(id: string): Promise<void>
  goal(id: string, input: GoalUpdateRequest): Promise<ConversationDetail>
  /** Turn plan mode on or off; approving a plan review turns it off as well. */
  setPlan(id: string, active: boolean): Promise<ConversationDetail>
  /** The agent team this conversation leads (or belongs to), as the panel reads it. */
  team(id: string): Promise<TeamView>
  /** Direct children of one conversation, oldest first (DSH's `subagentCatalog` / `list_agents`). */
  children(id: string): Promise<SubagentSummary[]>
  /** Deliver one follow-up message to a direct child; resolves with the refreshed children list. */
  childMessage(id: string, childId: string, input: ChildMessageInput): Promise<SubagentSummary[]>
  /** Stop a direct child's run; resolves with the refreshed children list. */
  childStop(id: string, childId: string): Promise<SubagentSummary[]>
  removeQueued(id: string, submissionId: string): Promise<void>
  fork(id: string, entryId: string): Promise<ConversationDetail>
  watch(id: string, listener: (value: ConversationDetail) => void): Promise<() => Promise<void>>
  catalog(): Promise<ModelCatalog>
  saveProvider(input: ProviderInput): Promise<void>
  provider(id: string): Promise<ProviderConfigSummary>
  deleteProvider(id: string): Promise<void>
  testProvider(id: string, modelId?: string): Promise<ProviderTestResult>
  discoverProvider(id: string): Promise<{ models: Array<{ id: string; name: string }> }>
  settings(): AppSettings
  /** The imported user-level Pi MCP configuration and each server's connection state. */
  mcp(): McpView
  capabilities(): { accessModes: AccessMode[] }
  updateSettings(input: UpdateAppSettingsInput): Promise<AppSettings>
  /** Open the persisted application configuration file with the host's default program. */
  openConfigFile(): Promise<void>
  workspaces(): WorkspaceSummary[]
  addWorkspace(input: AddWorkspaceInput): Promise<WorkspaceSummary>
  renameWorkspace(id: string, input: RenameWorkspaceInput): Promise<WorkspaceSummary>
  deleteWorkspace(id: string): Promise<void>
  /** Ask the operating system for a directory; null means the operator cancelled. */
  pickDirectory(signal?: AbortSignal): Promise<string | null>
  listDirectories(path?: string): Promise<DirectoryListing>
  createDirectory(parent: string, name: string): Promise<void>
  workspaceFiles(id: string, path: string, query?: string): Promise<WorkspaceFileEntry[]>
  searchWorkspace(id: string, query: string): Promise<WorkspaceFileEntry[]>
  workspaceFile(id: string, path: string): Promise<WorkspaceFile>
  workspaceAsset(id: string, path: string): Promise<{ mimeType: string; data: Uint8Array }>
  /** Local Git branches of one workspace, plus where HEAD currently points. */
  gitBranches(id: string): Promise<GitBranchSnapshot>
  /** Switch HEAD to an existing local branch; blocked switches come back as structured issues. */
  switchGitBranch(id: string, input: SwitchGitBranchInput): Promise<GitBranchMutation>
  /** Create a branch at HEAD and switch to it. */
  createGitBranch(id: string, input: CreateGitBranchInput): Promise<GitBranchMutation>
  skills(workspaceId: string): Promise<SkillCatalog>
  skill(workspaceId: string, skillId: string, resource?: string): Promise<SkillContent>
  validateSkill(workspaceId: string, skillId: string): Promise<SkillValidation>
  presets(): AgentPreset[]
  createPreset(input: CreateAgentPresetInput): Promise<AgentPreset>
  updatePreset(id: string, input: UpdateAgentPresetInput): Promise<AgentPreset>
  deletePreset(id: string): Promise<void>
  feedback(id: string, entryId: string, rating: 'up' | 'down' | null): Promise<void>
  /** Append operator feedback text to the application state. */
  sendFeedback(input: { text: string; userAgent?: string }): Promise<void>
  retry(id: string, entryId: string, requestId: string): Promise<{ conversationId: string; submissionId: string }>
  automations(): Automation[]
  createAutomation(input: CreateAutomationInput): Promise<Automation>
  updateAutomation(id: string, input: UpdateAutomationInput): Promise<Automation>
  deleteAutomation(id: string): Promise<void>
  runAutomation(id: string): Promise<{ automation: Automation; conversationId: string }>
  close(): Promise<void>
}
export interface RuntimeOptions { dataDir: string; workspace: string; piDir?: string; demo?: boolean; /** Override the imported Pi MCP file (tests and `PI_WEB_MCP_CONFIG`). */ mcpConfigPath?: string }
