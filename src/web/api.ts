import type {
  AccessMode, AddWorkspaceInput, AppSettings, AskUserQuestionAnswerItem, Automation, AutomationRun, ChildMessageInput, ConversationDetail, ConversationSummary,
  CreateAutomationInput, CreateConversationInput, DirectoryListing, EditQueueInput, FeedbackInput, GitBranchMutation, GitBranchSnapshot, GitCommitInput, GitCommitMessageInput, GitCommitMessageResult, GitCommitResult, GitPushResult, GitWorktreeDiff, GitWorktreeStatus, GoalUpdateRequest,
  HooksListView,
  McpView, ModelCatalog, PersonalizationView, ProviderConfigSummary, ProviderInput, ProviderTestResult,
  RenameWorkspaceInput, SubmitInput, SubagentSummary, TeamView, ThinkingLevel, UpdateAutomationInput, UpdateConversationInput,
  UpdateAppSettingsInput, WetrackAnalysisIndex, WetrackAnalysisRecord, WetrackAnalysisRun, WetrackAnalysisSettings, WetrackAnalysisStartInput,
  WetrackDefectDetail, WetrackDefectList, WetrackDefectReport,
  WorkspaceFile, WorkspaceFileEntry, WorkspaceSummary,
} from '../shared/types.ts'
import type { SkillCatalog, SkillContent, SkillValidation } from '../shared/skills.ts'
import type { InstallPluginInput, PluginDescription, PluginOverview } from '../shared/plugins.ts'
import type {
  PluginUiCallInput, PluginUiDescriptor, PluginUiReadResourceInput, PluginUiSurfaceView,
} from '../shared/plugin-ui.ts'

/**
 * 所有 API 调用抛出的失败类型：message 是面向用户可读的文案，code 是服务端错误码
 * （可选，供调用方按错误类型分支）。
 */
export class ApiFailure extends Error {
  readonly code: string | undefined

  constructor(message: string, code?: string) {
    super(message)
    this.name = 'ApiFailure'
    this.code = code
  }
}

/**
 * 错误映射约定：非 2xx 响应读 body 里的 `{ error, code }`——error 是服务端给的中文
 * 文案，缺失时按状态码兜底；响应体不是 JSON 或 body 不是对象时，成功响应用「无法
 * 读取的数据」、失败响应用状态码文案兜底；带 body 的请求自动补 `Content-Type: application/json`。
 */
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

/**
 * 功能：文本形态的请求封装，用于非 JSON 端点（NDJSON 轨迹导出）。
 * @returns 响应文本；失败时同样映射 body.error 或状态码文案
 */
async function requestText(path: string): Promise<string> {
  const response = await fetch(path)
  if (!response.ok) {
    let message = `请求失败（${response.status}）`
    try {
      const body = (await response.json()) as unknown
      if (isRecord(body) && typeof body.error === 'string') message = body.error
    } catch { /* 解析失败保留状态码兜底文案 */ }
    throw new ApiFailure(message)
  }
  return response.text()
}

/** 窄化守卫：值是普通对象（非 null、非数组）。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * 前端对服务端 REST API 的唯一封装层：方法按资源分组（会话/工作区/插件/自动化/
 * WeTrack/provider/事件流等），内部统一走 `request` / `requestText`，错误统一为
 * ApiFailure。路径里的 id 一律 encodeURIComponent。
 */
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
  /** 应答一张待决提问卡片；响应携带结算后的投影会话详情。 */
  answerInteraction(id: string, callId: string, answers: AskUserQuestionAnswerItem[]): Promise<ConversationDetail> {
    return request(`/api/conversations/${encodeURIComponent(id)}/interactions/${encodeURIComponent(callId)}/answer`, {
      method: 'POST', body: JSON.stringify({ answers }),
    })
  },
  /** 关掉一组待决提问；响应携带该工具行按「已取消」结算的详情。 */
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
  /** 开关计划模式；响应是切换后的投影会话。 */
  setPlan(id: string, active: boolean): Promise<ConversationDetail> {
    return request(`/api/conversations/${encodeURIComponent(id)}/plan`, { method: 'POST', body: JSON.stringify({ active }) })
  },
  /** 一个会话的智能体团队视图；成员运行期间面板会反复读取。 */
  async getTeam(id: string): Promise<TeamView> {
    const result = await request<{ team: TeamView }>(`/api/conversations/${encodeURIComponent(id)}/team`)
    return result.team
  },
  /** 一个会话的直接子智能体，旧的在前。 */
  async listChildren(id: string): Promise<SubagentSummary[]> {
    const result = await request<{ subagents: SubagentSummary[] }>(`/api/conversations/${encodeURIComponent(id)}/children`)
    return result.subagents
  },
  /** 向某个子智能体发送一条追问；响应是刷新后的子智能体列表。 */
  async childMessage(id: string, childId: string, input: ChildMessageInput): Promise<SubagentSummary[]> {
    const result = await request<{ subagents: SubagentSummary[] }>(
      `/api/conversations/${encodeURIComponent(id)}/children/${encodeURIComponent(childId)}/messages`,
      { method: 'POST', body: JSON.stringify(input) },
    )
    return result.subagents
  },
  /** 停止一个运行中的子智能体；响应是刷新后的子智能体列表。 */
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
  /** 用户级个性化指令及其落盘文件（编辑器读写的就是它）。 */
  getPersonalization(): Promise<PersonalizationView> {
    return request('/api/personalization')
  },
  savePersonalization(content: string): Promise<PersonalizationView> {
    return request('/api/personalization', { method: 'PUT', body: JSON.stringify({ content }) })
  },
  /** 导入的 Pi MCP 目录：配置路径、各服务器及其工具与连接状态。 */
  getMcp(): Promise<McpView> {
    return request('/api/mcp')
  },
  /** 钩子清单：用户级与项目级来源、逐条信任状态。 */
  getHooks(workspaceId?: string): Promise<HooksListView> {
    return request(workspaceId === undefined ? '/api/hooks' : `/api/hooks?workspaceId=${encodeURIComponent(workspaceId)}`)
  },
  /** 批准一条项目级钩子（写 digest 进信任集）。 */
  trustHook(input: { workspaceId: string; digest: string }): Promise<{ ok: boolean }> {
    return request('/api/hooks/trust', { method: 'POST', body: JSON.stringify(input) })
  },
  /** 撤销一条项目级钩子的信任。 */
  revokeHook(input: { workspaceId: string; digest: string }): Promise<{ ok: boolean }> {
    return request('/api/hooks/trust', { method: 'DELETE', body: JSON.stringify(input) })
  },
  /** 删除一条钩子（事件内 index 定位）。 */
  removeHookEntry(input: { scope: 'user' | 'project'; workspaceId?: string; event: string; index: number }): Promise<HooksListView> {
    return request('/api/hooks/remove', { method: 'POST', body: JSON.stringify(input) })
  },
  /** 启停一条钩子。 */
  setHookEnabled(input: { scope: 'user' | 'project'; workspaceId?: string; event: string; index: number; enabled: boolean }): Promise<HooksListView> {
    return request('/api/hooks/enabled', { method: 'POST', body: JSON.stringify(input) })
  },
  updateSettings(patch: UpdateAppSettingsInput): Promise<AppSettings> {
    return request('/api/settings', { method: 'PATCH', body: JSON.stringify(patch) })
  },
  /** 用系统默认程序打开本地应用配置文件。 */
  openConfigFile(): Promise<{ ok: boolean }> {
    return request('/api/settings/open-config', { method: 'POST' })
  },
  listWorkspaces(): Promise<{ workspaces: WorkspaceSummary[] }> {
    return request('/api/workspaces')
  },
  getSkills(workspaceId: string): Promise<SkillCatalog> {
    return request(`/api/workspaces/${encodeURIComponent(workspaceId)}/skills`)
  },
  getSkill(workspaceId: string, skillId: string, resource?: string): Promise<SkillContent> {
    const query = new URLSearchParams({ skillId })
    if (resource !== undefined) query.set('resource', resource)
    return request(`/api/workspaces/${encodeURIComponent(workspaceId)}/skills/read?${query.toString()}`)
  },
  validateSkill(workspaceId: string, skillId: string): Promise<SkillValidation> {
    return request(`/api/workspaces/${encodeURIComponent(workspaceId)}/skills/validate`, {
      method: 'POST', body: JSON.stringify({ skillId }),
    })
  },
  getPluginOverview(): Promise<PluginOverview> {
    return request('/api/plugins/overview')
  },
  addPluginMarketplace(source: string): Promise<PluginOverview> {
    return request('/api/plugins/marketplaces', { method: 'POST', body: JSON.stringify({ source }) })
  },
  removePluginMarketplace(id: string): Promise<PluginOverview> {
    return request(`/api/plugins/marketplaces/${encodeURIComponent(id)}`, { method: 'DELETE' })
  },
  refreshPluginMarketplace(id: string): Promise<PluginOverview> {
    return request(`/api/plugins/marketplaces/${encodeURIComponent(id)}/refresh`, { method: 'POST' })
  },
  installPlugin(input: InstallPluginInput): Promise<{ operationId: string }> {
    return request('/api/plugins/install', { method: 'POST', body: JSON.stringify(input) })
  },
  updatePlugin(pluginId: string): Promise<{ operationId: string }> {
    return request('/api/plugins/update', { method: 'POST', body: JSON.stringify({ pluginId }) })
  },
  describePlugin(pluginId: string): Promise<PluginDescription> {
    return request(`/api/plugins/${encodeURIComponent(pluginId)}/describe`)
  },
  uninstallPlugin(pluginId: string, keepData = false): Promise<PluginOverview> {
    const query = keepData ? '?keepData=1' : ''
    return request(`/api/plugins/${encodeURIComponent(pluginId)}${query}`, { method: 'DELETE' })
  },
  setPluginEnabled(pluginId: string, enabled: boolean): Promise<PluginOverview> {
    return request(`/api/plugins/${encodeURIComponent(pluginId)}`, { method: 'PATCH', body: JSON.stringify({ enabled }) })
  },
  /** 当前工作区/会话可打开的已启用插件 UI 表面列表。 */
  async pluginUiSurfaces(workspaceId?: string, conversationId?: string): Promise<PluginUiSurfaceView[]> {
    const query = new URLSearchParams()
    if (workspaceId !== undefined) query.set('workspaceId', workspaceId)
    if (conversationId !== undefined) query.set('conversationId', conversationId)
    const suffix = query.size === 0 ? '' : `?${query.toString()}`
    const result = await request<{ surfaces: PluginUiSurfaceView[] }>(`/api/plugins/ui/surfaces${suffix}`)
    return result.surfaces
  },
  /** 代理一个沙箱插件页经 bridge 发起的 MCP `tools/call`。 */
  pluginUiCall(input: PluginUiCallInput): Promise<{ result: unknown }> {
    return request('/api/plugins/ui/call', { method: 'POST', body: JSON.stringify(input) })
  },
  /** 代理一个沙箱插件页经 bridge 发起的 MCP `resources/read`。 */
  pluginUiReadResource(input: PluginUiReadResourceInput): Promise<{ resource: unknown }> {
    return request('/api/plugins/ui/read-resource', { method: 'POST', body: JSON.stringify(input) })
  },
  /** 拼出某个插件 UI 表面的沙箱页 URL。 */
  pluginUiPageUrl(page: Pick<PluginUiDescriptor, 'pluginId' | 'serverName' | 'resourceUri'>): string {
    const query = new URLSearchParams({
      pluginId: page.pluginId,
      serverName: page.serverName,
      uri: page.resourceUri,
    })
    return `/api/plugins/ui/page?${query.toString()}`
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
  getWorkspaceFile(id: string, path: string, line?: number): Promise<WorkspaceFile> {
    const query = new URLSearchParams({ path })
    if (line !== undefined) query.set('line', String(line))
    return request(`/api/workspaces/${encodeURIComponent(id)}/file?${query.toString()}`)
  },
  searchWorkspaceFiles(id: string, queryText: string): Promise<{ entries: WorkspaceFileEntry[] }> {
    const query = new URLSearchParams({ q: queryText })
    return request(`/api/workspaces/${encodeURIComponent(id)}/search?${query.toString()}`)
  },
  getGitBranches(id: string): Promise<GitBranchSnapshot> {
    return request(`/api/workspaces/${encodeURIComponent(id)}/git/branches`)
  },
  switchGitBranch(id: string, branchName: string): Promise<GitBranchMutation> {
    return request(`/api/workspaces/${encodeURIComponent(id)}/git/switch`, { method: 'POST', body: JSON.stringify({ branchName }) })
  },
  createGitBranch(id: string, branchName: string): Promise<GitBranchMutation> {
    return request(`/api/workspaces/${encodeURIComponent(id)}/git/branches`, { method: 'POST', body: JSON.stringify({ branchName }) })
  },
  gitWorktreeStatus(id: string): Promise<GitWorktreeStatus> {
    return request(`/api/workspaces/${encodeURIComponent(id)}/git/status`)
  },
  gitWorktreeDiff(id: string, path: string, sourceId?: 'unstaged' | 'staged' | 'branch'): Promise<GitWorktreeDiff> {
    const query = new URLSearchParams({ path })
    if (sourceId !== undefined) query.set('sourceId', sourceId)
    return request(`/api/workspaces/${encodeURIComponent(id)}/git/diff?${query.toString()}`)
  },
  gitCommit(id: string, input: GitCommitInput): Promise<GitCommitResult> {
    return request(`/api/workspaces/${encodeURIComponent(id)}/git/commit`, { method: 'POST', body: JSON.stringify(input) })
  },
  gitPush(id: string): Promise<GitPushResult> {
    return request(`/api/workspaces/${encodeURIComponent(id)}/git/push`, { method: 'POST' })
  },
  gitCommitMessage(id: string, input: GitCommitMessageInput): Promise<GitCommitMessageResult> {
    return request(`/api/workspaces/${encodeURIComponent(id)}/git/commit-message`, { method: 'POST', body: JSON.stringify(input) })
  },
  /** 一个会话的完整捕获轨迹，按时间序的 NDJSON 文本。 */
  trajectory(id: string): Promise<string> {
    return requestText(`/api/conversations/${encodeURIComponent(id)}/trajectory`)
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
  automationRuns(id: string, limit = 20, offset = 0): Promise<{ runs: AutomationRun[]; total: number }> {
    return request(`/api/automations/${encodeURIComponent(id)}/runs?limit=${limit}&offset=${offset}`)
  },
  purgeEndedAutomations(): Promise<{ removed: number }> {
    return request('/api/automations/purge-ended', { method: 'POST' })
  },
  wetrackDefects(): Promise<WetrackDefectList> {
    return request('/api/wetrack/defects')
  },
  wetrackDefect(defectNumber: string): Promise<WetrackDefectDetail> {
    return request(`/api/wetrack/defects/${encodeURIComponent(defectNumber)}`)
  },
  wetrackReport(defectNumber: string): Promise<WetrackDefectReport> {
    return request(`/api/wetrack/defects/${encodeURIComponent(defectNumber)}/report`)
  },
  wetrackAnalyses(): Promise<WetrackAnalysisIndex> {
    return request('/api/wetrack/analyses')
  },
  wetrackAnalysis(defectNumber: string): Promise<{ analysis: WetrackAnalysisRecord | null }> {
    return request(`/api/wetrack/analysis/${encodeURIComponent(defectNumber)}`)
  },
  wetrackAnalysisRuns(): Promise<{ runs: WetrackAnalysisRun[] }> {
    return request('/api/wetrack/analysis-runs')
  },
  startWetrackAnalysis(input: WetrackAnalysisStartInput): Promise<WetrackAnalysisRun> {
    return request(`/api/wetrack/analysis-runs/${encodeURIComponent(input.defectNumber)}`, {
      method: 'POST', body: '{}',
    })
  },
  wetrackAnalysisSettings(): Promise<WetrackAnalysisSettings> {
    return request('/api/wetrack/workspace')
  },
  updateWetrackAnalysisSettings(input: { workspaceId?: string | null; thinkingLevel?: ThinkingLevel }): Promise<WetrackAnalysisSettings> {
    return request('/api/wetrack/workspace', { method: 'PUT', body: JSON.stringify(input) })
  },
  updateQueued(id: string, submissionId: string, input: EditQueueInput): Promise<{ submissionId: string }> {
    return request(`/api/conversations/${encodeURIComponent(id)}/queue/${encodeURIComponent(submissionId)}`, {
      method: 'PATCH', body: JSON.stringify(input),
    })
  },
  saveFeedback(id: string, input: FeedbackInput): Promise<{ ok: boolean }> {
    return request(`/api/conversations/${encodeURIComponent(id)}/feedback`, { method: 'POST', body: JSON.stringify(input) })
  },
  /** 提交运维反馈文本；服务端把它追加进应用状态。 */
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
  /**
   * 功能：订阅一个会话的实时事件流（SSE）。每个 `snapshot` 事件携带完整的投影
   * ConversationDetail，直接替换本地详情状态。
   * @param listener 收到快照时的回调
   * @param onState 连接状态回调：'connecting' / 'open' / 'error'
   * @returns EventSource，由调用方负责 close()
   * 内部逻辑：快照 JSON 解析失败时回报 error；连接断开浏览器自动重连，onState 跟随。
   */
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
  /** 订阅模型目录变更事件：本窗口保存、另一实例写入或配置文件被编辑都会触发。 */
  watchModels(listener: () => void): EventSource {
    const source = new EventSource('/api/models/events')
    source.addEventListener('changed', () => { listener() })
    return source
  },
  /** 订阅插件市场变更（安装进度、启用/停用、市场刷新）。 */
  watchPlugins(listener: (overview: PluginOverview) => void): EventSource {
    const source = new EventSource('/api/plugins/events')
    source.addEventListener('overview', (event) => {
      try { listener(JSON.parse((event as MessageEvent<string>).data) as PluginOverview) }
      catch { /* 帧损坏则忽略；下一次变更会推送全新 overview */ }
    })
    return source
  },
}
