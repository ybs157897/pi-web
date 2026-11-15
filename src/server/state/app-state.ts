import { access, chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { dirname, join, resolve } from 'node:path'
import { z } from 'zod'
import type {
  AccessMode,
  AppSettings,
  Automation,
  AutomationRun,
  ThinkingLevel,
  WorkspaceSummary,
} from '../../shared/types.ts'
import { COLLAPSE_TIMINGS, CODEMODE_MODES, PERFORMANCE_USAGE_MODES, SHORTCUT_COMMANDS, TRANSCRIPT_VIEW_MODES } from '../../shared/types.ts'

const modelRef = z.object({ provider: z.string().min(1).max(100), modelId: z.string().min(1).max(256) }).strict()
const thinking = z.enum(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'])
const accessMode = z.enum(['readOnly', 'workspaceWrite', 'fullAccess'])
/** 存储条目在设置路由上已归一化；本 schema 为旧文件补默认值。 */
const modelAllowlist = z.array(z.string().trim().min(1).max(200)).max(100).default([])
const settingsSchema = z.object({
  theme: z.enum(['system', 'light', 'dark']),
  locale: z.enum(['zh', 'en']),
  fontSize: z.number().min(12).max(20),
  codeFontSize: z.number().min(10).max(16),
  terminalFontSize: z.number().min(10).max(20),
  /** 用户自定义字体；此设置出现之前写入的文件读取为空串，即内置字体栈。 */
  textFontFamily: z.string().max(500).default(''),
  codeFontFamily: z.string().max(500).default(''),
  terminalFontFamily: z.string().max(500).default(''),
  transcriptView: z.enum(TRANSCRIPT_VIEW_MODES),
  collapseTiming: z.enum(COLLAPSE_TIMINGS),
  performanceUsage: z.enum(PERFORMANCE_USAGE_MODES),
  codingViews: z.boolean(),
  busySendMode: z.enum(['followUp', 'steer']),
  defaultModel: modelRef.optional(),
  modelAllowlist,
  defaultThinkingLevel: thinking,
  defaultAccessMode: accessMode,
  /** Pi 代码模式开关；此设置出现之前写入的文件读取为 `on`。 */
  codemodeMode: z.enum(CODEMODE_MODES).default('on'),
  /** 跨会话记忆开关；此设置出现之前写入的文件读取为关闭。 */
  memoryEnabled: z.boolean().default(false),
  /** 中文思考提示段（随 personal-instructions 注入）；本字段加入之前落盘的旧文件读取为关闭。 */
  chineseReasoning: z.boolean().default(false),
  /** 缺陷分析会话默认不进入普通会话侧栏，除非显式开启。 */
  showAnalysisConversations: z.boolean().default(false),
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
/** 历史插件开关状态：仍为旧文件解析，但运行时不再读取——工具始终开启。 */
const pluginStateSchema = z.object({ enabled: z.boolean(), tools: z.record(z.string(), z.boolean()) }).strict()
const automationRunSchema = z.object({
  id: z.string().min(1),
  status: z.enum(['running', 'completed', 'failed', 'interrupted', 'delivered']),
  /** 仅在"尚未追踪发生时间"之前写入的记录上缺失。 */
  plannedAt: z.number().finite().optional(),
  conversationId: z.string().optional(),
  startedAt: z.number().finite().optional(),
  finishedAt: z.number().finite().optional(),
  error: z.string().max(500).optional(),
}).strict()
/** RRULE 之前的日历式重复规则；仅为让旧文件可加载并迁移而保留。 */
const legacyAutomationScheduleSchema = z.object({
  unit: z.enum(['hour', 'day', 'week', 'month']),
  timeOfDay: z.string().regex(/^\d{1,2}:\d{2}$/u).optional(),
  dayOfWeek: z.number().int().min(0).max(6).optional(),
  dayOfMonth: z.number().int().min(1).max(31).optional(),
}).strict()
const automationSchema = z.object({
  id: z.string().min(1).max(128),
  name: z.string().min(1).max(120),
  prompt: z.string().min(1).max(100_000),
  status: z.enum(['active', 'paused', 'ended']).optional(),
  rrule: z.string().min(1).max(2_000).optional(),
  timeZone: z.string().min(1).max(80).optional(),
  target: z.enum(['session', 'new_once', 'new']).optional(),
  sessionId: z.string().min(1).optional(),
  /** 旧版字段，由自动化服务在加载时迁移。 */
  enabled: z.boolean().optional(),
  intervalMs: z.number().int().min(60_000).max(365 * 24 * 60 * 60 * 1000).optional(),
  schedule: legacyAutomationScheduleSchema.optional(),
  nextRunAt: z.number().finite().optional(),
  createdAt: z.number().finite(),
  updatedAt: z.number().finite(),
  lastRun: automationRunSchema.optional(),
  runs: z.array(automationRunSchema).optional(),
  builtin: z.string().min(1).max(64).optional(),
  accessMode: accessMode.optional(),
  model: modelRef.optional(),
  workspaceId: z.string().optional(),
}).strict().transform(value => ({
  ...value,
  // RRULE 之前的文件带 `enabled` 且无 status；旧版任务总是开启新会话。
  status: value.status ?? (value.enabled === false ? 'paused' as const : 'active' as const),
  target: value.target ?? 'new' as const,
}))
const feedbackEntrySchema = z.object({
  text: z.string().min(1).max(2_000),
  createdAt: z.number().finite(),
  userAgent: z.string().min(1).max(500).optional(),
}).strict()
const appStateSchema = z.object({
  version: z.literal(1),
  settings: settingsSchema,
  workspaces: z.array(workspaceSchema),
  /** 旧版插件开关，仅为让既有文件仍可解析而保留。 */
  plugins: z.record(z.string(), pluginStateSchema),
  automations: z.array(automationSchema),
  feedback: z.array(feedbackEntrySchema).default([]),
}).strict()

/** 一条操作者从 Web 客户端提交的反馈记录。 */
export type FeedbackEntry = { text: string; createdAt: number; userAgent?: string }

/**
 * 落盘的应用状态：版本号、设置、工作区、旧版插件开关（仅兼容）、自动化任务与反馈列表。
 * AppStateStore 持有的内存态与磁盘 JSON 同构。
 */
export type PersistedAppState = {
  version: 1
  settings: AppSettings
  workspaces: WorkspaceSummary[]
  /** 旧版插件开关：仅为 schema 兼容保留，运行时忽略。 */
  plugins: Record<string, { enabled: boolean; tools: Record<string, boolean> }>
  automations: Automation[]
  feedback: FeedbackEntry[]
}

const DEFAULT_ACCESS: AccessMode = 'fullAccess'
/** 操作者反馈是有界日志：超过上限时追加即丢弃最旧条目。 */
const FEEDBACK_LIMIT = 200

/** 判断错误是否为 ENOENT（文件/目录不存在）。 */
function isMissing(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT'
}

/**
 * 功能：把已退役的双模式显示设置折叠成如今的"工作详情"设置：`processDisplay` 映射为
 * transcript 视图、`collapseProcess` 映射为折叠时机（旧值一律折叠到完成时机）。
 * @param value 原始解析出的应用状态（未校验）。
 * @returns 补齐新键、删除旧键后的状态；非对象结构原样返回。
 * 内部逻辑：仅当 settings 是普通对象时改写；旧键绝不随读取存活，保证严格 schema 可接受旧文件。
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
 * 功能：退役的逐条消息评分记录与如今的操作者反馈共用 `feedback` 键。评分无法表示为条目，
 * 旧记录直接丢弃、键读取为空列表；保证所有落盘状态仍可解析。
 * @param value 原始状态。
 * @returns feedback 为数组或缺失时原样返回；否则把该键替换为空数组。
 */
function migrateFeedback(value: unknown): unknown {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return value
  const state = value as Record<string, unknown>
  if (state.feedback === undefined || Array.isArray(state.feedback)) return value
  return { ...state, feedback: [] }
}

/**
 * 功能：退役的 Agent 预设特性——预设列表、默认预设设置与每个自动化任务的预设引用全部读取为已删除。
 * 旧键绝不随读取存活，因此严格 schema 始终接受旧文件。
 * @param value 原始状态。
 * @returns 删除顶层 presets、settings.defaultPresetId 与每条 automation.presetId 后的状态。
 */
function migratePresets(value: unknown): unknown {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return value
  const state = { ...(value as Record<string, unknown>) }
  delete state.presets
  if (typeof state.settings === 'object' && state.settings !== null && !Array.isArray(state.settings)) {
    const settings = { ...(state.settings as Record<string, unknown>) }
    delete settings.defaultPresetId
    state.settings = settings
  }
  if (Array.isArray(state.automations)) {
    state.automations = (state.automations as unknown[]).map(entry => {
      if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return entry
      const automation = { ...(entry as Record<string, unknown>) }
      delete automation.presetId
      return automation
    })
  }
  return state
}

/** 用 access 探测文件是否可访问（任何错误都视为不存在）。 */
async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

/**
 * 功能：构建全新安装时的默认设置。
 * @param defaultThinkingLevel 建议的默认思考级别（来自目录推断）；undefined 时用 medium。
 * @param workspaceId 初始工作区 id；undefined 时不设置 defaultWorkspaceId。
 * @returns 完整的 AppSettings 默认值对象。
 */
function defaultSettings(defaultThinkingLevel: ThinkingLevel | undefined, workspaceId: string | undefined): AppSettings {
  return {
    theme: 'system',
    locale: 'zh',
    fontSize: 14,
    codeFontSize: 11,
    terminalFontSize: 11,
    textFontFamily: '',
    codeFontFamily: '',
    terminalFontFamily: '',
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
    chineseReasoning: false,
    showAnalysisConversations: false,
    ...(workspaceId === undefined ? {} : { defaultWorkspaceId: workspaceId }),
  }
}

/**
 * 功能：原子写出应用状态 JSON（美化缩进）到指定路径。
 * @param path app-state.json 的绝对路径。
 * @param value 待落盘的完整状态。
 * 内部逻辑：目录 0700 → 临时文件 wx 独占创建（0600）→ chmod → rename；失败清理临时文件后抛出。
 */
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

/**
 * 应用自持设置与元数据的序列化存储，与 Pi Durable 的转录数据库分开持久化（app-state.json）。
 * 契约：所有写入经 `update` 串行排队（#tail 链）保证原子落盘与内存一致；读取用 structuredClone
 * 快照，调用方改动不会泄漏回存储。
 */
export class AppStateStore {
  #state: PersistedAppState
  #path: string
  #tail: Promise<void> = Promise.resolve()

  /** 私有构造：一律经 {@link AppStateStore.open} 创建。 */
  private constructor(path: string, state: PersistedAppState) {
    this.#path = path
    this.#state = state
  }

  /**
   * 功能：打开（或初始化）app-state.json 并返回存储实例。
   * @param options.dataDir 数据目录，状态文件位于其下的 app-state.json。
   * @param options.defaultWorkspace 可选初始工作区；缺省时全新安装以空工作区列表启动。
   * @param options.defaultThinkingLevel 可选默认思考级别。
   * @returns AppStateStore 实例。
   * 内部逻辑：文件存在→依次过 migrateLegacySettings/migrateFeedback/migratePresets 再 zod 校验，
   * 失败抛中文错误；文件缺失→写默认状态。随后清空不再展示的模型白名单（防止无入口的死锁过滤），
   * 有 defaultWorkspace 时 ensureWorkspace 兜底注册。
   */
  static async open(options: {
    dataDir: string
    /** 可选：缺省时全新安装以空工作区列表启动。 */
    defaultWorkspace?: WorkspaceSummary
    defaultThinkingLevel?: ThinkingLevel
  }): Promise<AppStateStore> {
    const path = join(resolve(options.dataDir), 'app-state.json')
    let state: PersistedAppState
    try {
      const raw: unknown = JSON.parse(await readFile(path, 'utf8'))
      const parsed = appStateSchema.safeParse(migratePresets(migrateFeedback(migrateLegacySettings(raw))))
      if (!parsed.success) throw new Error('应用数据格式不受支持')
      state = parsed.data
    } catch (error) {
      if (!isMissing(error)) throw new Error(`无法读取有效的应用配置：${path}`)
      state = {
        version: 1,
        settings: defaultSettings(options.defaultThinkingLevel, options.defaultWorkspace?.id),
        workspaces: options.defaultWorkspace === undefined ? [] : [structuredClone(options.defaultWorkspace)],
        plugins: {},
        automations: [],
        feedback: [],
      }
      await writeJsonAtomic(path, state)
    }
    // 模型白名单控件已不再展示；清掉存量过滤条件，避免模型持续被隐藏而无可见的修复入口。
    if (state.settings.modelAllowlist.length > 0) {
      state = { ...state, settings: { ...state.settings, modelAllowlist: [] } }
      await writeJsonAtomic(path, state)
    }
    const store = new AppStateStore(path, state)
    if (options.defaultWorkspace !== undefined) await store.ensureWorkspace(options.defaultWorkspace)
    return store
  }

  /**
   * 功能：返回当前状态的结构化快照。
   * @returns PersistedAppState 的深拷贝；调用方的修改不会影响存储内部状态。
   */
  snapshot(): PersistedAppState {
    return structuredClone(this.#state)
  }

  /** 本存储持久化的配置文件的绝对路径。 */
  get path(): string {
    return this.#path
  }

  /**
   * 功能：确认配置文件在磁盘上。应用在启动时与每次保存后都会写它，
   * 文件缺失意味着被应用之外的力量删除：重写一次当前状态，然后回报文件是否在场。
   * @returns true 文件已存在（或重写成功）；false 重写后仍缺失。
   * 内部逻辑：先探测；缺失时借一次空 update 触发完整写盘，再探测一次。
   */
  async ensureFile(): Promise<boolean> {
    if (await fileExists(this.#path)) return true
    await this.update(() => undefined)
    return await fileExists(this.#path)
  }

  /**
   * 功能：追加一条操作者反馈，仅保留最新的 {@link FEEDBACK_LIMIT} 条。
   * @param entry 反馈条目。
   */
  async recordFeedback(entry: FeedbackEntry): Promise<void> {
    await this.update(state => {
      state.feedback.push(structuredClone(entry))
      if (state.feedback.length > FEEDBACK_LIMIT) state.feedback.splice(0, state.feedback.length - FEEDBACK_LIMIT)
    })
  }

  /**
   * 功能：串行执行一次状态变更：克隆草稿 → 执行变更 → 原子写盘 → 替换内存态。
   * @param change 以草稿为参数的同步或异步变更函数，直接原地改草稿。
   * @returns change 的返回值；变更失败时既不落盘也不替换内存态，错误透传。
   * 内部逻辑：所有更新挂到 #tail 链上排队，保证并发调用按序落盘、无交错写；
   * #tail 自身吞掉结果以保持链条存活。
   */
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

  /**
   * 功能：确保某个工作区已注册（按 id 或 path 判重）；未设置默认工作区时以首个为准。
   * @param workspace 要注册的工作区摘要。
   * 内部逻辑：已存在同 id 或同 path 的工作区时跳过；否则追加克隆副本，并在 defaultWorkspaceId
   * 为空时补上该工作区的 id。
   */
  async ensureWorkspace(workspace: WorkspaceSummary): Promise<void> {
    if (this.#state.workspaces.some(candidate => candidate.id === workspace.id || candidate.path === workspace.path)) return
    await this.update(state => {
      state.workspaces.push(structuredClone(workspace))
      if (!state.settings.defaultWorkspaceId) state.settings.defaultWorkspaceId = workspace.id
    })
  }
}
