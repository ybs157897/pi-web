/**
 * Application settings and the model surfaces the client reads.
 *
 * Provider edits are allowlist-aware: the directory an editor saves never drops models
 * the allowlist currently hides.
 */
import type {
  AccessMode, AgentPreset, AppSettings, ModelCatalog, ModelRef as UiModelRef, ProviderConfigSummary,
  ProviderInput, ProviderTestResult, UpdateAppSettingsInput, WorkspaceSummary,
} from '../../shared/types.ts'
import type { AppStateStore } from '../state/app-state.ts'
import type { RuntimeModels } from '../model/catalog.ts'
import { isValidAllowlistEntry, modelWithinAllowlist, normalizeModelAllowlist } from '../model/allowlist.ts'
import { RuntimeError } from '../runtime-errors.ts'
import { openLocalFile, safeFailure } from './helpers.ts'

export interface SettingsDeps {
  appState: AppStateStore
  modelRuntime: RuntimeModels
  workspaceWriteAvailable: boolean
  selectedPreset(id: string): AgentPreset | undefined
  assertOpen(): void
  syncIdleAgents(): Promise<void>
  assertModelAllowed(model: UiModelRef | undefined, label: string): void
  modelAllowlist(): readonly string[]
  /** The workspace selected at startup; clearing the default falls back to it. */
  launchWorkspace: WorkspaceSummary | undefined
}

export function createSettings(deps: SettingsDeps) {
  const { appState, modelRuntime, workspaceWriteAvailable, selectedPreset, assertOpen, syncIdleAgents, assertModelAllowed, modelAllowlist, launchWorkspace } = deps

  const settings = (): AppSettings => appState.snapshot().settings

  const capabilities = (): { accessModes: AccessMode[] } => ({
    accessModes: workspaceWriteAvailable ? ['readOnly', 'workspaceWrite', 'fullAccess'] : ['readOnly', 'fullAccess'],
  })

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
    if (input.defaultPresetId) selectedPreset(input.defaultPresetId)
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
      if (input.defaultModel === null) delete state.settings.defaultModel
      else if (input.defaultModel !== undefined) state.settings.defaultModel = { ...input.defaultModel }
      if (input.defaultPresetId === null) delete state.settings.defaultPresetId
      else if (input.defaultPresetId !== undefined) state.settings.defaultPresetId = input.defaultPresetId
      if (input.defaultWorkspaceId === null) {
        if (launchWorkspace === undefined) delete state.settings.defaultWorkspaceId
        else state.settings.defaultWorkspaceId = launchWorkspace.id
      }
      else if (input.defaultWorkspaceId !== undefined) state.settings.defaultWorkspaceId = input.defaultWorkspaceId
      if (input.shortcuts === null) delete state.settings.shortcuts
      else if (input.shortcuts !== undefined) state.settings.shortcuts = structuredClone(input.shortcuts)
      return structuredClone(state.settings)
    })
    // Code mode is stored in each conversation's agent, so an explicit switch applies now.
    // The document-layout switch is deliberately not synced here: it changes the contract
    // for conversations created from now on, and an open conversation keeps the one it
    // started with. A restart still aligns every idle conversation with the current setting.
    if (input.codemodeMode !== undefined && input.codemodeMode !== previousCodemodeMode) await syncIdleAgents()
    return saved
  }

  /** Hand the persisted application configuration file to the operator's default program. */
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
    // Persist a default the catalog no longer contains (or the allowlist now
    // hides); a valid but temporarily unconfigured default is left alone so it
    // returns when its credential does.
    if (defaultModel && effectiveDefault !== undefined && !inCatalog(effectiveDefault)) {
      await appState.update(state => { state.settings.defaultModel = { ...defaultModel } })
    }
    return { ...result, models, providers, ...(defaultModel ? { defaultModel } : {}) }
  }

  /** Provider config is a model surface too: explicit picks and the restore list stay inside the allowlist. */
  const providerInAllowlist = (id: string, models: ProviderConfigSummary['models']): ProviderConfigSummary['models'] =>
    models.filter(model => modelWithinAllowlist(modelAllowlist(), { provider: id, modelId: model.id }))

  const provider = async (id: string): Promise<ProviderConfigSummary> => {
    const result = await modelRuntime.provider(id)
    return {
      ...result,
      models: providerInAllowlist(id, result.models),
      ...(result.defaults ? { defaults: providerInAllowlist(id, result.defaults) } : {}),
    }
  }
  const deleteProvider = (id: string) => modelRuntime.deleteProvider(id)
  /**
   * The provider editor only renders models the allowlist permits, so a save
   * carries just the visible rows. Merge the currently hidden models back in:
   * a removed visible row still deletes that model, while saving a filtered
   * directory never quietly drops the models the filter hid.
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
  // A probe spends real quota, so it may only target an allowed model: an
  // explicit one is checked, and the picked default travels into the call.
  const testProvider = async (id: string, modelId?: string) => {
    const allowed = (modelRuntime.models.getProvider(id)?.getModels() ?? [])
      .filter(model => modelWithinAllowlist(modelAllowlist(), { provider: model.provider, modelId: model.id }))
      .map(model => ({ provider: model.provider, modelId: model.id }))
    const selected = modelId !== undefined ? { provider: id, modelId } : allowed[0]
    if (!selected) throw new RuntimeError('NOT_FOUND', '所选 Provider 或模型不存在')
    assertModelAllowed(selected, '所选模型')
    return modelRuntime.testProvider(id, selected.modelId)
  }
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
