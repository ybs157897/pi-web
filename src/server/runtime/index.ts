import { randomUUID } from 'node:crypto'
import { mkdir, realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { Harness, UsageDoc } from '@earendil-works/pi-durable'
import type { Cursor } from '@earendil-works/pi-durable'
import type { Context } from '@earendil-works/chord/context'
import { CodingTools } from '../tools/shell/tools.ts'
import { createRegistry } from '@earendil-works/pi-durable'
import { CODEMODE_TOOL_NAME } from '@earendil-works/pi-durable/codemode'
import { createToolSearchExtension } from '@earendil-works/pi-durable/tool-search'
import { CodemodeSandbox } from '@earendil-works/pi-codemode'
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node'
import type { Usage } from '@earendil-works/pi-ai'
import type { Runtime, RuntimeOptions } from '../contracts.ts'
import type {
  PersonalizationView, WetrackAnalysisIndex, WetrackAnalysisRecord, WetrackDefectDetail, WetrackDefectList, WetrackDefectReport, WorkspaceSummary,
} from '../../shared/types.ts'
import { createModelRuntime } from '../model/catalog.ts'
import { createDemoModelRuntime } from '../model/demo.ts'
import { createChildModelResolver } from '../agents/builtins.ts'
import { modelWithinAllowlist } from '../model/allowlist.ts'
import { RuntimeError } from '../runtime-errors.ts'
import { builtinFixturePath, readWetrackDefect, readWetrackDefects, readWetrackReport, wetrackConfigured } from '../automation/wetrack.ts'
import { listWetrackAnalyses, readWetrackAnalysis } from '../automation/wetrack-analysis.ts'
import { createWetrackAnalysisRuns } from '../automation/wetrack-analysis-runs.ts'
import {
  WETRACK_DAILY_AUTOMATION_KEY, WETRACK_DAILY_RRULE, markWetrackDailyProvisioned,
  wetrackDailyCoordinatorPrompt, wetrackDailyProvisioned,
} from '../automation/wetrack-daily.ts'
import { TodoTools } from '../tools/todo.ts'
import { createScheduleExtension } from '../tools/schedule.ts'
import { createWetrackAnalysisExtension } from '../tools/wetrack-analysis.ts'
import { createGoalExtension } from '../tools/goal.ts'
import { InteractionTools } from '../tools/interaction.ts'
import { createPlanExtension, Plans } from '../tools/plan.ts'
import { createSubagentTools, type ChildModelList, SUBAGENT_MODEL_LIST_LIMIT } from '../tools/subagent.ts'
import { createTeamTools } from '../tools/team.ts'
import { MCP_EXTENSION_NAME, McpRegistry } from '../mcp/registry.ts'
import { SkillStore } from '../skills/store.ts'
import { piWebHome } from '../state/home.ts'
import { MAX_PERSONALIZATION_BYTES, readPersonalization, writePersonalization } from '../state/personalization.ts'
import { createSkillTools } from '../tools/skill.ts'
import { createWorkPolicyExtension } from '../conversation/work-policy.ts'
import { createExecutionPolicyExtension, EXECUTION_POLICY_EXTENSION_NAME } from '../conversation/execution-policy.ts'
import { HooksStore } from '../hooks/store.ts'
import { createHooksExtension } from '../hooks/extension.ts'
import { createManageHooksTool } from '../hooks/tool.ts'
import { createHooksFeature } from './hooks.ts'
import { createRuntimeCodemodeExtension } from '../codemode-policy.ts'
import { BrowserTools } from '../tools/browser.ts'
import { ResearchTools } from '../tools/research.ts'
import { COMPACTION_POLICY, createCompactionExtension } from '../conversation/compaction.ts'
import {
  TRAJECTORY_CAPTURE_DIR, TRAJECTORY_EXTENSION_NAME, assembleTrajectory, createHookCapture, createTrajectoryExtension, drainTrajectoryCapture,
  wrapModelsWithTrajectory,
} from '../conversation/trajectory.ts'
import { MEMORY_EXTRACTION_DRAIN_MS, createMemoryExtraction } from '../memory/extraction.ts'
import { createMemoryExtension } from '../memory/policy.ts'
import { ensureMemoryDirectory, resolveMemoryRoot } from '../memory/store.ts'
export { RuntimeError } from '../runtime-errors.ts'
export type { ConversationMetadata } from './helpers.ts'
import { AppStateStore } from '../state/app-state.ts'
import { PluginStore, type PluginChangeEvent } from '../plugins/store.ts'
import { createPluginReferenceExtension, pluginReferenceCapabilities } from '../plugins/reference.ts'
import { WorkspaceFiles } from '../workspace/files.ts'
import { GitBranches } from '../workspace/git/branches.ts'
import { GitWorktree } from '../workspace/git/worktree.ts'
import { createExecutionEnv, workspaceWriteSupported } from '../conversation/execution-env.ts'
import { disposeShellSessions } from '../tools/shell/runner.ts'
import { createAutomations } from './automations.ts'
import { createWorkspaces } from './workspaces.ts'
import { createSettings } from './settings.ts'
import { createPlugins } from './plugins.ts'
import { createTeam } from './team.ts'
import { createQueue } from './queue.ts'
import { createConversations } from './conversations.ts'
import { createCore } from './core.ts'
import { createInteractionReplies } from './interactions.ts'
import { createSubagentSettlement } from './subagent-settle.ts'

import { CODEMODE_EXTENSION_NAME, CONVERSATION_KIND, CTX, DEFAULT_TITLE, META, accumulateUsage, ensureRuntimePolicy, parseConversationId } from './helpers.ts'

/**
 * 功能：装配整个运行时——数据目录、模型运行时、工具注册表、各 feature 服务、
 * 恢复流程与关闭顺序，返回面向 HTTP 层的完整 Runtime 契约。
 * @param options 数据目录、工作区、模型目录、demo 开关等启动选项
 * @returns 组装完毕的 Runtime；恢复完成后（resume、syncIdleAgents）才返回
 * 内部逻辑：核心（core）先于团队 feature 创建（团队需要 core 的回调），harness
 * 最后打开并回填给 core；扩展按依赖顺序安装（记忆在执行策略前、轨迹在压缩后）；
 * 启动恢复链为自动化迁移 → 排队编辑 → 团队对账 → 后台委派结算 → resume →
 * syncIdleAgents。close 按「停止接收 → drain 后台任务 → harness 关闭」的顺序执行。
 */
export async function createRuntime(options: RuntimeOptions): Promise<Runtime> {
  const dataDir = resolve(options.dataDir)
  const requestedWorkspace = options.workspace === undefined ? undefined : resolve(options.workspace)
  await mkdir(dataDir, { recursive: true, mode: 0o700 })
  if (requestedWorkspace !== undefined) await mkdir(requestedWorkspace, { recursive: true })
  const initialWorkspacePath = requestedWorkspace === undefined ? undefined : await realpath(requestedWorkspace)
  const modelRuntime = options.demo ? createDemoModelRuntime(options.models) : await createModelRuntime({ dataDir, piDir: options.piDir })
  /** 目录重载（文件编辑、保存、另一个实例写入）向 web 客户端的扇出通知集合。 */
  const modelListeners = new Set<() => void>()
  const unsubscribeModels = modelRuntime.subscribe(() => {
    for (const listener of [...modelListeners]) {
      try { listener() } catch { /* 单个事件流掉线不得中断重载 */ }
    }
  })
  const initialWorkspace: WorkspaceSummary | undefined = initialWorkspacePath === undefined ? undefined : {
    id: randomUUID(),
    name: basename(initialWorkspacePath) || initialWorkspacePath,
    path: initialWorkspacePath,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }
  const appState = await AppStateStore.open({
    dataDir,
    ...(initialWorkspace === undefined ? {} : { defaultWorkspace: initialWorkspace }),
    defaultThinkingLevel: modelRuntime.defaultThinkingLevel,
  })
  const initialState = appState.snapshot()
  const launchWorkspace = initialWorkspacePath === undefined
    ? undefined
    : initialState.workspaces.find(item => item.path === initialWorkspacePath) ?? initialWorkspace
  if (initialState.workspaces.find(item => item.id === initialState.settings.defaultWorkspaceId) === undefined && launchWorkspace !== undefined) {
    await appState.update(state => { state.settings.defaultWorkspaceId = launchWorkspace.id })
  }
  /**
   * 功能：读取当前生效的默认工作区。
   * @returns 设置指向的工作区；已删除则返回 undefined
   * 内部逻辑：每次按当前设置与列表实时解析，删除默认工作区在下一次读取即生效，
   * 而不是保留启动时的对象。
   */
  const defaultWorkspace = (): WorkspaceSummary | undefined => {
    const state = appState.snapshot()
    return state.workspaces.find(item => item.id === state.settings.defaultWorkspaceId)
  }
  const workspaceFiles = new WorkspaceFiles(() => appState.snapshot().workspaces)
  const gitBranches = new GitBranches(() => appState.snapshot().workspaces)
  const gitWorktree = new GitWorktree(() => appState.snapshot().workspaces)
  // hooks 双来源存储：用户级 hooks.json 放 dataDir 根（与 personalization 同款，测试/演示自动隔离；
  // 生产 dataDir 默认即 ~/.pi-web）；项目级随仓库；信任集存 dataDir（不进仓库）。
  const hooksStore = new HooksStore(dataDir, dataDir)
  /** 会话 → 工作区引用：hooks 扩展与 manage_hooks 共用的解析口径（META.workspaceId）。 */
  const resolveHooksWorkspace = async (conversationId: ReturnType<typeof parseConversationId>, context: Context) => {
    const metadata = await harness.snapshot(META, conversationId, context)
    const workspaceId = metadata?.workspaceId
    if (workspaceId === undefined) return undefined
    const workspace = appState.snapshot().workspaces.find(item => item.id === workspaceId)
    return workspace === undefined ? undefined : { id: workspace.id, path: workspace.path }
  }
  const hooksFeature = createHooksFeature({
    store: hooksStore,
    workspacePath: id => appState.snapshot().workspaces.find(item => item.id === id)?.path,
  })
  let onPluginChange: (event: PluginChangeEvent) => void = () => undefined
  const pluginStore = await PluginStore.open({ dataDir, onChange: event => onPluginChange(event) })
  const skillStore = new SkillStore({
    // ZCode 风格的用户级根目录：跨工作区共享的只读技能。demo 运行与真实全局 home 隔离。
    globalRoot: options.demo ? join(dataDir, 'skills') : join(piWebHome(), 'skills'),
    // 共享的用户级根目录：同类 agent 普遍遵循的 `.agents/skills` 约定。demo 运行与真实 home 隔离，与上面的全局根一致。
    userAgentsRoot: options.demo ? join(dataDir, 'agents-skills') : join(homedir(), '.agents', 'skills'),
    builtinRoot: resolve('skills'),
    pluginRoots: () => pluginStore.skillRoots(),
  })
  // 启动时对默认工作区探测沙盒能力；尚无工作区时无可探测，报告平台能力，
  // 由逐会话创建时对用户选定的工作区再测。
  const workspaceWriteAvailable = process.platform !== 'darwin'
    ? false
    : defaultWorkspace() === undefined || await workspaceWriteSupported(defaultWorkspace()!.path)
  const storage = await openNodeSqliteStorage(resolve(dataDir, 'pi-durable.sqlite'))
  // 先声明再装扩展，扩展闭包可在调用时读取 harness。
  let harness: Harness
  let teamService: ReturnType<typeof createTeam>
  const core = createCore({
    appState, modelRuntime, workspaceFiles,
    installedExtensions: () => registry.snapshot().installed(),
    isClosed: () => runtimeClosed,
    defaultWorkspace,
    projectTeam: (id) => teamService.projection(id),
    subagentSummaries: (id) => teamService.summaries(id),
  })
  const {
    assertOpen, requireConversation, ensureMetadata, withMetadata, markConversationSeen,
    detailFromView, currentDetail, selectedWorkspace, modelAllowlist,
    assertModelAllowed, firstAvailableAllowedModel, assertConversationModelAllowed,
    buildAgentChange, syncIdleAgents,
  } = core
  teamService = createTeam({
    appState,
    harness: () => harness,
    requireConversation,
    currentDetail,
    detailFromView,
    defaultWorkspace,
  })

  /**
   * 本项目启用的 Pi 1.3.0 能力：导入的 MCP 服务与 code mode。MCP 是对全局
   * `mcp.json` 的只读导入；文件缺失、条目损坏或服务失败只在 MCP 视图里报告，
   * 永不构成启动失败。
   */
  const mcpConfigPath = options.mcpConfigPath ??
    (options.demo ? join(dataDir, 'mcp.json') : join(options.piDir ?? dataDir, 'mcp.json'))
  const mcp = await McpRegistry.open({
    configPath: mcpConfigPath,
    pluginServers: () => pluginStore.mcpServers(),
  })
  const codemodeSandbox = new CodemodeSandbox({ memoryLimitBytes: 256 * 1024 * 1024 })
  const registry = createRegistry()
  // 工作政策扩展：chineseReasoning 闭包每请求读设置快照，开关切换在下一请求生效、无需重建 agent。
  registry.install(createWorkPolicyExtension({ dataDir, chineseReasoning: () => appState.snapshot().settings.chineseReasoning }))
  registry.install(createCompactionExtension({ harness: () => harness }))
  // 装在压缩扩展之后，使捕获的请求反映裁剪后的确切形状。
  registry.install(createTrajectoryExtension({
    dir: join(dataDir, TRAJECTORY_CAPTURE_DIR),
    enabled: process.env.PI_WEB_TRAJECTORY !== '0',
    fullRequest: process.env.PI_WEB_TRAJECTORY_FULL_REQUEST === '1',
    harness: () => harness,
  }))
  // 装在执行策略之前：其 section 落入计划模式过滤、其 write/edit 包装位于计划守卫之内。
  registry.install(createMemoryExtension({
    dataDir,
    memoryEnabled: () => appState.snapshot().settings.memoryEnabled,
  }))
  registry.install(CodingTools)
  registry.install(ResearchTools)
  registry.install(BrowserTools)
  registry.install(TodoTools)
  // 任务存储是宿主级的，因此工具惰性解析 feature：它在下方、装完这些工具安装期
  // 不需要的服务之后才创建。
  registry.install(createScheduleExtension({
    automations: {
      list: () => automationsFeature().list(),
      create: input => automationsFeature().create(input),
      update: (id, input) => automationsFeature().update(id, input),
      remove: id => automationsFeature().remove(id),
      run: id => automationsFeature().run(id),
    },
  }))
  // 分析记录比写出它们的会话更长寿：问题页在无关联会话时也能读回，因此存储放在应用数据目录。
  registry.install(createWetrackAnalysisExtension({
    dataDir,
    readDefect: async defectNumber => (await wetrackDefect(defectNumber)).defect,
    readDefects: async () => wetrackDefects(),
  }))
  registry.install(createGoalExtension({
    canCreate: async (id, context) => {
      const record = await harness.commit(tx => tx.conversation(id), context)
      return record !== undefined && record.owner === undefined
    },
    canContinue: async (id, context) => {
      const conversation = await harness.conversation(id, context)
      if (!conversation) return false
      const agent = await conversation.agent(context)
      const direct = new Set(agent.tools.map(tool => tool.name))
      const callable = new Set(agent.callable.map(tool => tool.name))
      return ['get_goal', 'update_goal'].every(name => direct.has(name) || direct.has(CODEMODE_TOOL_NAME) && callable.has(name))
    },
  }))
  registry.install(InteractionTools)
  registry.install(createPlanExtension({ readAccessMode: async (tx, conversationId) => (await tx.doc(META, conversationId)).accessMode }))
  registry.install(createSkillTools({
    store: skillStore,
    canWrite: async (conversationId, context) => {
      const metadata = await harness.snapshot(META, conversationId, context)
      const plan = await harness.snapshot(Plans, conversationId, context)
      return metadata !== undefined && (metadata.accessMode === 'fullAccess' || metadata.accessMode === 'workspaceWrite') && plan?.active !== true
    },
  }))
  // hooks 扩展常驻：配置在每次触发时热读，创建即生效（无需 reconfigure）；
  // 运行记录走 trajectory 同一 JSONL 通道。manage_hooks 的写授权门与 skill 同款。
  registry.install(createHooksExtension({
    store: hooksStore,
    resolveWorkspace: resolveHooksWorkspace,
    capture: createHookCapture(join(dataDir, TRAJECTORY_CAPTURE_DIR)),
  }))
  registry.install(createManageHooksTool({
    store: hooksStore,
    resolveWorkspace: resolveHooksWorkspace,
    canWrite: async (conversationId, context) => {
      const metadata = await harness.snapshot(META, conversationId, context)
      const plan = await harness.snapshot(Plans, conversationId, context)
      return metadata !== undefined && (metadata.accessMode === 'fullAccess' || metadata.accessMode === 'workspaceWrite') && plan?.active !== true
    },
  }))
  /** 委派模型选择在这里校验：目录、白名单与等级支持都在此汇聚。 */
  const resolveChildModel = createChildModelResolver({
    models: modelRuntime.models,
    allowlist: () => appState.snapshot().settings.modelAllowlist,
    supportedThinkingLevels: (provider, modelId) => modelRuntime.supportedThinkingLevels(provider, modelId),
  })
  /**
   * 功能：目录中白名单覆盖且 Provider 已配置凭据的模型清单。
   * @returns 前 `SUBAGENT_MODEL_LIST_LIMIT` 个模型与总数，截断时前端显示「等 N 个」
   * 内部逻辑：按 Provider 只查一次凭据（缓存），逐 Provider checkAuth 探测配置状态。
   */
  const availableChildModels = async (): Promise<ChildModelList> => {
    const listed = modelRuntime.models.getModels()
      .filter(model => modelWithinAllowlist(appState.snapshot().settings.modelAllowlist, { provider: model.provider, modelId: model.id }))
      .map(model => ({ provider: model.provider, modelId: model.id }))
    const configured = new Map<string, boolean>()
    for (const pick of listed) {
      if (configured.has(pick.provider)) continue
      try { configured.set(pick.provider, await modelRuntime.models.checkAuth(pick.provider) !== undefined) }
      catch { configured.set(pick.provider, false) }
    }
    const usable = listed.filter(pick => configured.get(pick.provider) === true)
    return { models: usable.slice(0, SUBAGENT_MODEL_LIST_LIMIT), total: usable.length }
  }
  /** 后台委派结算：分离的等待，把子会话结果注入父会话。 */
  const subagentSettlement = createSubagentSettlement({ harness: () => harness })
  registry.install(createSubagentTools({
    prepareChild: teamService.prepareChild,
    resolveChildModel,
    availableChildModels,
    settleWhenAnswered: subagentSettlement.settleWhenAnswered,
  }))
  registry.install(createTeamTools({
    prepareChild: teamService.prepareChild,
    conversationInfo: teamService.conversationInfo,
    watchMembers: teamService.watchMembers,
    memberSession: teamService.memberSession,
    resolveChildModel,
  }))
  // 无工具：仅从实时插件投影追加每请求提醒。
  registry.install(createPluginReferenceExtension({
    capabilities: () => pluginReferenceCapabilities(pluginStore.overview()),
  }))
  /** Pi 的延迟工具加载器；MCP 工具集变化时重新安装。 */
  const TOOL_SEARCH_EXTENSION_NAME = 'tool-search'
  /**
   * 功能：让 MCP 呈现（code mode 命名空间、`mcp` 工具、`tool_search`）与执行策略
   * 与当前连接保持同步。
   * @returns 无返回
   * 内部逻辑：先卸载旧的四件（codemode、MCP、tool-search、执行策略）再按序重装；
   * 执行策略必须保持最后——它捕获已安装工具快照，因此每次变化都在 MCP 组之后
   * 重装它。存在 deferred 工具时才安装 tool-search 加载器。
   */
  const refreshMcpExtensions = (): void => {
    const current = registry.snapshot()
    const policy = current.extension(EXECUTION_POLICY_EXTENSION_NAME)
    if (policy !== undefined) registry.uninstall(policy)
    const search = current.extension(TOOL_SEARCH_EXTENSION_NAME)
    if (search !== undefined) registry.uninstall(search)
    const previousMcp = current.extension(MCP_EXTENSION_NAME)
    if (previousMcp !== undefined) registry.uninstall(previousMcp)
    const previousCodemode = current.extension(CODEMODE_EXTENSION_NAME)
    if (previousCodemode !== undefined) registry.uninstall(previousCodemode)

    registry.install(createRuntimeCodemodeExtension({ sandbox: codemodeSandbox, namespaces: mcp.namespaces() }))
    const mcpExtension = mcp.extension()
    if (mcpExtension !== undefined) registry.install(mcpExtension)
    // `tool_search` 把延迟的 MCP 工具装进模型的下一次请求。codemode 或 deferred
    // 暴露下的工具都注册为 deferred（脚本可直接调用）；存在这类工具时才装加载器。
    if (mcpExtension?.tools?.some(tool => tool.deferred === true) === true) {
      registry.install(createToolSearchExtension())
    }
    registry.install(createExecutionPolicyExtension(registry.snapshot().installed()))
  }
  refreshMcpExtensions()

  const pluginListeners = new Set<() => void>()
  /** 向全部插件监听者扇出变更通知；单个监听者掉线不影响其余。 */
  const notifyPluginListeners = (): void => {
    for (const listener of [...pluginListeners]) {
      try { listener() } catch { /* 单个事件流掉线不得中断重载 */ }
    }
  }
  /** 插件驱动的重载串行化：安装/卸载/启用可能背靠背到来。 */
  let pluginRefreshTail: Promise<void> = Promise.resolve()
  let runtimeClosed = false
  /** 仅技能层的插件变化不得重连用户自己的 MCP 服务。 */
  let lastMcpProjection = JSON.stringify(pluginStore.mcpServers())
  onPluginChange = (event) => {
    notifyPluginListeners()
    if (event.reason === 'operation' || event.reason === 'marketplace') return
    pluginRefreshTail = pluginRefreshTail.then(async () => {
      if (runtimeClosed) return
      const projection = JSON.stringify(pluginStore.mcpServers())
      if (projection !== lastMcpProjection) {
        try {
          await mcp.reload()
          refreshMcpExtensions()
          lastMcpProjection = projection
        } catch {
          // 重载失败保留既有连接；每个服务的状态见 MCP 视图。
        }
      }
      notifyPluginListeners()
    }, () => undefined)
  }
  let closePromise: Promise<void> | undefined
  const activeWatchStops = new Set<() => Promise<void>>()
  harness = await Harness.open(storage, {
    // 每条 Provider 流的最终消息都会被打上 `ttftMs`。
    models: wrapModelsWithTrajectory(modelRuntime.models),
    registry,
    settings: { compaction: COMPACTION_POLICY },
    /** 按会话解析执行环境：工作区路径、访问模式、记忆根与额外可写目录。 */
    env: async (target) => {
      const metadata = await harness.snapshot(META, target.conversationId, CTX)
      const workspaceId = metadata?.workspaceId ?? defaultWorkspace()?.id
      const selectedWorkspace = workspaceId === undefined
        ? undefined
        : appState.snapshot().workspaces.find(item => item.id === workspaceId)
      if (selectedWorkspace === undefined) {
        throw new RuntimeError('INVALID_INPUT', '此会话没有可用的工作区，请先在侧栏添加工作区')
      }
      const selectedMode = metadata?.accessMode ?? appState.snapshot().settings.defaultAccessMode
      const memoryRoot = appState.snapshot().settings.memoryEnabled
        ? resolveMemoryRoot({ dataDir, workspacePath: selectedWorkspace.path })
        : undefined
      if (memoryRoot !== undefined && selectedMode !== 'readOnly') void ensureMemoryDirectory(memoryRoot)
      const extraWriteRoots = memoryRoot !== undefined && selectedMode === 'workspaceWrite' ? [memoryRoot] : []
      return createExecutionEnv(selectedWorkspace.path, selectedMode, extraWriteRoots)
    },
    /** 新会话创建钩子：注入运行时政策扩展与元数据初值；fork 继承父会话的字段。 */
    conversationCreated: async (tx, conversation) => {
      await ensureRuntimePolicy(tx, conversation)
      const metadata = await tx.doc(META, conversation.id)
      const now = Date.now()
      metadata.createdAt = now
      metadata.updatedAt = now
      metadata.archived = false
      metadata.pinned = false
      metadata.titleSource = 'auto'
      metadata.queueCreatedAt = {}
      metadata.requestReceipts = {}
      metadata.title = DEFAULT_TITLE
      metadata.workspaceId = defaultWorkspace()?.id ?? null
      metadata.accessMode = appState.snapshot().settings.defaultAccessMode
      metadata.feedback = {}
      metadata.queueEdits = {}
      if (conversation.parent) {
        const parent = await tx.doc(META, conversation.parent.conversationId)
        metadata.title = parent.title === DEFAULT_TITLE ? 'Fork' : `${parent.title} (fork)`
        metadata.workspaceId = parent.workspaceId ?? defaultWorkspace()?.id ?? null
        metadata.accessMode = parent.accessMode ?? appState.snapshot().settings.defaultAccessMode
        metadata.feedback = {}
        metadata.queueEdits = {}
        const parentPlan = await tx.doc(Plans, conversation.parent.conversationId)
        if (parentPlan.active) {
          const plan = await tx.doc(Plans, conversation.id)
          plan.active = true
          plan.updatedAt = now
        }
      }
    },
    onReport: () => undefined,
  }, CTX)
  core.setHarness(harness)

  const memoryExtraction = createMemoryExtraction({
    harness: () => harness,
    models: () => modelRuntime.models,
    dataDir,
    memoryEnabled: () => appState.snapshot().settings.memoryEnabled,
    defaultModel: () => modelRuntime.defaultModel,
    accessMode: async (conversationId) => (await harness.snapshot(META, conversationId, CTX))?.accessMode,
    thinkingLevels: (provider, modelId) => modelRuntime.supportedThinkingLevels(provider, modelId),
    recordUsage: async (conversationId, model, usage) => {
      const key = `${model.provider}/${model.modelId}`
      await harness.commit(async tx => {
        const record = await tx.doc(UsageDoc, conversationId)
        const total = record.models[key]
        if (total === undefined) record.models[key] = structuredClone(usage) as unknown as typeof total
        else accumulateUsage(total as unknown as Usage, usage)
      }, CTX)
    },
  })
  /** 会话 feature：创建、配置、提交、停止、计划、分叉、重试与实时订阅。 */
  const conversationsService = createConversations({
    appState, harness: () => harness, modelRuntime, workspaceFiles, memoryExtraction, assertOpen, requireConversation,
    ensureMetadata, withMetadata, markConversationSeen, detailFromView, currentDetail,
    selectedWorkspace, assertModelAllowed, assertConversationModelAllowed, buildAgentChange,
    defaultWorkspace,
  })

  /** 队列 feature：排队消息的编辑与撤回，复用会话提交入口保证幂等。 */
  const queueService = createQueue({
    harness: () => harness, requireConversation, ensureMetadata, withMetadata,
    submitWithReferences: conversationsService.submitWithReferences, workspaceFiles, defaultWorkspace,
  })
  /** 交互回复 feature：回答与放弃 ask_user_question / 计划审阅。 */
  const interactionsService = createInteractionReplies({
    harness: () => harness, requireConversation, currentDetail, assertConversationModelAllowed,
  })

  /** 设置 feature：应用设置读写与模型/Provider 的白名单过滤面。 */
  const settingsService = createSettings({
    appState, modelRuntime, workspaceWriteAvailable, assertOpen, syncIdleAgents,
    assertModelAllowed, modelAllowlist, launchWorkspace,
  })

  /** 工作区 feature：注册、目录选择、文件面与 Git 能力面。 */
  const workspacesService = createWorkspaces({
    appState, modelRuntime, workspaceFiles, list: conversationsService.list, withMetadata, parseConversationId,
    assertNoAutomationReferences: (...args) => automationsFeature().assertNoAutomationReferences(...args),
    conversationModel: async (value: string) => (await requireConversation(value)).agent(CTX).then(agent => agent.model),
  })

  let automationsService: ReturnType<typeof createAutomations> | undefined
  /** 自动化 feature 的惰性创建：schedule 工具安装期不需要它。 */
  const automationsFeature = (): ReturnType<typeof createAutomations> => {
    automationsService ??= createAutomations({
      appState, modelRuntime, isClosed: () => runtimeClosed, requireConversation, currentDetail,
      selectedWorkspace, assertModelAllowed,
      create: (input) => conversationsService.create(input),
      submit: (value, input) => conversationsService.submit(value, input),
    })
    return automationsService
  }

  /** 记录操作者反馈（文本 ≤2000 字符，userAgent 截到 500 字符）。 */
  const sendFeedback = async (input: { text: string; userAgent?: string }): Promise<void> => {
    assertOpen()
    const text = input.text.trim()
    if (!text || text.length > 2_000) throw new RuntimeError('INVALID_INPUT', '反馈内容必须在 1 到 2000 个字符之间')
    const userAgent = input.userAgent?.trim()
    await appState.recordFeedback({
      text,
      createdAt: Date.now(),
      ...(userAgent ? { userAgent: userAgent.slice(0, 500) } : {}),
    })
  }

  /** 独立问题页数据源：CLI 读取或内置 demo fixture，绝不经过模型。 */
  const wetrackDefects = async (): Promise<WetrackDefectList> => readWetrackDefects(
    options.demo === true && !wetrackConfigured() ? { fixture: builtinFixturePath() } : {},
  )
  /** 单个缺陷详情；demo 且未配置时回退内置 fixture。 */
  const wetrackDefect = async (defectNumber: string): Promise<WetrackDefectDetail> => readWetrackDefect(defectNumber,
    options.demo === true && !wetrackConfigured() ? { fixture: builtinFixturePath() } : {},
  )
  /** 单个缺陷的报告页数据。 */
  const wetrackReport = async (defectNumber: string): Promise<WetrackDefectReport> => readWetrackReport(defectNumber, { dataDir: options.dataDir })
  /** 问题列表的徽标数据；正文按缺陷单独拉取，列表保持轻量。 */
  const wetrackAnalyses = async (): Promise<WetrackAnalysisIndex> => ({
    analyses: await listWetrackAnalyses(dataDir),
  })
  /** 读取单个缺陷的历史分析记录；无记录返回 null。 */
  const wetrackAnalysis = async (defectNumber: string): Promise<WetrackAnalysisRecord | null> =>
    await readWetrackAnalysis(dataDir, defectNumber) ?? null
  /** 问题分析运行：由会话 feature 执行的分析任务存储。 */
  const analysisRuns = createWetrackAnalysisRuns({
    dataDir,
    create: conversationsService.create,
    submit: conversationsService.submit,
    requireConversation,
    currentDetail: id => currentDetail(parseConversationId(id)),
    selectedWorkspace: id => selectedWorkspace(id),
    analysisModel: () => {
      const modelId = 'deepseek-v4.1-flash'
      for (const provider of modelRuntime.models.getProviders()) {
        if (provider.id === 'codebuddy' && modelRuntime.models.getModel(provider.id, modelId) !== undefined) return { provider: provider.id, modelId }
      }
      return undefined
    },
    supportedThinkingLevels: () => {
      const modelId = 'deepseek-v4.1-flash'
      for (const provider of modelRuntime.models.getProviders()) {
        if (provider.id === 'codebuddy' && modelRuntime.models.getModel(provider.id, modelId) !== undefined) {
          return modelRuntime.supportedThinkingLevels(provider.id, modelId) ?? []
        }
      }
      return []
    },
    activateSkills: async workspace => {
      const catalog = await skillStore.list(workspace.path)
      const priority = { agents: 0, pi: 1, plugin: 2, 'user-agents': 3, global: 4, builtin: 5 }
      const selected = catalog.skills.filter(skill => skill.name === 'rd-cli-ops')
        .toSorted((left, right) => priority[left.source] - priority[right.source])[0]
      if (selected === undefined) return { skillIds: [] }
      return { skillIds: [selected.source === 'plugin' ? selected.id : selected.name] }
    },
  })
  await analysisRuns.recover()
  for (const run of await analysisRuns.list()) {
    if (run.conversationId === undefined) continue
    const id = parseConversationId(run.conversationId)
    if ((await harness.snapshot(CONVERSATION_KIND, id, CTX))?.kind === 'defectAnalysis') continue
    await harness.commit(async tx => {
      const kind = await tx.doc(CONVERSATION_KIND, id)
      kind.kind = 'defectAnalysis'
    }, CTX)
  }

  // 每晚的问题分析只装配一次，且只在操作者已绑定分析工作区后。已删除的任务
  // 保持删除：标记文件记住它已被提供过。仍在的任务把提示词与工作区同步到
  // 当前分析规程。
  const provisionWetrackDaily = async (): Promise<void> => {
    const binding = await analysisRuns.workspaceBinding()
    if (binding.workspaceId === undefined) return
    const { model } = await analysisRuns.settings()
    const spec = {
      key: WETRACK_DAILY_AUTOMATION_KEY,
      name: '问题清单每日分析',
      prompt: wetrackDailyCoordinatorPrompt(),
      rrule: WETRACK_DAILY_RRULE,
      workspaceId: binding.workspaceId,
      accessMode: 'readOnly' as const,
      ...(model === undefined ? {} : { model }),
    }
    const existing = automationsFeature().list().find(item => item.builtin === WETRACK_DAILY_AUTOMATION_KEY)
    if (existing === undefined) {
      if (await wetrackDailyProvisioned(dataDir)) return
      await automationsFeature().ensureBuiltin(spec)
      await markWetrackDailyProvisioned(dataDir)
      return
    }
    await automationsFeature().ensureBuiltin(spec)
  }
  await provisionWetrackDaily()

  // 提交恢复可能自行启动调度器。在任何恢复路径被允许提交或续跑之前，
  // 先给每个存量会话装上政策守卫。
  let policyCursor: Cursor | undefined
  do {
    const page = await harness.commit(tx => tx.scanConversations({ order: 'ascending' }, 250, policyCursor), CTX)
    for (const record of page.items) await harness.commit(async tx => {
      const metadata = await tx.doc(META, record.id)
      if (/^WeTrack DTS\d{3,16} 代码分析$/u.test(metadata.title) || metadata.title.startsWith('问题分析 · DTS')) {
        const kind = await tx.doc(CONVERSATION_KIND, record.id)
        kind.kind = 'defectAnalysis'
      }
      await ensureRuntimePolicy(tx, record)
    }, CTX)
    policyCursor = page.next
  } while (policyCursor)
  await queueService.recover()
  await automationsFeature().recover()
  await teamService.reconcileRosters()
  // 在 resume 之前：因崩溃丢失的后台委派现在结算，调度器恢复后注入的消息
  // 会开启父会话的 follow-up 运行。
  await subagentSettlement.reconcileBackgroundDelegations()
  harness.resume()
  // 升级会把 code mode 加入既有注册表，而 agent 选择是按会话存储的：
  // 先把空闲会话对齐到当前呈现再开始服务。
  await syncIdleAgents()

  /** 插件 feature：市场操作与插件 UI 宿主桥接。 */
  const pluginsService = createPlugins({
    pluginStore, mcp, harness: () => harness, listeners: pluginListeners,
    flushRefresh: () => pluginRefreshTail.catch(() => undefined),
  })

  /** 编辑器读取的文件与提示词 section 相同，因此保存对下一次请求生效。 */
  const personalizationView = async (): Promise<PersonalizationView> => {
    const record = await readPersonalization(dataDir)
    return { content: record.content, filePath: record.filePath, limitBytes: MAX_PERSONALIZATION_BYTES }
  }

  /** 面向 HTTP 层的 Runtime 契约：全部按 feature 分组透传。 */
  return {
    /** 列出全部无主会话摘要。 */
    list: () => conversationsService.list(),
    /** 创建新会话。 */
    create: (input) => conversationsService.create(input),
    // 读取详情就是客户端的「查看会话」；侧栏未读点在下一次列表刷新时清除。
    // 内部调用方直接用 `currentDetail`。
    detail: (value) => conversationsService.detail(value),
    /** 更新会话标题/归档/置顶/工作区/模式/模型/思考等级。 */
    update: (value, input) => conversationsService.update(value, input),
    /** 向会话提交一条用户消息。 */
    submit: (value, input) => conversationsService.submit(value, input),
    /** 回答一条 pending 交互（问答或计划审阅）。 */
    answerInteraction: (value, callId, answers) => interactionsService.answerInteraction(value, callId, answers),
    /** 放弃一条 pending 交互。 */
    cancelInteraction: (value, callId) => interactionsService.cancelInteraction(value, callId),
    /** 编辑一条排队消息并提交替换。 */
    editQueued: (value, submissionId, input) => queueService.editQueued(value, submissionId, input),
    /** 停止会话当前运行。 */
    stop: (value) => conversationsService.stop(value),
    /** 触发上下文压缩。 */
    compact: (value) => conversationsService.compact(value),
    /** 导出会话的完整执行轨迹（SQL + 捕获目录拼装）。 */
    trajectory: async (value) => {
      const conversation = await requireConversation(value)
      return await assembleTrajectory({
        dbPath: resolve(dataDir, 'pi-durable.sqlite'),
        captureDir: join(dataDir, TRAJECTORY_CAPTURE_DIR),
        conversationId: String(conversation.id),
      })
    },
    /** 创建/更新会话目标。 */
    goal: (value, input) => conversationsService.goal(value, input),
    /** 开关计划模式。 */
    setPlan: (value, active) => conversationsService.setPlan(value, active),
    /** 读取会话的完整团队视图。 */
    team: (value) => teamService.team(value),
    /** 列出会话的子智能体目录。 */
    children: (value) => teamService.children(value),
    /** 给一个直属子会话发消息。 */
    childMessage: (value, childValue, input) => teamService.childMessage(value, childValue, input),
    /** 停止一个直属子会话。 */
    childStop: (value, childValue) => teamService.childStop(value, childValue),
    /** 撤回一条排队消息。 */
    removeQueued: (value, submissionId) => queueService.removeQueued(value, submissionId),
    /** 从指定条目分叉新会话。 */
    fork: (value, entryId) => conversationsService.fork(value, entryId),
    /** 从指定位置重试（分叉 + 重放提交）。 */
    retry: (value, entryId, requestId) => conversationsService.retry(value, entryId, requestId),
    /** 订阅会话实时详情，返回取消订阅函数。 */
    watch: (value, listener) => conversationsService.watch(value, listener),
    /** 读取白名单过滤后的模型目录（含默认模型修正写回）。 */
    catalog: () => settingsService.catalog(),
    /** 订阅模型目录重载通知，返回取消订阅函数。 */
    watchModels: (listener: () => void) => {
      modelListeners.add(listener)
      return () => { modelListeners.delete(listener) }
    },
    /** 保存 Provider 配置（隐藏模型合并回写）。 */
    saveProvider: (input) => settingsService.saveProvider(input),
    /** 读取单个 Provider 配置摘要。 */
    provider: (id) => settingsService.provider(id),
    /** 删除 Provider 配置。 */
    deleteProvider: (id) => settingsService.deleteProvider(id),
    /** Provider 连通性测试（仅限白名单内模型）。 */
    testProvider: (id, modelId) => settingsService.testProvider(id, modelId),
    /** 发现 Provider 端点提供的模型清单。 */
    discoverProvider: (id) => settingsService.discoverProvider(id),
    /** 读取应用设置快照。 */
    settings: () => settingsService.settings(),
    /** 读取个性化提示词编辑视图。 */
    personalization: async (): Promise<PersonalizationView> => personalizationView(),
    /** 保存个性化提示词并返回最新视图。 */
    savePersonalization: async (content: string): Promise<PersonalizationView> => {
      await writePersonalization(dataDir, content)
      return personalizationView()
    },
    /** 钩子清单：用户级与项目级来源、逐条信任状态。 */
    hooks: (workspaceId?: string) => hooksFeature.list(workspaceId),
    /** 整体替换来源钩子配置（项目级编辑不自动批准）。 */
    saveHooks: (input: Parameters<typeof hooksFeature.save>[0]) => hooksFeature.save(input),
    /** 批准一条项目级钩子。 */
    trustHook: (input: Parameters<typeof hooksFeature.trust>[0]) => hooksFeature.trust(input),
    /** 撤销一条项目级钩子的信任。 */
    revokeHook: (input: Parameters<typeof hooksFeature.revoke>[0]) => hooksFeature.revoke(input),
    /** 删除一条钩子（事件内 index 定位）。 */
    removeHookEntry: (input: Parameters<typeof hooksFeature.removeEntry>[0]) => hooksFeature.removeEntry(input),
    /** 启停一条钩子。 */
    setHookEnabled: (input: Parameters<typeof hooksFeature.setEnabled>[0]) => hooksFeature.setEnabled(input),
    /** MCP 视图：服务、工具与连接状态。 */
    mcp: () => mcp.view(),
    /** 能力声明：可选的访问模式。 */
    capabilities: () => settingsService.capabilities(),
    /** 更新应用设置。 */
    updateSettings: (input) => settingsService.updateSettings(input),
    /** 用系统默认程序打开应用配置文件。 */
    openConfigFile: () => settingsService.openConfigFile(),
    /** 工作区列表。 */
    workspaces: () => workspacesService.list(),
    /** 添加工作区。 */
    addWorkspace: (input) => workspacesService.add(input),
    /** 重命名工作区。 */
    renameWorkspace: (id, input) => workspacesService.rename(id, input),
    /** 注销工作区并改绑其会话。 */
    deleteWorkspace: (id) => workspacesService.remove(id),
    /** 唤起系统原生目录选择器。 */
    pickDirectory: (signal) => workspacesService.pickDirectory(signal),
    /** 列出目录内容（树形选择）。 */
    listDirectories: (dir) => workspacesService.listDirectories(dir),
    /** 在父目录下创建子目录。 */
    createDirectory: (parent, name) => workspacesService.createDirectory(parent, name),
    /** 列出工作区文件。 */
    workspaceFiles: (id, path, query) => workspacesService.fileList(id, path, query),
    /** 全工作区搜索。 */
    searchWorkspace: (id, query) => workspacesService.search(id, query),
    /** 读取工作区文本文件。 */
    workspaceFile: (id, path, line) => workspacesService.file(id, path, line),
    /** 读取工作区二进制资源。 */
    workspaceAsset: (id, path) => workspacesService.asset(id, path),
    /** 分支快照。 */
    gitBranches: (id) => workspacesService.gitBranches(id),
    /** 切换分支。 */
    switchGitBranch: (id, input) => workspacesService.switchGitBranch(id, input),
    /** 新建分支。 */
    createGitBranch: (id, input) => workspacesService.createGitBranch(id, input),
    /** 变基状态。 */
    gitWorktreeStatus: (id) => workspacesService.gitWorktreeStatus(id),
    /** 单文件差异。 */
    gitWorktreeDiff: (id, path, sourceId) => workspacesService.gitWorktreeDiff(id, path, sourceId),
    /** 按暂存内容提交。 */
    gitCommit: (id, input) => workspacesService.gitCommit(id, input),
    /** 推送当前分支。 */
    gitPush: (id) => workspacesService.gitPush(id),
    /** 模型生成提交信息建议。 */
    gitCommitMessage: (id, input) => workspacesService.gitCommitMessage(id, input),
    /** 列出工作区可用技能。 */
    skills: async (workspaceId) => skillStore.list(workspaceFiles.workspace(workspaceId).path),
    /** 加载技能（入口文档或附属资源）。 */
    skill: async (workspaceId, skillId, resource) => skillStore.load(workspaceFiles.workspace(workspaceId).path, skillId, resource),
    /** 校验技能清单。 */
    validateSkill: async (workspaceId, skillId) => skillStore.validate(workspaceFiles.workspace(workspaceId).path, skillId),
    /** 插件总览。 */
    plugins: () => pluginsService.overview(),
    /** 添加插件市场来源。 */
    addPluginMarketplace: (source) => pluginsService.addMarketplace(source),
    /** 删除插件市场来源。 */
    removePluginMarketplace: (id) => pluginsService.removeMarketplace(id),
    /** 刷新插件市场。 */
    refreshPluginMarketplace: (id) => pluginsService.refreshMarketplace(id),
    /** 安装插件。 */
    installPlugin: (input) => pluginsService.install(input),
    /** 更新插件。 */
    updatePlugin: (pluginId) => pluginsService.update(pluginId),
    /** 读取插件描述。 */
    describePlugin: (pluginId) => pluginsService.describe(pluginId),
    /** 卸载插件（可选保留数据）。 */
    uninstallPlugin: (pluginId, keepData) => pluginsService.uninstall(pluginId, keepData ?? false),
    /** 启用/停用插件。 */
    setPluginEnabled: (pluginId, enabled) => pluginsService.setEnabled(pluginId, enabled),
    /** 订阅插件变更通知。 */
    watchPlugins: (listener) => pluginsService.watch(listener),
    /** 插件 UI surface 清单。 */
    pluginUiSurfaces: () => pluginsService.uiSurfaces(),
    /** 渲染插件 UI 页面。 */
    pluginUiPage: (input) => pluginsService.uiPage(input),
    /** 从插件页面调用插件工具。 */
    pluginUiCall: (input) => pluginsService.uiCall(input),
    /** 读取插件 UI 资源原文。 */
    pluginUiReadResource: (input) => pluginsService.uiReadResource(input),
    /** 记录/清除一条消息的反馈。 */
    feedback: (value, entryValue, rating) => conversationsService.feedback(value, entryValue, rating),
    /** 记录操作者反馈。 */
    sendFeedback,
    /** 定时任务列表。 */
    automations: () => automationsFeature().list(),
    /** 创建定时任务。 */
    createAutomation: (input) => automationsFeature().create(input),
    /** 更新定时任务。 */
    updateAutomation: (id, input) => automationsFeature().update(id, input),
    /** 删除定时任务。 */
    deleteAutomation: (id) => automationsFeature().remove(id),
    /** 手动执行一次定时任务。 */
    runAutomation: (id) => automationsFeature().run(id),
    /** 定时任务运行历史。 */
    automationRuns: (id) => automationsFeature().runs(id),
    /** 清除规则已耗尽的定时任务。 */
    purgeEndedAutomations: () => automationsFeature().purgeEnded(),
    /** 问题清单列表（CLI 或内置 fixture）。 */
    wetrackDefects,
    /** 单个缺陷详情。 */
    wetrackDefect,
    /** 缺陷报告页数据。 */
    wetrackReport,
    /** 分析徽标列表。 */
    wetrackAnalyses,
    /** 单个缺陷的历史分析记录。 */
    wetrackAnalysis,
    /** 分析运行列表。 */
    wetrackAnalysisRuns: analysisRuns.list,
    /** 启动一次问题分析。 */
    startWetrackAnalysis: analysisRuns.start,
    /** 读取分析设置。 */
    wetrackAnalysisSettings: analysisRuns.settings,
    /** 更新分析设置（绑定工作区与思考等级）。 */
    updateWetrackAnalysisSettings: async input => {
      if (input.workspaceId === null || input.workspaceId === undefined) return analysisRuns.settings()
      return analysisRuns.bindWorkspace(input.workspaceId, input.thinkingLevel)
    },
    /** 关闭运行时：按顺序停止接收、drain 后台任务、关闭 harness 与沙盒/MCP。 */
    async close() {
      if (!closePromise) {
        runtimeClosed = true
        automationsService?.close()
        memoryExtraction.shutdown()
        disposeShellSessions()
        unsubscribeModels()
        modelListeners.clear()
        modelRuntime.close()
        closePromise = (async () => {
          try {
            await conversationsService.closeWatches()
          } finally {
            try {
              await memoryExtraction.drain(MEMORY_EXTRACTION_DRAIN_MS)
              await subagentSettlement.drain()
              // 捕获写入是即发即忘的追加；关闭前 drain，防止测试的临时目录删除
              // 与仍在排队的轨迹行竞争。
              await drainTrajectoryCapture()
              await harness.close(CTX)
              await automationsService?.drain()
              await analysisRuns.drain()
            } finally {
              await pluginRefreshTail.catch(() => undefined)
              await Promise.allSettled([codemodeSandbox.close(), mcp.close()])
            }
          }
        })()
      }
      await closePromise
    },
  }
}
