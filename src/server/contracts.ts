import type {
  AddWorkspaceInput,
  AccessMode,
  AgentPreset,
  AppSettings,
  Automation,
  ConversationDetail,
  ConversationSummary,
  CreateAgentPresetInput,
  CreateAutomationInput,
  CreateConversationInput,
  EditQueueInput,
  ModelCatalog,
  PluginSummary,
  ProviderConfigSummary,
  ProviderInput,
  ProviderTestResult,
  RenameWorkspaceInput,
  SubmitInput,
  UpdateAgentPresetInput,
  UpdateAppSettingsInput,
  UpdateAutomationInput,
  UpdateConversationInput,
  UpdatePluginInput,
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
  editQueued(id: string, submissionId: string, input: EditQueueInput): Promise<{ submissionId: string }>
  stop(id: string): Promise<void>
  removeQueued(id: string, submissionId: string): Promise<void>
  fork(id: string, entryId: string): Promise<ConversationDetail>
  watch(id: string, listener: (value: ConversationDetail) => void): Promise<() => Promise<void>>
  catalog(): Promise<ModelCatalog>
  saveProvider(input: ProviderInput): Promise<void>
  provider(id: string): Promise<ProviderConfigSummary>
  deleteProvider(id: string): Promise<void>
  testProvider(id: string, modelId?: string): Promise<ProviderTestResult>
  settings(): AppSettings
  capabilities(): { accessModes: AccessMode[] }
  updateSettings(input: UpdateAppSettingsInput): Promise<AppSettings>
  workspaces(): WorkspaceSummary[]
  addWorkspace(input: AddWorkspaceInput): Promise<WorkspaceSummary>
  renameWorkspace(id: string, input: RenameWorkspaceInput): Promise<WorkspaceSummary>
  workspaceFiles(id: string, path: string, query?: string): Promise<WorkspaceFileEntry[]>
  searchWorkspace(id: string, query: string): Promise<WorkspaceFileEntry[]>
  workspaceFile(id: string, path: string): Promise<WorkspaceFile>
  workspaceAsset(id: string, path: string): Promise<{ mimeType: string; data: Uint8Array }>
  plugins(): PluginSummary[]
  updatePlugin(id: string, input: UpdatePluginInput): Promise<PluginSummary>
  presets(): AgentPreset[]
  createPreset(input: CreateAgentPresetInput): Promise<AgentPreset>
  updatePreset(id: string, input: UpdateAgentPresetInput): Promise<AgentPreset>
  deletePreset(id: string): Promise<void>
  feedback(id: string, entryId: string, rating: 'up' | 'down' | null): Promise<void>
  retry(id: string, entryId: string, requestId: string): Promise<{ conversationId: string; submissionId: string }>
  automations(): Automation[]
  createAutomation(input: CreateAutomationInput): Promise<Automation>
  updateAutomation(id: string, input: UpdateAutomationInput): Promise<Automation>
  deleteAutomation(id: string): Promise<void>
  runAutomation(id: string): Promise<{ automation: Automation; conversationId: string }>
  close(): Promise<void>
}
export interface RuntimeOptions { dataDir: string; workspace: string; piDir?: string; demo?: boolean }
