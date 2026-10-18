import type {
  AccessMode, AddWorkspaceInput, AgentPreset, AppSettings, Automation, ConversationDetail, ConversationSummary,
  CreateAgentPresetInput, CreateAutomationInput, CreateConversationInput, EditQueueInput, FeedbackInput,
  ModelCatalog, PluginSummary, ProviderConfigSummary, ProviderInput, ProviderTestResult,
  RenameWorkspaceInput, SubmitInput, UpdateAgentPresetInput, UpdateAutomationInput, UpdateConversationInput,
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
