import { createHash, randomUUID } from 'node:crypto'
import { Buffer } from 'node:buffer'
import { execFile } from 'node:child_process'
import { mkdir, realpath } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import { BACKGROUND_CONTEXT, type Context } from '@earendil-works/chord/context'
import type { Draft, JsonValue } from '@earendil-works/chord'
import {
  defineDoc,
  AgentDoc,
  Harness,
  UsageDoc,
  type ConversationId,
  type ConversationRecord,
  type EntryId,
  type ModelRef,
  type SubmissionId,
  type TaskId,
  type Tx,
} from '@earendil-works/pi-durable'
import type { ConversationView, Cursor } from '@earendil-works/pi-durable'
import { CodingTools } from '@earendil-works/pi-durable/tools'
import { createRegistry } from '@earendil-works/pi-durable'
import { type Extension, type ToolRegistration } from '@earendil-works/pi-durable'
import { CODEMODE_TOOL_NAME, createCodemodeExtension } from '@earendil-works/pi-durable/codemode'
import { createToolSearchExtension } from '@earendil-works/pi-durable/tool-search'
import { CodemodeSandbox } from '@earendil-works/pi-codemode'
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node'
import type { AgentChange, UserInput } from '@earendil-works/pi-durable'
import type { UserMessage } from '@earendil-works/pi-ai'
import type { Runtime, RuntimeOptions } from './contracts.ts'
import type { GoalUpdateRequest } from '../shared/types.ts'
import type {
  AccessMode,
  AddWorkspaceInput,
  AgentPreset,
  AppSettings,
  AskUserQuestionAnswerItem,
  Automation,
  ChatMessage,
  ChildMessageInput,
  ConversationDetail,
  ConversationSummary,
  CreateAgentPresetInput,
  CreateAutomationInput,
  CreateConversationInput,
  CreateGitBranchInput,
  EditQueueInput,
  GitBranchMutation,
  GitBranchSnapshot,
  ModelRef as UiModelRef,
  ProviderConfigSummary,
  ProviderInput,
  QueueItem,
  RenameWorkspaceInput,
  SubmitInput,
  SubagentSummary,
  SwitchGitBranchInput,
  TeamView,
  ThinkingLevel,
  UpdateAgentPresetInput,
  UpdateAppSettingsInput,
  UpdateAutomationInput,
  UpdateConversationInput,
  WorkspaceSummary,
} from '../shared/types.ts'
import { activeDurationMs, projectConversation, usageTokens } from './projection.ts'
import { clampThinkingLevel, createModelRuntime } from './models.ts'
import { createDemoModelRuntime } from './demo-model.ts'
import { isValidAllowlistEntry, modelWithinAllowlist, normalizeModelAllowlist } from './model-allowlist.ts'
import { RuntimeError } from './runtime-errors.ts'
import { fallbackSessionTitle, frameTitleMessages, normalizeSessionTitle, titleSystemPrompt, TITLE_POLICY } from './session-title.ts'
import { TodoTools, Todos } from './todo-tools.ts'
import { createGoalExtension, GOAL_TOOL_NAMES, Goals, applyGoalCreate, applyGoalUpdate } from './goal-tools.ts'
import { InteractionTools, Interactions } from './interaction-tools.ts'
import { PlanExtension, Plans, decidePlanReview, interactionTable, planReviewOf, type StoredPlanReview } from './plan-tools.ts'
import { SUBAGENT_TOOL, Subagents, createSubagentTools } from './subagent-tools.ts'
import {
  TEAM_TOOL_NAMES,
  Team,
  TeamLink,
  createTeamTools,
  projectTeam,
  reconcileProvisioning,
  type MemberSessionState,
  type TeamConversationInfo,
} from './team-tools.ts'
import { validateAnswers } from './interactions.ts'
import { createDirectory as createHostDirectory, listDirectories as listHostDirectories, pickNativeDirectory } from './directory-picker.ts'
import { McpManager } from './mcp.ts'
import { SkillStore } from './skills.ts'
import { createSkillTools, SKILL_READ_TOOLS } from './skill-tools.ts'
import { createWorkPolicyExtension, WORK_POLICY_EXTENSION_NAME } from './work-policy.ts'
import { COMPACTION_EXTENSION_NAME, COMPACTION_POLICY, createCompactionExtension } from './compaction.ts'
export { RuntimeError } from './runtime-errors.ts'
import { AppStateStore } from './app-state.ts'
import { WorkspaceFiles, type AttachmentInput, type AttachmentReference } from './workspace-files.ts'
import { GitBranches } from './git-branches.ts'
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
/** The Pi code mode extension's registry name (`createCodemodeExtension`). */
const CODEMODE_EXTENSION_NAME = 'codemode'
/** Tools a read-only conversation keeps: reads plus interaction tools that touch no workspace state. */
const READ_ONLY_TOOLS = new Set(['read', 'todo_write', 'ask_user_question', 'exit_plan_mode', CODEMODE_TOOL_NAME, SUBAGENT_TOOL, ...TEAM_TOOL_NAMES, ...SKILL_READ_TOOLS, ...GOAL_TOOL_NAMES])

/** Add the host's tool-free policy without changing a conversation's tools or custom instructions. */
async function ensureRuntimePolicy(tx: Tx, conversationId: ConversationId): Promise<void> {
  const agent = await tx.doc(AgentDoc, conversationId)
  const extensions = agent.extensions
  const required = [WORK_POLICY_EXTENSION_NAME, COMPACTION_EXTENSION_NAME]
  if (Array.isArray(extensions)) {
    for (const name of required) if (!extensions.includes(name)) extensions.unshift(name)
  } else if (extensions !== undefined) {
    agent.extensions = {
      ...extensions,
      add: [...new Set([...required, ...extensions.add ?? []])],
      ...(extensions.remove === undefined ? {} : { remove: extensions.remove.filter(name => !required.includes(name)) }),
    }
  }
}

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

const OPEN_CONFIG_TIMEOUT_MS = 15_000
/** Children listed per parent, mirroring DSH's catalog page, and the row-level answer summary bound. */
const SUBAGENT_LIMIT = 50
const SUBAGENT_ANSWER_CHARS = 200
const SUBAGENT_MESSAGE_CHARS = 20_000

/**
 * Open one local file on the operator's desktop, following the same platform
 * split directory-picker.ts uses for its native surface. The launcher hands
 * off and exits, so a command that never returns is killed at the timeout
 * instead of holding the request open.
 */
function openLocalFile(path: string): Promise<void> {
  const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : process.platform === 'linux' ? 'xdg-open' : undefined
  if (command === undefined) throw new RuntimeError('UNSUPPORTED', '当前系统没有可用的文件打开方式')
  // `start` is a cmd builtin, and its first quoted argument is the window title.
  const args = command === 'cmd' ? ['/c', 'start', '', path] : [path]
  return new Promise<void>((resolve, reject) => {
    execFile(command, args, { timeout: OPEN_CONFIG_TIMEOUT_MS }, (error, _stdout, stderr) => {
      if (error === null) {
        resolve()
        return
      }
      const failure = error as NodeJS.ErrnoException & { killed?: boolean }
      if (failure.code === 'ENOENT') {
        reject(new RuntimeError('UNSUPPORTED', `当前系统缺少打开文件的命令：${command}`))
        return
      }
      if (failure.killed) {
        reject(new RuntimeError('PROVIDER_ERROR', '打开配置文件超时，系统命令未退出'))
        return
      }
      reject(new RuntimeError('PROVIDER_ERROR', `无法打开配置文件：${safeFailure(stderr.trim() ? new Error(stderr.trim()) : error)}`))
    })
  })
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
  /** Catalog reloads (file edits, saves, another instance) fanned out to web clients. */
  const modelListeners = new Set<() => void>()
  const unsubscribeModels = modelRuntime.subscribe(() => {
    for (const listener of [...modelListeners]) {
      try { listener() } catch { /* a dropped event stream must not stop the reload */ }
    }
  })
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
  const gitBranches = new GitBranches(() => appState.snapshot().workspaces)
  const skillStore = new SkillStore()
  const workspaceWriteAvailable = await workspaceWriteSupported(defaultWorkspace.path)
  const storage = await openNodeSqliteStorage(resolve(dataDir, 'pi-durable.sqlite'))
  // Declared before the extensions so their closures can read the harness at call time.
  let harness: Harness
  /**
   * One conversation's live turn status plus its model. `pi.live.run` is the same signal the child
   * catalog uses (`busy`), so `inactive` here means exactly "no turn is executing".
   */
  const conversationInfo = async (value: string): Promise<TeamConversationInfo> => {
    const id = parseConversationId(value)
    const conversation = await harness.conversation(id, CTX)
    if (conversation === undefined) return { status: 'inactive' }
    const viewWatch = await conversation.watch(CTX)
    try {
      const running = liveRunTaskId(viewWatch.value) !== undefined
      const agent = await conversation.agent(CTX)
      return {
        status: running ? 'running' : 'inactive',
        ...(agent.model === undefined ? {} : { model: `${agent.model.provider}/${agent.model.modelId}` }),
      }
    } finally {
      await viewWatch.stop()
    }
  }
  /**
   * Durable evidence about one provisioned member session, for the spawn replay path and the
   * provisioning reconciliation. DSH reads the persisted child Session (`roster.ts:385-397`);
   * Pi's tool API has no session-log reader, so the same questions are answered from the
   * conversation table, the child's link document, and its initial submission record.
   */
  const memberSession = async (value: string, leadId: ConversationId, name: string): Promise<MemberSessionState> => {
    const childId = parseConversationId(value)
    const record = await harness.commit((tx) => tx.conversation(childId), CTX)
    if (record === undefined) return { exists: false, linked: false, promptRejected: false, running: false }
    const link = await harness.snapshot(TeamLink, childId, CTX)
    const submission = await harness.commit(
      (tx) => tx.submissionByRequest(childId, `team-spawn:${String(leadId)}:${name}`), CTX)
    const conversation = await harness.conversation(childId, CTX)
    let running = false
    if (conversation !== undefined) {
      const viewWatch = await conversation.watch(CTX)
      try {
        running = liveRunTaskId(viewWatch.value) !== undefined
      } finally {
        await viewWatch.stop()
      }
    }
    return {
      exists: true,
      linked: link?.leadConversationId === String(leadId) && link.name === name,
      // DSH needs the initial prompt durably accepted (`roster.ts:389-394`). Pi's inbox admission
      // (`queued`) already survives a crash and the replay resubmits under the same request ID, so
      // only an explicit rejection (`unanswered`) is terminal.
      promptRejected: submission?.status === 'unanswered',
      running,
    }
  }
  /**
   * DSH reconciles provisioning-only members when the Lead session starts (`roster.ts:175-179`).
   * Pi's equivalent start point is runtime creation: every Lead document is scanned once here.
   */
  const reconcileTeamRosters = async (): Promise<void> => {
    const records: ConversationRecord[] = []
    let cursor: Cursor | undefined
    do {
      const page = await harness.commit((tx) => tx.scanConversations({ order: 'ascending' }, 250, cursor), CTX)
      records.push(...page.items)
      cursor = page.next
    } while (cursor)
    for (const record of records) {
      const doc = await harness.snapshot(Team, record.id, CTX)
      if (doc === undefined || !doc.members.some(member => member.role === 'teammate' && member.phase === 'provisioning')) continue
      try {
        await reconcileProvisioning(
          { read: (id, ctx) => harness.snapshot(Team, id, ctx), commit: (change, ctx) => harness.commit(change, ctx) },
          { memberSession },
          record.id,
          CTX,
        )
      } catch {
        // One malformed roster must not stop the remaining teams from being reconciled.
      }
    }
  }
  /**
   * Observe each teammate's busy transitions for `wait_agent`. DSH's `TeamActivity` is notified by
   * the runtime's `agent/status` event; Pi exposes no such subscription, so the same edge is read
   * off the child conversation view (`pi.live.run` entering or leaving).
   */
  const watchTeamMembers = async (leadValue: string, onChange: () => void): Promise<() => Promise<void>> => {
    const leadId = parseConversationId(leadValue)
    const doc = await harness.snapshot(Team, leadId, CTX)
    const ids = (doc?.members ?? []).flatMap(member =>
      member.role === 'teammate' && typeof member.conversationId === 'string' ? [member.conversationId] : [])
    const stops: Array<() => Promise<unknown>> = []
    for (const value of ids) {
      const conversation = await harness.conversation(parseConversationId(value), CTX)
      if (conversation === undefined) continue
      const viewWatch = await conversation.watch(CTX)
      let running = liveRunTaskId(viewWatch.value) !== undefined
      viewWatch.start(async (view) => {
        const next = liveRunTaskId(view) !== undefined
        if (next === running) return
        running = next
        onChange()
      })
      stops.push(() => viewWatch.stop())
    }
    return async () => { await Promise.allSettled(stops.map(stop => stop())) }
  }
  // A task-owned child copies the owner's `pi.agent` in the creation hook, so only the runtime's
  // own metadata needs stamping: the delegation label becomes the child's title, and the child
  // works in the parent's workspace under the parent's access mode. Both subagents and teammates
  // create their child this way.
  const prepareChildConversation = async (tx: Tx, childId: ConversationId, parentId: ConversationId, label: string): Promise<void> => {
    const metadata = await tx.doc(META, childId)
    const parent = await tx.doc(META, parentId)
    metadata.title = label
    metadata.titleSource = 'user'
    metadata.workspaceId = parent.workspaceId ?? defaultWorkspace.id
    metadata.presetId = parent.presetId ?? null
    metadata.accessMode = parent.accessMode ?? appState.snapshot().settings.defaultAccessMode
  }
  /**
   * Pi 1.3.0 capabilities this project turns on: imported MCP servers and code mode.
   * MCP is a read-only import of the global `mcp.json`; a missing file, a bad
   * entry, or a failing server is reported in the MCP view, never a startup failure.
   */
  const mcpConfigPath = options.mcpConfigPath ??
    (options.demo ? join(dataDir, 'mcp.json') : join(options.piDir ?? dataDir, 'mcp.json'))
  const mcp = await McpManager.open({ configPath: mcpConfigPath })
  const codemodeSandbox = new CodemodeSandbox({ memoryLimitBytes: 256 * 1024 * 1024 })
  const registry = createRegistry()
  registry.install(createWorkPolicyExtension())
  registry.install(createCompactionExtension({ harness: () => harness }))
  registry.install(CodingTools)
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
  registry.install(createSubagentTools({ prepareChild: prepareChildConversation }))
  registry.install(createTeamTools({
    prepareChild: prepareChildConversation,
    conversationInfo,
    watchMembers: watchTeamMembers,
    memberSession,
  }))
  registry.install(createCodemodeExtension({ sandbox: codemodeSandbox, namespaces: mcp.namespaces() }))
  const mcpExtension = mcp.extension()
  if (mcpExtension !== undefined) registry.install(mcpExtension)
  // `tool_search` loads deferred MCP tools into the model's next request. Tools behind
  // either `codemode` or `deferred` exposure are registered deferred (scripts can call
  // them directly); install the loader whenever such a tool exists.
  if (mcpExtension?.tools?.some(tool => tool.deferred === true) === true) {
    registry.install(createToolSearchExtension())
  }
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
  harness = await Harness.open(storage, {
    models: modelRuntime.models,
    registry,
    settings: { compaction: COMPACTION_POLICY },
    env: async (target) => {
      const metadata = await harness.snapshot(META, target.conversationId, CTX)
      const selectedWorkspace = workspaceFiles.workspace(metadata?.workspaceId ?? defaultWorkspace.id)
      const selectedMode = metadata?.accessMode ?? appState.snapshot().settings.defaultAccessMode
      return createExecutionEnv(selectedWorkspace.path, selectedMode)
    },
    conversationCreated: async (tx, conversation) => {
      await ensureRuntimePolicy(tx, conversation.id)
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

  const detailFromView = async (
    id: ConversationId,
    view: ConversationView,
    metadata?: Readonly<ConversationMetadata>,
    options: { subagents?: boolean; team?: boolean } = {},
  ): Promise<ConversationDetail> => {
    const currentMetadata = metadata ?? await ensureMetadata(id)
    const settings = appState.snapshot().settings
    const fallbackWorkspace = workspaceFiles.workspace(currentMetadata.workspaceId ?? settings.defaultWorkspaceId ?? defaultWorkspace.id)
    const team = options.team === true ? await teamProjection(id) : undefined
    const detail = projectConversation(view, cloneMetadata(currentMetadata), {
      workspace: fallbackWorkspace.path,
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

  /** The Lead (or the Lead of a member conversation) this conversation's team record lives on. */
  const teamLeadId = async (id: ConversationId): Promise<ConversationId> => {
    const link = await harness.snapshot(TeamLink, id, CTX)
    return link?.leadConversationId ? parseConversationId(link.leadConversationId) : id
  }

  /**
   * The team as `ConversationDetail.team`. Undefined until the conversation has a teammate or a
   * task, so a plain conversation pays two document reads and no member-status probe.
   */
  const teamProjection = async (id: ConversationId): Promise<TeamView | undefined> => {
    const leadId = await teamLeadId(id)
    const doc = await harness.snapshot(Team, leadId, CTX)
    if (!doc) return undefined
    const hasTeammate = doc.members.some(member => member.role === 'teammate')
    const hasTask = doc.tasks.some(task => task.status !== 'deleted')
    if (!hasTeammate && !hasTask) return undefined
    return await projectTeam(doc, String(leadId), conversationInfo)
  }

  /**
   * DSH's `agentTeam` projection over the Lead document. The Lead row is synthesized even before the
   * document exists, mirroring `roster.ts:126-157`; teammates carry their child's live turn status.
   */
  const team = async (value: string): Promise<TeamView> => {
    const conversation = await requireConversation(value)
    const leadId = await teamLeadId(conversation.id)
    const doc = await harness.snapshot(Team, leadId, CTX)
    return await projectTeam(doc ?? { members: [], tasks: [] }, String(leadId), conversationInfo)
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

  /**
   * DSH's `subagentCatalog` over Pi's owner edge: the conversations this one created, each with the
   * label its delegation recorded and the child's latest answer. The catalog is durable in DSH
   * because children are sessions in the same log; here the owner edge plus the child's own
   * transcript is what survives, so the row is read instead of folded.
   */
  const subagentSummaries = async (parentId: ConversationId): Promise<SubagentSummary[]> => {
    const page = await harness.commit((tx) => tx.scanConversations({ ownerConversationId: parentId }, SUBAGENT_LIMIT), CTX)
    const rows = await Promise.all(page.items.map(childSummary))
    return rows.filter((row): row is SubagentSummary => row !== undefined)
      .sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id))
  }

  const childSummary = async (record: ConversationRecord): Promise<SubagentSummary | undefined> => {
    const conversation = await harness.conversation(record.id, CTX)
    if (!conversation) return undefined
    const identity = await harness.snapshot(Subagents, record.id, CTX)
    const usage = await harness.snapshot(UsageDoc, record.id, CTX)
    const viewWatch = await conversation.watch(CTX)
    try {
      const detail = await detailFromView(record.id, viewWatch.value)
      const tokens = usageTokens(usage)
      const durationMs = activeDurationMs(detail.messages)
      const metricsAt = Date.now()
      return {
        id: String(record.id),
        label: identity?.record?.label ?? detail.conversation.title,
        title: detail.conversation.title,
        status: detail.conversation.busy ? 'running' : 'inactive',
        answer: latestAnswer(detail.messages),
        ...(tokens === undefined ? {} : { tokens }),
        ...(durationMs === undefined ? {} : { durationMs }),
        metricsAt,
        createdAt: detail.conversation.createdAt,
        updatedAt: detail.conversation.updatedAt,
      }
    } finally {
      await viewWatch.stop()
    }
  }

  /** The row's answer summary: the child's last assistant text, collapsed to one bounded line. */
  const latestAnswer = (messages: readonly ChatMessage[]): string => {
    for (const message of [...messages].reverse()) {
      if (message.role !== 'assistant') continue
      const text = message.blocks.flatMap(block => block.type === 'text' ? [block.text] : []).join(' ').replace(/\s+/g, ' ').trim()
      if (text !== '') return text.length > SUBAGENT_ANSWER_CHARS ? `${text.slice(0, SUBAGENT_ANSWER_CHARS - 1)}…` : text
    }
    return ''
  }

  const children = async (value: string): Promise<SubagentSummary[]> => {
    const parent = await requireConversation(value)
    return subagentSummaries(parent.id)
  }

  /**
   * Resolve one direct child of `parentId`. DSH's control tools authorize by live lineage; Pi exposes
   * no such check, so ownership is enforced here: any conversation this parent did not create is a
   * NOT_FOUND rather than a control target (`docs/families.md` A7).
   */
  const requireChild = async (parentId: ConversationId, childValue: string): Promise<Awaited<ReturnType<typeof requireConversation>>> => {
    const childId = parseConversationId(childValue)
    const record = await harness.commit((tx) => tx.conversation(childId), CTX)
    if (!record || record.owner?.conversationId !== parentId) throw new RuntimeError('NOT_FOUND', '子会话不存在')
    return requireConversation(childValue)
  }

  /** DSH's `send_message` for one direct child: a follow-up the child's next boundary places. */
  const childMessage = async (value: string, childValue: string, input: ChildMessageInput): Promise<SubagentSummary[]> => {
    const parent = await requireConversation(value)
    const child = await requireChild(parent.id, childValue)
    const text = input.text.trim()
    if (text === '' || text.length > SUBAGENT_MESSAGE_CHARS) throw new RuntimeError('INVALID_INPUT', '子智能体消息无效')
    if (!input.requestId.trim() || input.requestId.length > 256) throw new RuntimeError('INVALID_INPUT', 'requestId 无效')
    await child.submit({ type: 'input', content: text, requestId: input.requestId, whenBusy: 'followUp' }, CTX)
    return subagentSummaries(parent.id)
  }

  /** DSH's `interrupt_agent` for one direct child; the child's own descendants stop with it. */
  const childStop = async (value: string, childValue: string): Promise<SubagentSummary[]> => {
    const parent = await requireConversation(value)
    const child = await requireChild(parent.id, childValue)
    await child.abort(CTX)
    return subagentSummaries(parent.id)
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
    const installed = registry.snapshot().installed()
    const installedByName = new Map(installed.map(extension => [extension.name, extension]))
    const state = appState.snapshot()
    const codemodeMode = state.settings.codemodeMode
    // Every installed extension is on: plugin switches are no longer exposed, so the legacy
    // per-plugin state must not disable anything. Pi code mode is the one presentation switch:
    // `off` removes the extension everywhere, `on`/`only` keep a preset's own extension list.
    const extensionNames = [...new Set([WORK_POLICY_EXTENSION_NAME, COMPACTION_EXTENSION_NAME, ...(preset ? preset.extensions : installed.map(extension => extension.name))])]
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
      ...(preset?.instructions ? { instructions: preset.instructions } : {}),
    }
  }

  /**
   * Pi stores the selected extensions and tools in every conversation's `pi.agent`, so a
   * settings change (`on`/`only`/`off`) or an upgrade that adds code mode would leave
   * existing conversations on their old presentation. Recompute each idle ownerless
   * conversation's agent from its metadata, preserving its model and thinking level.
   * A conversation whose stored configuration no longer resolves keeps its old agent.
   */
  const syncCodemodeAgents = async (): Promise<void> => {
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
    const agent = await buildAgentChange(workspace.id, accessMode, preset, {
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
      // Only an explicitly picked model is passed on; a preset without its own
      // model and the inherited model keep today's resolution through the
      // default chain, where a stale default falls back inside the allowlist.
      const explicitModel = input.model ?? (presetChanged ? preset?.model : currentAgent.model)
      const thinkingLevel = input.thinkingLevel ?? (presetChanged ? preset?.thinkingLevel ?? settings.defaultThinkingLevel : currentAgent.thinkingLevel)
      if (input.model && !modelRuntime.models.getModel(input.model.provider, input.model.modelId)) throw new RuntimeError('MODEL_UNAVAILABLE', '所选模型不在 Pi 模型目录中')
      assertModelAllowed(input.model, '所选模型')
      if (presetChanged) assertModelAllowed(preset?.model, 'Preset 模型')
      if (!presetChanged && !input.model) assertModelAllowed(currentAgent.model, '会话模型')
      if (thinkingLevel && !SUPPORTED_THINKING.has(thinkingLevel)) throw new RuntimeError('INVALID_INPUT', '思考等级无效')
      const change = await buildAgentChange(workspace.id, accessMode, preset, {
        ...(explicitModel ? { model: explicitModel } : {}),
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
    await assertConversationModelAllowed(conversation)
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
        metadata.title = fallbackSessionTitle(input.text) || DEFAULT_TITLE
      }
      metadata.updatedAt = Date.now()
      // A placed input starts a new turn, and DSH starts a turn without a task list. Queued inputs
      // are placed later, so their turn keeps the list this commit leaves behind.
      if (status.status !== 'queued') {
        const todos = await tx.doc(Todos, conversation.id)
        todos.items = null
        todos.updatedAt = Date.now()
      }
    }, CTX)
    if (input.text.trim()) scheduleTitleRevision(conversation.id, input.text)
    return { submissionId: String(request.id) }
  }

  /**
   * DSH's title provider cadence over pi-web's own run loop: one revision per
   * submitted prompt, generated off the session's own route so titles cost the
   * same account, never delaying the response, and a newer revision supersedes
   * the older one. A user rename flips the source to `user` and pins the title,
   * so this writes only while the title is still auto.
   *
   * DSH hands its title call a `session-title` purpose that its adapter maps to
   * thinking-disabled. pi-ai has no such marker, and models declaring
   * `thinkingLevelMap.off === null` (deepseek) cannot disable thinking, so this
   * budgets past the reasoning preamble and still accepts only a clean stop with
   * visible text; anything else keeps the deterministic fallback title.
   */
  const titleRevisions = new Map<string, AbortController>()
  const scheduleTitleRevision = (id: ConversationId, text: string): void => {
    const key = String(id)
    titleRevisions.get(key)?.abort()
    const controller = new AbortController()
    titleRevisions.set(key, controller)
    void (async () => {
      try {
        const conversation = await harness.conversation(id, CTX)
        if (conversation === undefined) return
        const agent = await conversation.agent(CTX)
        const route = agent.model ?? modelRuntime.defaultModel
        if (route === undefined) return
        const model = modelRuntime.models.getModel(route.provider, route.modelId)
        if (model === undefined) return
        const framed = frameTitleMessages([{ seq: 0, text }])
        if (Buffer.byteLength(framed, 'utf8') > TITLE_POLICY.maxInputBytes) return
        const result = await modelRuntime.models.completeSimple(model, {
          systemPrompt: titleSystemPrompt(),
          messages: [{ role: 'user', content: framed, timestamp: Date.now() }],
        }, {
          maxTokens: TITLE_POLICY.titleMaxOutputTokens,
          timeoutMs: TITLE_POLICY.timeoutMs,
          sessionId: `title-${randomUUID()}`,
          signal: controller.signal,
        })
        if (controller.signal.aborted || result.stopReason !== 'stop') return
        const title = normalizeSessionTitle(result.content.flatMap(part => part.type === 'text' ? [part.text] : []).join('\n'))
        if (title === '') return
        await withMetadata(id, draft => {
          if (draft.titleSource === 'auto') draft.title = title
        })
      } catch {
        // An automatic title failure is a warning: the fallback title stays.
      } finally {
        if (titleRevisions.get(key) === controller) titleRevisions.delete(key)
      }
    })()
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

  /**
   * Settle one pending plan review. The reply carries the decision so the model knows whether to
   * execute or revise; approving also turns plan mode off, in the same commit that marks the review
   * answered, so a later request cannot talk the model back into planning. Asking for changes leaves
   * plan mode on and hands the feedback over in the reply message.
   */
  const answerPlanReview = async (
    conversation: Awaited<ReturnType<typeof requireConversation>>,
    callId: string,
    review: StoredPlanReview,
    answers: AskUserQuestionAnswerItem[],
  ): Promise<ConversationDetail> => {
    const id = conversation.id
    // A superseded or already answered review is settled: nothing is waiting and plan mode stays as it is.
    if (review.status !== 'pending') return currentDetail(id)
    await assertConversationModelAllowed(conversation)
    const decision = decidePlanReview(review, answers)
    const settledAnswers = answers.map(answer => ({
      id: answer.id,
      selected: [...answer.selected],
      ...(answer.custom === undefined ? {} : { custom: answer.custom }),
    }))
    const reply = {
      kind: 'answer_to_pending_question',
      callId,
      interactionKind: 'plan-review',
      approveLabel: review.approveLabel,
      approved: decision.approved,
      ...(decision.feedback === undefined ? {} : { feedback: decision.feedback }),
      answers: settledAnswers,
      instruction: decision.approved
        ? 'The user approved the plan and plan mode is now off: execute the approved plan in this turn.'
        : 'The user asked for changes and plan mode is still on: revise the plan and submit it again with exit_plan_mode.',
    }
    await conversation.submit({
      type: 'input',
      content: JSON.stringify(reply),
      requestId: `plan-review-reply:${callId}`,
      entry: {
        kind: 'pi-web.plan-review-reply',
        data: {
          callId,
          approved: decision.approved,
          answers: settledAnswers,
          ...(decision.feedback === undefined ? {} : { feedback: decision.feedback }),
        },
      },
      whenBusy: 'steer',
    }, CTX)
    await harness.commit(async (tx) => {
      const table = interactionTable(await tx.doc(Interactions, id))
      const stored = planReviewOf(table[callId])
      if (!stored || stored.status !== 'pending') return
      stored.status = 'answered'
      stored.approved = decision.approved
      stored.answers = settledAnswers
      stored.answeredAt = Date.now()
      if (decision.feedback !== undefined) stored.feedback = decision.feedback
      if (!decision.approved) return
      const plan = await tx.doc(Plans, id)
      plan.active = false
      plan.updatedAt = Date.now()
    }, CTX)
    return currentDetail(id)
  }

  /**
   * Settle one pending interaction. The reply is submitted first, so a rejected submission leaves the
   * call answerable; the document is marked answered afterwards. The reply entry carries the call id
   * and `requestId` is derived from it, so a retry after a restart never injects the message twice.
   */
  const answerInteraction = async (value: string, callId: string, answers: AskUserQuestionAnswerItem[]): Promise<ConversationDetail> => {
    const conversation = await requireConversation(value)
    const id = conversation.id
    if (typeof callId !== 'string' || callId.trim() === '' || callId.length > 160) {
      throw new RuntimeError('INVALID_INPUT', '交互请求 ID 无效')
    }
    const state = await harness.snapshot(Interactions, id, CTX)
    const request = state?.[callId]
    if (!request) throw new RuntimeError('NOT_FOUND', '交互请求不存在')
    const review = planReviewOf(request)
    if (review) return answerPlanReview(conversation, callId, review, answers)
    if (request.status === 'answered') return currentDetail(id)
    if (request.status === 'cancelled') throw new RuntimeError('CONFLICT', '该问题已放弃整组，无法再回答')
    const invalid = validateAnswers(request.questions, answers)
    if (invalid) throw new RuntimeError('INVALID_INPUT', invalid)
    await assertConversationModelAllowed(conversation)
    const settledAnswers = answers.map(answer => ({
      id: answer.id,
      selected: [...answer.selected],
      ...(answer.custom === undefined ? {} : { custom: answer.custom }),
    }))
    const reply = {
      kind: 'answer_to_pending_question',
      callId,
      questions: request.questions.map(question => ({
        ...question,
        ...(question.options ? { options: question.options.map(option => ({ ...option })) } : {}),
      })),
      answers: settledAnswers,
    }
    await conversation.submit({
      type: 'input',
      content: JSON.stringify(reply),
      requestId: `question-reply:${callId}`,
      entry: { kind: 'pi-web.user-question-reply', data: { callId, answers: settledAnswers } },
      whenBusy: 'steer',
    }, CTX)
    await harness.commit(async (tx) => {
      const doc = await tx.doc(Interactions, id)
      const stored = doc[callId]
      // Only a pending call settles here: an answer that lost the race against a
      // dismissal must not resurrect the question.
      if (!stored || stored.status !== 'pending') return
      stored.status = 'answered'
      stored.answers = settledAnswers
      stored.answeredAt = Date.now()
    }, CTX)
    return currentDetail(id)
  }

  /**
   * Dismiss one pending question set the way DSH's `ASK_CANCELLED` does: nobody answers,
   * the model is told, and the row can no longer take an answer. The dismissal reply is
   * steered first with a call-derived `requestId`, so a retry after a restart never tells
   * the model twice; already-cancelled calls are idempotent, and an answered call is a
   * conflict because its answers are already on their way.
   */
  const cancelInteraction = async (value: string, callId: string): Promise<ConversationDetail> => {
    const conversation = await requireConversation(value)
    const id = conversation.id
    if (typeof callId !== 'string' || callId.trim() === '' || callId.length > 160) {
      throw new RuntimeError('INVALID_INPUT', '交互请求 ID 无效')
    }
    const state = await harness.snapshot(Interactions, id, CTX)
    const request = state?.[callId]
    if (!request) throw new RuntimeError('NOT_FOUND', '交互请求不存在')
    if (planReviewOf(request)) throw new RuntimeError('UNSUPPORTED', '计划待审请在卡片上批准或要求修改')
    if (request.status === 'answered') throw new RuntimeError('CONFLICT', '该问题已回答，无法放弃整组问题')
    if (request.status === 'cancelled') return currentDetail(id)
    await assertConversationModelAllowed(conversation)
    const dismissal = {
      kind: 'dismissed_pending_question',
      callId,
      questions: request.questions.map(question => ({
        ...question,
        ...(question.options ? { options: question.options.map(option => ({ ...option })) } : {}),
      })),
      instruction: 'The user dismissed these questions without answering. Do not ask them again; continue with work that does not depend on the answers, or wrap up.',
    }
    await conversation.submit({
      type: 'input',
      content: JSON.stringify(dismissal),
      requestId: `question-dismiss:${callId}`,
      entry: { kind: 'pi-web.user-question-dismissed', data: { callId } },
      whenBusy: 'steer',
    }, CTX)
    await harness.commit(async (tx) => {
      const doc = await tx.doc(Interactions, id)
      const stored = doc[callId]
      if (!stored || stored.status !== 'pending') return
      stored.status = 'cancelled'
      stored.cancelledAt = Date.now()
    }, CTX)
    return currentDetail(id)
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

  const goal = async (value: string, input: GoalUpdateRequest): Promise<ConversationDetail> => {
    const conversation = await requireConversation(value)
    const id = conversation.id
    await harness.commit(async (tx) => {
      const doc = await tx.doc(Goals, id)
      if (input.action === 'create') {
        const outcome = applyGoalCreate(doc.goal, {
          id: randomUUID(),
          objective: input.objective ?? '',
          ...(input.maxGoalRounds === undefined ? {} : { maxGoalRounds: input.maxGoalRounds }),
        }, Date.now())
        if (!outcome.ok) throw new RuntimeError('CONFLICT', outcome.error)
        doc.goal = outcome.goal
        return
      }
      const current = doc.goal
      if (current === null) throw new RuntimeError('NOT_FOUND', '当前会话没有目标')
      const outcome = applyGoalUpdate(current, {
        goalId: current.id,
        revision: current.revision,
        action: input.action,
        ...(input.objective === undefined ? {} : { objective: input.objective }),
        ...(input.blockedReason === undefined ? {} : { blockedReason: input.blockedReason }),
        ...(input.maxGoalRounds === undefined ? {} : { maxGoalRounds: input.maxGoalRounds }),
      }, { actor: 'human', now: Date.now() })
      if (!outcome.ok) throw new RuntimeError('CONFLICT', outcome.error)
      doc.goal = outcome.goal
    }, CTX)
    return currentDetail(id)
  }

  /**
   * Turn plan mode on or off. The document write is what the `plan-policy` section reads before every
   * request, so a switch made while a run is going takes effect on the next request (DSH's pending
   * semantics); an idempotent request only refreshes `updatedAt`.
   */
  const setPlan = async (value: string, active: boolean): Promise<ConversationDetail> => {
    if (typeof active !== 'boolean') throw new RuntimeError('INVALID_INPUT', '计划模式开关无效')
    const conversation = await requireConversation(value)
    const id = conversation.id
    await harness.commit(async (tx) => {
      const doc = await tx.doc(Plans, id)
      doc.active = active
      doc.updatedAt = Date.now()
    }, CTX)
    return currentDetail(id)
  }

  const compact = async (value: string): Promise<void> => {
    const conversation = await requireConversation(value)
    await assertConversationModelAllowed(conversation)
    await conversation.compact(undefined, CTX)
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
    // Custom documents are not part of the conversation view, so a human action that writes only a
    // document (pause a goal, clear a list) would otherwise stay invisible until the next entry.
    const docWatches = [
      await harness.watchDoc(Todos, id, CTX),
      await harness.watchDoc(Goals, id, CTX),
      await harness.watchDoc(Interactions, id, CTX),
      await harness.watchDoc(Plans, id, CTX),
    ]
    let latestView = viewWatch.value
    let latestMetadata = metadataWatch.value ?? await ensureMetadata(id)
    let stopped = false
    let delivery = Promise.resolve()
    const refresh = () => {
      delivery = delivery.then(async () => {
        if (!stopped) listener(await detailFromView(id, latestView, latestMetadata, { subagents: true, team: true }))
      })
      return delivery
    }
    listener(await detailFromView(id, latestView, latestMetadata, { subagents: true, team: true }))
    viewWatch.start(async (view) => {
      latestView = view
      await refresh()
    })
    metadataWatch.start(async (metadata) => {
      if (metadata) latestMetadata = metadata
      await refresh()
    })
    for (const docWatch of docWatches) {
      docWatch?.start(async () => { await refresh() })
    }
    const unsubscribe = async () => {
      if (stopped) return
      stopped = true
      activeWatchStops.delete(unsubscribe)
      await Promise.all([viewWatch.stop(), metadataWatch.stop(), ...docWatches.map(docWatch => docWatch?.stop())])
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
    // Code mode is stored in each conversation's agent, so an explicit switch applies now.
    if (input.codemodeMode !== undefined && input.codemodeMode !== previousCodemodeMode) await syncCodemodeAgents()
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

  const pickDirectory = (signal?: AbortSignal): Promise<string | null> => pickNativeDirectory(signal)
  const listDirectories = (path?: string) => listHostDirectories(path)
  const createDirectory = (parent: string, name: string) => createHostDirectory(parent, name)

  const workspaceFileList = (id: string, path: string, query?: string) => workspaceFiles.list(id, path, query)

  /**
   * Unregister a workspace, mirroring DSH's row action: its sessions rebind to a
   * remaining workspace so no conversation keeps a dangling binding, and the
   * directory on disk is left untouched.
   */
  const deleteWorkspace = async (id: string): Promise<void> => {
    const state = appState.snapshot()
    if (!state.workspaces.some(workspace => workspace.id === id)) throw new RuntimeError('NOT_FOUND', '工作区不存在')
    const remaining = state.workspaces.filter(workspace => workspace.id !== id)
    if (remaining.length === 0) throw new RuntimeError('INVALID_INPUT', '至少需要保留一个工作区')
    const fallback = remaining.find(workspace => workspace.id === state.settings.defaultWorkspaceId) ?? remaining[0]
    if (fallback === undefined) throw new RuntimeError('INVALID_INPUT', '至少需要保留一个工作区')
    for (const summary of await list()) {
      if (summary.workspaceId !== id) continue
      await withMetadata(parseConversationId(summary.id), draft => { draft.workspaceId = fallback.id })
    }
    await appState.update(current => {
      current.workspaces = current.workspaces.filter(workspace => workspace.id !== id)
      if (current.settings.defaultWorkspaceId === id) current.settings.defaultWorkspaceId = fallback.id
    })
  }

  const searchWorkspace = (id: string, query: string) => workspaceFiles.list(id, '', query)
  const workspaceFile = (id: string, path: string) => workspaceFiles.read(id, path)
  const workspaceAsset = (id: string, path: string) => workspaceFiles.asset(id, path)

  const gitBranchSnapshot = (id: string): Promise<GitBranchSnapshot> => gitBranches.snapshot(id)
  const switchGitBranch = (id: string, input: SwitchGitBranchInput): Promise<GitBranchMutation> => gitBranches.switch(id, input)
  const createGitBranch = (id: string, input: CreateGitBranchInput): Promise<GitBranchMutation> => gitBranches.create(id, input)

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

  /** Append one operator feedback entry, capturing the client's user agent when present. */
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

  /**
   * The catalog every model surface reads: filtered to the allowlist, with a
   * default that fell outside it replaced by the first available allowed model
   * and written back, so a later start reads the same correction.
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

  const automations = (): Automation[] => appState.snapshot().automations

  const validateAutomation = (input: CreateAutomationInput | UpdateAutomationInput): void => {
    if (input.name !== undefined && (!input.name.trim() || input.name.length > 120)) throw new RuntimeError('INVALID_INPUT', 'Automation 名称无效')
    if (input.prompt !== undefined && (!input.prompt.trim() || input.prompt.length > 100_000)) throw new RuntimeError('INVALID_INPUT', 'Automation 提示词无效')
    if (input.intervalMs !== undefined && input.intervalMs !== null && (!Number.isSafeInteger(input.intervalMs) || input.intervalMs < 60_000 || input.intervalMs > 365 * 24 * 60 * 60 * 1000)) {
      throw new RuntimeError('INVALID_INPUT', 'Automation interval 必须在 1 分钟到 1 年之间')
    }
    if (input.model && !modelRuntime.models.getModel(input.model.provider, input.model.modelId)) throw new RuntimeError('MODEL_UNAVAILABLE', 'Automation 模型不在 Pi 模型目录中')
    assertModelAllowed(input.model, 'Automation 模型')
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
  await reconcileTeamRosters()
  // Upgrade stored selections, including child conversations, before resuming any model request.
  // In-flight request checkpoints retain their original prompt; the next preparation sees the policy.
  let policyCursor: Cursor | undefined
  do {
    const page = await harness.commit(tx => tx.scanConversations({ order: 'ascending' }, 250, policyCursor), CTX)
    for (const record of page.items) await harness.commit(tx => ensureRuntimePolicy(tx, record.id), CTX)
    policyCursor = page.next
  } while (policyCursor)
  harness.resume()
  // Upgrades add code mode to an existing registry, and the stored agent selection is
  // per conversation: bring idle conversations onto the current presentation before serving.
  await syncCodemodeAgents()

  return {
    list,
    create,
    detail: async (value) => currentDetail(parseConversationId(value)),
    update,
    submit,
    answerInteraction,
    cancelInteraction,
    editQueued,
    stop,
    compact,
    goal,
    setPlan,
    team,
    children,
    childMessage,
    childStop,
    removeQueued,
    fork,
    retry,
    watch,
    catalog,
    watchModels: (listener: () => void) => {
      modelListeners.add(listener)
      return () => { modelListeners.delete(listener) }
    },
    saveProvider,
    provider,
    deleteProvider,
    testProvider,
    discoverProvider,
    settings,
    mcp: () => mcp.view(),
    capabilities,
    updateSettings,
    openConfigFile,
    workspaces,
    addWorkspace,
    renameWorkspace,
    deleteWorkspace,
    pickDirectory,
    listDirectories,
    createDirectory,
    workspaceFiles: workspaceFileList,
    searchWorkspace,
    workspaceFile,
    workspaceAsset,
    gitBranches: gitBranchSnapshot,
    switchGitBranch,
    createGitBranch,
    skills: async (workspaceId) => skillStore.list(workspaceFiles.workspace(workspaceId).path),
    skill: async (workspaceId, skillId, resource) => skillStore.load(workspaceFiles.workspace(workspaceId).path, skillId, resource),
    validateSkill: async (workspaceId, skillId) => skillStore.validate(workspaceFiles.workspace(workspaceId).path, skillId),
    presets,
    createPreset,
    updatePreset,
    deletePreset,
    feedback,
    sendFeedback,
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
        unsubscribeModels()
        modelListeners.clear()
        modelRuntime.close()
        closePromise = (async () => {
          try {
            await Promise.all([...activeWatchStops].map((unsubscribe) => unsubscribe()))
          } finally {
            try {
              await harness.close(CTX)
              await Promise.allSettled([...automationTasks])
            } finally {
              await Promise.allSettled([codemodeSandbox.close(), mcp.close()])
            }
          }
        })()
      }
      await closePromise
    },
  }
}
