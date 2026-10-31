import { randomUUID } from 'node:crypto'
import { mkdir, realpath } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import { Harness, UsageDoc } from '@earendil-works/pi-durable'
import type { Cursor } from '@earendil-works/pi-durable'
import { CodingTools } from '../tools/shell/tools.ts'
import { createRegistry } from '@earendil-works/pi-durable'
import { CODEMODE_TOOL_NAME } from '@earendil-works/pi-durable/codemode'
import { createToolSearchExtension } from '@earendil-works/pi-durable/tool-search'
import { CodemodeSandbox } from '@earendil-works/pi-codemode'
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node'
import type { Usage } from '@earendil-works/pi-ai'
import type { Runtime, RuntimeOptions } from '../contracts.ts'
import type { WetrackDefectDetail, WetrackDefectList, WetrackDefectReport, WorkspaceSummary } from '../../shared/types.ts'
import { createModelRuntime } from '../model/catalog.ts'
import { createDemoModelRuntime } from '../model/demo.ts'
import { RuntimeError } from '../runtime-errors.ts'
import { builtinFixturePath, readWetrackDefect, readWetrackDefects, readWetrackReport, wetrackConfigured } from '../automation/wetrack.ts'
import { TodoTools } from '../tools/todo.ts'
import { createGoalExtension } from '../tools/goal.ts'
import { InteractionTools } from '../tools/interaction.ts'
import { PlanExtension, Plans } from '../tools/plan.ts'
import { createSubagentTools } from '../tools/subagent.ts'
import { createTeamTools } from '../tools/team.ts'
import { MCP_EXTENSION_NAME, McpRegistry } from '../mcp/registry.ts'
import { SkillStore } from '../skills/store.ts'
import { piWebHome } from '../state/home.ts'
import { createSkillTools } from '../tools/skill.ts'
import { createWorkPolicyExtension } from '../conversation/work-policy.ts'
import { createExecutionPolicyExtension, EXECUTION_POLICY_EXTENSION_NAME } from '../conversation/execution-policy.ts'
import { createRuntimeCodemodeExtension } from '../codemode-policy.ts'
import { ResearchTools } from '../tools/research.ts'
import { COMPACTION_POLICY, createCompactionExtension } from '../conversation/compaction.ts'
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
import { disposeBackgroundShells } from '../tools/shell/runner.ts'
import { createAutomations } from './automations.ts'
import { createWorkspaces } from './workspaces.ts'
import { createPresets } from './presets.ts'
import { createSettings } from './settings.ts'
import { createPlugins } from './plugins.ts'
import { createTeam } from './team.ts'
import { createQueue } from './queue.ts'
import { createConversations } from './conversations.ts'
import { createCore } from './core.ts'
import { createInteractionReplies } from './interactions.ts'

import { CODEMODE_EXTENSION_NAME, CTX, DEFAULT_TITLE, META, accumulateUsage, ensureRuntimePolicy, parseConversationId } from './helpers.ts'

export async function createRuntime(options: RuntimeOptions): Promise<Runtime> {
  const dataDir = resolve(options.dataDir)
  const requestedWorkspace = options.workspace === undefined ? undefined : resolve(options.workspace)
  await mkdir(dataDir, { recursive: true, mode: 0o700 })
  if (requestedWorkspace !== undefined) await mkdir(requestedWorkspace, { recursive: true })
  const initialWorkspacePath = requestedWorkspace === undefined ? undefined : await realpath(requestedWorkspace)
  const modelRuntime = options.demo ? createDemoModelRuntime() : await createModelRuntime({ dataDir, piDir: options.piDir })
  /** Catalog reloads (file edits, saves, another instance) fanned out to web clients. */
  const modelListeners = new Set<() => void>()
  const unsubscribeModels = modelRuntime.subscribe(() => {
    for (const listener of [...modelListeners]) {
      try { listener() } catch { /* a dropped event stream must not stop the reload */ }
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
   * The live default workspace: whatever the current settings point at, resolved
   * against the current list so deleting it takes effect on the next read instead
   * of keeping a startup-time object alive.
   */
  const defaultWorkspace = (): WorkspaceSummary | undefined => {
    const state = appState.snapshot()
    return state.workspaces.find(item => item.id === state.settings.defaultWorkspaceId)
  }
  const workspaceFiles = new WorkspaceFiles(() => appState.snapshot().workspaces)
  const gitBranches = new GitBranches(() => appState.snapshot().workspaces)
  const gitWorktree = new GitWorktree(() => appState.snapshot().workspaces)
  let onPluginChange: (event: PluginChangeEvent) => void = () => undefined
  const pluginStore = await PluginStore.open({ dataDir, onChange: event => onPluginChange(event) })
  const skillStore = new SkillStore({
    // ZCode-style user-level root: read-only skills shared across every workspace.
    // Demo runs stay isolated from the real global home.
    globalRoot: options.demo ? join(dataDir, 'skills') : join(piWebHome(), 'skills'),
    pluginRoots: () => pluginStore.skillRoots(),
  })
  // Probe the sandbox against the default workspace at startup; with no workspace yet there is
  // nothing to probe, so report the platform capability and let per-conversation creation re-test
  // against whichever workspace the user picks.
  const workspaceWriteAvailable = process.platform !== 'darwin'
    ? false
    : defaultWorkspace() === undefined || await workspaceWriteSupported(defaultWorkspace()!.path)
  const storage = await openNodeSqliteStorage(resolve(dataDir, 'pi-durable.sqlite'))
  // Declared before the extensions so their closures can read the harness at call time.
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
    detailFromView, currentDetail, selectedWorkspace, selectedPreset, modelAllowlist,
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
   * Pi 1.3.0 capabilities this project turns on: imported MCP servers and code mode.
   * MCP is a read-only import of the global `mcp.json`; a missing file, a bad
   * entry, or a failing server is reported in the MCP view, never a startup failure.
   */
  const mcpConfigPath = options.mcpConfigPath ??
    (options.demo ? join(dataDir, 'mcp.json') : join(options.piDir ?? dataDir, 'mcp.json'))
  const mcp = await McpRegistry.open({
    configPath: mcpConfigPath,
    pluginServers: () => pluginStore.mcpServers(),
  })
  const codemodeSandbox = new CodemodeSandbox({ memoryLimitBytes: 256 * 1024 * 1024 })
  const registry = createRegistry()
  registry.install(createWorkPolicyExtension())
  registry.install(createCompactionExtension({ harness: () => harness }))
  // Installed before the execution policy so its sections are covered by the plan-mode filter and
  // its write/edit wraps sit inside the plan guard.
  registry.install(createMemoryExtension({
    dataDir,
    memoryEnabled: () => appState.snapshot().settings.memoryEnabled,
  }))
  registry.install(CodingTools)
  registry.install(ResearchTools)
  registry.install(TodoTools)
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
  registry.install(PlanExtension)
  registry.install(createSkillTools({
    store: skillStore,
    canWrite: async (conversationId, context) => {
      const metadata = await harness.snapshot(META, conversationId, context)
      const plan = await harness.snapshot(Plans, conversationId, context)
      return metadata !== undefined && (metadata.accessMode === 'fullAccess' || metadata.accessMode === 'workspaceWrite') && plan?.active !== true
    },
  }))
  registry.install(createSubagentTools({ prepareChild: teamService.prepareChild }))
  registry.install(createTeamTools({
    prepareChild: teamService.prepareChild,
    conversationInfo: teamService.conversationInfo,
    watchMembers: teamService.watchMembers,
    memberSession: teamService.memberSession,
  }))
  // Tool-free: it only appends a per-request reminder from the live plugin projection.
  registry.install(createPluginReferenceExtension({
    capabilities: () => pluginReferenceCapabilities(pluginStore.overview()),
  }))
  /** Pi's deferred-tool loader; reinstalled whenever the MCP tool set changes. */
  const TOOL_SEARCH_EXTENSION_NAME = 'tool-search'
  /**
   * Keep the MCP surface (code mode namespaces, `mcp` tools, `tool_search`) and the execution policy
   * in sync with the current connections. The policy must stay last: it captures the installed tool
   * snapshot, so every change reinstalls it after the MCP group.
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
    // `tool_search` loads deferred MCP tools into the model's next request. Tools behind either
    // `codemode` or `deferred` exposure are registered deferred (scripts can call them directly);
    // install the loader whenever such a tool exists.
    if (mcpExtension?.tools?.some(tool => tool.deferred === true) === true) {
      registry.install(createToolSearchExtension())
    }
    registry.install(createExecutionPolicyExtension(registry.snapshot().installed()))
  }
  refreshMcpExtensions()

  const pluginListeners = new Set<() => void>()
  const notifyPluginListeners = (): void => {
    for (const listener of [...pluginListeners]) {
      try { listener() } catch { /* a dropped event stream must not stop the reload */ }
    }
  }
  /** Serialized plugin-driven reloads: install/uninstall/enable can arrive back to back. */
  let pluginRefreshTail: Promise<void> = Promise.resolve()
  let runtimeClosed = false
  /** Skill-only plugin changes must not reconnect the user's own MCP servers. */
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
          // A failed reload keeps the previous connections; each server's state is in the MCP view.
        }
      }
      notifyPluginListeners()
    }, () => undefined)
  }
  let closePromise: Promise<void> | undefined
  const activeWatchStops = new Set<() => Promise<void>>()
  harness = await Harness.open(storage, {
    models: modelRuntime.models,
    registry,
    settings: { compaction: COMPACTION_POLICY },
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
        metadata.presetId = parent.presetId ?? null
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
  const conversationsService = createConversations({
    appState, harness: () => harness, modelRuntime, workspaceFiles, memoryExtraction, assertOpen, requireConversation,
    ensureMetadata, withMetadata, markConversationSeen, detailFromView, currentDetail,
    selectedWorkspace, selectedPreset, assertModelAllowed, assertConversationModelAllowed, buildAgentChange,
    defaultWorkspace,
  })

  const queueService = createQueue({
    harness: () => harness, requireConversation, ensureMetadata, withMetadata,
    submitWithReferences: conversationsService.submitWithReferences, workspaceFiles, defaultWorkspace,
  })
  const interactionsService = createInteractionReplies({
    harness: () => harness, requireConversation, currentDetail, assertConversationModelAllowed,
  })

  const settingsService = createSettings({
    appState, modelRuntime, workspaceWriteAvailable, selectedPreset, assertOpen, syncIdleAgents,
    assertModelAllowed, modelAllowlist, launchWorkspace,
  })

  const presetsService = createPresets({
    appState, modelRuntime, installedExtensions: () => registry.snapshot().installed(),
    assertModelAllowed, workspaceWriteAvailable,
    assertNoAutomationReferences: (...args) => automationsFeature().assertNoAutomationReferences(...args),
  })

  const workspacesService = createWorkspaces({
    appState, modelRuntime, workspaceFiles, list: conversationsService.list, withMetadata, parseConversationId,
    assertNoAutomationReferences: (...args) => automationsFeature().assertNoAutomationReferences(...args),
    conversationModel: async (value: string) => (await requireConversation(value)).agent(CTX).then(agent => agent.model),
  })

  let automationsService: ReturnType<typeof createAutomations> | undefined
  const automationsFeature = (): ReturnType<typeof createAutomations> => {
    automationsService ??= createAutomations({
      appState, modelRuntime, isClosed: () => runtimeClosed, requireConversation, currentDetail,
      selectedWorkspace, selectedPreset, assertModelAllowed,
      create: (input) => conversationsService.create(input),
      submit: (value, input) => conversationsService.submit(value, input),
    })
    return automationsService
  }

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

  /** Standalone issues page: a CLI read or the bundled demo fixture, never a model turn. */
  const wetrackDefects = async (): Promise<WetrackDefectList> => readWetrackDefects(
    options.demo === true && !wetrackConfigured() ? { fixture: builtinFixturePath() } : {},
  )
  const wetrackDefect = async (defectNumber: string): Promise<WetrackDefectDetail> => readWetrackDefect(defectNumber,
    options.demo === true && !wetrackConfigured() ? { fixture: builtinFixturePath() } : {},
  )
  const wetrackReport = async (defectNumber: string): Promise<WetrackDefectReport> => readWetrackReport(defectNumber, { dataDir: options.dataDir })

  // Submission recovery can start the scheduler itself. Install guards on every stored
  // conversation before any recovery path is allowed to submit or resume work.
  let policyCursor: Cursor | undefined
  do {
    const page = await harness.commit(tx => tx.scanConversations({ order: 'ascending' }, 250, policyCursor), CTX)
    for (const record of page.items) await harness.commit(tx => ensureRuntimePolicy(tx, record), CTX)
    policyCursor = page.next
  } while (policyCursor)
  await queueService.recover()
  await automationsFeature().recover()
  await teamService.reconcileRosters()
  harness.resume()
  // Upgrades add code mode to an existing registry, and the stored agent selection is
  // per conversation: bring idle conversations onto the current presentation before serving.
  await syncIdleAgents()

  const pluginsService = createPlugins({
    pluginStore, mcp, harness: () => harness, listeners: pluginListeners,
    flushRefresh: () => pluginRefreshTail.catch(() => undefined),
  })

  return {
    list: () => conversationsService.list(),
    create: (input) => conversationsService.create(input),
    // Reading the detail is what "viewing a conversation" means for the client; the sidebar's
    // unread dot clears on the next list refresh. Internal callers use `currentDetail` directly.
    detail: (value) => conversationsService.detail(value),
    update: (value, input) => conversationsService.update(value, input),
    submit: (value, input) => conversationsService.submit(value, input),
    answerInteraction: (value, callId, answers) => interactionsService.answerInteraction(value, callId, answers),
    cancelInteraction: (value, callId) => interactionsService.cancelInteraction(value, callId),
    editQueued: (value, submissionId, input) => queueService.editQueued(value, submissionId, input),
    stop: (value) => conversationsService.stop(value),
    compact: (value) => conversationsService.compact(value),
    goal: (value, input) => conversationsService.goal(value, input),
    setPlan: (value, active) => conversationsService.setPlan(value, active),
    team: (value) => teamService.team(value),
    children: (value) => teamService.children(value),
    childMessage: (value, childValue, input) => teamService.childMessage(value, childValue, input),
    childStop: (value, childValue) => teamService.childStop(value, childValue),
    removeQueued: (value, submissionId) => queueService.removeQueued(value, submissionId),
    fork: (value, entryId) => conversationsService.fork(value, entryId),
    retry: (value, entryId, requestId) => conversationsService.retry(value, entryId, requestId),
    watch: (value, listener) => conversationsService.watch(value, listener),
    catalog: () => settingsService.catalog(),
    watchModels: (listener: () => void) => {
      modelListeners.add(listener)
      return () => { modelListeners.delete(listener) }
    },
    saveProvider: (input) => settingsService.saveProvider(input),
    provider: (id) => settingsService.provider(id),
    deleteProvider: (id) => settingsService.deleteProvider(id),
    testProvider: (id, modelId) => settingsService.testProvider(id, modelId),
    discoverProvider: (id) => settingsService.discoverProvider(id),
    settings: () => settingsService.settings(),
    mcp: () => mcp.view(),
    capabilities: () => settingsService.capabilities(),
    updateSettings: (input) => settingsService.updateSettings(input),
    openConfigFile: () => settingsService.openConfigFile(),
    workspaces: () => workspacesService.list(),
    addWorkspace: (input) => workspacesService.add(input),
    renameWorkspace: (id, input) => workspacesService.rename(id, input),
    deleteWorkspace: (id) => workspacesService.remove(id),
    pickDirectory: (signal) => workspacesService.pickDirectory(signal),
    listDirectories: (dir) => workspacesService.listDirectories(dir),
    createDirectory: (parent, name) => workspacesService.createDirectory(parent, name),
    workspaceFiles: (id, path, query) => workspacesService.fileList(id, path, query),
    searchWorkspace: (id, query) => workspacesService.search(id, query),
    workspaceFile: (id, path) => workspacesService.file(id, path),
    workspaceAsset: (id, path) => workspacesService.asset(id, path),
    gitBranches: (id) => workspacesService.gitBranches(id),
    switchGitBranch: (id, input) => workspacesService.switchGitBranch(id, input),
    createGitBranch: (id, input) => workspacesService.createGitBranch(id, input),
    gitWorktreeStatus: (id) => workspacesService.gitWorktreeStatus(id),
    gitWorktreeDiff: (id, path) => workspacesService.gitWorktreeDiff(id, path),
    gitCommit: (id, input) => workspacesService.gitCommit(id, input),
    gitPush: (id) => workspacesService.gitPush(id),
    gitCommitMessage: (id, input) => workspacesService.gitCommitMessage(id, input),
    skills: async (workspaceId) => skillStore.list(workspaceFiles.workspace(workspaceId).path),
    skill: async (workspaceId, skillId, resource) => skillStore.load(workspaceFiles.workspace(workspaceId).path, skillId, resource),
    validateSkill: async (workspaceId, skillId) => skillStore.validate(workspaceFiles.workspace(workspaceId).path, skillId),
    plugins: () => pluginsService.overview(),
    addPluginMarketplace: (source) => pluginsService.addMarketplace(source),
    removePluginMarketplace: (id) => pluginsService.removeMarketplace(id),
    refreshPluginMarketplace: (id) => pluginsService.refreshMarketplace(id),
    installPlugin: (input) => pluginsService.install(input),
    updatePlugin: (pluginId) => pluginsService.update(pluginId),
    describePlugin: (pluginId) => pluginsService.describe(pluginId),
    uninstallPlugin: (pluginId, keepData) => pluginsService.uninstall(pluginId, keepData ?? false),
    setPluginEnabled: (pluginId, enabled) => pluginsService.setEnabled(pluginId, enabled),
    watchPlugins: (listener) => pluginsService.watch(listener),
    pluginUiSurfaces: () => pluginsService.uiSurfaces(),
    pluginUiPage: (input) => pluginsService.uiPage(input),
    pluginUiCall: (input) => pluginsService.uiCall(input),
    pluginUiReadResource: (input) => pluginsService.uiReadResource(input),
    presets: () => presetsService.list(),
    createPreset: (input) => presetsService.create(input),
    updatePreset: (id, input) => presetsService.update(id, input),
    deletePreset: (id) => presetsService.remove(id),
    feedback: (value, entryValue, rating) => conversationsService.feedback(value, entryValue, rating),
    sendFeedback,
    automations: () => automationsFeature().list(),
    createAutomation: (input) => automationsFeature().create(input),
    updateAutomation: (id, input) => automationsFeature().update(id, input),
    deleteAutomation: (id) => automationsFeature().remove(id),
    runAutomation: (id) => automationsFeature().run(id),
    wetrackDefects,
    wetrackDefect,
    wetrackReport,
    async close() {
      if (!closePromise) {
        runtimeClosed = true
        automationsService?.close()
        memoryExtraction.shutdown()
        disposeBackgroundShells()
        unsubscribeModels()
        modelListeners.clear()
        modelRuntime.close()
        closePromise = (async () => {
          try {
            await conversationsService.closeWatches()
          } finally {
            try {
              await memoryExtraction.drain(MEMORY_EXTRACTION_DRAIN_MS)
              await harness.close(CTX)
              await automationsService?.drain()
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
