import { createHash, randomUUID } from 'node:crypto'
import { mkdir, realpath } from 'node:fs/promises'
import { basename, resolve } from 'node:path'
import { BACKGROUND_CONTEXT, type Context } from '@earendil-works/chord/context'
import type { Draft, JsonValue } from '@earendil-works/chord'
import {
  defineDoc,
  Harness,
  type ConversationId,
  type ConversationRecord,
  type EntryId,
  type ModelRef,
  type SubmissionId,
  type TaskId,
} from '@earendil-works/pi-durable'
import type { ConversationView, Cursor } from '@earendil-works/pi-durable'
import { CodingTools } from '@earendil-works/pi-durable/tools'
import { createRegistry } from '@earendil-works/pi-durable'
import { type Extension, type ToolRegistration } from '@earendil-works/pi-durable'
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node'
import type { AgentChange, UserInput } from '@earendil-works/pi-durable'
import type { UserMessage } from '@earendil-works/pi-ai'
import type { Runtime, RuntimeOptions } from './contracts.ts'
import type {
  AccessMode,
  AddWorkspaceInput,
  AgentPreset,
  AppSettings,
  Automation,
  ChatMessage,
  ConversationDetail,
  ConversationSummary,
  CreateAgentPresetInput,
  CreateAutomationInput,
  CreateConversationInput,
  EditQueueInput,
  ModelRef as UiModelRef,
  PluginSummary,
  ProviderInput,
  QueueItem,
  RenameWorkspaceInput,
  SubmitInput,
  ThinkingLevel,
  UpdateAgentPresetInput,
  UpdateAppSettingsInput,
  UpdateAutomationInput,
  UpdateConversationInput,
  UpdatePluginInput,
  WorkspaceSummary,
} from '../shared/types.ts'
import { projectConversation } from './projection.ts'
import { createModelRuntime } from './models.ts'
import { createDemoModelRuntime } from './demo-model.ts'
import { RuntimeError } from './runtime-errors.ts'
export { RuntimeError } from './runtime-errors.ts'
import { AppStateStore } from './app-state.ts'
import { WorkspaceFiles, type AttachmentInput, type AttachmentReference } from './workspace-files.ts'
import { createExecutionEnv, workspaceWriteSupported } from './execution-env.ts'

export type ConversationMetadata = {
  [key: string]: JsonValue
  title: string
  createdAt: number
  updatedAt: number
  archived: boolean
  pinned: boolean
  titleSource: 'auto' | 'user'
  queueCreatedAt: Record<string, number>
  requestReceipts: Record<string, { fingerprint: string; submissionId: number | null; status: 'pending' | 'accepted' }>
  workspaceId: string | null
  presetId: string | null
  accessMode: AccessMode
  feedback: Record<string, 'up' | 'down' | null>
  queueEdits: Record<string, {
    fingerprint: string
    sourceSubmissionId: number
    input: { text: string; whenBusy: 'steer' | 'followUp'; images: Array<{ data: string; mimeType: string }>; files: AttachmentReference[] }
    status: 'pending' | 'aborting' | 'aborted' | 'complete' | 'conflict'
    submissionId: number | null
  }>
}

const META = defineDoc<ConversationMetadata>({
  kind: 'pi-durable-web.conversation',
  version: 1,
  scope: 'conversation',
  history: 'latest',
  fork: 'initial',
  initial: () => ({
    title: 'New conversation',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    archived: false,
    pinned: false,
    titleSource: 'auto',
    queueCreatedAt: {},
    requestReceipts: {},
    workspaceId: null,
    presetId: null,
    accessMode: 'fullAccess',
    feedback: {},
    queueEdits: {},
  }),
})

const CTX: Context = BACKGROUND_CONTEXT
const DEFAULT_TITLE = 'New conversation'
const SUPPORTED_THINKING = new Set<ThinkingLevel>(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'])

function parseNumericId(value: string, label: string): number {
  const id = Number(value)
  if (!Number.isSafeInteger(id) || id <= 0) throw new RuntimeError('INVALID_INPUT', `${label} 无效`)
  return id
}

function parseConversationId(value: string): ConversationId {
  return parseNumericId(value, '会话 ID') as ConversationId
}

function parseEntryId(value: string): EntryId {
  return parseNumericId(value, '消息 ID') as EntryId
}

function parseSubmissionId(value: string): SubmissionId {
  return parseNumericId(value, '提交 ID') as SubmissionId
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  return Object.fromEntries(Object.entries(value))
}

function liveRunTaskId(view: ConversationView): TaskId | undefined {
  const live = objectValue(view.docs['pi.live'])
  const run = live ? objectValue(live.run) : undefined
  const id = run?.taskId
  return typeof id === 'number' && Number.isSafeInteger(id) && id > 0 ? id as TaskId : undefined
}

function attachmentReferences(value: unknown): AttachmentReference[] {
  if (!Array.isArray(value)) return []
  return value.flatMap(item => {
    const file = objectValue(item)
    if (!file || typeof file.name !== 'string' || typeof file.mimeType !== 'string' || typeof file.path !== 'string' || typeof file.size !== 'number') return []
    return [{ name: file.name, mimeType: file.mimeType, path: file.path, size: file.size }]
  })
}

type QueueContent = { text: string; images: Array<{ data: string; mimeType: string }>; files: AttachmentReference[] }

function queueContent(value: unknown, entryValue: unknown): QueueContent {
  const images: QueueContent['images'] = []
  const texts: string[] = []
  if (typeof value === 'string') texts.push(value)
  else if (Array.isArray(value)) {
    for (const partValue of value) {
      const part = objectValue(partValue)
      if (part?.type === 'text' && typeof part.text === 'string') texts.push(part.text)
      if (part?.type === 'image' && typeof part.data === 'string' && typeof part.mimeType === 'string') {
        images.push({ data: part.data, mimeType: part.mimeType })
      }
    }
  }
  const entry = objectValue(entryValue)
  const data = entry ? objectValue(entry.data) : undefined
  const files = attachmentReferences(data?.files)
  return { text: texts.join('\n'), images, files }
}

function safeTitle(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  const title = value.trim()
  if (!title || title.length > 200) throw new RuntimeError('INVALID_INPUT', '标题长度必须在 1 到 200 个字符之间')
  return title
}

function safeFailure(value: unknown): string {
  const text = value instanceof Error ? value.message : '操作失败'
  return text
    .replace(/\bauthorization\s*[:=]\s*(?:bearer\s+)?[^\s,;]+/gi, 'Authorization: [redacted]')
    .replace(/\bbearer\s+[^\s,;]+/gi, 'Bearer [redacted]')
    .replace(/(["']?(?:api[_ -]?key|access[_ -]?token|refresh[_ -]?token|client[_ -]?secret)["']?\s*[:=]\s*["']?)[^"'\s,;}]+/gi, '$1[redacted]')
    .replace(/\b(?:sk|rk|pk|key|token|secret)[-_][A-Za-z0-9._~+/-]{8,}/gi, '[redacted]')
    .replace(/[\r\n\t]+/g, ' ')
    .slice(0, 500)
}

function imageData(value: string): string {
  const match = /^data:[^,]*;base64,(.*)$/s.exec(value)
  return match?.[1] ?? value
}

function canonicalSubmit(input: SubmitInput): string {
  return JSON.stringify({
    text: input.text,
    images: (input.images ?? []).map((image) => ({ mimeType: image.mimeType, data: image.data })),
    files: (input.files ?? []).map((file) => ({ name: file.name, mimeType: file.mimeType, data: file.data })),
    whenBusy: input.whenBusy ?? 'followUp',
  })
}

function fingerprintSubmit(input: SubmitInput): string {
  return createHash('sha256').update(canonicalSubmit(input)).digest('hex')
}

function submissionContent(input: SubmitInput, files: readonly AttachmentReference[] = []): UserInput {
  const images = input.images ?? []
  const references = files.map(file => `[File attachment: ${file.name} (${file.path})]`).filter(reference => !input.text.includes(reference))
  const text = [input.text, ...references].filter(Boolean).join('\n\n')
  if (!images.length) return text
  return [
    ...(text ? [{ type: 'text' as const, text }] : []),
    ...images.map((image) => ({ type: 'image' as const, data: imageData(image.data), mimeType: image.mimeType })),
  ]
}

function assertSubmit(input: SubmitInput): void {
  if (typeof input.requestId !== 'string' || input.requestId.trim().length === 0 || input.requestId.length > 256) {
    throw new RuntimeError('INVALID_INPUT', 'requestId 必须是 1 到 256 个字符')
  }
  if (typeof input.text !== 'string' || input.text.length > 1_000_000) throw new RuntimeError('INVALID_INPUT', '消息文本无效或过长')
  if (input.whenBusy !== undefined && !['steer', 'followUp', 'reject'].includes(input.whenBusy)) {
    throw new RuntimeError('INVALID_INPUT', '忙碌时的提交方式无效')
  }
  if (input.images && input.images.length > 16) throw new RuntimeError('INVALID_INPUT', '单条消息最多包含 16 张图片')
  for (const image of input.images ?? []) {
    if (!/^image\/(png|jpeg|gif|webp|avif)$/.test(image.mimeType) || image.data.length > 12_000_000) {
      throw new RuntimeError('INVALID_INPUT', '图片类型或大小无效')
    }
  }
  if (input.files && input.files.length > 8) throw new RuntimeError('INVALID_INPUT', '单条消息最多附加 8 个文件')
  let totalAttachmentBytes = 0
  for (const file of input.files ?? []) {
    if (!file.name.trim() || file.name.length > 240 || !/^[\w.+-]+\/[\w.+-]+$/.test(file.mimeType) || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(file.data)) {
      throw new RuntimeError('INVALID_INPUT', '附件名称、类型或 Base64 内容无效')
    }
    const bytes = Buffer.from(file.data, 'base64')
    if (bytes.toString('base64') !== file.data || bytes.length > 8 * 1024 * 1024) throw new RuntimeError('INVALID_INPUT', '附件内容无效或过大')
    totalAttachmentBytes += bytes.length
  }
  if (totalAttachmentBytes > 16 * 1024 * 1024) throw new RuntimeError('INVALID_INPUT', '附件总大小不能超过 16 MiB')
  if (!input.text.trim() && !(input.images?.length) && !(input.files?.length)) throw new RuntimeError('INVALID_INPUT', '消息不能为空')
}

function cloneMetadata(value: Readonly<ConversationMetadata>): ConversationMetadata {
  return {
    title: value.title,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    archived: value.archived,
    pinned: value.pinned,
    titleSource: value.titleSource,
    queueCreatedAt: { ...value.queueCreatedAt },
    requestReceipts: structuredClone(value.requestReceipts),
    workspaceId: value.workspaceId,
    presetId: value.presetId,
    accessMode: value.accessMode,
    feedback: { ...value.feedback },
    queueEdits: structuredClone(value.queueEdits),
  }
}

export async function createRuntime(options: RuntimeOptions): Promise<Runtime> {
  const dataDir = resolve(options.dataDir)
  const requestedWorkspace = resolve(options.workspace)
  await mkdir(dataDir, { recursive: true, mode: 0o700 })
  await mkdir(requestedWorkspace, { recursive: true })
  const initialWorkspacePath = await realpath(requestedWorkspace)
  const modelRuntime = options.demo ? createDemoModelRuntime() : await createModelRuntime({ dataDir, piDir: options.piDir })
  const initialWorkspace: WorkspaceSummary = {
    id: randomUUID(),
    name: basename(initialWorkspacePath) || initialWorkspacePath,
    path: initialWorkspacePath,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }
  const appState = await AppStateStore.open({
    dataDir,
    defaultWorkspace: initialWorkspace,
    defaultThinkingLevel: modelRuntime.defaultThinkingLevel,
  })
  const initialState = appState.snapshot()
  const launchWorkspace = initialState.workspaces.find(item => item.path === initialWorkspacePath) ?? initialWorkspace
  const defaultWorkspace = initialState.workspaces.find(item => item.id === initialState.settings.defaultWorkspaceId) ??
    launchWorkspace
  if (defaultWorkspace.id !== initialState.settings.defaultWorkspaceId) {
    await appState.update(state => { state.settings.defaultWorkspaceId = defaultWorkspace.id })
  }
  const workspaceFiles = new WorkspaceFiles(() => appState.snapshot().workspaces)
  const workspaceWriteAvailable = await workspaceWriteSupported(defaultWorkspace.path)
  const storage = await openNodeSqliteStorage(resolve(dataDir, 'pi-durable.sqlite'))
  const registry = createRegistry()
  registry.install(CodingTools)
  let runtimeClosed = false
  let closePromise: Promise<void> | undefined
  const activeWatchStops = new Set<() => Promise<void>>()
  const automationTimers = new Map<string, ReturnType<typeof setTimeout>>()
  const automationTasks = new Set<Promise<void>>()
  const queueActionLocks = new Map<string, Promise<void>>()
  const withQueueActionLock = async <T>(key: string, action: () => Promise<T>): Promise<T> => {
    const previous = queueActionLocks.get(key) ?? Promise.resolve()
    const result = previous.then(action, action)
    const settled = result.then(() => undefined, () => undefined)
    queueActionLocks.set(key, settled)
    try { return await result } finally {
      if (queueActionLocks.get(key) === settled) queueActionLocks.delete(key)
    }
  }
  let runAutomation: (id: string) => Promise<{ automation: Automation; conversationId: string }>
  const scheduleAutomation = (automation: Automation): void => {
    const existing = automationTimers.get(automation.id)
    if (existing) clearTimeout(existing)
    automationTimers.delete(automation.id)
    if (runtimeClosed || !automation.enabled || automation.intervalMs === undefined) return
    const dueAt = automation.nextRunAt ?? Date.now() + automation.intervalMs
    const timer = setTimeout(() => {
      automationTimers.delete(automation.id)
      void runAutomation(automation.id).catch(() => undefined)
    }, Math.max(0, dueAt - Date.now()))
    timer.unref?.()
    automationTimers.set(automation.id, timer)
  }
  let harness: Harness
  harness = await Harness.open(storage, {
    models: modelRuntime.models,
    registry,
    env: async (target) => {
      const metadata = await harness.snapshot(META, target.conversationId, CTX)
      const selectedWorkspace = workspaceFiles.workspace(metadata?.workspaceId ?? defaultWorkspace.id)
      const selectedMode = metadata?.accessMode ?? appState.snapshot().settings.defaultAccessMode
      return createExecutionEnv(selectedWorkspace.path, selectedMode)
    },
    conversationCreated: async (tx, conversation) => {
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
      metadata.workspaceId = defaultWorkspace.id
      metadata.accessMode = appState.snapshot().settings.defaultAccessMode
      metadata.feedback = {}
      metadata.queueEdits = {}
      if (conversation.parent) {
        const parent = await tx.doc(META, conversation.parent.conversationId)
        metadata.title = parent.title === DEFAULT_TITLE ? 'Fork' : `${parent.title} (fork)`
        metadata.workspaceId = parent.workspaceId ?? defaultWorkspace.id
        metadata.presetId = parent.presetId ?? null
        metadata.accessMode = parent.accessMode ?? appState.snapshot().settings.defaultAccessMode
        metadata.feedback = {}
        metadata.queueEdits = {}
      }
    },
    onReport: () => undefined,
  }, CTX)
  const assertOpen = () => {
    if (runtimeClosed) throw new RuntimeError('CONFLICT', '运行时已关闭')
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
      metadata.workspaceId ??= defaultWorkspace.id
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

  const detailFromView = async (id: ConversationId, view: ConversationView, metadata?: Readonly<ConversationMetadata>): Promise<ConversationDetail> => {
    const currentMetadata = metadata ?? await ensureMetadata(id)
    const settings = appState.snapshot().settings
    const fallbackWorkspace = workspaceFiles.workspace(currentMetadata.workspaceId ?? settings.defaultWorkspaceId ?? defaultWorkspace.id)
    return projectConversation(view, cloneMetadata(currentMetadata), {
      workspace: fallbackWorkspace.path,
      defaultModel: settings.defaultModel ?? modelRuntime.defaultModel,
    })
  }

  const currentDetail = async (id: ConversationId): Promise<ConversationDetail> => {
    const conversation = await requireConversation(String(id))
    const viewWatch = await conversation.watch(CTX)
    try {
      return await detailFromView(id, viewWatch.value)
    } finally {
      await viewWatch.stop()
    }
  }

  const selectedWorkspace = (id: string | undefined): WorkspaceSummary => {
    return workspaceFiles.workspace(id ?? appState.snapshot().settings.defaultWorkspaceId ?? defaultWorkspace.id)
  }

  const selectedPreset = (id: string | null | undefined): AgentPreset | undefined => {
    if (!id) return undefined
    const preset = appState.snapshot().presets.find(item => item.id === id)
    if (!preset) throw new RuntimeError('NOT_FOUND', 'Agent preset 不存在')
    return preset
  }

  const buildAgentChange = (workspaceId: string, accessMode: AccessMode, preset?: AgentPreset, overrides: {
    model?: UiModelRef
    thinkingLevel?: ThinkingLevel
  } = {}): AgentChange => {
    const workspace = workspaceFiles.workspace(workspaceId)
    const installed = registry.snapshot().installed()
    const installedByName = new Map(installed.map(extension => [extension.name, extension]))
    const state = appState.snapshot()
    const extensionNames = preset
      ? preset.extensions
      : installed.filter(extension => state.plugins[extension.name]?.enabled ?? true).map(extension => extension.name)
    const extensions: Extension[] = extensionNames.map(name => {
      const extension = installedByName.get(name)
      if (!extension) throw new RuntimeError('INVALID_INPUT', `Preset 引用了未安装的插件：${name}`)
      return extension
    })
    const registeredTools = extensions.flatMap(extension => (extension.tools ?? []).map(tool => ({ extension, tool })))
    const requestedTools = preset ? new Set(preset.tools) : undefined
    const tools: ToolRegistration[] = registeredTools.flatMap(({ extension, tool }) => {
      const enabled = requestedTools
        ? requestedTools.has(tool.name)
        : state.plugins[extension.name]?.tools[tool.name] ?? true
      if (!enabled) return []
      if (accessMode === 'readOnly' && tool.name !== 'read') return []
      return [tool]
    })
    if (requestedTools) {
      const registeredNames = new Set(registeredTools.map(({ tool }) => tool.name))
      for (const name of requestedTools) {
        if (!registeredNames.has(name)) throw new RuntimeError('INVALID_INPUT', `Preset 引用了未安装的工具：${name}`)
      }
    }
    const model = overrides.model ?? preset?.model ?? state.settings.defaultModel ?? modelRuntime.defaultModel
    if (model && !modelRuntime.models.getModel(model.provider, model.modelId)) throw new RuntimeError('MODEL_UNAVAILABLE', '配置的模型未出现在 Pi 模型目录中')
    const thinkingLevel = overrides.thinkingLevel ?? preset?.thinkingLevel ?? state.settings.defaultThinkingLevel ?? modelRuntime.defaultThinkingLevel
    if (thinkingLevel && !SUPPORTED_THINKING.has(thinkingLevel)) throw new RuntimeError('INVALID_INPUT', '思考等级无效')
    return {
      cwd: workspace.path,
      extensions,
      tools,
      ...(model ? { model } : {}),
      ...(thinkingLevel ? { thinkingLevel } : {}),
      ...(preset?.instructions ? { instructions: preset.instructions } : {}),
    }
  }

  const list = async (): Promise<ConversationSummary[]> => {
    assertOpen()
    const records: ConversationRecord[] = []
    let cursor: Cursor | undefined
    do {
      const page = await harness.commit((tx) => tx.scanConversations({ order: 'descending' }, 250, cursor), CTX)
      records.push(...page.items.filter((record) => record.owner === undefined))
      cursor = page.next
    } while (cursor)
    const summaries = await Promise.all(records.map(async (record) => {
      const conversation = await harness.conversation(record.id, CTX)
      if (!conversation) return undefined
      const metadata = await ensureMetadata(record.id)
      const view = await conversation.watch(CTX)
      try {
        return (await detailFromView(record.id, view.value, metadata)).conversation
      } finally {
        await view.stop()
      }
    }))
    return summaries.filter((item): item is ConversationSummary => item !== undefined)
      .sort((a, b) => b.updatedAt - a.updatedAt || b.createdAt - a.createdAt)
  }

  const create = async (input: CreateConversationInput): Promise<ConversationDetail> => {
    assertOpen()
    const title = safeTitle(input.title)
    const settings = appState.snapshot().settings
    const workspace = selectedWorkspace(input.workspaceId ?? settings.defaultWorkspaceId)
    const presetId = input.presetId ?? settings.defaultPresetId ?? null
    const preset = selectedPreset(presetId)
    const accessMode = input.accessMode ?? preset?.accessMode ?? settings.defaultAccessMode
    if (accessMode === 'workspaceWrite' && !await workspaceWriteSupported(workspace.path)) {
      throw new RuntimeError('UNSUPPORTED', '当前系统无法启用工作区写入沙盒')
    }
    const agent = buildAgentChange(workspace.id, accessMode, preset, {
      ...(input.model ? { model: input.model } : {}),
      ...(input.thinkingLevel ? { thinkingLevel: input.thinkingLevel } : {}),
    })
    const conversation = await harness.createConversation({ ownership: { kind: 'ownerless' }, agent }, CTX)
    await withMetadata(conversation.id, (metadata) => {
      metadata.workspaceId = workspace.id
      metadata.presetId = presetId
      metadata.accessMode = accessMode
      if (title) {
        metadata.title = title
        metadata.titleSource = 'user'
      }
    })
    return currentDetail(conversation.id)
  }

  const update = async (value: string, input: UpdateConversationInput): Promise<ConversationDetail> => {
    const conversation = await requireConversation(value)
    const id = conversation.id
    const title = safeTitle(input.title)
    const currentMetadata = await ensureMetadata(id)
    const settings = appState.snapshot().settings
    const workspace = selectedWorkspace(input.workspaceId ?? currentMetadata.workspaceId ?? undefined)
    const presetId = input.presetId === undefined ? currentMetadata.presetId : input.presetId
    const preset = selectedPreset(presetId ?? settings.defaultPresetId)
    const presetChanged = input.presetId !== undefined
    const accessMode = input.accessMode ?? (presetChanged ? preset?.accessMode ?? currentMetadata.accessMode : currentMetadata.accessMode)
    const configurationChanged = input.workspaceId !== undefined || input.presetId !== undefined || input.accessMode !== undefined || input.model !== undefined || input.thinkingLevel !== undefined
    if (accessMode === 'workspaceWrite' && !await workspaceWriteSupported(workspace.path)) {
      throw new RuntimeError('UNSUPPORTED', '当前系统无法启用工作区写入沙盒')
    }
    if (configurationChanged) {
      const currentAgent = await conversation.agent(CTX)
      const model = input.model ?? (presetChanged ? preset?.model ?? settings.defaultModel ?? modelRuntime.defaultModel : currentAgent.model)
      const thinkingLevel = input.thinkingLevel ?? (presetChanged ? preset?.thinkingLevel ?? settings.defaultThinkingLevel : currentAgent.thinkingLevel)
      if (input.model && !modelRuntime.models.getModel(input.model.provider, input.model.modelId)) throw new RuntimeError('MODEL_UNAVAILABLE', '所选模型不在 Pi 模型目录中')
      if (thinkingLevel && !SUPPORTED_THINKING.has(thinkingLevel)) throw new RuntimeError('INVALID_INPUT', '思考等级无效')
      const change = buildAgentChange(workspace.id, accessMode, preset, {
        ...(model ? { model } : {}),
        ...(thinkingLevel ? { thinkingLevel } : {}),
      })
      await conversation.configure(change, CTX)
    }
    if (title !== undefined || input.archived !== undefined || input.pinned !== undefined || configurationChanged) {
      await withMetadata(id, (metadata) => {
        if (configurationChanged) {
          metadata.workspaceId = workspace.id
          metadata.presetId = presetId
          metadata.accessMode = accessMode
        }
        if (title !== undefined) {
          metadata.title = title
          metadata.titleSource = 'user'
        }
        if (input.archived !== undefined) metadata.archived = input.archived
        if (input.pinned !== undefined) metadata.pinned = input.pinned
      })
    }
    return currentDetail(id)
  }

  const submitWithReferences = async (
    conversation: Awaited<ReturnType<typeof requireConversation>>,
    input: SubmitInput,
    files: readonly AttachmentReference[],
    actualRequestId = input.requestId,
    fingerprint = fingerprintSubmit(input),
  ): Promise<{ submissionId: string }> => {
    const existing = await harness.commit(async (tx) => {
      const metadata = await tx.doc(META, conversation.id)
      const receipt = metadata.requestReceipts[actualRequestId]
      if (receipt && receipt.fingerprint !== fingerprint) {
        throw new RuntimeError('CONFLICT', '同一个 requestId 不能用于不同内容')
      }
      if (receipt?.submissionId !== null && receipt?.submissionId !== undefined) return String(receipt.submissionId)
      metadata.requestReceipts[actualRequestId] = { fingerprint, status: 'pending', submissionId: null }
      return undefined
    }, CTX)
    if (existing) return { submissionId: existing }

    const request = await conversation.submit({
      type: 'input',
      content: submissionContent(input, files),
      requestId: actualRequestId,
      entry: { kind: 'pi-web.user', data: { requestId: input.requestId, ...(files.length ? { files: files.map(file => ({ ...file })) } : {}) } },
      whenBusy: input.whenBusy ?? 'followUp',
    }, CTX)
    const status = await request.status(CTX)
    await harness.commit(async (tx) => {
      const metadata = await tx.doc(META, conversation.id)
      metadata.requestReceipts[actualRequestId] = { fingerprint, status: 'accepted', submissionId: Number(request.id) }
      if (status.status === 'queued') metadata.queueCreatedAt[String(request.id)] = Date.now()
      if (metadata.titleSource === 'auto' && metadata.title === DEFAULT_TITLE && input.text.trim()) {
        metadata.title = input.text.trim().slice(0, 60)
      }
      metadata.updatedAt = Date.now()
    }, CTX)
    return { submissionId: String(request.id) }
  }

  const submit = async (value: string, input: SubmitInput): Promise<{ submissionId: string }> => {
    assertSubmit(input)
    const conversation = await requireConversation(value)
    const metadata = await ensureMetadata(conversation.id)
    const files = input.files?.length
      ? await workspaceFiles.saveAttachments(metadata.workspaceId ?? defaultWorkspace.id, String(conversation.id), input.requestId, input.files)
      : []
    return submitWithReferences(conversation, input, files)
  }

  const queuedContentFor = async (conversation: Awaited<ReturnType<typeof requireConversation>>, submissionId: SubmissionId): Promise<QueueContent | undefined> => {
    const view = await conversation.watch(CTX)
    try {
      const inbox = objectValue(view.value.docs['pi.inbox'])
      const items = Array.isArray(inbox?.items) ? inbox.items : []
      const item = items.map(objectValue).find(candidate => candidate?.id === Number(submissionId))
      if (!item || (item.mode !== 'steer' && item.mode !== 'followUp')) return undefined
      return queueContent(item.content, item.entry)
    } finally {
      await view.stop()
    }
  }

  const finishQueueEdit = async (conversation: Awaited<ReturnType<typeof requireConversation>>, requestId: string): Promise<{ submissionId: string }> => {
    const id = conversation.id
    const metadata = await ensureMetadata(id)
    const edit = metadata.queueEdits[requestId]
    if (!edit) throw new RuntimeError('NOT_FOUND', '排队编辑记录不存在')
    if (edit.status === 'complete' && edit.submissionId !== null) return { submissionId: String(edit.submissionId) }
    if (edit.status === 'conflict') throw new RuntimeError('CONFLICT', '排队消息已进入当前运行，编辑未提交')

    const sourceId = edit.sourceSubmissionId as SubmissionId
    const source = await harness.submission(sourceId, CTX)
    if (!source) {
      await withMetadata(id, (draft) => { draft.queueEdits[requestId].status = 'conflict' })
      throw new RuntimeError('NOT_FOUND', '排队消息不存在')
    }
    const sourceRecord = await source.status(CTX)
    if (sourceRecord.conversationId !== id || sourceRecord.type !== 'input') throw new RuntimeError('NOT_FOUND', '排队消息不存在')
    if (sourceRecord.status === 'queued') {
      await withMetadata(id, (draft) => {
        const current = draft.queueEdits[requestId]
        if (current && current.status !== 'complete' && current.status !== 'conflict') current.status = 'aborting'
      })
      const result = await harness.abortSubmission(sourceId, CTX, id)
      if (result === 'already_placed') {
        await withMetadata(id, (draft) => { draft.queueEdits[requestId].status = 'conflict' })
        throw new RuntimeError('CONFLICT', '消息已进入当前运行，无法编辑')
      }
      if (result === 'not_found' || result === 'settled') {
        const settled = await source.status(CTX)
        if (settled.status !== 'unanswered' || settled.reason !== 'aborted') {
          await withMetadata(id, (draft) => { draft.queueEdits[requestId].status = 'conflict' })
          throw new RuntimeError('CONFLICT', '排队消息状态已改变，编辑未提交')
        }
      }
      await withMetadata(id, (draft) => { draft.queueEdits[requestId].status = 'aborted' })
    } else if (sourceRecord.status === 'unanswered' && sourceRecord.reason === 'aborted' && edit.status === 'aborting') {
      await withMetadata(id, (draft) => { draft.queueEdits[requestId].status = 'aborted' })
    } else if (edit.status !== 'aborted' || sourceRecord.status !== 'unanswered' || sourceRecord.reason !== 'aborted') {
      await withMetadata(id, (draft) => { draft.queueEdits[requestId].status = 'conflict' })
      throw new RuntimeError('CONFLICT', '排队消息状态已改变，编辑未提交')
    }

    const currentMetadata = await ensureMetadata(id)
    const stored = currentMetadata.queueEdits[requestId]
    if (!stored) throw new RuntimeError('CONFLICT', '排队编辑状态丢失')
    const input: SubmitInput = {
      requestId,
      text: stored.input.text,
      whenBusy: stored.input.whenBusy,
      images: stored.input.images,
    }
    const replacement = await submitWithReferences(conversation, input, stored.input.files, `queue-edit:${requestId}`, stored.fingerprint)
    await withMetadata(id, (draft) => {
      const current = draft.queueEdits[requestId]
      current.status = 'complete'
      current.submissionId = Number(replacement.submissionId)
      delete draft.queueCreatedAt[String(sourceId)]
    })
    return replacement
  }

  const editQueued = async (value: string, submissionValue: string, input: EditQueueInput): Promise<{ submissionId: string }> => {
    assertSubmit(input)
    const conversation = await requireConversation(value)
    const sourceId = parseSubmissionId(submissionValue)
    const lockKey = `${conversation.id}:${sourceId}`
    return withQueueActionLock(lockKey, async () => {
      const fingerprint = createHash('sha256').update(JSON.stringify({ sourceId, payload: canonicalSubmit(input) })).digest('hex')
      const currentMetadata = await ensureMetadata(conversation.id)
      const existing = currentMetadata.queueEdits[input.requestId]
      if (existing) {
        if (existing.sourceSubmissionId !== Number(sourceId) || existing.fingerprint !== fingerprint) {
          throw new RuntimeError('CONFLICT', '同一个 requestId 不能用于不同的排队编辑')
        }
        return finishQueueEdit(conversation, input.requestId)
      }
      const source = await harness.submission(sourceId, CTX)
      if (!source) throw new RuntimeError('NOT_FOUND', '排队消息不存在')
      const sourceRecord = await source.status(CTX)
      if (sourceRecord.conversationId !== conversation.id || sourceRecord.type !== 'input' || sourceRecord.status !== 'queued') {
        throw new RuntimeError('CONFLICT', '消息已不在排队中，编辑未提交')
      }
      const current = await queuedContentFor(conversation, sourceId)
      if (!current) throw new RuntimeError('CONFLICT', '无法读取排队消息内容')
      const workspaceId = currentMetadata.workspaceId ?? defaultWorkspace.id
      const files = input.files === undefined
        ? current.files
        : input.files.length
          ? await workspaceFiles.saveAttachments(workspaceId, String(conversation.id), `queue-edit-${input.requestId}`, input.files)
          : []
      const effective = {
        text: input.text,
        whenBusy: input.whenBusy,
        images: input.images ?? current.images,
        files,
      }
      await withMetadata(conversation.id, (draft) => {
        draft.queueEdits[input.requestId] = {
          fingerprint,
          sourceSubmissionId: Number(sourceId),
          input: effective,
          status: 'pending',
          submissionId: null,
        }
      })
      return finishQueueEdit(conversation, input.requestId)
    })
  }

  const stop = async (value: string): Promise<void> => {
    const conversation = await requireConversation(value)
    const view = await conversation.watch(CTX)
    let taskId: TaskId | undefined
    try { taskId = liveRunTaskId(view.value) } finally { await view.stop() }
    if (taskId !== undefined) await harness.abortTask(taskId, CTX)
  }

  const removeQueued = async (value: string, submissionValue: string): Promise<void> => {
    const conversation = await requireConversation(value)
    const submissionId = parseSubmissionId(submissionValue)
    return withQueueActionLock(`${conversation.id}:${submissionId}`, async () => {
      const submission = await harness.submission(submissionId, CTX)
      if (!submission) throw new RuntimeError('NOT_FOUND', '排队消息不存在')
      const record = await submission.status(CTX)
      if (record.conversationId !== conversation.id || record.type !== 'input' || record.status !== 'queued') {
        throw new RuntimeError('NOT_FOUND', '排队消息不存在')
      }
      const result = await harness.abortSubmission(submissionId, CTX, conversation.id)
      if (result === 'already_placed') throw new RuntimeError('CONFLICT', '消息已进入当前运行，无法撤回')
      if (result === 'not_found' || result === 'settled') throw new RuntimeError('NOT_FOUND', '排队消息不存在')
      await withMetadata(conversation.id, (metadata) => { delete metadata.queueCreatedAt[String(submissionId)] })
    })
  }

  const fork = async (value: string, entryValue: string): Promise<ConversationDetail> => {
    const conversation = await requireConversation(value)
    const entryId = parseEntryId(entryValue)
    const cutoff = await conversation.entries({ order: 'descending', maxEntryId: entryId }, 1, undefined, CTX)
    if (cutoff.items[0]?.id !== entryId) throw new RuntimeError('NOT_FOUND', '分叉位置不属于该会话')
    const child = await conversation.fork(entryId, { ownership: { kind: 'ownerless' } }, CTX)
    return currentDetail(child.id)
  }

  const watch = async (value: string, listener: (value: ConversationDetail) => void): Promise<() => Promise<void>> => {
    const conversation = await requireConversation(value)
    const id = conversation.id
    await ensureMetadata(id)
    const viewWatch = await conversation.watch(CTX)
    const metadataWatch = await harness.watchDoc(META, id, CTX)
    if (!metadataWatch) {
      await viewWatch.stop()
      throw new RuntimeError('CONFLICT', '无法订阅会话元数据')
    }
    let latestView = viewWatch.value
    let latestMetadata = metadataWatch.value ?? await ensureMetadata(id)
    let stopped = false
    let delivery = Promise.resolve()
    const refresh = () => {
      delivery = delivery.then(async () => {
        if (!stopped) listener(await detailFromView(id, latestView, latestMetadata))
      })
      return delivery
    }
    listener(await detailFromView(id, latestView, latestMetadata))
    viewWatch.start(async (view) => {
      latestView = view
      await refresh()
    })
    metadataWatch.start(async (metadata) => {
      if (metadata) latestMetadata = metadata
      await refresh()
    })
    const unsubscribe = async () => {
      if (stopped) return
      stopped = true
      activeWatchStops.delete(unsubscribe)
      await Promise.all([viewWatch.stop(), metadataWatch.stop()])
      await delivery
    }
    activeWatchStops.add(unsubscribe)
    return unsubscribe
  }

  const settings = (): AppSettings => appState.snapshot().settings

  const capabilities = (): { accessModes: AccessMode[] } => ({
    accessModes: workspaceWriteAvailable ? ['readOnly', 'workspaceWrite', 'fullAccess'] : ['readOnly', 'fullAccess'],
  })

  const updateSettings = async (input: UpdateAppSettingsInput): Promise<AppSettings> => {
    if (input.defaultModel && !modelRuntime.models.getModel(input.defaultModel.provider, input.defaultModel.modelId)) {
      throw new RuntimeError('MODEL_UNAVAILABLE', '默认模型不在 Pi 模型目录中')
    }
    if (input.defaultWorkspaceId && !appState.snapshot().workspaces.some(item => item.id === input.defaultWorkspaceId)) {
      throw new RuntimeError('NOT_FOUND', '默认工作区不存在')
    }
    if (input.defaultPresetId) selectedPreset(input.defaultPresetId)
    if (input.defaultAccessMode === 'workspaceWrite' && !workspaceWriteAvailable) {
      throw new RuntimeError('UNSUPPORTED', '当前系统无法启用工作区写入沙盒')
    }
    return appState.update(state => {
      if (input.theme !== undefined) state.settings.theme = input.theme
      if (input.locale !== undefined) state.settings.locale = input.locale
      if (input.fontSize !== undefined) state.settings.fontSize = input.fontSize
      if (input.codeFontSize !== undefined) state.settings.codeFontSize = input.codeFontSize
      if (input.terminalFontSize !== undefined) state.settings.terminalFontSize = input.terminalFontSize
      if (input.processDisplay !== undefined) state.settings.processDisplay = input.processDisplay
      if (input.collapseProcess !== undefined) state.settings.collapseProcess = input.collapseProcess
      if (input.codingViews !== undefined) state.settings.codingViews = input.codingViews
      if (input.busySendMode !== undefined) state.settings.busySendMode = input.busySendMode
      if (input.defaultThinkingLevel !== undefined) state.settings.defaultThinkingLevel = input.defaultThinkingLevel
      if (input.defaultAccessMode !== undefined) state.settings.defaultAccessMode = input.defaultAccessMode
      if (input.defaultModel === null) delete state.settings.defaultModel
      else if (input.defaultModel !== undefined) state.settings.defaultModel = { ...input.defaultModel }
      if (input.defaultPresetId === null) delete state.settings.defaultPresetId
      else if (input.defaultPresetId !== undefined) state.settings.defaultPresetId = input.defaultPresetId
      if (input.defaultWorkspaceId === null) state.settings.defaultWorkspaceId = launchWorkspace.id
      else if (input.defaultWorkspaceId !== undefined) state.settings.defaultWorkspaceId = input.defaultWorkspaceId
      if (input.shortcuts === null) delete state.settings.shortcuts
      else if (input.shortcuts !== undefined) state.settings.shortcuts = structuredClone(input.shortcuts)
      return structuredClone(state.settings)
    })
  }

  const workspaces = (): WorkspaceSummary[] => appState.snapshot().workspaces

  const addWorkspace = async (input: AddWorkspaceInput): Promise<WorkspaceSummary> => {
    const candidate = await workspaceFiles.addWorkspace(input.path, input.name)
    return appState.update(state => {
      if (state.workspaces.some(item => item.path === candidate.path)) throw new RuntimeError('CONFLICT', '这个目录已经添加为工作区')
      state.workspaces.push(candidate)
      return structuredClone(candidate)
    })
  }

  const renameWorkspace = async (id: string, input: RenameWorkspaceInput): Promise<WorkspaceSummary> => {
    const name = input.name.trim()
    if (!name || name.length > 120) throw new RuntimeError('INVALID_INPUT', '工作区名称长度必须在 1 到 120 个字符之间')
    return appState.update(state => {
      const item = state.workspaces.find(workspace => workspace.id === id)
      if (!item) throw new RuntimeError('NOT_FOUND', '工作区不存在')
      item.name = name
      item.updatedAt = Date.now()
      return structuredClone(item)
    })
  }

  const workspaceFileList = (id: string, path: string, query?: string) => workspaceFiles.list(id, path, query)
  const searchWorkspace = (id: string, query: string) => workspaceFiles.list(id, '', query)
  const workspaceFile = (id: string, path: string) => workspaceFiles.read(id, path)
  const workspaceAsset = (id: string, path: string) => workspaceFiles.asset(id, path)

  const plugins = (): PluginSummary[] => {
    const configured = appState.snapshot().plugins
    return registry.snapshot().installed().map(extension => ({
      id: extension.name,
      name: extension.name,
      builtin: true,
      enabled: configured[extension.name]?.enabled ?? true,
      tools: (extension.tools ?? []).map(tool => ({
        name: tool.name,
        description: tool.description,
        enabled: configured[extension.name]?.tools[tool.name] ?? true,
      })),
    }))
  }

  const updatePlugin = async (id: string, input: UpdatePluginInput): Promise<PluginSummary> => {
    const extension = registry.snapshot().extension(id)
    if (!extension) throw new RuntimeError('NOT_FOUND', '插件未安装')
    const toolNames = new Set((extension.tools ?? []).map(tool => tool.name))
    for (const name of Object.keys(input.tools ?? {})) {
      if (!toolNames.has(name)) throw new RuntimeError('INVALID_INPUT', `插件 ${id} 没有工具 ${name}`)
    }
    await appState.update(state => {
      const existing = state.plugins[id] ?? { enabled: true, tools: {} }
      if (input.enabled !== undefined) existing.enabled = input.enabled
      for (const [name, enabled] of Object.entries(input.tools ?? {})) existing.tools[name] = enabled
      state.plugins[id] = existing
    })
    const updated = plugins().find(item => item.id === id)
    if (!updated) throw new RuntimeError('CONFLICT', '无法读取更新后的插件配置')
    return updated
  }

  const validatePreset = (value: AgentPreset): AgentPreset => {
    if (!/^[A-Za-z0-9._~-]{1,128}$/.test(value.id)) throw new RuntimeError('INVALID_INPUT', 'Preset ID 无效')
    if (!value.name.trim() || value.name.length > 120 || value.instructions.length > 32_000) throw new RuntimeError('INVALID_INPUT', 'Preset 名称或指令长度无效')
    if (value.description && value.description.length > 1000) throw new RuntimeError('INVALID_INPUT', 'Preset 说明过长')
    if (new Set(value.extensions).size !== value.extensions.length || new Set(value.tools).size !== value.tools.length) {
      throw new RuntimeError('INVALID_INPUT', 'Preset 插件与工具不能重复')
    }
    const knownExtensions = new Map(registry.snapshot().installed().map(extension => [extension.name, extension]))
    const extensions = value.extensions.map(name => {
      const extension = knownExtensions.get(name)
      if (!extension) throw new RuntimeError('INVALID_INPUT', `Preset 引用了未安装的插件：${name}`)
      return extension
    })
    const knownTools = new Set(extensions.flatMap(extension => (extension.tools ?? []).map(tool => tool.name)))
    for (const name of value.tools) if (!knownTools.has(name)) throw new RuntimeError('INVALID_INPUT', `Preset 引用了未安装的工具：${name}`)
    if (value.model && !modelRuntime.models.getModel(value.model.provider, value.model.modelId)) throw new RuntimeError('MODEL_UNAVAILABLE', 'Preset 模型不在 Pi 模型目录中')
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
      state.presets.splice(index, 1)
      if (state.settings.defaultPresetId === id) delete state.settings.defaultPresetId
    })
  }

  const feedback = async (value: string, entryValue: string, rating: 'up' | 'down' | null): Promise<void> => {
    const conversation = await requireConversation(value)
    const entryId = parseEntryId(entryValue)
    const page = await conversation.entries({ order: 'descending', maxEntryId: entryId }, 1, undefined, CTX)
    if (page.items[0]?.id !== entryId) throw new RuntimeError('NOT_FOUND', '反馈消息不属于该会话')
    await withMetadata(conversation.id, metadata => {
      if (rating === null) delete metadata.feedback[String(entryId)]
      else metadata.feedback[String(entryId)] = rating
    })
  }

  const retry = async (value: string, entryValue: string, requestId: string): Promise<{ conversationId: string; submissionId: string }> => {
    if (!requestId.trim() || requestId.length > 256) throw new RuntimeError('INVALID_INPUT', 'requestId 无效')
    const source = await requireConversation(value)
    const targetId = parseEntryId(entryValue)
    const history = await source.entries({ order: 'descending', maxEntryId: targetId }, 5_000, undefined, CTX)
    const targetIndex = history.items.findIndex(entry => entry.id === targetId)
    if (targetIndex < 0) throw new RuntimeError('NOT_FOUND', '重试位置不属于该会话')
    let userIndex = -1
    let userMessage: UserMessage | undefined
    for (let index = targetIndex; index < history.items.length; index += 1) {
      const messages = history.items[index]?.model ?? []
      const candidate = [...messages].reverse().find(message => message.role === 'user')
      if (candidate?.role === 'user') {
        userIndex = index
        userMessage = candidate
        break
      }
    }
    if (userIndex < 0 || userMessage?.role !== 'user') throw new RuntimeError('NOT_FOUND', '找不到可重试的用户输入')
    const userEntry = history.items[userIndex]
    if (!userEntry) throw new RuntimeError('NOT_FOUND', '用户输入已不在会话历史中')
    const content = userMessage.content
    const text = typeof content === 'string' ? content : content.flatMap(part => part.type === 'text' ? [part.text] : []).join('\n')
    const images = typeof content === 'string' ? [] : content.flatMap(part => part.type === 'image' ? [{ data: part.data, mimeType: part.mimeType }] : [])
    const data = objectValue(userEntry.data)
    const files = attachmentReferences(data?.files)
    const metadata = await ensureMetadata(source.id)
    const workspace = selectedWorkspace(metadata.workspaceId ?? undefined)
    let child: Awaited<ReturnType<typeof source.fork>>
    const previousEntry = history.items[userIndex + 1]
    if (previousEntry) {
      child = await source.fork(previousEntry.id, { ownership: { kind: 'ownerless' } }, CTX)
    } else {
      const agent = await source.agent(CTX)
      const change: AgentChange = {
        cwd: workspace.path,
        extensions: agent.extensions,
        tools: agent.tools,
        thinkingLevel: agent.thinkingLevel,
        ...(agent.model ? { model: agent.model } : {}),
        ...(agent.instructions ? { instructions: agent.instructions } : {}),
      }
      child = await harness.createConversation({ ownership: { kind: 'ownerless' }, agent: change }, CTX)
    }
    await withMetadata(child.id, draft => {
      draft.workspaceId = metadata.workspaceId ?? defaultWorkspace.id
      draft.presetId = metadata.presetId
      draft.accessMode = metadata.accessMode
      draft.title = metadata.title
      draft.titleSource = metadata.titleSource
    })
    const submitInput: SubmitInput = { text, requestId, whenBusy: 'reject', ...(images.length ? { images } : {}) }
    const submitted = await submitWithReferences(child, submitInput, files)
    return { conversationId: String(child.id), submissionId: submitted.submissionId }
  }

  const catalog = async () => {
    const result = await modelRuntime.catalog()
    const defaultModel = appState.snapshot().settings.defaultModel ?? result.defaultModel
    return { ...result, ...(defaultModel ? { defaultModel } : {}) }
  }

  const provider = (id: string) => modelRuntime.provider(id)
  const deleteProvider = (id: string) => modelRuntime.deleteProvider(id)
  const testProvider = (id: string, modelId?: string) => modelRuntime.testProvider(id, modelId)

  const automations = (): Automation[] => appState.snapshot().automations

  const validateAutomation = (input: CreateAutomationInput | UpdateAutomationInput): void => {
    if (input.name !== undefined && (!input.name.trim() || input.name.length > 120)) throw new RuntimeError('INVALID_INPUT', 'Automation 名称无效')
    if (input.prompt !== undefined && (!input.prompt.trim() || input.prompt.length > 100_000)) throw new RuntimeError('INVALID_INPUT', 'Automation 提示词无效')
    if (input.intervalMs !== undefined && input.intervalMs !== null && (!Number.isSafeInteger(input.intervalMs) || input.intervalMs < 60_000 || input.intervalMs > 365 * 24 * 60 * 60 * 1000)) {
      throw new RuntimeError('INVALID_INPUT', 'Automation interval 必须在 1 分钟到 1 年之间')
    }
    if (input.model && !modelRuntime.models.getModel(input.model.provider, input.model.modelId)) throw new RuntimeError('MODEL_UNAVAILABLE', 'Automation 模型不在 Pi 模型目录中')
    if (input.workspaceId) selectedWorkspace(input.workspaceId)
    if (input.presetId) selectedPreset(input.presetId)
  }

  const createAutomation = async (input: CreateAutomationInput): Promise<Automation> => {
    validateAutomation(input)
    const now = Date.now()
    const intervalMs = input.intervalMs
    const candidate: Automation = {
      id: randomUUID(),
      name: input.name.trim(),
      prompt: input.prompt,
      enabled: input.enabled ?? intervalMs !== undefined,
      ...(intervalMs !== undefined ? { intervalMs } : {}),
      ...(input.model ? { model: { ...input.model } } : {}),
      ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
      ...(input.presetId ? { presetId: input.presetId } : {}),
      ...(input.enabled !== false && intervalMs !== undefined ? { nextRunAt: now + intervalMs } : {}),
      createdAt: now,
      updatedAt: now,
    }
    const stored = await appState.update(state => {
      state.automations.push(candidate)
      return structuredClone(candidate)
    })
    scheduleAutomation(stored)
    return stored
  }

  const updateAutomation = async (id: string, input: UpdateAutomationInput): Promise<Automation> => {
    validateAutomation(input)
    const updated = await appState.update(state => {
      const current = state.automations.find(item => item.id === id)
      if (!current) throw new RuntimeError('NOT_FOUND', 'Automation 不存在')
      if (input.name !== undefined) current.name = input.name.trim()
      if (input.prompt !== undefined) current.prompt = input.prompt
      if (input.model !== undefined) current.model = input.model ? { ...input.model } : undefined
      if (input.workspaceId !== undefined) current.workspaceId = input.workspaceId
      if (input.presetId !== undefined) current.presetId = input.presetId
      if (input.intervalMs === null) {
        delete current.intervalMs
        delete current.nextRunAt
        if (input.enabled === undefined) current.enabled = false
      } else if (input.intervalMs !== undefined) {
        current.intervalMs = input.intervalMs
        current.nextRunAt = input.enabled === false ? undefined : Date.now() + input.intervalMs
      }
      if (input.enabled !== undefined) current.enabled = input.enabled
      if (!current.enabled || current.intervalMs === undefined) delete current.nextRunAt
      current.updatedAt = Date.now()
      return structuredClone(current)
    })
    scheduleAutomation(updated)
    return updated
  }

  const deleteAutomation = async (id: string): Promise<void> => {
    const current = appState.snapshot().automations.find(item => item.id === id)
    if (!current) throw new RuntimeError('NOT_FOUND', 'Automation 不存在')
    if (current.lastRun?.status === 'running') throw new RuntimeError('CONFLICT', 'Automation 仍在运行')
    const timer = automationTimers.get(id)
    if (timer) clearTimeout(timer)
    automationTimers.delete(id)
    await appState.update(state => {
      const index = state.automations.findIndex(item => item.id === id)
      if (index < 0) throw new RuntimeError('NOT_FOUND', 'Automation 不存在')
      state.automations.splice(index, 1)
    })
  }

  const finishAutomation = async (automationId: string, runId: string, conversationId: string): Promise<void> => {
    let status: NonNullable<Automation['lastRun']>['status'] = 'completed'
    let errorMessage: string | undefined
    try {
      const conversation = await requireConversation(conversationId)
      await conversation.waitForIdle(CTX)
      const detail = await currentDetail(conversation.id)
      if (detail.error) {
        status = 'failed'
        errorMessage = safeFailure(detail.error)
      }
    } catch (error) {
      status = 'failed'
      errorMessage = safeFailure(error)
    }
    const updated = await appState.update(state => {
      const automation = state.automations.find(item => item.id === automationId)
      if (!automation || automation.lastRun?.id !== runId) return undefined
      const finishedAt = Date.now()
      automation.lastRun = {
        id: runId,
        status,
        conversationId,
        startedAt: automation.lastRun.startedAt,
        finishedAt,
        ...(errorMessage ? { error: errorMessage } : {}),
      }
      automation.updatedAt = finishedAt
      if (automation.enabled && automation.intervalMs !== undefined) automation.nextRunAt = finishedAt + automation.intervalMs
      return structuredClone(automation)
    })
    if (updated) scheduleAutomation(updated)
  }

  runAutomation = async (id: string): Promise<{ automation: Automation; conversationId: string }> => {
    const current = appState.snapshot().automations.find(item => item.id === id)
    if (!current) throw new RuntimeError('NOT_FOUND', 'Automation 不存在')
    if (current.lastRun?.status === 'running') throw new RuntimeError('CONFLICT', 'Automation 已在运行')
    const runId = randomUUID()
    const startedAt = Date.now()
    const running = await appState.update(state => {
      const automation = state.automations.find(item => item.id === id)
      if (!automation) throw new RuntimeError('NOT_FOUND', 'Automation 不存在')
      if (automation.lastRun?.status === 'running') throw new RuntimeError('CONFLICT', 'Automation 已在运行')
      automation.lastRun = { id: runId, status: 'running', startedAt }
      delete automation.nextRunAt
      automation.updatedAt = startedAt
      return structuredClone(automation)
    })
    let conversationId: string | undefined
    try {
      const detail = await create({
        title: running.name,
        ...(running.model ? { model: running.model } : {}),
        ...(running.workspaceId ? { workspaceId: running.workspaceId } : {}),
        ...(running.presetId ? { presetId: running.presetId } : {}),
      })
      conversationId = detail.conversation.id
      await submit(conversationId, { text: running.prompt, requestId: `automation:${runId}`, whenBusy: 'reject' })
      await appState.update(state => {
        const automation = state.automations.find(item => item.id === id)
        if (automation?.lastRun?.id === runId) automation.lastRun.conversationId = conversationId
      })
    } catch (error) {
      await appState.update(state => {
        const automation = state.automations.find(item => item.id === id)
        if (automation?.lastRun?.id === runId) {
          automation.lastRun = {
            id: runId,
            status: 'failed',
            startedAt,
            finishedAt: Date.now(),
            ...(conversationId ? { conversationId } : {}),
            error: safeFailure(error),
          }
          automation.updatedAt = Date.now()
          if (automation.enabled && automation.intervalMs !== undefined) automation.nextRunAt = Date.now() + automation.intervalMs
        }
      })
      const updated = appState.snapshot().automations.find(item => item.id === id)
      if (updated) scheduleAutomation(updated)
      throw error
    }
    const task = finishAutomation(id, runId, conversationId)
    automationTasks.add(task)
    void task.finally(() => automationTasks.delete(task)).catch(() => undefined)
    const latest = appState.snapshot().automations.find(item => item.id === id)
    if (!latest || !conversationId) throw new RuntimeError('CONFLICT', 'Automation 运行状态无法读取')
    return { automation: latest, conversationId }
  }

  const recoverAutomations = async (): Promise<void> => {
    const recovered = await appState.update(state => {
      const now = Date.now()
      for (const automation of state.automations) {
        if (automation.lastRun?.status === 'running') {
          automation.lastRun = {
            ...automation.lastRun,
            status: 'interrupted',
            finishedAt: now,
            error: 'Pi Durable Web 在运行期间重新启动',
          }
          automation.updatedAt = now
        }
        if (automation.enabled && automation.intervalMs !== undefined && automation.nextRunAt === undefined) {
          automation.nextRunAt = now + automation.intervalMs
        }
      }
      return structuredClone(state.automations)
    })
    for (const automation of recovered) scheduleAutomation(automation)
  }

  const recoverQueueEdits = async (): Promise<void> => {
    const records: ConversationRecord[] = []
    let cursor: Cursor | undefined
    do {
      const page = await harness.commit((tx) => tx.scanConversations({ order: 'ascending' }, 250, cursor), CTX)
      records.push(...page.items.filter(record => record.owner === undefined))
      cursor = page.next
    } while (cursor)
    for (const record of records) {
      const metadata = await ensureMetadata(record.id)
      const pending = Object.entries(metadata.queueEdits).filter(([, edit]) => edit.status === 'pending' || edit.status === 'aborting' || edit.status === 'aborted')
      if (!pending.length) continue
      const conversation = await harness.conversation(record.id, CTX)
      if (!conversation) continue
      for (const [requestId] of pending) {
        try { await finishQueueEdit(conversation, requestId) } catch (error) {
          if (error instanceof RuntimeError && (error.code === 'CONFLICT' || error.code === 'NOT_FOUND')) continue
          throw error
        }
      }
    }
  }

  await recoverQueueEdits()
  await recoverAutomations()
  harness.resume()

  return {
    list,
    create,
    detail: async (value) => currentDetail(parseConversationId(value)),
    update,
    submit,
    editQueued,
    stop,
    removeQueued,
    fork,
    retry,
    watch,
    catalog,
    saveProvider: modelRuntime.saveProvider,
    provider,
    deleteProvider,
    testProvider,
    settings,
    capabilities,
    updateSettings,
    workspaces,
    addWorkspace,
    renameWorkspace,
    workspaceFiles: workspaceFileList,
    searchWorkspace,
    workspaceFile,
    workspaceAsset,
    plugins,
    updatePlugin,
    presets,
    createPreset,
    updatePreset,
    deletePreset,
    feedback,
    automations,
    createAutomation,
    updateAutomation,
    deleteAutomation,
    runAutomation,
    async close() {
      if (!closePromise) {
        runtimeClosed = true
        for (const timer of automationTimers.values()) clearTimeout(timer)
        automationTimers.clear()
        closePromise = (async () => {
          try {
            await Promise.all([...activeWatchStops].map((unsubscribe) => unsubscribe()))
          } finally {
            await harness.close(CTX)
            await Promise.allSettled([...automationTasks])
          }
        })()
      }
      await closePromise
    },
  }
}
