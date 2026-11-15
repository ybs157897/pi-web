/**
 * 应用设置，以及客户端读取的模型目录相关面。
 *
 * Provider 编辑对白名单敏感：编辑器保存的目录不会悄悄丢掉被白名单隐藏的模型。
 */
import type {
  AccessMode, AppSettings, ModelCatalog, ModelRef as UiModelRef, ProviderConfigSummary,
  ProviderInput, ProviderTestResult, UpdateAppSettingsInput, WorkspaceSummary,
} from '../../shared/types.ts'
import type { AppStateStore } from '../state/app-state.ts'
import { normalizeFontFamily } from '../../shared/fonts.ts'
import type { RuntimeModels } from '../model/catalog.ts'
import { isValidAllowlistEntry, modelWithinAllowlist, normalizeModelAllowlist } from '../model/allowlist.ts'
import { RuntimeError } from '../runtime-errors.ts'
import { openLocalFile, safeFailure } from './helpers.ts'

/** 设置 feature 的依赖注入契约：应用状态、模型运行时与组合根提供的策略回调。 */
export interface SettingsDeps {
  appState: AppStateStore
  modelRuntime: RuntimeModels
  workspaceWriteAvailable: boolean
  assertOpen(): void
  syncIdleAgents(): Promise<void>
  assertModelAllowed(model: UiModelRef | undefined, label: string): void
  modelAllowlist(): readonly string[]
  /** 启动时选中的工作区；清除默认工作区设置时回退到它。 */
  launchWorkspace: WorkspaceSummary | undefined
}

/**
 * 功能：创建设置 feature 服务，覆盖应用设置读写、能力声明、模型目录/Provider 的
 * 白名单过滤面与配置文件打开。
 * @param deps 依赖注入契约见 SettingsDeps
 * 职责边界：所有 Provider 相关面都先按白名单过滤再返回；保存 Provider 时会把
 * 被白名单隐藏的模型合并回请求，避免静默丢失。
 */
export function createSettings(deps: SettingsDeps) {
  const { appState, modelRuntime, workspaceWriteAvailable, assertOpen, syncIdleAgents, assertModelAllowed, modelAllowlist, launchWorkspace } = deps

  /** 读取当前应用设置快照。 */
  const settings = (): AppSettings => appState.snapshot().settings

  /** 声明客户端可选的访问模式；不支持写入沙盒的平台剔除 workspaceWrite。 */
  const capabilities = (): { accessModes: AccessMode[] } => ({
    accessModes: workspaceWriteAvailable ? ['readOnly', 'workspaceWrite', 'fullAccess'] : ['readOnly', 'fullAccess'],
  })

  /**
   * 功能：更新应用设置。
   * @param input 部分更新的设置字段，可携带默认模型、白名单、默认工作区等
   * @returns 保存后的完整设置
   * 内部逻辑：按序校验默认模型在目录内、白名单条目合法、默认模型在新白名单内、
   * 默认工作区存在、workspaceWrite 受平台支持，然后逐字段落盘；codemodeMode
   * 显式切换时同步空闲会话的 agent。默认工作区清空时回退到启动工作区。
   */
  const updateSettings = async (input: UpdateAppSettingsInput): Promise<AppSettings> => {
    if (input.defaultModel && !modelRuntime.models.getModel(input.defaultModel.provider, input.defaultModel.modelId)) {
      throw new RuntimeError('MODEL_UNAVAILABLE', '默认模型不在 Pi 模型目录中')
    }
    let nextAllowlist: string[] | undefined
    if (input.modelAllowlist !== undefined) {
      nextAllowlist = normalizeModelAllowlist(input.modelAllowlist)
      for (const entry of nextAllowlist) {
        if (!isValidAllowlistEntry(entry)) throw new RuntimeError('INVALID_INPUT', `模型白名单条目无效：${entry}`)
      }
    }
    // A default patched together with the allowlist is judged by the new list.
    if (input.defaultModel && !modelWithinAllowlist(nextAllowlist ?? appState.snapshot().settings.modelAllowlist, input.defaultModel)) {
      throw new RuntimeError('MODEL_UNAVAILABLE', '默认模型不在模型白名单内')
    }
    if (input.defaultWorkspaceId && !appState.snapshot().workspaces.some(item => item.id === input.defaultWorkspaceId)) {
      throw new RuntimeError('NOT_FOUND', '默认工作区不存在')
    }
    if (input.defaultAccessMode === 'workspaceWrite' && !workspaceWriteAvailable) {
      throw new RuntimeError('UNSUPPORTED', '当前系统无法启用工作区写入沙盒')
    }
    const previousCodemodeMode = appState.snapshot().settings.codemodeMode
    const saved = await appState.update(state => {
      if (input.theme !== undefined) state.settings.theme = input.theme
      if (input.locale !== undefined) state.settings.locale = input.locale
      if (input.fontSize !== undefined) state.settings.fontSize = input.fontSize
      if (input.codeFontSize !== undefined) state.settings.codeFontSize = input.codeFontSize
      if (input.terminalFontSize !== undefined) state.settings.terminalFontSize = input.terminalFontSize
      if (input.textFontFamily !== undefined) state.settings.textFontFamily = normalizeFontFamily(input.textFontFamily)
      if (input.codeFontFamily !== undefined) state.settings.codeFontFamily = normalizeFontFamily(input.codeFontFamily)
      if (input.terminalFontFamily !== undefined) state.settings.terminalFontFamily = normalizeFontFamily(input.terminalFontFamily)
      if (input.transcriptView !== undefined) state.settings.transcriptView = input.transcriptView
      if (input.collapseTiming !== undefined) state.settings.collapseTiming = input.collapseTiming
      if (input.performanceUsage !== undefined) state.settings.performanceUsage = input.performanceUsage
      if (input.codingViews !== undefined) state.settings.codingViews = input.codingViews
      if (input.busySendMode !== undefined) state.settings.busySendMode = input.busySendMode
      if (nextAllowlist !== undefined) state.settings.modelAllowlist = nextAllowlist
      if (input.defaultThinkingLevel !== undefined) state.settings.defaultThinkingLevel = input.defaultThinkingLevel
      if (input.defaultAccessMode !== undefined) state.settings.defaultAccessMode = input.defaultAccessMode
      if (input.codemodeMode !== undefined) state.settings.codemodeMode = input.codemodeMode
      if (input.memoryEnabled !== undefined) state.settings.memoryEnabled = input.memoryEnabled
      // 中文思考：section 渲染每请求读快照，这里落盘即可，无需同步 idle 会话。
      if (input.chineseReasoning !== undefined) state.settings.chineseReasoning = input.chineseReasoning
      if (input.showAnalysisConversations !== undefined) state.settings.showAnalysisConversations = input.showAnalysisConversations
      if (input.defaultModel === null) delete state.settings.defaultModel
      else if (input.defaultModel !== undefined) state.settings.defaultModel = { ...input.defaultModel }
      if (input.defaultWorkspaceId === null) {
        if (launchWorkspace === undefined) delete state.settings.defaultWorkspaceId
        else state.settings.defaultWorkspaceId = launchWorkspace.id
      }
      else if (input.defaultWorkspaceId !== undefined) state.settings.defaultWorkspaceId = input.defaultWorkspaceId
      if (input.shortcuts === null) delete state.settings.shortcuts
      else if (input.shortcuts !== undefined) state.settings.shortcuts = structuredClone(input.shortcuts)
      return structuredClone(state.settings)
    })
    // Code mode 存在每个会话的 agent 里，显式切换立即生效；文档布局开关刻意不同步——
    // 它只改变此后新建会话的契约，已打开的会话保持创建时的选择。重启仍会把空闲会话对齐到当前设置。
    if (input.codemodeMode !== undefined && input.codemodeMode !== previousCodemodeMode) await syncIdleAgents()
    return saved
  }

  /** 功能：把落盘的应用配置文件交给操作系统的默认程序打开。 */
  const openConfigFile = async (): Promise<void> => {
    assertOpen()
    let present: boolean
    try {
      present = await appState.ensureFile()
    } catch (error) {
      throw new RuntimeError('PROVIDER_ERROR', `无法写入应用配置文件：${safeFailure(error)}`)
    }
    if (!present) throw new RuntimeError('NOT_FOUND', '应用配置文件不存在')
    await openLocalFile(appState.path)
  }

  /**
   * 功能：返回客户端可见的模型目录，并保证默认模型落在白名单内。
   * @returns 带白名单过滤的目录：models/providers 按白名单裁剪，defaultModel 按
   * 「已存默认 → 目录默认 → 第一个可用 → 第一个在册」顺序解析
   * 内部逻辑：已存默认或目录默认不在过滤后的目录里时（可能被白名单隐藏或已下架），
   * 把解析出的新默认写回设置；暂时未配置凭据但在册的默认保持不动，凭据回来即恢复。
   */
  const catalog = async () => {
    const result = await modelRuntime.catalog()
    const settings = appState.snapshot().settings
    const allowlist = settings.modelAllowlist
    const models = result.models.filter(model => modelWithinAllowlist(allowlist, model))
    const visibleProviders = new Set(models.map(model => model.provider))
    const providers = result.providers.filter(provider => visibleProviders.has(provider.id))
    const inCatalog = (model: UiModelRef): boolean =>
      models.some(candidate => candidate.provider === model.provider && candidate.modelId === model.modelId)
    const selectable = (model: UiModelRef): boolean =>
      models.some(candidate => candidate.provider === model.provider && candidate.modelId === model.modelId && candidate.available)
    const stored = settings.defaultModel
    const effectiveDefault = stored ?? result.defaultModel
    const requested = [stored, result.defaultModel].filter((model): model is UiModelRef => model !== undefined)
    const available = models.filter(model => model.available)
    const selected = requested.find(selectable)
      ?? available[0]
      ?? requested.find(inCatalog)
      ?? models[0]
    const defaultModel: UiModelRef | undefined = selected === undefined
      ? undefined
      : { provider: selected.provider, modelId: selected.modelId }
    // 目录已不包含（或被白名单隐藏）的默认要落盘修正；有效但暂时未配置凭据的
    // 默认保持不动，凭据恢复时它会回来。
    if (defaultModel && effectiveDefault !== undefined && !inCatalog(effectiveDefault)) {
      await appState.update(state => { state.settings.defaultModel = { ...defaultModel } })
    }
    return { ...result, models, providers, ...(defaultModel ? { defaultModel } : {}) }
  }

  /** Provider 配置同样是模型面：显式选择与恢复列表都保持在白名单内。 */
  const providerInAllowlist = (id: string, models: ProviderConfigSummary['models']): ProviderConfigSummary['models'] =>
    models.filter(model => modelWithinAllowlist(modelAllowlist(), { provider: id, modelId: model.id }))

  /** 读取单个 Provider 配置摘要，模型与默认恢复列表均按白名单过滤。 */
  const provider = async (id: string): Promise<ProviderConfigSummary> => {
    const result = await modelRuntime.provider(id)
    return {
      ...result,
      models: providerInAllowlist(id, result.models),
      ...(result.defaults ? { defaults: providerInAllowlist(id, result.defaults) } : {}),
    }
  }
  /** 删除一个 Provider 配置。 */
  const deleteProvider = (id: string) => modelRuntime.deleteProvider(id)
  /**
   * 功能：保存 Provider 配置，并把被白名单隐藏的模型合并回请求。
   * @param input 编辑器提交的 Provider 目录
   * @returns 无返回；保存成功即生效
   * 内部逻辑：编辑器只渲染白名单允许的模型，保存只携带可见行。若既有被隐藏的
   * 模型，先读旧配置把它们补回再保存——可见行的删除仍会删除该模型，而过滤
   * 永远不会让保存悄悄丢掉被隐藏的模型。
   */
  const saveProvider = async (input: ProviderInput): Promise<void> => {
    let existing: ProviderConfigSummary | undefined
    try {
      existing = await modelRuntime.provider(input.id)
    } catch (error) {
      if (!(error instanceof RuntimeError) || error.code !== 'NOT_FOUND') throw error
    }
    if (!existing) return modelRuntime.saveProvider(input)
    const sent = new Set(input.models.map(model => model.id))
    const hidden = existing.models.filter(model => !sent.has(model.id) &&
      !modelWithinAllowlist(modelAllowlist(), { provider: input.id, modelId: model.id }))
    if (hidden.length === 0) return modelRuntime.saveProvider(input)
    await modelRuntime.saveProvider({ ...input, models: [...input.models, ...hidden] })
  }
  // 连通性测试消耗真实配额，因此只能指向白名单允许的模型：显式指定的先校验，
  // 自动选中的默认模型直接进入调用。
  const testProvider = async (id: string, modelId?: string) => {
    const allowed = (modelRuntime.models.getProvider(id)?.getModels() ?? [])
      .filter(model => modelWithinAllowlist(modelAllowlist(), { provider: model.provider, modelId: model.id }))
      .map(model => ({ provider: model.provider, modelId: model.id }))
    const selected = modelId !== undefined ? { provider: id, modelId } : allowed[0]
    if (!selected) throw new RuntimeError('NOT_FOUND', '所选 Provider 或模型不存在')
    assertModelAllowed(selected, '所选模型')
    return modelRuntime.testProvider(id, selected.modelId)
  }
  /** 向 Provider 端点发现可用模型清单，结果按白名单过滤。 */
  const discoverProvider = async (id: string) => {
    const result = await modelRuntime.discover(id)
    return { models: result.models.filter(model => modelWithinAllowlist(modelAllowlist(), { provider: id, modelId: model.id })) }
  }


  return {
    settings,
    capabilities,
    updateSettings,
    openConfigFile,
    catalog,
    provider,
    deleteProvider,
    saveProvider,
    testProvider,
    discoverProvider,
  }
}
