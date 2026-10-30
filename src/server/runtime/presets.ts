/**
 * Agent presets: a named bundle of extensions, tools, instructions and defaults.
 *
 * Validation needs the live extension registry and the model catalog, so those are
 * injected rather than imported.
 */
import { randomUUID } from 'node:crypto'
import type {
  AgentPreset, Automation, CreateAgentPresetInput, ModelRef as UiModelRef, ThinkingLevel,
  UpdateAgentPresetInput,
} from '../../shared/types.ts'
import type { AppStateStore } from '../state/app-state.ts'
import type { RuntimeModels } from '../model/catalog.ts'
import { RuntimeError } from '../runtime-errors.ts'
import { SUPPORTED_THINKING } from './helpers.ts'

type InstalledExtension = { name: string; tools?: ReadonlyArray<{ name: string }> }

export interface PresetsDeps {
  appState: AppStateStore
  modelRuntime: RuntimeModels
  installedExtensions(): ReadonlyArray<InstalledExtension>
  assertModelAllowed(model: UiModelRef | undefined, label: string): void
  workspaceWriteAvailable: boolean
  assertNoAutomationReferences(items: readonly Automation[], resource: 'workspace' | 'preset', id: string): void
}

export function createPresets(deps: PresetsDeps) {
  const { appState, modelRuntime, installedExtensions, assertModelAllowed, workspaceWriteAvailable, assertNoAutomationReferences } = deps

  const validatePreset = (value: AgentPreset): AgentPreset => {
    if (!/^[A-Za-z0-9._~-]{1,128}$/.test(value.id)) throw new RuntimeError('INVALID_INPUT', 'Preset ID 无效')
    if (!value.name.trim() || value.name.length > 120 || value.instructions.length > 32_000) throw new RuntimeError('INVALID_INPUT', 'Preset 名称或指令长度无效')
    if (value.description && value.description.length > 1000) throw new RuntimeError('INVALID_INPUT', 'Preset 说明过长')
    if (new Set(value.extensions).size !== value.extensions.length || new Set(value.tools).size !== value.tools.length) {
      throw new RuntimeError('INVALID_INPUT', 'Preset 插件与工具不能重复')
    }
    const knownExtensions = new Map(installedExtensions().map(extension => [extension.name, extension]))
    const extensions = value.extensions.map(name => {
      const extension = knownExtensions.get(name)
      if (!extension) throw new RuntimeError('INVALID_INPUT', `Preset 引用了未安装的插件：${name}`)
      return extension
    })
    const knownTools = new Set(extensions.flatMap(extension => (extension.tools ?? []).map(tool => tool.name)))
    for (const name of value.tools) if (!knownTools.has(name)) throw new RuntimeError('INVALID_INPUT', `Preset 引用了未安装的工具：${name}`)
    if (value.model && !modelRuntime.models.getModel(value.model.provider, value.model.modelId)) throw new RuntimeError('MODEL_UNAVAILABLE', 'Preset 模型不在 Pi 模型目录中')
    assertModelAllowed(value.model, 'Preset 模型')
    if (value.thinkingLevel && !SUPPORTED_THINKING.has(value.thinkingLevel)) throw new RuntimeError('INVALID_INPUT', 'Preset 思考等级无效')
    if (value.accessMode === 'workspaceWrite' && !workspaceWriteAvailable) throw new RuntimeError('UNSUPPORTED', '当前系统无法启用工作区写入沙盒')
    return structuredClone({ ...value, name: value.name.trim() })
  }

  const presets = (): AgentPreset[] => appState.snapshot().presets

  const createPreset = async (input: CreateAgentPresetInput): Promise<AgentPreset> => {
    const candidate = validatePreset({ ...input, id: input.id ?? randomUUID() })
    return appState.update(state => {
      if (state.presets.some(item => item.id === candidate.id)) throw new RuntimeError('CONFLICT', 'Preset ID 已存在')
      state.presets.push(candidate)
      return structuredClone(candidate)
    })
  }

  const updatePreset = async (id: string, input: UpdateAgentPresetInput): Promise<AgentPreset> => {
    return appState.update(state => {
      const index = state.presets.findIndex(item => item.id === id)
      if (index < 0) throw new RuntimeError('NOT_FOUND', 'Agent preset 不存在')
      const candidate = validatePreset({ ...state.presets[index], ...input, id })
      state.presets[index] = candidate
      return structuredClone(candidate)
    })
  }

  const deletePreset = async (id: string): Promise<void> => {
    await appState.update(state => {
      const index = state.presets.findIndex(item => item.id === id)
      if (index < 0) throw new RuntimeError('NOT_FOUND', 'Agent preset 不存在')
      assertNoAutomationReferences(state.automations, 'preset', id)
      state.presets.splice(index, 1)
      if (state.settings.defaultPresetId === id) delete state.settings.defaultPresetId
    })
  }


  return {
    list: presets,
    create: createPreset,
    update: updatePreset,
    remove: deletePreset,
  }
}
