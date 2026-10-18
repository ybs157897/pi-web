import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { dirname, join, resolve } from 'node:path'
import { z } from 'zod'
import type {
  AccessMode,
  AgentPreset,
  AppSettings,
  Automation,
  AutomationRun,
  PluginSummary,
  ThinkingLevel,
  WorkspaceSummary,
} from '../shared/types.ts'

const modelRef = z.object({ provider: z.string().min(1).max(100), modelId: z.string().min(1).max(256) }).strict()
const thinking = z.enum(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'])
const accessMode = z.enum(['readOnly', 'workspaceWrite', 'fullAccess'])
const settingsSchema = z.object({
  theme: z.enum(['system', 'light', 'dark']),
  locale: z.enum(['zh', 'en']),
  fontSize: z.number().min(12).max(20),
  codeFontSize: z.number().min(10).max(16),
  terminalFontSize: z.number().min(10).max(20),
  processDisplay: z.enum(['detailed', 'compact']),
  collapseProcess: z.enum(['afterResponse', 'always', 'never']),
  codingViews: z.boolean(),
  busySendMode: z.enum(['followUp', 'steer']),
  defaultModel: modelRef.optional(),
  defaultThinkingLevel: thinking,
  defaultAccessMode: accessMode,
  defaultPresetId: z.string().min(1).optional(),
  defaultWorkspaceId: z.string().min(1).optional(),
  shortcuts: z.partialRecord(z.enum(['newConversation', 'search', 'settings', 'toggleSidebar', 'send', 'newline', 'alternateSend']), z.string().min(1).max(80)).optional(),
}).strict()
const workspaceSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1).max(120),
  path: z.string().min(1),
  createdAt: z.number().finite(),
  updatedAt: z.number().finite(),
}).strict()
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
const feedbackSchema = z.record(z.string(), z.record(z.string(), z.enum(['up', 'down']).nullable()))
const appStateSchema = z.object({
  version: z.literal(1),
  settings: settingsSchema,
  workspaces: z.array(workspaceSchema),
  plugins: z.record(z.string(), pluginStateSchema),
  presets: z.array(presetSchema),
  automations: z.array(automationSchema),
  feedback: feedbackSchema,
}).strict()

export type PersistedAppState = {
  version: 1
  settings: AppSettings
  workspaces: WorkspaceSummary[]
  plugins: Record<string, { enabled: boolean; tools: Record<string, boolean> }>
  presets: AgentPreset[]
  automations: Automation[]
  feedback: Record<string, Record<string, 'up' | 'down' | null>>
}

const DEFAULT_ACCESS: AccessMode = 'fullAccess'

function isMissing(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT'
}

function defaultSettings(defaultThinkingLevel: ThinkingLevel | undefined, workspaceId: string): AppSettings {
  return {
    theme: 'system',
    locale: 'zh',
    fontSize: 14,
    codeFontSize: 11,
    terminalFontSize: 11,
    processDisplay: 'compact',
    collapseProcess: 'afterResponse',
    codingViews: true,
    busySendMode: 'followUp',
    defaultThinkingLevel: defaultThinkingLevel ?? 'medium',
    defaultAccessMode: DEFAULT_ACCESS,
    defaultWorkspaceId: workspaceId,
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
    defaultWorkspace: WorkspaceSummary
    defaultThinkingLevel?: ThinkingLevel
  }): Promise<AppStateStore> {
    const path = join(resolve(options.dataDir), 'app-state.json')
    let state: PersistedAppState
    try {
      const raw: unknown = JSON.parse(await readFile(path, 'utf8'))
      const parsed = appStateSchema.safeParse(raw)
      if (!parsed.success) throw new Error('应用数据格式不受支持')
      state = parsed.data
    } catch (error) {
      if (!isMissing(error)) throw new Error(`无法读取有效的应用配置：${path}`)
      state = {
        version: 1,
        settings: defaultSettings(options.defaultThinkingLevel, options.defaultWorkspace.id),
        workspaces: [structuredClone(options.defaultWorkspace)],
        plugins: {},
        presets: [],
        automations: [],
        feedback: {},
      }
      await writeJsonAtomic(path, state)
    }
    const store = new AppStateStore(path, state)
    await store.ensureWorkspace(options.defaultWorkspace)
    return store
  }

  snapshot(): PersistedAppState {
    return structuredClone(this.#state)
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
