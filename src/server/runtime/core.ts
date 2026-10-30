/**
 * Conversation state shared by every feature: metadata, detail projection, model policy
 * and agent configuration.
 *
 * The harness is created after the tool registry (its extensions close over it), so this
 * factory keeps a late-bound handle: `setHarness` is called once the runtime opens it.
 */
import type {
  AgentChange, Conversation, ConversationId, ConversationRecord, ConversationView, Cursor, Extension, Harness, ToolRegistration,
} from '@earendil-works/pi-durable'
import type {
  AccessMode, AgentPreset, ConversationDetail, ModelRef as UiModelRef, SubagentSummary,
  TeamView, ThinkingLevel, WorkspaceSummary,
} from '../../shared/types.ts'
import type { AppStateStore } from '../state/app-state.ts'
import type { RuntimeModels } from '../model/catalog.ts'
import type { WorkspaceFiles } from '../workspace/files.ts'
import { clampThinkingLevel } from '../model/catalog.ts'
import { modelWithinAllowlist } from '../model/allowlist.ts'
import { projectConversation } from '../conversation/projection.ts'
import { CODEMODE_TOOL_NAME } from '@earendil-works/pi-durable/codemode'
import { CODEMODE_EXTENSION_NAME, READ_ONLY_TOOLS } from './helpers.ts'
import { WORK_POLICY_EXTENSION_NAME } from '../conversation/work-policy.ts'
import { COMPACTION_EXTENSION_NAME } from '../conversation/compaction.ts'
import { MEMORY_EXTENSION_NAME } from '../memory/policy.ts'
import { PLUGIN_REFERENCE_EXTENSION_NAME } from '../plugins/reference.ts'
import { EXECUTION_POLICY_EXTENSION_NAME } from '../conversation/execution-policy.ts'
import {
  CTX, META, SUPPORTED_THINKING, cloneMetadata, liveRunTaskId, parseConversationId, type ConversationMetadata,
} from './helpers.ts'
import { Todos } from '../tools/todo.ts'
import { Goals } from '../tools/goal.ts'
import { Interactions } from '../tools/interaction.ts'
import { Plans } from '../tools/plan.ts'
import { RuntimeError } from '../runtime-errors.ts'
import type { Draft } from '@earendil-works/chord'

export interface CoreDeps {
  appState: AppStateStore
  modelRuntime: RuntimeModels
  workspaceFiles: WorkspaceFiles
  installedExtensions(): ReadonlyArray<Extension>
  isClosed(): boolean
  defaultWorkspace(): WorkspaceSummary | undefined
  /** Late-bound so the team feature can use this core without a construction cycle. */
  projectTeam(id: ConversationId): Promise<TeamView | undefined>
  subagentSummaries(id: ConversationId): Promise<SubagentSummary[]>
}

export function createCore(deps: CoreDeps) {
  const { appState, modelRuntime, workspaceFiles, isClosed, projectTeam, subagentSummaries, defaultWorkspace } = deps
  let harness: Harness
  const setHarness = (value: Harness): void => { harness = value }

  const assertOpen = () => {
    if (isClosed()) throw new RuntimeError('CONFLICT', '运行时已关闭')
  }

  const requireConversation = async (value: string) => {
    assertOpen()
    const id = parseConversationId(value)
    const conversation = await harness.conversation(id, CTX)
    if (!conversation) throw new RuntimeError('NOT_FOUND', '会话不存在')
    return conversation
  }

  const ensureMetadata = async (id: ConversationId): Promise<Readonly<ConversationMetadata>> => {
    const existing = await harness.snapshot(META, id, CTX)
    if (existing && existing.workspaceId && existing.accessMode && existing.feedback && existing.queueEdits) return existing
    await harness.commit(async (tx) => {
      const metadata = await tx.doc(META, id)
      metadata.updatedAt = Date.now()
      metadata.workspaceId ??= defaultWorkspace()?.id ?? null
      metadata.accessMode ??= appState.snapshot().settings.defaultAccessMode
      metadata.presetId ??= null
      metadata.feedback ??= {}
      metadata.queueEdits ??= {}
    }, CTX)
    const migrated = await harness.snapshot(META, id, CTX)
    if (!migrated) throw new RuntimeError('CONFLICT', '无法加载会话元数据')
    return migrated
  }

  const withMetadata = async (id: ConversationId, update: (metadata: Draft<ConversationMetadata>) => void): Promise<void> => {
    await harness.commit(async (tx) => {
      const metadata = await tx.doc(META, id)
      update(metadata)
      metadata.updatedAt = Date.now()
    }, CTX)
  }

  /**
   * Settle the unread marker when the client views a conversation. Unlike `withMetadata` this
   * leaves `updatedAt` alone: reading a row must not reorder the sidebar.
   */
  const markConversationSeen = async (id: ConversationId, seenAt: number): Promise<void> => {
    await harness.commit(async (tx) => {
      const metadata = await tx.doc(META, id)
      if ((metadata.seenAt ?? 0) >= seenAt) return
      metadata.seenAt = seenAt
    }, CTX)
  }

  const detailFromView = async (
    id: ConversationId,
    view: ConversationView,
    metadata?: Readonly<ConversationMetadata>,
    options: { subagents?: boolean; team?: boolean } = {},
  ): Promise<ConversationDetail> => {
    const currentMetadata = metadata ?? await ensureMetadata(id)
    const settings = appState.snapshot().settings
    const fallbackWorkspaceId = currentMetadata.workspaceId ?? settings.defaultWorkspaceId ?? defaultWorkspace()?.id
    const fallbackWorkspace = fallbackWorkspaceId === undefined
      ? undefined
      : appState.snapshot().workspaces.find(item => item.id === fallbackWorkspaceId)
    const team = options.team === true ? await projectTeam(id) : undefined
    const detail = projectConversation(view, cloneMetadata(currentMetadata), {
      workspace: fallbackWorkspace?.path,
      defaultModel: settings.defaultModel ?? modelRuntime.defaultModel,
      todos: await harness.snapshot(Todos, id, CTX),
      interactions: await harness.snapshot(Interactions, id, CTX),
      goal: await harness.snapshot(Goals, id, CTX),
      plan: await harness.snapshot(Plans, id, CTX),
      // Only a conversation's own detail carries its children: the sidebar list (`list`) and a
      // child's own detail skip the walk, so the tree is one level and each load stays bounded.
      ...(options.subagents === true ? { subagents: await subagentSummaries(id) } : {}),
      ...(team === undefined ? {} : { team }),
    })
    // A stored level can predate the model's current level map (a hand-edited
    // provider file narrows it, for example). The request would be clamped by
    // pi-ai anyway, so project that same clamp instead of a level no picker
    // offers.
    const activeModel = detail.conversation.model
    const supportedLevels = activeModel === undefined
      ? undefined
      : modelRuntime.supportedThinkingLevels(activeModel.provider, activeModel.modelId)
    if (activeModel === undefined || supportedLevels === undefined) return detail
    const effective = clampThinkingLevel(detail.conversation.thinkingLevel, supportedLevels)
    return effective === detail.conversation.thinkingLevel
      ? detail
      : { ...detail, conversation: { ...detail.conversation, thinkingLevel: effective } }
  }

  const currentDetail = async (id: ConversationId): Promise<ConversationDetail> => {
    const conversation = await requireConversation(String(id))
    const viewWatch = await conversation.watch(CTX)
    try {
      return await detailFromView(id, viewWatch.value, undefined, { subagents: true, team: true })
    } finally {
      await viewWatch.stop()
    }
  }

  const selectedWorkspace = (id: string | undefined): WorkspaceSummary => {
    const resolved = id ?? appState.snapshot().settings.defaultWorkspaceId ?? defaultWorkspace()?.id
    if (resolved === undefined) throw new RuntimeError('NOT_FOUND', '工作区不存在')
    return workspaceFiles.workspace(resolved)
  }

  const selectedPreset = (id: string | null | undefined): AgentPreset | undefined => {
    if (!id) return undefined
    const preset = appState.snapshot().presets.find(item => item.id === id)
    if (!preset) throw new RuntimeError('NOT_FOUND', 'Agent preset 不存在')
    return preset
  }

  const modelAllowlist = (): readonly string[] => appState.snapshot().settings.modelAllowlist

  /** An explicit pick outside the project allowlist is refused; `label` names what picked it. */
  const assertModelAllowed = (model: UiModelRef | undefined, label: string): void => {
    if (model && !modelWithinAllowlist(modelAllowlist(), model)) {
      throw new RuntimeError('MODEL_UNAVAILABLE', `${label}不在模型白名单内`)
    }
  }

  /** The allowlist's first model in the directory, the replacement a fallen-out default resolves to. */
  const firstAllowedModel = (): UiModelRef | undefined => {
    const candidate = modelRuntime.models.getModels().find(model => modelWithinAllowlist(modelAllowlist(), { provider: model.provider, modelId: model.id }))
    return candidate ? { provider: candidate.provider, modelId: candidate.id } : undefined
  }

  /**
   * The first allowed model on a provider that actually has credentials. A
   * stale default must not be replaced by an arbitrary shipped model the user
   * cannot call; fall back to the directory order only when no route is ready.
   */
  const firstAvailableAllowedModel = async (): Promise<UiModelRef | undefined> => {
    for (const provider of modelRuntime.models.getProviders()) {
      let configured = false
      try { configured = await modelRuntime.models.checkAuth(provider.id) !== undefined }
      catch { /* an unreadable credential just makes the route unavailable here */ }
      if (!configured) continue
      const candidate = provider.getModels().find(model => modelWithinAllowlist(modelAllowlist(), { provider: provider.id, modelId: model.id }))
      if (candidate) return { provider: provider.id, modelId: candidate.id }
    }
    return firstAllowedModel()
  }

  /**
   * A run uses the model its conversation is bound to, so a conversation created
   * before the allowlist changed must not keep calling an out-of-scope model.
   */
  const assertConversationModelAllowed = async (conversation: Awaited<ReturnType<typeof requireConversation>>): Promise<void> => {
    const agent = await conversation.agent(CTX)
    const model = agent.model ?? appState.snapshot().settings.defaultModel ?? modelRuntime.defaultModel
    if (!model) return
    if (!modelRuntime.models.getModel(model.provider, model.modelId)) throw new RuntimeError('MODEL_UNAVAILABLE', '会话模型不在 Pi 模型目录中')
    assertModelAllowed(model, '会话模型')
  }

  const buildAgentChange = async (workspaceId: string, accessMode: AccessMode, preset?: AgentPreset, overrides: {
    model?: UiModelRef
    thinkingLevel?: ThinkingLevel
  } = {}): Promise<AgentChange> => {
    const workspace = workspaceFiles.workspace(workspaceId)
    const installed = deps.installedExtensions()
    const installedByName = new Map(installed.map(extension => [extension.name, extension]))
    const state = appState.snapshot()
    const codemodeMode = state.settings.codemodeMode
    // Every installed extension is on: plugin switches are no longer exposed, so the legacy
    // per-plugin state must not disable anything. Pi code mode is the one presentation switch:
    // `off` removes the extension everywhere, `on`/`only` keep a preset's own extension list.
    const extensionNames = [...new Set([WORK_POLICY_EXTENSION_NAME, COMPACTION_EXTENSION_NAME, MEMORY_EXTENSION_NAME, PLUGIN_REFERENCE_EXTENSION_NAME, EXECUTION_POLICY_EXTENSION_NAME, ...(preset ? preset.extensions : installed.map(extension => extension.name))])]
      .filter(name => codemodeMode !== 'off' || name !== CODEMODE_EXTENSION_NAME)
    const extensions: Extension[] = extensionNames.map(name => {
      const extension = installedByName.get(name)
      if (!extension) throw new RuntimeError('INVALID_INPUT', `Preset 引用了未安装的插件：${name}`)
      return extension
    })
    const registeredTools = extensions.flatMap(extension => (extension.tools ?? []).map(tool => ({ extension, tool })))
    const requestedTools = preset
      ? new Set(preset.tools.filter(name => codemodeMode !== 'off' || name !== CODEMODE_TOOL_NAME))
      : undefined
    const tools: ToolRegistration[] = registeredTools.flatMap(({ tool }) => {
      // Tools are always on; only a preset's tool list narrows them further.
      if (requestedTools && !requestedTools.has(tool.name)) return []
      if (accessMode === 'readOnly' && !READ_ONLY_TOOLS.has(tool.name)) return []
      return [tool]
    })
    if (requestedTools) {
      const registeredNames = new Set(registeredTools.map(({ tool }) => tool.name))
      for (const name of requestedTools) {
        if (!registeredNames.has(name)) throw new RuntimeError('INVALID_INPUT', `Preset 引用了未安装的工具：${name}`)
      }
    }
    // Pi's `codemode.mode: only`: the model sees just the script tool; the enabled tools
    // stay callable by nested calls, which is what scripts reach. `null` clears a stored
    // filter when the conversation leaves `only`, so an `undefined` (change nothing) is
    // not enough here.
    const modelTools = codemodeMode === 'only' && extensions.some(extension => extension.name === CODEMODE_EXTENSION_NAME)
      ? tools.filter(tool => tool.name === CODEMODE_TOOL_NAME)
      : null
    const requestedModel = overrides.model ?? preset?.model
    let model = requestedModel ?? state.settings.defaultModel ?? modelRuntime.defaultModel
    if (model && !modelRuntime.models.getModel(model.provider, model.modelId)) {
      // An explicit pick or preset must fail loudly; a stale stored default
      // resolves to a model that actually exists instead of blocking a new
      // conversation.
      if (requestedModel) throw new RuntimeError('MODEL_UNAVAILABLE', '配置的模型未出现在 Pi 模型目录中')
      model = await firstAvailableAllowedModel()
      if (!model) throw new RuntimeError('MODEL_UNAVAILABLE', '配置的模型未出现在 Pi 模型目录中')
    } else if (!model) {
      model = await firstAvailableAllowedModel()
      if (!model) throw new RuntimeError('MODEL_UNAVAILABLE', '没有可用的模型')
    }
    if (model && !modelWithinAllowlist(modelAllowlist(), model)) {
      // An explicit pick is refused; a stored default the allowlist no longer
      // covers only resolves to an allowed model instead of blocking the run.
      if (requestedModel) throw new RuntimeError('MODEL_UNAVAILABLE', `${overrides.model ? '所选模型' : 'Preset 模型'}不在模型白名单内`)
      const fallback = await firstAvailableAllowedModel()
      if (!fallback) throw new RuntimeError('MODEL_UNAVAILABLE', '配置的模型不在模型白名单内')
      model = fallback
    }
    const thinkingLevel = overrides.thinkingLevel ?? preset?.thinkingLevel ?? state.settings.defaultThinkingLevel ?? modelRuntime.defaultThinkingLevel
    if (thinkingLevel && !SUPPORTED_THINKING.has(thinkingLevel)) throw new RuntimeError('INVALID_INPUT', '思考等级无效')
    const instructions = preset?.instructions
    // Store what the model will actually send. A configured level list can
    // narrow after the conversation last chose one; keeping the unsupported
    // value in `pi.agent` makes the composer label disagree with the request.
    const supportedLevels = model ? modelRuntime.supportedThinkingLevels(model.provider, model.modelId) : undefined
    const effectiveThinking = thinkingLevel && supportedLevels
      ? clampThinkingLevel(thinkingLevel, supportedLevels)
      : thinkingLevel
    return {
      cwd: workspace.path,
      extensions,
      tools,
      modelTools,
      ...(model ? { model } : {}),
      ...(effectiveThinking ? { thinkingLevel: effectiveThinking } : {}),
      ...(instructions ? { instructions } : {}),
    }
  }

  /**
   * Pi stores the selected extensions, tools and instructions in every conversation's
   * `pi.agent`, so a settings change (`on`/`only`/`off`, document layout on or off) or
   * an upgrade that adds code mode would leave existing conversations on their old
   * presentation. Recompute each idle ownerless conversation's agent from its metadata,
   * preserving its model and thinking level.
   * A conversation whose stored configuration no longer resolves keeps its old agent.
   */
  const syncIdleAgents = async (): Promise<void> => {
    const records: ConversationRecord[] = []
    let cursor: Cursor | undefined
    do {
      const page = await harness.commit((tx) => tx.scanConversations({ order: 'ascending' }, 250, cursor), CTX)
      records.push(...page.items.filter(record => record.owner === undefined))
      cursor = page.next
    } while (cursor)
    for (const record of records) {
      try {
        const conversation = await harness.conversation(record.id, CTX)
        if (conversation === undefined) continue
        const viewWatch = await conversation.watch(CTX)
        let busy: boolean
        try { busy = liveRunTaskId(viewWatch.value) !== undefined } finally { await viewWatch.stop() }
        if (busy) continue
        const metadata = await ensureMetadata(record.id)
        const settings = appState.snapshot().settings
        const preset = selectedPreset(metadata.presetId ?? settings.defaultPresetId)
        const workspace = selectedWorkspace(metadata.workspaceId ?? undefined)
        const accessMode = metadata.accessMode ?? settings.defaultAccessMode
        const agent = await conversation.agent(CTX)
        const change = await buildAgentChange(workspace.id, accessMode, preset, {
          ...(agent.model ? { model: agent.model } : {}),
          ...(agent.thinkingLevel ? { thinkingLevel: agent.thinkingLevel } : {}),
        })
        await conversation.configure(change, CTX)
      } catch {
        // Best effort: an explicit edit later reports the actual configuration error.
      }
    }
  }


  return {
    setHarness,
    assertOpen,
    requireConversation,
    ensureMetadata,
    withMetadata,
    markConversationSeen,
    detailFromView,
    currentDetail,
    selectedWorkspace,
    selectedPreset,
    modelAllowlist,
    assertModelAllowed,
    firstAllowedModel,
    firstAvailableAllowedModel,
    assertConversationModelAllowed,
    buildAgentChange,
    syncIdleAgents,
  }
}
