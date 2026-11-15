/**
 * 所有 feature 共享的会话状态：元数据、详情投影、模型策略与 agent 配置。
 *
 * harness 在工具注册表之后创建（扩展闭包引用它），因此本工厂持有迟绑定句柄：
 * 运行时打开 harness 后调用一次 `setHarness`。
 */
import type {
  AgentChange, Conversation, ConversationId, ConversationRecord, ConversationView, Cursor, Extension, Harness, ToolRegistration,
} from '@earendil-works/pi-durable'
import type {
  AccessMode, ConversationDetail, ModelRef as UiModelRef, SubagentSummary,
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
import { TRAJECTORY_EXTENSION_NAME } from '../conversation/trajectory.ts'
import { MEMORY_EXTENSION_NAME } from '../memory/policy.ts'
import { PLUGIN_REFERENCE_EXTENSION_NAME } from '../plugins/reference.ts'
import { EXECUTION_POLICY_EXTENSION_NAME } from '../conversation/execution-policy.ts'
import {
  CONVERSATION_KIND, CTX, META, SUPPORTED_THINKING, cloneMetadata, liveRunTaskId, parseConversationId, type ConversationMetadata,
} from './helpers.ts'
import { Todos } from '../tools/todo.ts'
import { Goals } from '../tools/goal.ts'
import { Interactions } from '../tools/interaction.ts'
import { Plans } from '../tools/plan.ts'
import { RuntimeError } from '../runtime-errors.ts'
import type { Draft } from '@earendil-works/chord'

/** 核心 feature 的依赖注入契约：状态、模型运行时与团队/子智能体投影的迟绑定回调。 */
export interface CoreDeps {
  appState: AppStateStore
  modelRuntime: RuntimeModels
  workspaceFiles: WorkspaceFiles
  installedExtensions(): ReadonlyArray<Extension>
  isClosed(): boolean
  defaultWorkspace(): WorkspaceSummary | undefined
  /** 迟绑定：让团队 feature 使用核心而不形成构造环。 */
  projectTeam(id: ConversationId): Promise<TeamView | undefined>
  subagentSummaries(id: ConversationId): Promise<SubagentSummary[]>
}

/**
 * 功能：创建核心 feature 服务——所有 feature 共用的会话元数据读写、详情投影、
 * 模型策略（白名单/可用性）与 agent 配置构建。
 * @param deps 依赖注入契约见 CoreDeps
 * 职责边界：本工厂只做状态读取与策略裁决；会话的生命周期操作（创建/提交等）
 * 在 conversations feature，团队与子智能体投影通过迟绑定回调进入。
 */
export function createCore(deps: CoreDeps) {
  const { appState, modelRuntime, workspaceFiles, isClosed, projectTeam, subagentSummaries, defaultWorkspace } = deps
  let harness: Harness
  /** 迟绑定 harness：运行时打开后调用一次。 */
  const setHarness = (value: Harness): void => { harness = value }

  /** 运行时已关闭时抛 CONFLICT，作为所有入口的第一道闸。 */
  const assertOpen = () => {
    if (isClosed()) throw new RuntimeError('CONFLICT', '运行时已关闭')
  }

  /** 解析会话 ID 并取回会话句柄；运行时关闭或会话不存在即抛错。 */
  const requireConversation = async (value: string) => {
    assertOpen()
    const id = parseConversationId(value)
    const conversation = await harness.conversation(id, CTX)
    if (!conversation) throw new RuntimeError('NOT_FOUND', '会话不存在')
    return conversation
  }

  /**
   * 功能：读取会话元数据，缺失关键字段时先做迁移补齐。
   * @param id 会话 ID
   * @returns 只读元数据快照
   * 内部逻辑：已具备 workspaceId/accessMode/feedback/queueEdits 的旧记录直接返回；
   * 否则在事务里按当前设置补默认值（工作区回退到默认工作区），再读一次快照。
   */
  const ensureMetadata = async (id: ConversationId): Promise<Readonly<ConversationMetadata>> => {
    const existing = await harness.snapshot(META, id, CTX)
    if (existing && existing.workspaceId && existing.accessMode && existing.feedback && existing.queueEdits) return existing
    await harness.commit(async (tx) => {
      const metadata = await tx.doc(META, id)
      metadata.updatedAt = Date.now()
      metadata.workspaceId ??= defaultWorkspace()?.id ?? null
      metadata.accessMode ??= appState.snapshot().settings.defaultAccessMode
      metadata.feedback ??= {}
      metadata.queueEdits ??= {}
    }, CTX)
    const migrated = await harness.snapshot(META, id, CTX)
    if (!migrated) throw new RuntimeError('CONFLICT', '无法加载会话元数据')
    return migrated
  }

  /** 在事务中对元数据应用一次可变更新，并顺带刷新 updatedAt。 */
  const withMetadata = async (id: ConversationId, update: (metadata: Draft<ConversationMetadata>) => void): Promise<void> => {
    await harness.commit(async (tx) => {
      const metadata = await tx.doc(META, id)
      update(metadata)
      metadata.updatedAt = Date.now()
    }, CTX)
  }

  /**
   * 功能：客户端查看会话时落定未读标记。
   * @param id 会话 ID
   * @param seenAt 本次查看的时间戳
   * @returns 无返回
   * 内部逻辑：与 withMetadata 不同，本函数不碰 updatedAt——读取一行不得改变
   * 侧栏排序；seenAt 只单调前进（已有更大值时跳过）。
   */
  const markConversationSeen = async (id: ConversationId, seenAt: number): Promise<void> => {
    await harness.commit(async (tx) => {
      const metadata = await tx.doc(META, id)
      if ((metadata.seenAt ?? 0) >= seenAt) return
      metadata.seenAt = seenAt
    }, CTX)
  }

  /**
   * 功能：把一次会话视图投影成客户端的 ConversationDetail。
   * @param id 会话 ID
   * @param view 会话视图（watch 快照）
   * @param metadata 可选预取元数据；缺省时内部读取
   * @param options subagents/team 控制是否附子智能体目录与团队视图
   * @returns 完整详情投影
   * 内部逻辑：并行收集 todos/interactions/goal/plan/kind 文档与工作区回退路径后调用
   * projectConversation；随后把思考等级按当前模型支持表收敛（存档等级可能已超出
   * 模型现行等级表），与请求实际会被 pi-ai 收敛的结果保持一致。
   */
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
      kind: (await harness.snapshot(CONVERSATION_KIND, id, CTX))?.kind,
      // 只有会话自身的详情携带子智能体：侧栏列表（list）与子会话自己的详情都跳过
      // 这次遍历，因此树只有一层，每次加载的开销有界。
      ...(options.subagents === true ? { subagents: await subagentSummaries(id) } : {}),
      ...(team === undefined ? {} : { team }),
    })
    // 存档的等级可能早于模型现行等级表（例如手改的 Provider 文件收窄了它）。请求
    // 反正会被 pi-ai 收敛，因此投影出同样的收敛结果，而不是暴露选择器里不存在的等级。
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

  /** 读取当前详情（附子智能体与团队投影）；内部调用方使用，不落定未读标记。 */
  const currentDetail = async (id: ConversationId): Promise<ConversationDetail> => {
    const conversation = await requireConversation(String(id))
    const viewWatch = await conversation.watch(CTX)
    try {
      return await detailFromView(id, viewWatch.value, undefined, { subagents: true, team: true })
    } finally {
      await viewWatch.stop()
    }
  }

  /** 解析指定 ID（或设置默认、或启动默认）的工作区；全部落空抛 NOT_FOUND。 */
  const selectedWorkspace = (id: string | undefined): WorkspaceSummary => {
    const resolved = id ?? appState.snapshot().settings.defaultWorkspaceId ?? defaultWorkspace()?.id
    if (resolved === undefined) throw new RuntimeError('NOT_FOUND', '工作区不存在')
    return workspaceFiles.workspace(resolved)
  }

  /** 读取当前模型白名单快照。 */
  const modelAllowlist = (): readonly string[] => appState.snapshot().settings.modelAllowlist

  /** 白名单之外的显式选择直接拒绝；`label` 用于指明是谁选择的模型。 */
  const assertModelAllowed = (model: UiModelRef | undefined, label: string): void => {
    if (model && !modelWithinAllowlist(modelAllowlist(), model)) {
      throw new RuntimeError('MODEL_UNAVAILABLE', `${label}不在模型白名单内`)
    }
  }

  /** 白名单在目录中的第一个模型；失效默认最终回退到这里。 */
  const firstAllowedModel = (): UiModelRef | undefined => {
    const candidate = modelRuntime.models.getModels().find(model => modelWithinAllowlist(modelAllowlist(), { provider: model.provider, modelId: model.id }))
    return candidate ? { provider: candidate.provider, modelId: candidate.id } : undefined
  }

  /**
   * 功能：找出凭据已配置的 Provider 上的第一个白名单内模型。
   * @returns 可用模型引用；没有就绪路由时回退到目录顺序的第一个白名单模型
   * 内部逻辑：逐 Provider 检查凭据（读取失败只视为该路由不可用）；失效默认不得被
   * 用户根本调不了的随机出厂模型顶替，只有没有就绪路由时才落到目录顺序。
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
   * 功能：校验一次运行将要使用的模型（会话绑定 → 存档默认 → 目录默认）在目录与白名单内。
   * @param conversation 目标会话
   * @returns 通过即无返回，否则抛 MODEL_UNAVAILABLE
   * 内部逻辑：运行使用会话绑定的模型，因此白名单变更前创建的会话不得继续
   * 调用范围外的模型；先查目录存在性，再查白名单。
   */
  const assertConversationModelAllowed = async (conversation: Awaited<ReturnType<typeof requireConversation>>): Promise<void> => {
    const agent = await conversation.agent(CTX)
    const model = agent.model ?? appState.snapshot().settings.defaultModel ?? modelRuntime.defaultModel
    if (!model) return
    if (!modelRuntime.models.getModel(model.provider, model.modelId)) throw new RuntimeError('MODEL_UNAVAILABLE', '会话模型不在 Pi 模型目录中')
    assertModelAllowed(model, '会话模型')
  }

  /**
   * 功能：为一次（重）配置构建 AgentChange——扩展集合、工具过滤、模型解析与思考等级收敛。
   * @param workspaceId 目标工作区 ID
   * @param accessMode 访问模式，决定只读工具过滤
   * @param overrides 显式指定的模型与思考等级（可选）
   * @returns 可交给 conversation.configure 的变更对象
   * 内部逻辑：所有已装扩展全量启用，codemode `off` 是唯一呈现开关；只读模式在
   * READ_ONLY_TOOLS 之外过滤工具（保留 wetrack_analysis_ 前缀）；模型按「显式指定
   * → 存档默认 → 目录默认」解析，显式指定的坏模型报错、存档默认静默回退到
   * firstAvailableAllowedModel，白名单同理；思考等级按模型支持表收敛后返回。
   */
  const buildAgentChange = async (workspaceId: string, accessMode: AccessMode, overrides: {
    model?: UiModelRef
    thinkingLevel?: ThinkingLevel
  } = {}): Promise<AgentChange> => {
    const workspace = workspaceFiles.workspace(workspaceId)
    const installed = deps.installedExtensions()
    const installedByName = new Map(installed.map(extension => [extension.name, extension]))
    const state = appState.snapshot()
    const codemodeMode = state.settings.codemodeMode
    // 所有已装扩展全量开启：插件开关不再暴露，遗留的按插件状态不得停用任何扩展。
    // Pi code mode 是唯一呈现开关：`off` 到处移除该扩展，`on`/`only` 保留原生工具可见。
    const extensionNames = [...new Set([WORK_POLICY_EXTENSION_NAME, COMPACTION_EXTENSION_NAME, TRAJECTORY_EXTENSION_NAME, MEMORY_EXTENSION_NAME, PLUGIN_REFERENCE_EXTENSION_NAME, EXECUTION_POLICY_EXTENSION_NAME, ...installed.map(extension => extension.name)])]
      .filter(name => codemodeMode !== 'off' || name !== CODEMODE_EXTENSION_NAME)
    const extensions: Extension[] = extensionNames.map(name => {
      const extension = installedByName.get(name)
      if (!extension) throw new RuntimeError('INVALID_INPUT', `插件未安装：${name}`)
      return extension
    })
    const registeredTools = extensions.flatMap(extension => (extension.tools ?? []).map(tool => ({ extension, tool })))
    const tools: ToolRegistration[] = registeredTools.flatMap(({ tool }) => {
      // 工具始终开启；只读模式仅过滤掉白名单外的写类工具。
      if (accessMode === 'readOnly' && !READ_ONLY_TOOLS.has(tool.name) && !tool.name.startsWith('wetrack_analysis_')) return []
      return [tool]
    })
    // Pi 的 `codemode.mode: only`：模型只看到脚本工具，已启用工具仍可被嵌套调用
    // （正是脚本可达的通道）。`null` 在会话离开 `only` 时清除存档过滤——这里
    // `undefined`（不改）是不够的。
    const modelTools = codemodeMode === 'only' && extensions.some(extension => extension.name === CODEMODE_EXTENSION_NAME)
      ? tools.filter(tool => tool.name === CODEMODE_TOOL_NAME)
      : null
    const requestedModel = overrides.model
    let model = requestedModel ?? state.settings.defaultModel ?? modelRuntime.defaultModel
    if (model && !modelRuntime.models.getModel(model.provider, model.modelId)) {
      // 显式指定的模型必须响亮地失败；失效的存档默认则解析到真实存在的模型，
      // 而不是阻塞新会话。
      if (requestedModel) throw new RuntimeError('MODEL_UNAVAILABLE', '配置的模型未出现在 Pi 模型目录中')
      model = await firstAvailableAllowedModel()
      if (!model) throw new RuntimeError('MODEL_UNAVAILABLE', '配置的模型未出现在 Pi 模型目录中')
    } else if (!model) {
      model = await firstAvailableAllowedModel()
      if (!model) throw new RuntimeError('MODEL_UNAVAILABLE', '没有可用的模型')
    }
    if (model && !modelWithinAllowlist(modelAllowlist(), model)) {
      // 显式指定直接拒绝；白名单不再覆盖的存档默认只回退到允许的模型，
      // 而不是阻塞这次运行。
      if (requestedModel) throw new RuntimeError('MODEL_UNAVAILABLE', '所选模型不在模型白名单内')
      const fallback = await firstAvailableAllowedModel()
      if (!fallback) throw new RuntimeError('MODEL_UNAVAILABLE', '配置的模型不在模型白名单内')
      model = fallback
    }
    const thinkingLevel = overrides.thinkingLevel ?? state.settings.defaultThinkingLevel ?? modelRuntime.defaultThinkingLevel
    if (thinkingLevel && !SUPPORTED_THINKING.has(thinkingLevel)) throw new RuntimeError('INVALID_INPUT', '思考等级无效')
    // 落盘的是模型实际会发送的等级。配置的等级表可能在会话上次选择后收窄；
    // 在 `pi.agent` 里保留不支持的值会让编辑器标签与请求不一致。
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
    }
  }

  /**
   * 功能：把空闲的无主会话 agent 重新计算到当前设置。
   * @returns 无返回；单会话失败静默跳过
   * 内部逻辑：Pi 把选中的扩展、工具与指令存在每个会话的 `pi.agent` 里，设置切换
   * （on/only/off、文档布局）或升级加入 code mode 后旧会话会停在旧呈现上。分页扫描
   * 无主会话，跳过正在运行的，按元数据重建配置并保留其模型与思考等级；存档配置
   * 解析失败的会话保留旧 agent（best effort，后续显式编辑再报真实错误）。
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
        const workspace = selectedWorkspace(metadata.workspaceId ?? undefined)
        const accessMode = metadata.accessMode ?? settings.defaultAccessMode
        const agent = await conversation.agent(CTX)
        const change = await buildAgentChange(workspace.id, accessMode, {
          ...(agent.model ? { model: agent.model } : {}),
          ...(agent.thinkingLevel ? { thinkingLevel: agent.thinkingLevel } : {}),
        })
        await conversation.configure(change, CTX)
      } catch {
        // 尽力而为：之后的显式编辑会报告真实的配置错误。
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
    modelAllowlist,
    assertModelAllowed,
    firstAllowedModel,
    firstAvailableAllowedModel,
    assertConversationModelAllowed,
    buildAgentChange,
    syncIdleAgents,
  }
}
