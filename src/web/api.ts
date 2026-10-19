import type {
  AccessMode, AddWorkspaceInput, AgentPreset, AppSettings, AskUserQuestionAnswerItem, Automation, ChildMessageInput, ConversationDetail, ConversationSummary,
  CreateAgentPresetInput, CreateAutomationInput, CreateConversationInput, DirectoryListing, EditQueueInput, FeedbackInput, GoalUpdateRequest,
  ModelCatalog, PluginSummary, ProviderConfigSummary, ProviderInput, ProviderTestResult,
  RenameWorkspaceInput, SubmitInput, SubagentSummary, TeamView, UpdateAgentPresetInput, UpdateAutomationInput, UpdateConversationInput,
  UpdateAppSettingsInput, UpdatePluginInput, WorkspaceFile, WorkspaceFileEntry, WorkspaceSummary,
} from '../shared/types.ts'

export class ApiFailure extends Error {
  readonly code: string | undefined

  constructor(message: string, code?: string) {
    super(message)
    this.name = 'ApiFailure'
    this.code = code
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: {
      ...(init?.body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...init?.headers,
    },
  })
  let payload: unknown
  try {
    payload = await response.json()
  } catch {
    throw new ApiFailure(response.ok ? '服务器返回了无法读取的数据' : `请求失败（${response.status}）`)
  }
  if (!response.ok) {
    const body = isRecord(payload) ? payload : {}
    throw new ApiFailure(
      typeof body.error === 'string' ? body.error : `请求失败（${response.status}）`,
      typeof body.code === 'string' ? body.code : undefined,
    )
  }
  return payload as T
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export const api = {
  health(): Promise<{ ok: boolean; demo: boolean; version: string; user: string }> {
    return request('/api/health')
  },
  listDirectories(path?: string): Promise<DirectoryListing> {
    const query = path === undefined ? '' : `?${new URLSearchParams({ path }).toString()}`
    return request(`/api/directories${query}`)
  },
  createDirectory(path: string, name: string): Promise<{ ok: boolean }> {
    return request('/api/directories', { method: 'POST', body: JSON.stringify({ path, name }) })
  },
  async pickWorkspaceDirectory(): Promise<string | null> {
    const result = await request<{ path: string | null }>('/api/workspaces/pick', { method: 'POST' })
    return result.path
  },
  deleteWorkspace(id: string): Promise<{ ok: boolean }> {
    return request(`/api/workspaces/${encodeURIComponent(id)}`, { method: 'DELETE' })
  },
  async listConversations(): Promise<ConversationSummary[]> {
    const result = await request<{ conversations: ConversationSummary[] }>('/api/conversations')
    return result.conversations
  },
  createConversation(input: CreateConversationInput): Promise<ConversationDetail> {
    return request('/api/conversations', { method: 'POST', body: JSON.stringify(input) })
  },
  getConversation(id: string): Promise<ConversationDetail> {
    return request(`/api/conversations/${encodeURIComponent(id)}`)
  },
  updateConversation(id: string, input: UpdateConversationInput): Promise<ConversationDetail> {
    return request(`/api/conversations/${encodeURIComponent(id)}`, {
      method: 'PATCH', body: JSON.stringify(input),
    })
  },
  submit(id: string, input: SubmitInput): Promise<{ submissionId: string }> {
    return request(`/api/conversations/${encodeURIComponent(id)}/messages`, {
      method: 'POST', body: JSON.stringify(input),
    })
  },
  stop(id: string): Promise<{ ok: boolean }> {
    return request(`/api/conversations/${encodeURIComponent(id)}/stop`, { method: 'POST' })
  },
  /** Answer one pending question card; the response carries the projected detail after settlement. */
  answerInteraction(id: string, callId: string, answers: AskUserQuestionAnswerItem[]): Promise<ConversationDetail> {
    return request(`/api/conversations/${encodeURIComponent(id)}/interactions/${encodeURIComponent(callId)}/answer`, {
      method: 'POST', body: JSON.stringify({ answers }),
    })
  },
  /** Dismiss a pending question set; the response carries the detail with the row settled as cancelled. */
  cancelInteraction(id: string, callId: string): Promise<ConversationDetail> {
    return request(`/api/conversations/${encodeURIComponent(id)}/interactions/${encodeURIComponent(callId)}/cancel`, {
      method: 'POST',
    })
  },
  compact(id: string): Promise<{ ok: boolean }> {
    return request(`/api/conversations/${encodeURIComponent(id)}/compact`, { method: 'POST' })
  },
  updateGoal(id: string, input: GoalUpdateRequest): Promise<ConversationDetail> {
    return request(`/api/conversations/${encodeURIComponent(id)}/goal`, { method: 'POST', body: JSON.stringify(input) })
  },
  /** Turn plan mode on or off; the response is the projected conversation after the switch. */
  setPlan(id: string, active: boolean): Promise<ConversationDetail> {
    return request(`/api/conversations/${encodeURIComponent(id)}/plan`, { method: 'POST', body: JSON.stringify({ active }) })
  },
  /** The agent team of one conversation; the panel re-reads it while a member is running. */
  async getTeam(id: string): Promise<TeamView> {
    const result = await request<{ team: TeamView }>(`/api/conversations/${encodeURIComponent(id)}/team`)
    return result.team
  },
  /** Direct subagents of one conversation, oldest first. */
  async listChildren(id: string): Promise<SubagentSummary[]> {
    const result = await request<{ subagents: SubagentSummary[] }>(`/api/conversations/${encodeURIComponent(id)}/children`)
    return result.subagents
  },
  /** Send one follow-up message to a subagent; the response is its refreshed child list. */
  async childMessage(id: string, childId: string, input: ChildMessageInput): Promise<SubagentSummary[]> {
    const result = await request<{ subagents: SubagentSummary[] }>(
      `/api/conversations/${encodeURIComponent(id)}/children/${encodeURIComponent(childId)}/messages`,
      { method: 'POST', body: JSON.stringify(input) },
    )
    return result.subagents
  },
  /** Stop a running subagent; the response is its refreshed child list. */
  async childStop(id: string, childId: string): Promise<SubagentSummary[]> {
    const result = await request<{ subagents: SubagentSummary[] }>(
      `/api/conversations/${encodeURIComponent(id)}/children/${encodeURIComponent(childId)}/stop`,
      { method: 'POST' },
    )
    return result.subagents
  },
  removeQueued(id: string, submissionId: string): Promise<{ ok: boolean }> {
    return request(`/api/conversations/${encodeURIComponent(id)}/queue/${encodeURIComponent(submissionId)}`, {
      method: 'DELETE',
    })
  },
  fork(id: string, entryId: string): Promise<ConversationDetail> {
    return request(`/api/conversations/${encodeURIComponent(id)}/fork`, {
      method: 'POST', body: JSON.stringify({ entryId }),
    })
  },
  getModels(): Promise<ModelCatalog> {
    return request('/api/models')
  },
  getCapabilities(): Promise<{ accessModes: AccessMode[] }> {
    return request('/api/capabilities')
  },
  getSettings(): Promise<AppSettings> {
    return request('/api/settings')
  },
  updateSettings(patch: UpdateAppSettingsInput): Promise<AppSettings> {
    return request('/api/settings', { method: 'PATCH', body: JSON.stringify(patch) })
  },
  /** Open the local application configuration file with the system's default program. */
  openConfigFile(): Promise<{ ok: boolean }> {
    return request('/api/settings/open-config', { method: 'POST' })
  },
  listWorkspaces(): Promise<{ workspaces: WorkspaceSummary[] }> {
    return request('/api/workspaces')
  },
  createWorkspace(input: AddWorkspaceInput): Promise<{ workspace: WorkspaceSummary }> {
    return request('/api/workspaces', { method: 'POST', body: JSON.stringify(input) })
  },
  renameWorkspace(id: string, input: RenameWorkspaceInput): Promise<{ workspace: WorkspaceSummary }> {
    return request(`/api/workspaces/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(input) })
  },
  listWorkspaceFiles(id: string, path = ''): Promise<{ path: string; entries: WorkspaceFileEntry[] }> {
    const query = new URLSearchParams({ path })
    return request(`/api/workspaces/${encodeURIComponent(id)}/files?${query.toString()}`)
  },
  getWorkspaceFile(id: string, path: string): Promise<WorkspaceFile> {
    const query = new URLSearchParams({ path })
    return request(`/api/workspaces/${encodeURIComponent(id)}/file?${query.toString()}`)
  },
  searchWorkspaceFiles(id: string, queryText: string): Promise<{ entries: WorkspaceFileEntry[] }> {
    const query = new URLSearchParams({ q: queryText })
    return request(`/api/workspaces/${encodeURIComponent(id)}/search?${query.toString()}`)
  },
  listPlugins(): Promise<{ plugins: PluginSummary[] }> {
    return request('/api/plugins')
  },
  updatePlugin(id: string, patch: UpdatePluginInput): Promise<{ plugin: PluginSummary }> {
    return request(`/api/plugins/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(patch) })
  },
  listPresets(): Promise<{ presets: AgentPreset[] }> {
    return request('/api/presets')
  },
  createPreset(input: CreateAgentPresetInput): Promise<{ preset: AgentPreset }> {
    return request('/api/presets', { method: 'POST', body: JSON.stringify(input) })
  },
  updatePreset(id: string, patch: UpdateAgentPresetInput): Promise<{ preset: AgentPreset }> {
    return request(`/api/presets/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(patch) })
  },
  deletePreset(id: string): Promise<{ ok: boolean }> {
    return request(`/api/presets/${encodeURIComponent(id)}`, { method: 'DELETE' })
  },
  listAutomations(): Promise<{ automations: Automation[] }> {
    return request('/api/automations')
  },
  createAutomation(input: CreateAutomationInput): Promise<{ automation: Automation }> {
    return request('/api/automations', { method: 'POST', body: JSON.stringify(input) })
  },
  updateAutomation(id: string, patch: UpdateAutomationInput): Promise<{ automation: Automation }> {
    return request(`/api/automations/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(patch) })
  },
  deleteAutomation(id: string): Promise<{ ok: boolean }> {
    return request(`/api/automations/${encodeURIComponent(id)}`, { method: 'DELETE' })
  },
  runAutomation(id: string): Promise<{ automation: Automation; conversationId?: string }> {
    return request(`/api/automations/${encodeURIComponent(id)}/run-now`, { method: 'POST' })
  },
  updateQueued(id: string, submissionId: string, input: EditQueueInput): Promise<{ submissionId: string }> {
    return request(`/api/conversations/${encodeURIComponent(id)}/queue/${encodeURIComponent(submissionId)}`, {
      method: 'PATCH', body: JSON.stringify(input),
    })
  },
  saveFeedback(id: string, input: FeedbackInput): Promise<{ ok: boolean }> {
    return request(`/api/conversations/${encodeURIComponent(id)}/feedback`, { method: 'POST', body: JSON.stringify(input) })
  },
  /** Send operator feedback text; the server appends it to the application state. */
  sendFeedback(input: { text: string }): Promise<{ ok: boolean }> {
    return request('/api/feedback', { method: 'POST', body: JSON.stringify(input) })
  },
  retry(id: string, input: { entryId: string; requestId: string }): Promise<{ conversationId: string; submissionId: string }> {
    return request(`/api/conversations/${encodeURIComponent(id)}/retry`, { method: 'POST', body: JSON.stringify(input) })
  },
  saveProvider(input: ProviderInput): Promise<{ ok: boolean }> {
    return request('/api/providers', { method: 'POST', body: JSON.stringify(input) })
  },
  async getProvider(id: string): Promise<ProviderConfigSummary> {
    const result = await request<{ provider: ProviderConfigSummary }>(`/api/providers/${encodeURIComponent(id)}`)
    return result.provider
  },
  deleteProvider(id: string): Promise<{ ok: boolean }> {
    return request(`/api/providers/${encodeURIComponent(id)}`, { method: 'DELETE' })
  },
  testProvider(id: string): Promise<ProviderTestResult> {
    return request(`/api/providers/${encodeURIComponent(id)}/test`, { method: 'POST' })
  },
  async discoverProvider(id: string): Promise<Array<{ id: string; name: string }>> {
    const result = await request<{ models: Array<{ id: string; name: string }> }>(`/api/providers/${encodeURIComponent(id)}/discover`, { method: 'POST' })
    return result.models
  },
  watch(id: string, listener: (detail: ConversationDetail) => void, onState: (state: 'connecting' | 'open' | 'error') => void): EventSource {
    const source = new EventSource(`/api/conversations/${encodeURIComponent(id)}/events`)
    onState('connecting')
    source.onopen = () => { onState('open') }
    source.onerror = () => { onState('error') }
    source.addEventListener('snapshot', (event) => {
      try {
        listener(JSON.parse((event as MessageEvent<string>).data) as ConversationDetail)
      } catch {
        onState('error')
      }
    })
    return source
  },
}
