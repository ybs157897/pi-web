import type { GoalUpdateRequest, HooksListView } from '../shared/types.ts'
import type { HooksEntryInput, HooksSaveInput, HooksTrustInput } from './runtime/hooks.ts'
import type { MutableModels } from '@earendil-works/pi-ai'
import type { SkillCatalog, SkillContent, SkillValidation } from '../shared/skills.ts'
import type { InstallPluginInput, PluginDescription, PluginOverview } from '../shared/plugins.ts'
import type {
  AddWorkspaceInput,
  AccessMode,
  AppSettings,
  AskUserQuestionAnswerItem,
  Automation,
  AutomationRun,
  ChildMessageInput,
  ConversationDetail,
  ConversationSummary,
  CreateAutomationInput,
  CreateConversationInput,
  CreateGitBranchInput,
  GitCommitInput,
  GitChangeSourceId,
  GitCommitMessageInput,
  GitCommitMessageResult,
  GitCommitResult,
  GitPushResult,
  GitWorktreeDiff,
  GitWorktreeStatus,
  DirectoryListing,
  EditQueueInput,
  GitBranchMutation,
  GitBranchSnapshot,
  McpView,
  ModelCatalog,
  PersonalizationView,
  ProviderConfigSummary,
  ProviderInput,
  ProviderTestResult,
  RenameWorkspaceInput,
  SubmitInput,
  SubagentSummary,
  SwitchGitBranchInput,
  TeamView,
  ThinkingLevel,
  UpdateAppSettingsInput,
  UpdateAutomationInput,
  UpdateConversationInput,
  WorkspaceFile,
  WorkspaceFileEntry,
  WorkspaceSummary,
  WetrackAnalysisIndex,
  WetrackAnalysisRecord,
  WetrackAnalysisRun,
  WetrackAnalysisSettings,
  WetrackAnalysisStartInput,
  WetrackDefectDetail,
  WetrackDefectList,
  WetrackDefectReport,
} from '../shared/types.ts'

/**
 * 运行时操作契约：HTTP 层（app.ts）与确定性集成测试共同面向此接口编程。
 * 覆盖会话、交互、模型/provider、设置、个性化、工作区、文件、Git、技能、插件、
 * 反馈、自动化任务与 WeTrack 缺陷分析等全部后端能力。
 */
export interface Runtime {
  list(): Promise<ConversationSummary[]>
  create(input: CreateConversationInput): Promise<ConversationDetail>
  detail(id: string): Promise<ConversationDetail>
  update(id: string, input: UpdateConversationInput): Promise<ConversationDetail>
  submit(id: string, input: SubmitInput): Promise<{ submissionId: string }>
  /** 回答一条待回答的提问调用；结算会话文档并把答复作为引导消息注入。 */
  answerInteraction(id: string, callId: string, answers: AskUserQuestionAnswerItem[]): Promise<ConversationDetail>
  /** 不作答直接关闭一条待回答的提问调用；注入关闭引导并把调用结算为 cancelled。 */
  cancelInteraction(id: string, callId: string): Promise<ConversationDetail>
  editQueued(id: string, submissionId: string, input: EditQueueInput): Promise<{ submissionId: string }>
  stop(id: string): Promise<void>
  compact(id: string): Promise<void>
  /** 会话完整轨迹，按时间排序的 JSONL：entry、task 与采集到的请求。 */
  trajectory(id: string): Promise<string>
  goal(id: string, input: GoalUpdateRequest): Promise<ConversationDetail>
  /** 开关计划模式；批准一次计划审阅同样会将其关闭。 */
  setPlan(id: string, active: boolean): Promise<ConversationDetail>
  /** 该会话领导（或所属）的智能体团队，按面板所需形态返回。 */
  team(id: string): Promise<TeamView>
  /** 一个会话的直接子会话，最旧在前（DSH 的 `subagentCatalog` / `list_agents`）。 */
  children(id: string): Promise<SubagentSummary[]>
  /** 向一个直接子会话投递后续消息；以刷新后的子会话列表兑现。 */
  childMessage(id: string, childId: string, input: ChildMessageInput): Promise<SubagentSummary[]>
  /** 停止一个直接子会话的运行；以刷新后的子会话列表兑现。 */
  childStop(id: string, childId: string): Promise<SubagentSummary[]>
  removeQueued(id: string, submissionId: string): Promise<void>
  fork(id: string, entryId: string): Promise<ConversationDetail>
  watch(id: string, listener: (value: ConversationDetail) => void): Promise<() => Promise<void>>
  catalog(): Promise<ModelCatalog>
  /** 观察 provider 目录重载；返回退订函数。 */
  watchModels(listener: () => void): () => void
  saveProvider(input: ProviderInput): Promise<void>
  provider(id: string): Promise<ProviderConfigSummary>
  deleteProvider(id: string): Promise<void>
  testProvider(id: string, modelId?: string): Promise<ProviderTestResult>
  discoverProvider(id: string): Promise<{ models: Array<{ id: string; name: string }> }>
  settings(): AppSettings
  /** 用户级个性化指令：应用主目录下的 `AGENTS.md`，从设置页编辑。 */
  personalization(): Promise<PersonalizationView>
  savePersonalization(content: string): Promise<PersonalizationView>
  /** 用户/项目级钩子：清单投影、配置写回、信任批准/撤销、条目删除与启停。 */
  hooks(workspaceId?: string): Promise<HooksListView>
  saveHooks(input: HooksSaveInput): Promise<HooksListView>
  trustHook(input: HooksTrustInput): Promise<void>
  revokeHook(input: HooksTrustInput): Promise<void>
  removeHookEntry(input: HooksEntryInput): Promise<HooksListView>
  setHookEnabled(input: HooksEntryInput & { enabled: boolean }): Promise<HooksListView>
  /** 导入的用户级 Pi MCP 配置及各服务器的连接状态。 */
  mcp(): McpView
  capabilities(): { accessModes: AccessMode[] }
  updateSettings(input: UpdateAppSettingsInput): Promise<AppSettings>
  /** 用宿主默认程序打开持久化的应用配置文件。 */
  openConfigFile(): Promise<void>
  workspaces(): WorkspaceSummary[]
  addWorkspace(input: AddWorkspaceInput): Promise<WorkspaceSummary>
  renameWorkspace(id: string, input: RenameWorkspaceInput): Promise<WorkspaceSummary>
  deleteWorkspace(id: string): Promise<void>
  /** 调起操作系统选择目录；null 表示操作者取消。 */
  pickDirectory(signal?: AbortSignal): Promise<string | null>
  listDirectories(path?: string): Promise<DirectoryListing>
  createDirectory(parent: string, name: string): Promise<void>
  workspaceFiles(id: string, path: string, query?: string): Promise<WorkspaceFileEntry[]>
  searchWorkspace(id: string, query: string): Promise<WorkspaceFileEntry[]>
  workspaceFile(id: string, path: string): Promise<WorkspaceFile>
  workspaceAsset(id: string, path: string): Promise<{ mimeType: string; data: Uint8Array }>
  /** 一个工作区的本地 Git 分支，外加 HEAD 当前指向。 */
  gitBranches(id: string): Promise<GitBranchSnapshot>
  /** 把 HEAD 切到既有本地分支；被阻断的切换以结构化 issue 返回。 */
  switchGitBranch(id: string, input: SwitchGitBranchInput): Promise<GitBranchMutation>
  /** 在 HEAD 处创建分支并切换过去。 */
  createGitBranch(id: string, input: CreateGitBranchInput): Promise<GitBranchMutation>
  /** 工作区变更、分支位置与行数统计，供状态卡片使用。 */
  gitWorktreeStatus(id: string): Promise<GitWorktreeStatus>
  /** 单个文件的当前工作区 diff；未跟踪文件返回其文本；`sourceId` 选择审阅来源。 */
  gitWorktreeDiff(id: string, path: string, sourceId?: GitChangeSourceId): Promise<GitWorktreeDiff>
  /** 提交暂存区，可选先把全部工作区变更入暂存。 */
  gitCommit(id: string, input: GitCommitInput): Promise<GitCommitResult>
  /** 把当前分支推送到已配置的上游。 */
  gitPush(id: string): Promise<GitPushResult>
  /** 用会话模型从选定的工作区 diff 起草一条提交信息。 */
  gitCommitMessage(id: string, input: GitCommitMessageInput): Promise<GitCommitMessageResult>
  skills(workspaceId: string): Promise<SkillCatalog>
  skill(workspaceId: string, skillId: string, resource?: string): Promise<SkillContent>
  validateSkill(workspaceId: string, skillId: string): Promise<SkillValidation>
  /** 插件市场、安装记录、操作与诊断信息。 */
  plugins(): Promise<PluginOverview>
  addPluginMarketplace(source: string): Promise<PluginOverview>
  removePluginMarketplace(id: string): Promise<PluginOverview>
  refreshPluginMarketplace(id: string): Promise<PluginOverview>
  /** 在后台启动一次安装；返回的操作可在 `plugins()` 中看到。 */
  installPlugin(input: InstallPluginInput): Promise<{ operationId: string }>
  /** 在后台把已安装插件更新到目录版本；操作同样可在 `plugins()` 中看到。 */
  updatePlugin(pluginId: string): Promise<{ operationId: string }>
  /** 候选或已安装插件的组成清单，用于安装确认。 */
  describePlugin(pluginId: string): Promise<PluginDescription>
  uninstallPlugin(pluginId: string, keepData?: boolean): Promise<PluginOverview>
  setPluginEnabled(pluginId: string, enabled: boolean): Promise<PluginOverview>
  /** 插件存储每次变更都会唤醒监听者，让打开中的设置面板立即重新拉取。 */
  watchPlugins(listener: () => void): () => void
  feedback(id: string, entryId: string, rating: 'up' | 'down' | null): Promise<void>
  /** 把操作者反馈文本追加到应用状态。 */
  sendFeedback(input: { text: string; userAgent?: string }): Promise<void>
  retry(id: string, entryId: string, requestId: string): Promise<{ conversationId: string; submissionId: string }>
  automations(): Automation[]
  createAutomation(input: CreateAutomationInput): Promise<Automation>
  updateAutomation(id: string, input: UpdateAutomationInput): Promise<Automation>
  deleteAutomation(id: string): Promise<void>
  runAutomation(id: string): Promise<{ automation: Automation; conversationId: string }>
  /** 一个任务的运行历史，最新在前。 */
  automationRuns(id: string): AutomationRun[]
  /** 删除规则已耗尽的全部任务；返回删除数量。 */
  purgeEndedAutomations(): Promise<number>
  /** 独立列表页用的 WeTrack 缺陷；这份数据永远不会进入会话。 */
  wetrackDefects(): Promise<WetrackDefectList>
  /** 单个缺陷的完整详情，供缺陷页弹窗使用。 */
  wetrackDefect(defectNumber: string): Promise<WetrackDefectDetail>
  /** 操作者为某个缺陷写下的本地分析文档（若写过）。 */
  wetrackReport(defectNumber: string): Promise<WetrackDefectReport>
  /** 列表徽章用的存量分析摘要，最新在前。 */
  wetrackAnalyses(): Promise<WetrackAnalysisIndex>
  /** 单个缺陷的存量分析正文；从未分析过时为 null。 */
  wetrackAnalysis(defectNumber: string): Promise<WetrackAnalysisRecord | null>
  wetrackAnalysisRuns(): Promise<WetrackAnalysisRun[]>
  startWetrackAnalysis(input: WetrackAnalysisStartInput): Promise<WetrackAnalysisRun>
  wetrackAnalysisSettings(): Promise<WetrackAnalysisSettings>
  updateWetrackAnalysisSettings(input: { workspaceId?: string | null; thinkingLevel?: ThinkingLevel }): Promise<WetrackAnalysisSettings>
  close(): Promise<void>
}
/**
 * runtime 装配选项：`workspace` 是显式选择加入（`PI_WEB_WORKSPACE`）；
 * 不提供时应用以"零工作区"状态启动，由用户在 UI 里自行添加。
 */
export interface RuntimeOptions { dataDir: string; workspace?: string; piDir?: string; demo?: boolean; /** 覆盖被导入的 Pi MCP 文件（测试与 `PI_WEB_MCP_CONFIG` 使用）。 */ mcpConfigPath?: string; models?: MutableModels }
