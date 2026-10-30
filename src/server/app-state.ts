import { access, chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { dirname, join, resolve } from 'node:path'
import { z } from 'zod'
import type {
  AccessMode,
  AgentPreset,
  AppSettings,
  Automation,
  AutomationRun,
  ThinkingLevel,
  WorkspaceSummary,
} from '../shared/types.ts'
import { COLLAPSE_TIMINGS, CODEMODE_MODES, PERFORMANCE_USAGE_MODES, SHORTCUT_COMMANDS, TRANSCRIPT_VIEW_MODES } from '../shared/types.ts'

const modelRef = z.object({ provider: z.string().min(1).max(100), modelId: z.string().min(1).max(256) }).strict()
const thinking = z.enum(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'])
const accessMode = z.enum(['readOnly', 'workspaceWrite', 'fullAccess'])
/** Stored entries are normalized on the settings route; the schema fills the default for old files. */
const modelAllowlist = z.array(z.string().trim().min(1).max(200)).max(100).default([])
const settingsSchema = z.object({
  theme: z.enum(['system', 'light', 'dark']),
  locale: z.enum(['zh', 'en']),
  fontSize: z.number().min(12).max(20),
  codeFontSize: z.number().min(10).max(16),
  terminalFontSize: z.number().min(10).max(20),
  transcriptView: z.enum(TRANSCRIPT_VIEW_MODES),
  collapseTiming: z.enum(COLLAPSE_TIMINGS),
  performanceUsage: z.enum(PERFORMANCE_USAGE_MODES),
  codingViews: z.boolean(),
  busySendMode: z.enum(['followUp', 'steer']),
  defaultModel: modelRef.optional(),
  modelAllowlist,
  defaultThinkingLevel: thinking,
  defaultAccessMode: accessMode,
  /** Pi code mode; absent files written before this setting read as `on`. */
  codemodeMode: z.enum(CODEMODE_MODES).default('on'),
  /** Cross-conversation memory; absent files written before this setting read as off. */
  memoryEnabled: z.boolean().default(false),
  defaultPresetId: z.string().min(1).optional(),
  defaultWorkspaceId: z.string().min(1).optional(),
  shortcuts: z.partialRecord(z.enum(SHORTCUT_COMMANDS), z.string().min(1).max(80)).optional(),
}).strict()
const workspaceSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1).max(120),
  path: z.string().min(1),
  createdAt: z.number().finite(),
  updatedAt: z.number().finite(),
}).strict()
/** Historical plugin switch state: still parsed for old files, but never read — tools are always on. */
const pluginStateSchema = z.object({ enabled: z.boolean(), tools: z.record(z.string(), z.boolean()) }).strict()
const presetSchema = z.object({
  id: z.string().min(1).max(128),
  name: z.string().min(1).max(120),
  description: z.string().max(1000).optional(),
  instructions: z.string().max(32_000),
  extensions: z.array(z.string().min(1).max(160)).max(100),
  tools: z.array(z.string().min(1).max(160)).max(500),
  model: modelRef.optional(),
  thinkingLevel: thinking.optional(),
  accessMode,
}).strict()
const automationRunSchema = z.object({
  id: z.string().min(1),
  status: z.enum(['running', 'completed', 'failed', 'interrupted']),
  conversationId: z.string().optional(),
  startedAt: z.number().finite(),
  finishedAt: z.number().finite().optional(),
  error: z.string().max(500).optional(),
}).strict()
const automationSchema = z.object({
  id: z.string().min(1).max(128),
  name: z.string().min(1).max(120),
  prompt: z.string().min(1).max(100_000),
  enabled: z.boolean(),
  intervalMs: z.number().int().min(60_000).max(365 * 24 * 60 * 60 * 1000).optional(),
  nextRunAt: z.number().finite().optional(),
  createdAt: z.number().finite(),
  updatedAt: z.number().finite(),
  lastRun: automationRunSchema.optional(),
  model: modelRef.optional(),
  workspaceId: z.string().optional(),
  presetId: z.string().optional(),
}).strict()
const feedbackEntrySchema = z.object({
  text: z.string().min(1).max(2_000),
  createdAt: z.number().finite(),
  userAgent: z.string().min(1).max(500).optional(),
}).strict()
const appStateSchema = z.object({
  version: z.literal(1),
  settings: settingsSchema,
  workspaces: z.array(workspaceSchema),
  /** Legacy plugin switches, kept only so pre-existing files still parse. */
  plugins: z.record(z.string(), pluginStateSchema),
  presets: z.array(presetSchema),
  automations: z.array(automationSchema),
  feedback: z.array(feedbackEntrySchema).default([]),
}).strict()

/** One operator feedback entry submitted from the web client. */
export type FeedbackEntry = { text: string; createdAt: number; userAgent?: string }

export type PersistedAppState = {
  version: 1
  settings: AppSettings
  workspaces: WorkspaceSummary[]
  /** Legacy plugin switches: retained for schema compatibility, ignored at runtime. */
  plugins: Record<string, { enabled: boolean; tools: Record<string, boolean> }>
  presets: AgentPreset[]
  automations: Automation[]
  feedback: FeedbackEntry[]
}

const DEFAULT_ACCESS: AccessMode = 'fullAccess'
/** Operator feedback is a bounded log: appending past the cap drops the oldest entry. */
const FEEDBACK_LIMIT = 200

function isMissing(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT'
}

/**
 * Read the retired two-mode display settings as today's work-details settings:
 * `processDisplay` seeds the transcript view and `collapseProcess` the timing
 * (every legacy value folded at completion). Legacy keys never survive the read.
 */
function migrateLegacySettings(value: unknown): unknown {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return value
  const state = value as Record<string, unknown>
  if (typeof state.settings !== 'object' || state.settings === null || Array.isArray(state.settings)) return value
  const settings = state.settings as Record<string, unknown>
  const next: Record<string, unknown> = { ...settings }
  if (next.transcriptView === undefined) next.transcriptView = next.processDisplay === 'compact' ? 'compact' : 'detailed'
  if (next.collapseTiming === undefined) next.collapseTiming = 'completion'
  if (next.performanceUsage === undefined) next.performanceUsage = 'detailed'
  delete next.processDisplay
  delete next.collapseProcess
  return { ...state, settings: next }
}

/**
 * The retired per-message rating record shares its key with today's operator
 * feedback entries. Ratings cannot be represented as entries, so a legacy
 * record is dropped and the key reads as an empty entry list; every stored
 * state still parses.
 */
function migrateFeedback(value: unknown): unknown {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return value
  const state = value as Record<string, unknown>
  if (state.feedback === undefined || Array.isArray(state.feedback)) return value
  return { ...state, feedback: [] }
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

function defaultSettings(defaultThinkingLevel: ThinkingLevel | undefined, workspaceId: string | undefined): AppSettings {
  return {
    theme: 'system',
    locale: 'zh',
    fontSize: 14,
    codeFontSize: 11,
    terminalFontSize: 11,
    transcriptView: 'detailed',
    collapseTiming: 'completion',
    performanceUsage: 'detailed',
    codingViews: true,
    busySendMode: 'followUp',
    modelAllowlist: [],
    defaultThinkingLevel: defaultThinkingLevel ?? 'medium',
    defaultAccessMode: DEFAULT_ACCESS,
    codemodeMode: 'on',
    memoryEnabled: false,
    ...(workspaceId === undefined ? {} : { defaultWorkspaceId: workspaceId }),
  }
}

async function writeJsonAtomic(path: string, value: PersistedAppState): Promise<void> {
  const directory = dirname(path)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  await chmod(directory, 0o700)
  const temporary = join(directory, `.tmp-${process.pid}-${randomUUID()}`)
  try {
    await writeFile(temporary, JSON.stringify(value, null, 2), { encoding: 'utf8', mode: 0o600, flag: 'wx' })
    await chmod(temporary, 0o600)
    await rename(temporary, path)
    await chmod(path, 0o600)
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined)
    throw error
  }
}

/** Serializes app-owned settings and metadata separately from the Pi Durable transcript database. */
export class AppStateStore {
  #state: PersistedAppState
  #path: string
  #tail: Promise<void> = Promise.resolve()

  private constructor(path: string, state: PersistedAppState) {
    this.#path = path
    this.#state = state
  }

  static async open(options: {
    dataDir: string
    /** Optional: without it a fresh install starts with an empty workspace list. */
    defaultWorkspace?: WorkspaceSummary
    defaultThinkingLevel?: ThinkingLevel
  }): Promise<AppStateStore> {
    const path = join(resolve(options.dataDir), 'app-state.json')
    let state: PersistedAppState
    try {
      const raw: unknown = JSON.parse(await readFile(path, 'utf8'))
      const parsed = appStateSchema.safeParse(migrateFeedback(migrateLegacySettings(raw)))
      if (!parsed.success) throw new Error('应用数据格式不受支持')
      state = parsed.data
    } catch (error) {
      if (!isMissing(error)) throw new Error(`无法读取有效的应用配置：${path}`)
      state = {
        version: 1,
        settings: defaultSettings(options.defaultThinkingLevel, options.defaultWorkspace?.id),
        workspaces: options.defaultWorkspace === undefined ? [] : [structuredClone(options.defaultWorkspace)],
        plugins: {},
        presets: [],
        automations: [],
        feedback: [],
      }
      await writeJsonAtomic(path, state)
    }
    // The model allowlist control is no longer shown. Clear any stored filter
    // so it cannot keep hiding models without a visible way to fix it.
    if (state.settings.modelAllowlist.length > 0) {
      state = { ...state, settings: { ...state.settings, modelAllowlist: [] } }
      await writeJsonAtomic(path, state)
    }
    const store = new AppStateStore(path, state)
    if (options.defaultWorkspace !== undefined) await store.ensureWorkspace(options.defaultWorkspace)
    return store
  }

  snapshot(): PersistedAppState {
    return structuredClone(this.#state)
  }

  /** Absolute path of the configuration file this store persists. */
  get path(): string {
    return this.#path
  }

  /**
   * Confirm the configuration file is on disk. The application writes it at
   * startup and after every save, so a missing file means it was removed
   * behind the app's back: rewrite the current state once, then report
   * whether the file is present.
   */
  async ensureFile(): Promise<boolean> {
    if (await fileExists(this.#path)) return true
    await this.update(() => undefined)
    return await fileExists(this.#path)
  }

  /** Append one operator feedback entry, keeping only the newest {@link FEEDBACK_LIMIT} entries. */
  async recordFeedback(entry: FeedbackEntry): Promise<void> {
    await this.update(state => {
      state.feedback.push(structuredClone(entry))
      if (state.feedback.length > FEEDBACK_LIMIT) state.feedback.splice(0, state.feedback.length - FEEDBACK_LIMIT)
    })
  }

  update<T>(change: (draft: PersistedAppState) => T | Promise<T>): Promise<T> {
    const execute = async (): Promise<T> => {
      const draft = structuredClone(this.#state)
      const result = await change(draft)
      await writeJsonAtomic(this.#path, draft)
      this.#state = draft
      return result
    }
    const result = this.#tail.then(execute, execute)
    this.#tail = result.then(() => undefined, () => undefined)
    return result
  }

  async ensureWorkspace(workspace: WorkspaceSummary): Promise<void> {
    if (this.#state.workspaces.some(candidate => candidate.id === workspace.id || candidate.path === workspace.path)) return
    await this.update(state => {
      state.workspaces.push(structuredClone(workspace))
      if (!state.settings.defaultWorkspaceId) state.settings.defaultWorkspaceId = workspace.id
    })
  }
}
