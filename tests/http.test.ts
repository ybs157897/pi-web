import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir, userInfo } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AskUserQuestionAnswerItem, AskUserQuestionItem, ConversationDetail, ConversationSummary, CreateConversationInput, ModelCatalog, ProviderInput, SubmitInput, UpdateConversationInput } from '../src/shared/types.ts'
import type { Runtime } from '../src/server/contracts.ts'
import type { GoalUpdateRequest } from '../src/shared/types.ts'
import type * as Protocol from '../src/shared/types.ts'
import { createApp } from '../src/server/app.ts'
import { AppStateStore } from '../src/server/app-state.ts'
import { RuntimeError } from '../src/server/runtime-errors.ts'
import { validateAnswers } from '../src/server/interactions.ts'
import { WorkspaceFiles } from '../src/server/workspace-files.ts'
import { DEFAULT_SHORTCUTS, resolveShortcuts } from '../src/web/keyboard.ts'

const NOW = 1_800_000_000_000
const QUESTION_SET: AskUserQuestionItem[] = [
  { id: 'scope', question: 'Which scope?', options: [{ label: 'Small' }, { label: 'Large' }] },
  { id: 'notes', question: 'Anything else?' },
]

function makeDetail(id = 'conv-1', title = 'Test conversation'): ConversationDetail {
  return {
    conversation: {
      id,
      title,
      createdAt: NOW,
      updatedAt: NOW,
      archived: false,
      pinned: false,
      busy: false,
      thinkingLevel: 'medium',
      cwd: '/tmp/pi-web-test',
    },
    messages: [],
    queue: [],
  }
}

class FakeRuntime implements Runtime {
  readonly details = new Map<string, ConversationDetail>([['conv-1', makeDetail()]])
  readonly listeners = new Map<string, Set<(value: ConversationDetail) => void>>()
  readonly modelListeners = new Set<() => void>()
  readonly calls: string[] = []
  cleanupCount = 0
  closeCount = 0
  lastProvider: ProviderInput | undefined
  lastFeedback: { text: string; userAgent?: string } | undefined

  async list(): Promise<ConversationSummary[]> {
    this.calls.push('list')
    return [...this.details.values()].map(value => value.conversation)
  }

  async create(input: CreateConversationInput): Promise<ConversationDetail> {
    this.calls.push('create')
    const detail = makeDetail('conv-created', input.title ?? 'New conversation')
    this.details.set(detail.conversation.id, detail)
    return detail
  }

  async detail(id: string): Promise<ConversationDetail> {
    this.calls.push(`detail:${id}`)
    const detail = this.details.get(id)
    if (!detail) throw Object.assign(new Error('missing'), { code: 'NOT_FOUND' })
    return structuredClone(detail)
  }

  async update(id: string, input: UpdateConversationInput): Promise<ConversationDetail> {
    this.calls.push(`update:${id}`)
    const detail = await this.detail(id)
    detail.conversation = { ...detail.conversation, ...input, presetId: input.presetId ?? detail.conversation.presetId, updatedAt: NOW + 1 }
    this.details.set(id, detail)
    return detail
  }

  async submit(id: string, input: SubmitInput): Promise<{ submissionId: string }> {
    this.calls.push(`submit:${id}:${input.requestId}`)
    return { submissionId: 'submission-1' }
  }

  readonly questionSets = new Map<string, AskUserQuestionItem[]>([['call-1', QUESTION_SET]])
  readonly answeredCalls = new Set<string>()
  /** Plan reviews the fake answers: both carry the same approve label the runtime uses. */
  readonly planReviewCalls = new Set(['call-plan-1', 'call-plan-2'])

  async answerInteraction(id: string, callId: string, answers: AskUserQuestionAnswerItem[]): Promise<ConversationDetail> {
    this.calls.push(`answer:${id}:${callId}`)
    const detail = this.details.get(id)
    if (!detail) throw Object.assign(new Error('missing'), { code: 'NOT_FOUND' })
    if (this.planReviewCalls.has(callId)) {
      if (this.answeredCalls.has(callId)) return structuredClone(detail)
      this.answeredCalls.add(callId)
      const approved = answers.some(answer => answer.selected.includes('同意执行'))
      detail.interactions = [{
        id: callId, kind: 'plan-review', status: 'answered', detail: '# 演示计划', approveLabel: '同意执行',
        approved, createdAt: NOW, answeredAt: NOW + 1,
      }]
      detail.plan = { active: !approved }
      this.details.set(id, detail)
      return structuredClone(detail)
    }
    const questions = this.questionSets.get(callId)
    if (!questions) throw Object.assign(new Error('missing'), { code: 'NOT_FOUND' })
    if (this.answeredCalls.has(callId)) return structuredClone(detail)
    const invalid = validateAnswers(questions, answers)
    if (invalid) throw new RuntimeError('INVALID_INPUT', invalid)
    this.answeredCalls.add(callId)
    detail.interactions = [{ id: callId, kind: 'question', status: 'answered', questions, answer: { answers }, createdAt: NOW, answeredAt: NOW + 1 }]
    this.details.set(id, detail)
    return structuredClone(detail)
  }

  async cancelInteraction(id: string, callId: string): Promise<ConversationDetail> {
    this.calls.push(`cancel:${id}:${callId}`)
    const detail = this.details.get(id)
    if (!detail) throw Object.assign(new Error('missing'), { code: 'NOT_FOUND' })
    const questions = this.questionSets.get(callId)
    if (!questions) throw Object.assign(new Error('missing'), { code: 'NOT_FOUND' })
    if (this.answeredCalls.has(callId)) throw new RuntimeError('CONFLICT', '该问题已回答，无法放弃整组问题')
    detail.interactions = [{ id: callId, kind: 'question', status: 'cancelled', questions, createdAt: NOW }]
    this.details.set(id, detail)
    return structuredClone(detail)
  }

  async stop(id: string): Promise<void> {
    this.calls.push(`stop:${id}`)
  }

  async compact(id: string): Promise<void> {
    this.calls.push(`compact:${id}`)
  }

  async goal(id: string, input: GoalUpdateRequest): Promise<ConversationDetail> {
    this.calls.push(`goal:${id}:${input.action}`)
    return this.details.get(id) ?? makeDetail(id)
  }

  async setPlan(id: string, active: boolean): Promise<ConversationDetail> {
    this.calls.push(`plan:${id}:${active}`)
    const detail = this.details.get(id)
    if (!detail) throw Object.assign(new Error('missing'), { code: 'NOT_FOUND' })
    detail.plan = { active }
    this.details.set(id, detail)
    return structuredClone(detail)
  }

  /** One parent with one finished child; the routes only move these summaries around. */
  readonly childRows = new Map<string, Protocol.SubagentSummary[]>([['conv-1', [{
    id: 'child-1', label: '核对清单', title: '核对清单', status: 'inactive', answer: '子会话已完成核对。',
    createdAt: NOW, updatedAt: NOW,
  }]]])

  async children(id: string): Promise<Protocol.SubagentSummary[]> {
    this.calls.push(`children:${id}`)
    if (!this.details.has(id)) throw Object.assign(new Error('missing'), { code: 'NOT_FOUND' })
    return structuredClone(this.childRows.get(id) ?? [])
  }

  /** One Lead row plus one teammate and one blocked task; the route stays read-only. */
  teamRows: Protocol.TeamView = {
    members: [
      { name: 'lead', role: 'lead', phase: 'active', status: 'inactive', conversationId: 'conv-1', label: 'Lead', model: 'demo/model' },
      { name: 'researcher', role: 'teammate', phase: 'active', status: 'inactive', conversationId: 'child-1', label: '资料调研', model: 'demo/model' },
    ],
    tasks: [
      {
        id: 'task-1', revision: 1, subject: '调研团队面板', description: '核对面板字段。', status: 'pending',
        blockedBy: [], writeScopes: ['src/web'], ready: true, blocked: false, writeScopeWarnings: [],
        createdAt: NOW, updatedAt: NOW,
      },
      {
        id: 'task-2', revision: 1, subject: '实现 TeamPanel', description: '按 DSH 面板实现。', status: 'pending',
        blockedBy: ['task-1'], writeScopes: [], ready: false, blocked: true, writeScopeWarnings: [],
        createdAt: NOW, updatedAt: NOW,
      },
    ],
  }

  async team(id: string): Promise<Protocol.TeamView> {
    this.calls.push(`team:${id}`)
    if (!this.details.has(id)) throw Object.assign(new Error('missing'), { code: 'NOT_FOUND' })
    return structuredClone(this.teamRows)
  }

  async childMessage(id: string, childId: string, input: Protocol.ChildMessageInput): Promise<Protocol.SubagentSummary[]> {
    this.calls.push(`childMessage:${id}:${childId}:${input.requestId}`)
    const rows = this.childRows.get(id) ?? []
    if (!this.details.has(id) || !rows.some(row => row.id === childId)) throw Object.assign(new Error('missing'), { code: 'NOT_FOUND' })
    const updated = rows.map(row => row.id === childId ? { ...row, status: 'running' as const, updatedAt: NOW + 1 } : row)
    this.childRows.set(id, updated)
    return structuredClone(updated)
  }

  async childStop(id: string, childId: string): Promise<Protocol.SubagentSummary[]> {
    this.calls.push(`childStop:${id}:${childId}`)
    const rows = this.childRows.get(id) ?? []
    if (!this.details.has(id) || !rows.some(row => row.id === childId)) throw Object.assign(new Error('missing'), { code: 'NOT_FOUND' })
    const stopped = rows.map(row => row.id === childId ? { ...row, status: 'inactive' as const, updatedAt: NOW + 2 } : row)
    this.childRows.set(id, stopped)
    return structuredClone(stopped)
  }

  async removeQueued(id: string, submissionId: string): Promise<void> {
    this.calls.push(`removeQueued:${id}:${submissionId}`)
  }

  async fork(id: string, entryId: string): Promise<ConversationDetail> {
    this.calls.push(`fork:${id}:${entryId}`)
    const detail = makeDetail('conv-forked', 'Forked conversation')
    this.details.set(detail.conversation.id, detail)
    return detail
  }

  async watch(id: string, listener: (value: ConversationDetail) => void): Promise<() => Promise<void>> {
    this.calls.push(`watch:${id}`)
    if (!this.details.has(id)) throw Object.assign(new Error('missing'), { code: 'NOT_FOUND' })
    const listeners = this.listeners.get(id) ?? new Set()
    listeners.add(listener)
    this.listeners.set(id, listeners)
    return async () => {
      this.cleanupCount += 1
      listeners.delete(listener)
    }
  }

  notify(id: string): void {
    const detail = this.details.get(id)
    if (!detail) return
    for (const listener of this.listeners.get(id) ?? []) listener(structuredClone(detail))
  }

  async catalog(): Promise<ModelCatalog> {
    this.calls.push('catalog')
    return {
      models: [{ provider: 'test', modelId: 'model-1', name: 'Test model', reasoning: true, available: true }],
      providers: [{ id: 'test', name: 'Test', configured: true, custom: false, source: 'builtin' }],
      defaultModel: { provider: 'test', modelId: 'model-1' },
      thinkingLevels: ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
    }
  }

  watchModels(listener: () => void): () => void {
    this.modelListeners.add(listener)
    return () => { this.modelListeners.delete(listener) }
  }

  emitModels(): void {
    for (const listener of [...this.modelListeners]) listener()
  }

  async saveProvider(input: ProviderInput): Promise<void> {
    this.calls.push('saveProvider')
    this.lastProvider = input
  }

  settingsValue: Protocol.AppSettings = {
    theme: 'system', locale: 'zh', fontSize: 14, codeFontSize: 11, terminalFontSize: 13,
    transcriptView: 'detailed', collapseTiming: 'completion', performanceUsage: 'detailed', codingViews: true, busySendMode: 'followUp',
    defaultThinkingLevel: 'off', defaultAccessMode: 'workspaceWrite', modelAllowlist: [], codemodeMode: 'on', memoryEnabled: false,
  }
  settings() { return this.settingsValue }
  mcp(): Protocol.McpView {
    return { configPath: '/tmp/pi-web-test/mcp.json', configExists: false, servers: [] }
  }
  capabilities(): { accessModes: Protocol.AccessMode[] } { return { accessModes: ['readOnly', 'workspaceWrite', 'fullAccess'] } }
  async updateSettings(input: Protocol.UpdateAppSettingsInput) {
    this.calls.push('settings:' + JSON.stringify(input))
    const { defaultModel, defaultPresetId, defaultWorkspaceId, shortcuts, ...rest } = input
    this.settingsValue = { ...this.settingsValue, ...rest }
    if (defaultModel !== undefined) { if (defaultModel === null) delete this.settingsValue.defaultModel; else this.settingsValue.defaultModel = defaultModel }
    if (defaultPresetId !== undefined) { if (defaultPresetId === null) delete this.settingsValue.defaultPresetId; else this.settingsValue.defaultPresetId = defaultPresetId }
    if (defaultWorkspaceId !== undefined) { if (defaultWorkspaceId === null) delete this.settingsValue.defaultWorkspaceId; else this.settingsValue.defaultWorkspaceId = defaultWorkspaceId }
    if (shortcuts !== undefined) { if (shortcuts === null) delete this.settingsValue.shortcuts; else this.settingsValue.shortcuts = shortcuts }
    return this.settingsValue
  }
  workspaces(): Protocol.WorkspaceSummary[] { return [{ id: 'ws-1', name: 'Workspace', path: '/tmp/pi-web-test', createdAt: NOW, updatedAt: NOW }] }
  async addWorkspace(input: Protocol.AddWorkspaceInput): Promise<Protocol.WorkspaceSummary> { return { ...this.workspaces()[0]!, name: input.name ?? 'Added', path: input.path } }
  async deleteWorkspace(id: string) { this.calls.push(`delete-workspace:${id}`) }
  async pickDirectory(): Promise<string | null> { return '/tmp/picked-workspace' }
  async listDirectories(path?: string): Promise<Protocol.DirectoryListing> { return { path: path ?? '/tmp', home: '/tmp', crumbs: [], entries: [], truncated: false } }
  async createDirectory(): Promise<void> { return undefined }
  async renameWorkspace(id: string, input: Protocol.RenameWorkspaceInput) { this.calls.push('workspace:' + id); return { ...this.workspaces()[0]!, name: input.name } }
  async workspaceFiles(_id: string, path: string): Promise<Protocol.WorkspaceFileEntry[]> { return [{ name: 'test.txt', path: path ? path + '/test.txt' : 'test.txt', type: 'file', size: 4 }] }
  async searchWorkspace(id: string, query: string) { this.calls.push('search:' + query); return this.workspaceFiles(id, '') }
  async workspaceFile(_id: string, path: string): Promise<Protocol.WorkspaceFile> { return { path, kind: 'text', content: 'text', size: 4, modifiedAt: NOW, mimeType: 'text/plain' } }
  async workspaceAsset(_id: string, path: string): Promise<{ mimeType: string; data: Uint8Array }> { return { mimeType: path.endsWith('.html') ? 'text/html' : 'application/octet-stream', data: new TextEncoder().encode('<script>unsafe()</script>') } }
  async gitBranches(id: string): Promise<Protocol.GitBranchSnapshot> {
    this.calls.push('git-branches:' + id)
    return { isGitAvailable: true, isRepository: true, repoRoot: '/tmp/repo', headRefType: 'branch', currentBranchName: 'main', branches: [{ name: 'main', isCurrent: true, upstreamName: null, commitHash: 'a'.repeat(40), commitTimestampMs: NOW }] }
  }
  async switchGitBranch(id: string, input: Protocol.SwitchGitBranchInput): Promise<Protocol.GitBranchMutation> {
    this.calls.push(`git-switch:${id}:${input.branchName}`)
    const snapshot = await this.gitBranches(id)
    return { ok: true, action: 'switch', branchName: input.branchName, didChange: true, created: false, snapshot, issues: [] }
  }
  async createGitBranch(id: string, input: Protocol.CreateGitBranchInput): Promise<Protocol.GitBranchMutation> {
    this.calls.push(`git-create:${id}:${input.branchName}`)
    const snapshot = await this.gitBranches(id)
    return { ok: true, action: 'create-and-switch', branchName: input.branchName, didChange: true, created: true, snapshot, issues: [] }
  }
  async gitWorktreeStatus(id: string): Promise<Protocol.GitWorktreeStatus> {
    this.calls.push('git-status:' + id)
    return { isGitAvailable: true, isRepository: true, repoRoot: '/tmp/repo', branchName: 'main', headRefType: 'branch', ahead: 0, behind: 0, dirtyFileCount: 1, added: 2, removed: 1, files: [{ path: 'a.ts', status: 'modified', added: 2, removed: 1 }] }
  }
  async gitWorktreeDiff(id: string, path: string): Promise<Protocol.GitWorktreeDiff> {
    this.calls.push(`git-diff:${id}:${path}`)
    return { path, diff: '- old\n+ new\n' }
  }
  async gitCommit(id: string, input: Protocol.GitCommitInput): Promise<Protocol.GitCommitResult> {
    this.calls.push(`git-commit:${id}:${input.message}:${input.includeUnstaged}`)
    return { ok: true, commitHash: 'abc1234', status: await this.gitWorktreeStatus(id) }
  }
  async gitPush(id: string): Promise<Protocol.GitPushResult> {
    this.calls.push('git-push:' + id)
    return { ok: true }
  }
  async gitCommitMessage(id: string, input: Protocol.GitCommitMessageInput): Promise<Protocol.GitCommitMessageResult> {
    this.calls.push(`git-commit-message:${id}:${input.includeUnstaged}:${input.conversationId ?? ''}`)
    return { message: 'Add the status panel', provider: 'demo', model: 'demo-model' }
  }
  async skills() { return { skills: [], diagnostics: [] } }
  async skill(): Promise<import('../src/shared/skills.ts').SkillContent> { throw new RuntimeError('NOT_FOUND', 'Skill not found') }
  async validateSkill() { return { valid: false, errors: ['Skill not found'], warnings: [] } }
  async plugins(): Promise<import('../src/shared/plugins.ts').PluginOverview> {
    return { marketplaces: [], plugins: [], operations: [], diagnostics: [] }
  }
  async addPluginMarketplace(source: string) { this.calls.push('add-marketplace:' + source); return this.plugins() }
  async removePluginMarketplace(id: string) { this.calls.push('remove-marketplace:' + id); return this.plugins() }
  async refreshPluginMarketplace(id: string) { this.calls.push('refresh-marketplace:' + id); return this.plugins() }
  async installPlugin(input: { marketplace: string; name: string }) { this.calls.push(`install-plugin:${input.marketplace}/${input.name}`); return { operationId: 'operation-1' } }
  async updatePlugin(pluginId: string) { this.calls.push('update-plugin:' + pluginId); return { operationId: 'operation-2' } }
  async describePlugin(pluginId: string): Promise<import('../src/shared/plugins.ts').PluginDescription> {
    this.calls.push('describe-plugin:' + pluginId)
    const [name, marketplace] = pluginId.split('@')
    return {
      id: pluginId, name: name ?? '', marketplace: marketplace ?? '', version: '1.0.0', sourceType: 'directory',
      skills: [], mcpServers: [], uiSurfaces: [], unsupported: [], dependencies: [], installed: false,
    }
  }
  async uninstallPlugin(pluginId: string) { this.calls.push('uninstall-plugin:' + pluginId); return this.plugins() }
  async setPluginEnabled(pluginId: string, enabled: boolean) { this.calls.push(`enable-plugin:${pluginId}:${enabled}`); return this.plugins() }
  watchPlugins(): () => void { return () => undefined }
  pluginUiSurfaces() {
    return [{ id: 'demo@market:canvas', pluginId: 'demo@market', pluginName: 'demo', title: 'Canvas', serverName: 'plugin_demo_canvas', resourceUri: 'ui://demo/canvas' }]
  }
  async pluginUiPage(input: { pluginId: string; serverName: string; uri: string }): Promise<string> {
    this.calls.push(`plugin-ui-page:${input.pluginId}:${input.serverName}:${input.uri}`)
    if (input.pluginId === 'missing@market') throw new RuntimeError('PLUGIN_UI_UNAVAILABLE', 'Plugin UI server is unavailable')
    return `<!doctype html><html><head></head><body>${input.uri}</body></html>`
  }
  async pluginUiCall(input: { pluginId: string; serverName: string; tool: string; arguments?: unknown }) {
    this.calls.push(`plugin-ui-call:${input.pluginId}:${input.serverName}:${input.tool}`)
    if (input.pluginId === 'missing@market') throw new RuntimeError('PLUGIN_UI_UNAVAILABLE', 'Plugin UI server is unavailable')
    return { content: [{ type: 'text' as const, text: `call:${input.tool}` }] }
  }
  async pluginUiReadResource(input: { pluginId: string; serverName: string; uri: string }) {
    this.calls.push(`plugin-ui-read:${input.pluginId}:${input.uri}`)
    if (input.pluginId === 'missing@market') throw new RuntimeError('PLUGIN_UI_UNAVAILABLE', 'Plugin UI server is unavailable')
    return { contents: [{ uri: input.uri, text: 'resource' }] }
  }
  presets(): Protocol.AgentPreset[] { return [{ id: 'preset-1', name: 'Preset', instructions: '', extensions: ['coding'], tools: ['read'], accessMode: 'readOnly' }] }
  async createPreset(input: Protocol.CreateAgentPresetInput) { return { ...input, id: input.id ?? 'preset-new' } }
  async updatePreset(id: string, input: Protocol.UpdateAgentPresetInput) { return { ...this.presets()[0]!, ...input, id } }
  async deletePreset(id: string) { this.calls.push('delete-preset:' + id) }
  async provider(id: string): Promise<Protocol.ProviderConfigSummary> { return { id, name: 'Test', source: 'project', configured: true, custom: true, credentialConfigured: true, api: 'openai-completions', models: [{ id: 'model-1', name: 'Model' }], baseUrl: 'https://example.test/v1' } }
  async deleteProvider(id: string) { this.calls.push('delete-provider:' + id) }
  async testProvider(id: string, modelId = 'model-1'): Promise<Protocol.ProviderTestResult> { return { providerId: id, modelId, status: 'connected', checkedAt: NOW } }
  async discoverProvider(id: string): Promise<{ models: Array<{ id: string; name: string }> }> { this.calls.push(`discover:${id}`); return { models: [{ id: 'model-1', name: 'Model 1' }] } }
  async editQueued(id: string, submissionId: string, input: Protocol.EditQueueInput) { this.calls.push(`edit-queue:${id}:${submissionId}:${input.whenBusy}`); return { submissionId: 'new-submission' } }
  async feedback(id: string, entryId: string, rating: 'up' | 'down' | null) { this.calls.push(`feedback:${id}:${entryId}:${rating}`) }
  async sendFeedback(input: { text: string; userAgent?: string }) { this.calls.push('send-feedback'); this.lastFeedback = input }
  async openConfigFile() { this.calls.push('open-config') }
  async retry(id: string, entryId: string, requestId: string) { this.calls.push(`retry:${id}:${entryId}:${requestId}`); return { conversationId: 'retried-conv', submissionId: 'retried-submission' } }
  automations(): Protocol.Automation[] { return [{ id: 'auto-1', name: 'Scheduled task', prompt: 'Check', enabled: false, createdAt: NOW, updatedAt: NOW }] }
  async createAutomation(input: Protocol.CreateAutomationInput): Promise<Protocol.Automation> { return { ...input, id: 'auto-new', enabled: input.enabled ?? false, createdAt: NOW, updatedAt: NOW } }
  async updateAutomation(id: string, input: Protocol.UpdateAutomationInput): Promise<Protocol.Automation> { return { ...this.automations()[0]!, ...input, id, intervalMs: input.intervalMs ?? undefined } }
  async deleteAutomation(id: string) { this.calls.push('delete-automation:' + id) }
  async runAutomation(id: string) { return { automation: { ...this.automations()[0]!, id }, conversationId: 'scheduled-conv' } }

  async close(): Promise<void> {
    this.closeCount += 1
  }
}

class PersistedShortcutsRuntime extends FakeRuntime {
  constructor(private readonly stateStore: AppStateStore) { super() }

  settings(): Protocol.AppSettings { return this.stateStore.snapshot().settings }

  async updateSettings(input: Protocol.UpdateAppSettingsInput): Promise<Protocol.AppSettings> {
    if (input.shortcuts !== undefined) {
      await this.stateStore.update(state => {
        if (input.shortcuts === null) delete state.settings.shortcuts
        else state.settings.shortcuts = input.shortcuts
      })
    }
    return this.settings()
  }
}

/** Answers the workspace file routes from a real directory so path handling runs end to end. */
class WorkspaceFilesRuntime extends FakeRuntime {
  private readonly files: WorkspaceFiles

  constructor(private readonly root: string) {
    super()
    this.files = new WorkspaceFiles(() => this.workspaces())
  }

  workspaces(): Protocol.WorkspaceSummary[] { return [{ id: 'ws-1', name: 'Workspace', path: this.root, createdAt: NOW, updatedAt: NOW }] }
  override async workspaceFiles(id: string, path: string): Promise<Protocol.WorkspaceFileEntry[]> { return this.files.list(id, path) }
  override async workspaceFile(id: string, path: string): Promise<Protocol.WorkspaceFile> { return this.files.read(id, path) }
  override async workspaceAsset(id: string, path: string): Promise<{ mimeType: string; data: Uint8Array }> { return this.files.asset(id, path) }
}

const liveApps: Array<ReturnType<typeof createApp>> = []

function createTestApp(runtime = new FakeRuntime()) {
  const app = createApp(runtime, { demo: true })
  liveApps.push(app)
  return { app, runtime }
}

afterEach(async () => {
  await Promise.all(liveApps.splice(0).map(app => app.shutdown()))
})

describe('HTTP API', () => {
  it('exposes health, conversation operations and model configuration without returning provider secrets', async () => {
    const { app, runtime } = createTestApp()

    const health = await app.request('/api/health')
    expect(await health.json()).toEqual({ ok: true, demo: true, version: '0.1.0', user: userInfo().username })

    const list = await app.request('/api/conversations')
    expect((await list.json()).conversations).toHaveLength(1)

    const created = await app.request('/api/conversations', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'From web', model: { provider: 'test', modelId: 'model-1' } }),
    })
    expect(created.status).toBe(201)
    expect((await created.json()).conversation.title).toBe('From web')

    const detail = await app.request('/api/conversations/conv-1')
    expect((await detail.json()).conversation.id).toBe('conv-1')

    const updated = await app.request('/api/conversations/conv-1', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pinned: true }),
    })
    expect((await updated.json()).conversation.pinned).toBe(true)

    const submitted = await app.request('/api/conversations/conv-1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'Hello', requestId: 'req-1', whenBusy: 'followUp' }),
    })
    expect(submitted.status).toBe(202)
    expect(await submitted.json()).toEqual({ submissionId: 'submission-1' })

    expect(await (await app.request('/api/conversations/conv-1/stop', { method: 'POST' })).json()).toEqual({ ok: true })
    expect((await app.request('/api/conversations/conv-1/compact', { method: 'POST' })).status).toBe(202)
    expect(await (await app.request('/api/conversations/conv-1/queue/sub-1', { method: 'DELETE' })).json()).toEqual({ ok: true })

    const forked = await app.request('/api/conversations/conv-1/fork', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ entryId: 'entry-1' }),
    })
    expect(forked.status).toBe(201)
    expect((await forked.json()).conversation.id).toBe('conv-forked')

    const models = await app.request('/api/models')
    expect((await models.json()).models).toHaveLength(1)

    const saved = await app.request('/api/providers', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        id: 'custom',
        name: 'Custom',
        baseUrl: 'https://example.test/v1',
        apiKey: 'private-api-key-value',
        models: [{ id: 'model-x', name: 'Model X' }],
      }),
    })
    const savedText = await saved.clone().text()
    expect(await saved.json()).toEqual({ ok: true })
    expect(savedText).not.toContain('private-api-key-value')
    expect(runtime.lastProvider?.apiKey).toBe('private-api-key-value')
  })

  it('streams a model-catalog change to an already connected client', async () => {
    const { app, runtime } = createTestApp()
    const response = await app.request('/api/models/events')
    expect(response.headers.get('content-type')).toContain('text/event-stream')
    const reader = response.body!.getReader()
    const decoder = new TextDecoder()
    const first = decoder.decode((await reader.read()).value)
    expect(first).toContain('event: ready')
    runtime.emitModels()
    const second = decoder.decode((await reader.read()).value)
    expect(second).toContain('event: changed')
    await reader.cancel()
  })

  it('serves root favicon assets in production static mode', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pi-web-static-'))
    try {
      await writeFile(join(root, 'favicon.svg'), '<svg xmlns="http://www.w3.org/2000/svg"></svg>')
      const app = createApp(new FakeRuntime(), { demo: true, staticRoot: root })
      liveApps.push(app)
      const response = await app.request('/favicon.svg')
      expect(response.status).toBe(200)
      expect(response.headers.get('content-type')).toContain('image/svg+xml')
      expect(await response.text()).toContain('<svg')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('answers a pending question, rejects concrete validation failures, and stays idempotent', async () => {
    const { app } = createTestApp()
    const answer = (callId: string, answers: unknown) => app.request(`/api/conversations/conv-1/interactions/${callId}/answer`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ answers }),
    })

    const unknown = await answer('call-404', [{ id: 'scope', selected: ['Small'] }, { id: 'notes', selected: [] }])
    expect(unknown.status).toBe(404)

    const missing = await answer('call-1', [{ id: 'scope', selected: ['Small'] }])
    expect(missing.status).toBe(400)
    expect((await missing.json()).error).toContain('Missing an answer for question "notes"')

    const notOffered = await answer('call-1', [{ id: 'scope', selected: ['Huge'] }, { id: 'notes', selected: [] }])
    expect(notOffered.status).toBe(400)
    expect((await notOffered.json()).error).toContain('was not offered')

    const strict = await answer('call-1', [{ id: 'scope', selected: ['Small'], why: 'extra' }, { id: 'notes', selected: [] }])
    expect(strict.status).toBe(400)

    const wrongType = await answer('call-1', [{ id: 'scope', selected: 'Small' }, { id: 'notes', selected: [] }])
    expect(wrongType.status).toBe(400)

    const ok = await answer('call-1', [{ id: 'scope', selected: ['Small'] }, { id: 'notes', selected: [], custom: 'keep it simple' }])
    expect(ok.status).toBe(200)
    const detail = await ok.json() as ConversationDetail
    expect(detail.interactions?.[0]).toMatchObject({
      id: 'call-1',
      kind: 'question',
      status: 'answered',
      answer: { answers: [{ id: 'scope', selected: ['Small'] }, { id: 'notes', selected: [], custom: 'keep it simple' }] },
    })

    const repeat = await answer('call-1', [{ id: 'scope', selected: ['Small'] }, { id: 'notes', selected: [] }])
    expect(repeat.status).toBe(200)
    expect((await repeat.json() as ConversationDetail).interactions?.[0]?.status).toBe('answered')
  })

  it('dismisses a pending question set, conflicts once it is answered, and 404s an unknown call', async () => {
    const { app, runtime } = createTestApp()
    const cancel = (callId: string) => app.request(`/api/conversations/conv-1/interactions/${callId}/cancel`, { method: 'POST' })

    expect((await cancel('call-404')).status).toBe(404)
    const ok = await cancel('call-1')
    expect(ok.status).toBe(200)
    expect(runtime.calls).toContain('cancel:conv-1:call-1')
    expect((await ok.json() as ConversationDetail).interactions?.[0]).toMatchObject({ id: 'call-1', kind: 'question', status: 'cancelled' })
    // Dismissing again is idempotent: the response is the same settled detail.
    const repeat = await cancel('call-1')
    expect(repeat.status).toBe(200)
    expect((await repeat.json() as ConversationDetail).interactions?.[0]?.status).toBe('cancelled')

    // An answered call is a conflict: its answers are already on their way.
    const answered = await app.request('/api/conversations/conv-1/interactions/call-1/answer', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ answers: [{ id: 'scope', selected: ['Small'] }, { id: 'notes', selected: [] }] }),
    })
    expect(answered.status).toBe(200)
    const conflict = await cancel('call-1')
    expect(conflict.status).toBe(409)
    expect((await conflict.json() as { code?: string }).code).toBe('CONFLICT')
  })

  it('switches plan mode, validates the body, and answers a plan review', async () => {
    const { app, runtime } = createTestApp()
    const post = (path: string, body: unknown) => app.request(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })

    const on = await post('/api/conversations/conv-1/plan', { active: true })
    expect(on.status).toBe(200)
    expect((await on.json() as ConversationDetail).plan).toEqual({ active: true })
    expect(runtime.calls).toContain('plan:conv-1:true')

    const off = await post('/api/conversations/conv-1/plan', { active: false })
    expect((await off.json() as ConversationDetail).plan).toEqual({ active: false })
    expect(runtime.calls).toContain('plan:conv-1:false')

    expect((await post('/api/conversations/conv-1/plan', { active: 'yes' })).status).toBe(400)
    expect((await post('/api/conversations/conv-1/plan', {})).status).toBe(400)
    expect((await post('/api/conversations/conv-1/plan', { active: true, extra: 1 })).status).toBe(400)
    const missing = await post('/api/conversations/conv-404/plan', { active: true })
    expect(missing.status).toBe(404)

    const approved = await post('/api/conversations/conv-1/interactions/call-plan-1/answer', {
      answers: [{ id: 'plan-review', selected: ['同意执行'] }],
    })
    expect(approved.status).toBe(200)
    const detail = await approved.json() as ConversationDetail
    expect(detail.plan).toEqual({ active: false })
    expect(detail.interactions?.[0]).toMatchObject({ id: 'call-plan-1', kind: 'plan-review', status: 'answered', approved: true })
    const repeat = await post('/api/conversations/conv-1/interactions/call-plan-1/answer', {
      answers: [{ id: 'plan-review', selected: ['同意执行'] }],
    })
    expect((await repeat.json() as ConversationDetail).interactions?.[0]?.status).toBe('answered')

    const changes = await post('/api/conversations/conv-1/interactions/call-plan-2/answer', {
      answers: [{ id: 'plan-review', selected: ['要求修改'], custom: '补上回滚说明' }],
    })
    expect(changes.status).toBe(200)
    const revised = await changes.json() as ConversationDetail
    expect(revised.plan).toEqual({ active: true })
    expect(revised.interactions?.[0]).toMatchObject({ id: 'call-plan-2', kind: 'plan-review', approved: false })
  })

  it('lists subagents, delivers a follow-up and stops one, with the same rejections as the runtime', async () => {
    const { app, runtime } = createTestApp()
    const post = (path: string, body?: unknown) => app.request(path, {
      method: 'POST',
      ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
    })

    const list = await app.request('/api/conversations/conv-1/children')
    expect(list.status).toBe(200)
    const rows = (await list.json() as { subagents: Protocol.SubagentSummary[] }).subagents
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ id: 'child-1', label: '核对清单', status: 'inactive' })
    expect(runtime.calls).toContain('children:conv-1')

    const unknownParent = await app.request('/api/conversations/conv-404/children')
    expect(unknownParent.status).toBe(404)

    const sent = await post('/api/conversations/conv-1/children/child-1/messages', { text: '再补充一条', requestId: 'child-msg-1' })
    expect(sent.status).toBe(202)
    expect((await sent.json() as { subagents: Protocol.SubagentSummary[] }).subagents[0]?.status).toBe('running')
    expect(runtime.calls).toContain('childMessage:conv-1:child-1:child-msg-1')

    expect((await post('/api/conversations/conv-1/children/child-1/messages', { text: '', requestId: 'x' })).status).toBe(400)
    expect((await post('/api/conversations/conv-1/children/child-1/messages', { text: '你好' })).status).toBe(400)
    expect((await post('/api/conversations/conv-1/children/child-1/messages', { text: '你好', requestId: 'x', extra: 1 })).status).toBe(400)
    expect((await post('/api/conversations/conv-1/children/child-404/messages', { text: '你好', requestId: 'x' })).status).toBe(404)

    const stopped = await post('/api/conversations/conv-1/children/child-1/stop')
    expect(stopped.status).toBe(200)
    expect((await stopped.json() as { subagents: Protocol.SubagentSummary[] }).subagents[0]?.status).toBe('inactive')
    expect((await post('/api/conversations/conv-1/children/child-404/stop')).status).toBe(404)
    expect((await post('/api/conversations/conv-1/children/child%201/stop')).status).toBe(400)
    expect((await post('/api/conversations/conv%2F1/children/child-1/stop')).status).toBe(400)
  })

  it('reads the conversation team read-only, with the same id validation as the runtime', async () => {
    const { app, runtime } = createTestApp()

    const response = await app.request('/api/conversations/conv-1/team')
    expect(response.status).toBe(200)
    const team = (await response.json() as { team: Protocol.TeamView }).team
    expect(team.members.map(member => member.name)).toEqual(['lead', 'researcher'])
    expect(team.members[1]?.status).toBe('inactive')
    expect(team.tasks.map(task => task.id)).toEqual(['task-1', 'task-2'])
    expect(team.tasks[1]?.blocked).toBe(true)
    expect(team.tasks[1]?.ready).toBe(false)
    expect(runtime.calls).toContain('team:conv-1')

    // There is no write route: the DSH panel is read-only as well.
    expect((await app.request('/api/conversations/conv-1/team', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status).toBe(404)
    expect((await app.request('/api/conversations/conv-404/team')).status).toBe(404)
    expect((await app.request('/api/conversations/conv%2F1/team')).status).toBe(400)
    expect((await app.request('/api/conversations/conv%201/team')).status).toBe(400)
  })

  it('validates JSON, object fields, ids, image MIME and image sizes', async () => {
    const { app } = createTestApp()
    const badJson = await app.request('/api/conversations', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{',
    })
    expect(badJson.status).toBe(400)

    const wrongShape = await app.request('/api/conversations', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'ok', credential: 'do not accept unknown fields' }),
    })
    expect(wrongShape.status).toBe(400)

    const badId = await app.request('/api/conversations/../detail')
    expect([400, 404]).toContain(badId.status)

    const badImage = await app.request('/api/conversations/conv-1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: '', requestId: 'req-image', images: [{ data: 'PHN2Zz4=', mimeType: 'image/svg+xml' }] }),
    })
    expect(badImage.status).toBe(400)

    const emptySubmit = await app.request('/api/conversations/conv-1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: '   ', requestId: 'req-empty' }),
    })
    expect(emptySubmit.status).toBe(400)

    const oversized = await app.request('/api/conversations', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': String(JSON_BODY_LIMIT_FOR_TEST) },
      body: '{}',
    })
    expect(oversized.status).toBe(413)

    const noJsonType = await app.request('/api/conversations', { method: 'POST', body: '{}' })
    expect(noJsonType.status).toBe(415)
  })

  it('rejects foreign hosts and browser origins before runtime access', async () => {
    const { app, runtime } = createTestApp()
    const foreignHost = await app.request('/api/conversations', { headers: { host: 'remote.example' } })
    expect(foreignHost.status).toBe(403)

    const foreignOrigin = await app.request('/api/conversations', { headers: { origin: 'https://remote.example' } })
    expect(foreignOrigin.status).toBe(403)
    expect(runtime.calls).toEqual([])
  })

  it('sends an initial SSE snapshot and releases its watch when the client disconnects', async () => {
    const { app, runtime } = createTestApp()
    const response = await app.request('/api/conversations/conv-1/events')
    expect(response.headers.get('content-type')).toContain('text/event-stream')
    const reader = response.body?.getReader()
    expect(reader).toBeDefined()
    const first = await reader?.read()
    expect(new TextDecoder().decode(first?.value)).toContain('event: snapshot')
    expect(new TextDecoder().decode(first?.value)).toContain('"id":"conv-1"')
    await reader?.cancel()
    expect(runtime.cleanupCount).toBe(1)
    expect(runtime.listeners.get('conv-1')?.size).toBe(0)
  })

  it('closes active SSE subscriptions during application shutdown', async () => {
    const { app, runtime } = createTestApp()
    const response = await app.request('/api/conversations/conv-1/events')
    const reader = response.body?.getReader()
    await reader?.read()
    await app.shutdown()
    expect(runtime.cleanupCount).toBe(1)
    expect(runtime.listeners.get('conv-1')?.size).toBe(0)
  })

  it('coalesces slow SSE updates to a latest-state signal instead of buffering every snapshot', async () => {
    const { app, runtime } = createTestApp()
    const response = await app.request('/api/conversations/conv-1/events')
    const reader = response.body?.getReader()
    expect(reader).toBeDefined()
    const detailCalls = () => runtime.calls.filter(call => call === 'detail:conv-1').length
    expect(detailCalls()).toBe(1)

    for (let index = 0; index < 100; index += 1) runtime.notify('conv-1')
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(detailCalls()).toBe(1)

    await reader?.read()
    await vi.waitFor(() => expect(detailCalls()).toBe(2))
    for (let index = 0; index < 100; index += 1) runtime.notify('conv-1')
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(detailCalls()).toBe(2)
    await reader?.cancel()
    expect(runtime.cleanupCount).toBe(1)
  })

  it('cleans up one SSE watch on reconnect without removing the other subscriber', async () => {
    const { app, runtime } = createTestApp()
    const first = await app.request('/api/conversations/conv-1/events')
    const second = await app.request('/api/conversations/conv-1/events')
    const firstReader = first.body?.getReader()
    const secondReader = second.body?.getReader()
    await firstReader?.read()
    await secondReader?.read()
    expect(runtime.listeners.get('conv-1')?.size).toBe(2)

    await firstReader?.cancel()
    expect(runtime.listeners.get('conv-1')?.size).toBe(1)
    expect(runtime.cleanupCount).toBe(1)

    await secondReader?.cancel()
    expect(runtime.listeners.get('conv-1')?.size).toBe(0)
    expect(runtime.cleanupCount).toBe(2)
  })
})

describe('management API', () => {
  const json = (method: string, body: unknown): RequestInit => ({ method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })

  it('preserves actionable runtime failures without exposing unexpected exception details', async () => {
    const { app, runtime } = createTestApp()
    vi.spyOn(runtime, 'stop').mockRejectedValueOnce(new RuntimeError('CONFLICT', '消息已进入当前运行，无法撤回'))
      .mockRejectedValueOnce(new Error('private authentication file'))
      .mockRejectedValueOnce(new RuntimeError('UNSUPPORTED', '当前系统无法启用工作区写入沙盒'))
    const conflict = await app.request('/api/conversations/conv-1/stop', { method: 'POST' })
    expect(conflict.status).toBe(409)
    expect((await conflict.json()).error).toBe('消息已进入当前运行，无法撤回')
    const unexpected = await app.request('/api/conversations/conv-1/stop', { method: 'POST' })
    expect(unexpected.status).toBe(500)
    expect((await unexpected.json()).error).toBe('Internal server error')
    expect((await app.request('/api/conversations/conv-1/stop', { method: 'POST' })).status).toBe(422)
  })

  it('accepts all browser shortcuts over HTTP and restores them from persisted app state', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'pi-web-shortcuts-'))
    try {
      const defaultWorkspace = { id: 'ws-shortcuts', name: 'Shortcuts', path: dataDir, createdAt: NOW, updatedAt: NOW }
      const store = await AppStateStore.open({ dataDir, defaultWorkspace })
      const { app } = createTestApp(new PersistedShortcutsRuntime(store))
      const edited = resolveShortcuts({ search: 'Mod+p' })
      expect(Object.keys(edited)).toHaveLength(10)
      const editResponse = await app.request('/api/settings', json('PATCH', { shortcuts: edited }))
      expect(editResponse.status).toBe(200)
      expect((await editResponse.json()).shortcuts).toEqual(edited)

      // Restore uses the literal DEFAULT_SHORTCUTS object in SettingsDialog.
      const restored = { ...DEFAULT_SHORTCUTS }
      const restoreResponse = await app.request('/api/settings', json('PATCH', { shortcuts: restored }))
      expect(restoreResponse.status).toBe(200)
      expect((await (await app.request('/api/settings')).json()).shortcuts).toEqual(restored)

      const reopened = await AppStateStore.open({ dataDir, defaultWorkspace })
      expect(reopened.snapshot().settings.shortcuts).toEqual(restored)
    } finally {
      await rm(dataDir, { recursive: true, force: true })
    }
  })

  it('updates settings, workspace bindings and presets through typed routes', async () => {
    const { app, runtime } = createTestApp()
    expect((await (await app.request('/api/capabilities')).json()).accessModes).toContain('workspaceWrite')
    const settings = await app.request('/api/settings', json('PATCH', { locale: 'en', fontSize: 16, defaultModel: null, shortcuts: { search: 'Mod+p' } }))
    expect(settings.status).toBe(200)
    expect((await settings.json()).locale).toBe('en')
    expect((await app.request('/api/settings', json('PATCH', { fontSize: 100 }))).status).toBe(400)
    expect((await app.request('/api/settings', json('PATCH', { shortcuts: { arbitraryAction: 'x' } }))).status).toBe(400)
    // The allowlist is an array of pattern strings; a string, a non-string entry or an over-long entry is refused.
    expect((await app.request('/api/settings', json('PATCH', { modelAllowlist: 'opencode-go/deepseek*' }))).status).toBe(400)
    expect((await app.request('/api/settings', json('PATCH', { modelAllowlist: [42] }))).status).toBe(400)
    expect((await app.request('/api/settings', json('PATCH', { modelAllowlist: ['x'.repeat(201)] }))).status).toBe(400)
    const allowlist = await app.request('/api/settings', json('PATCH', { modelAllowlist: ['opencode-go/deepseek*'] }))
    expect(allowlist.status).toBe(200)
    expect((await allowlist.json()).modelAllowlist).toEqual(['opencode-go/deepseek*'])
    // Pi code mode is a three-value setting; an unknown value never reaches the runtime.
    expect((await app.request('/api/settings', json('PATCH', { codemodeMode: 'only' }))).status).toBe(200)
    expect(runtime.settings().codemodeMode).toBe('only')
    expect((await app.request('/api/settings', json('PATCH', { codemodeMode: 'sometimes' }))).status).toBe(400)
    expect((await app.request('/api/settings', json('PATCH', { memoryEnabled: true }))).status).toBe(200)
    expect(runtime.settings().memoryEnabled).toBe(true)
    expect((await app.request('/api/settings', json('PATCH', { memoryEnabled: 'yes' }))).status).toBe(400)
    const mcp = await app.request('/api/mcp')
    expect(mcp.status).toBe(200)
    expect(await mcp.json()).toEqual({ configPath: '/tmp/pi-web-test/mcp.json', configExists: false, servers: [] })
    const workspace = await app.request('/api/workspaces', json('POST', { path: '/tmp/pi-web-test', name: 'Project' }))
    expect(workspace.status).toBe(201)
    expect((await workspace.json()).workspace.name).toBe('Project')
    expect((await (await app.request('/api/workspaces/ws-1/files?path=src')).json()).entries[0].path).toBe('src/test.txt')
    expect((await (await app.request('/api/workspaces/ws-1/search?q=test')).json()).entries).toHaveLength(1)
    // Plugin management now means the marketplace, not the retired per-plugin switches.
    const plugins = await app.request('/api/plugins/overview')
    expect(plugins.status).toBe(200)
    expect(await plugins.json()).toMatchObject({ marketplaces: [], plugins: [], operations: [], diagnostics: [] })
    expect((await app.request('/api/plugins/marketplaces', json('POST', { source: '/tmp/pi-web-market' }))).status).toBe(201)
    expect((await app.request('/api/plugins/marketplaces', json('POST', { source: '' }))).status).toBe(400)
    expect((await app.request('/api/plugins/marketplaces/market', { method: 'DELETE' })).status).toBe(200)
    expect((await app.request('/api/plugins/marketplaces/market/refresh', { method: 'POST' })).status).toBe(200)
    expect((await app.request('/api/plugins/install', json('POST', { marketplace: 'market', name: 'demo' }))).status).toBe(202)
    expect((await app.request('/api/plugins/update', json('POST', { pluginId: 'demo@market' }))).status).toBe(202)
    expect((await app.request('/api/plugins/update', json('POST', { pluginId: 'not-an-id' }))).status).toBe(400)
    const described = await app.request('/api/plugins/demo@market/describe')
    expect(described.status).toBe(200)
    expect(await described.json()).toMatchObject({ id: 'demo@market', name: 'demo', marketplace: 'market', installed: false })
    const events = await app.request('/api/plugins/events')
    expect(events.headers.get('content-type')).toContain('text/event-stream')
    const reader = events.body!.getReader()
    const frames = new TextDecoder().decode((await reader.read()).value)
    expect(frames).toContain('event: ready')
    await reader.cancel()
    const uiSurfaces = await app.request('/api/plugins/ui/surfaces?workspaceId=ws-1')
    expect(uiSurfaces.status).toBe(200)
    expect(await uiSurfaces.json()).toMatchObject({ surfaces: [{ id: 'demo@market:canvas', serverName: 'plugin_demo_canvas' }] })
    expect((await app.request('/api/plugins/ui/surfaces?workspaceId=bad id')).status).toBe(400)
    const pageQuery = new URLSearchParams({ pluginId: 'demo@market', serverName: 'plugin_demo_canvas', uri: 'ui://demo/canvas' })
    const page = await app.request(`/api/plugins/ui/page?${pageQuery}`)
    expect(page.status).toBe(200)
    expect(page.headers.get('content-type')).toContain('text/html')
    expect(await page.text()).toContain('ui://demo/canvas')
    expect((await app.request('/api/plugins/ui/page?pluginId=demo%40market&serverName=plugin_demo_canvas&uri=not-a-uri')).status).toBe(400)
    expect((await app.request(`/api/plugins/ui/page?${new URLSearchParams({ pluginId: 'missing@market', serverName: 'plugin_demo_canvas', uri: 'ui://demo/canvas' })}`)).status).toBe(422)
    const uiCall = await app.request('/api/plugins/ui/call', json('POST', { pluginId: 'demo@market', serverName: 'plugin_demo_canvas', tool: 'echo', arguments: { text: 'hi' } }))
    expect(uiCall.status).toBe(200)
    expect(await uiCall.json()).toEqual({ result: { content: [{ type: 'text', text: 'call:echo' }] } })
    expect((await app.request('/api/plugins/ui/call', json('POST', { pluginId: 'demo@market', serverName: 'plugin_demo_canvas' }))).status).toBe(400)
    const resource = await app.request('/api/plugins/ui/read-resource', json('POST', { pluginId: 'demo@market', serverName: 'plugin_demo_canvas', uri: 'ui://demo/canvas' }))
    expect(resource.status).toBe(200)
    expect(await resource.json()).toEqual({ resource: { contents: [{ uri: 'ui://demo/canvas', text: 'resource' }] } })
    expect((await app.request('/api/plugins/demo@market', json('PATCH', { enabled: false }))).status).toBe(200)
    expect((await app.request('/api/plugins/demo@market', { method: 'DELETE' })).status).toBe(200)
    expect((await app.request('/api/plugins/not-an-id', json('PATCH', { enabled: false }))).status).toBe(400)
    expect((await app.request('/api/presets', json('POST', { name: 'Review', instructions: 'Review', tools: ['read'], extensions: ['coding'], accessMode: 'readOnly' }))).status).toBe(201)
    expect((await app.request('/api/presets/preset-1', { method: 'DELETE' })).status).toBe(200)
  })

  it('lists and switches local git branches for a workspace', async () => {
    const { app, runtime } = createTestApp()
    const list = await app.request('/api/workspaces/ws-1/git/branches')
    expect(list.status).toBe(200)
    expect(await list.json()).toMatchObject({ isRepository: true, currentBranchName: 'main' })

    const switched = await app.request('/api/workspaces/ws-1/git/switch', json('POST', { branchName: 'feature' }))
    expect(switched.status).toBe(200)
    expect(await switched.json()).toMatchObject({ ok: true, action: 'switch', branchName: 'feature', didChange: true })
    expect(runtime.calls).toContain('git-switch:ws-1:feature')

    const created = await app.request('/api/workspaces/ws-1/git/branches', json('POST', { branchName: 'pi/topic' }))
    expect(created.status).toBe(200)
    expect(await created.json()).toMatchObject({ ok: true, action: 'create-and-switch', created: true })
    expect(runtime.calls).toContain('git-create:ws-1:pi/topic')

    expect((await app.request('/api/workspaces/ws-1/git/switch', json('POST', { branchName: '   ' }))).status).toBe(400)
    expect((await app.request('/api/workspaces/ws-1/git/switch', json('POST', { branchName: 'main', force: true }))).status).toBe(400)
    const status = await app.request('/api/workspaces/ws-1/git/status')
    expect(status.status).toBe(200)
    expect(await status.json()).toMatchObject({ isRepository: true, branchName: 'main', added: 2, removed: 1 })
    expect(runtime.calls).toContain('git-status:ws-1')

    const diff = await app.request('/api/workspaces/ws-1/git/diff?path=a.ts')
    expect(diff.status).toBe(200)
    expect(await diff.json()).toMatchObject({ path: 'a.ts', diff: '- old\n+ new\n' })
    expect(runtime.calls).toContain('git-diff:ws-1:a.ts')
    expect((await app.request('/api/workspaces/ws-1/git/diff')).status).toBe(400)

    const commit = await app.request('/api/workspaces/ws-1/git/commit', json('POST', { message: 'Update a', includeUnstaged: true }))
    expect(commit.status).toBe(200)
    expect(await commit.json()).toMatchObject({ ok: true, commitHash: 'abc1234' })
    expect(runtime.calls).toContain('git-commit:ws-1:Update a:true')
    const drafted = await app.request('/api/workspaces/ws-1/git/commit-message', json('POST', { conversationId: 'conv-1', includeUnstaged: true }))
    expect(drafted.status).toBe(200)
    expect(await drafted.json()).toMatchObject({ message: 'Add the status panel', provider: 'demo', model: 'demo-model' })
    expect(runtime.calls).toContain('git-commit-message:ws-1:true:conv-1')
    expect((await app.request('/api/workspaces/ws-1/git/commit-message', json('POST', { includeUnstaged: 'yes' }))).status).toBe(400)
    expect((await app.request('/api/workspaces/ws-1/git/commit', json('POST', { message: '   ', includeUnstaged: true }))).status).toBe(400)

    const push = await app.request('/api/workspaces/ws-1/git/push', { method: 'POST' })
    expect(push.status).toBe(200)
    expect(await push.json()).toMatchObject({ ok: true })
    expect(runtime.calls).toContain('git-push:ws-1')
  })

  it('supports queue changes, persisted feedback, retry and automation actions', async () => {
    const { app, runtime } = createTestApp()
    expect((await app.request('/api/conversations/conv-1/queue/sub-1', json('PATCH', { text: 'Edit', requestId: 'edit-id', whenBusy: 'steer' }))).status).toBe(202)
    expect(runtime.calls).toContain('edit-queue:conv-1:sub-1:steer')
    expect((await app.request('/api/conversations/conv-1/feedback', json('POST', { entryId: 'entry-1', rating: 'up' }))).status).toBe(200)
    expect((await app.request('/api/conversations/conv-1/feedback', json('POST', { entryId: 'entry-1', rating: 'unknown' }))).status).toBe(400)
    expect((await app.request('/api/conversations/conv-1/retry', json('POST', { entryId: 'entry-1', requestId: 'retry-1' }))).status).toBe(202)
    expect((await app.request('/api/automations', json('POST', { name: 'Task', prompt: 'Check', enabled: false, intervalMs: 60000 }))).status).toBe(201)
    expect((await app.request('/api/automations/auto-1', json('PATCH', { intervalMs: null }))).status).toBe(200)
    expect((await app.request('/api/automations/auto-1/run-now', { method: 'POST' })).status).toBe(202)
    expect((await app.request('/api/automations/auto-1', { method: 'DELETE' })).status).toBe(200)
  })

  it('opens the application configuration file and reports a missing file as NOT_FOUND', async () => {
    const { app, runtime } = createTestApp()
    const opened = await app.request('/api/settings/open-config', { method: 'POST' })
    expect(opened.status).toBe(200)
    expect(await opened.json()).toEqual({ ok: true })
    expect(runtime.calls).toContain('open-config')

    vi.spyOn(runtime, 'openConfigFile').mockRejectedValueOnce(new RuntimeError('NOT_FOUND', '应用配置文件不存在'))
    const missing = await app.request('/api/settings/open-config', { method: 'POST' })
    expect(missing.status).toBe(404)
    expect(await missing.json()).toMatchObject({ code: 'NOT_FOUND', error: '应用配置文件不存在' })
  })

  it('stores operator feedback with the client user agent and rejects invalid bodies', async () => {
    const { app, runtime } = createTestApp()
    const stored = await app.request('/api/feedback', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'user-agent': 'PiWebTest/1.0' },
      body: JSON.stringify({ text: '  希望支持导出会话  ' }),
    })
    expect(stored.status).toBe(200)
    expect(await stored.json()).toEqual({ ok: true })
    expect(runtime.lastFeedback).toEqual({ text: '希望支持导出会话', userAgent: 'PiWebTest/1.0' })

    expect((await app.request('/api/feedback', json('POST', { text: 'anonymous' }))).status).toBe(200)
    expect(runtime.lastFeedback).toEqual({ text: 'anonymous' })

    for (const body of [{ text: '' }, { text: '   ' }, { text: 'x'.repeat(2_001) }, { text: 'ok', extra: true }, {}]) {
      expect((await app.request('/api/feedback', json('POST', body))).status).toBe(400)
    }
    expect((await app.request('/api/feedback', { method: 'POST', body: JSON.stringify({ text: 'ok' }) })).status).toBe(415)
  })

  it('accepts ordinary file attachments, preserves model metadata and protects active file resources', async () => {
    const { app, runtime } = createTestApp()
    const attachment = await app.request('/api/conversations/conv-1/messages', json('POST', { text: '', requestId: 'file-1', files: [{ name: 'note.txt', mimeType: 'text/plain', data: 'aGVsbG8=' }] }))
    expect(attachment.status).toBe(202)
    expect((await app.request('/api/conversations/conv-1/messages', json('POST', { text: '', requestId: 'file-2', files: [{ name: '../secret', mimeType: 'text/plain', data: 'aGVsbG8=' }] }))).status).toBe(400)
    const modelSave = await app.request('/api/providers', json('POST', { id: 'test', name: 'Test', baseUrl: 'https://example.test/v1', headers: { 'x-model': 'value' }, models: [{ id: 'model-1', name: 'Model', api: 'openai-completions', maxTokens: 8192, input: ['text', 'image'], compat: { supportsStore: false } }] }))
    expect(modelSave.status).toBe(200)
    expect(runtime.lastProvider?.models[0]?.maxTokens).toBe(8192)
    const provider = await app.request('/api/providers/test')
    expect((await provider.json()).provider.credentialConfigured).toBe(true)
    expect((await app.request('/api/providers/test/test', { method: 'POST' })).status).toBe(200)
    const html = await app.request('/api/workspaces/ws-1/asset?path=demo.html')
    expect(html.headers.get('content-security-policy')).toContain('sandbox')
    expect(html.headers.get('content-security-policy')).toContain("script-src 'none'")
    expect(html.headers.get('cache-control')).toBe('no-store')
    expect(html.headers.get('x-content-type-options')).toBe('nosniff')
    const binary = await app.request('/api/workspaces/ws-1/asset?path=output.bin')
    expect(binary.headers.get('content-disposition')).toContain('attachment')
  })

  it('opens workspace files addressed by absolute, backslash separated and relative paths', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pi-web-workspace-'))
    const outside = await mkdtemp(join(tmpdir(), 'pi-web-outside-'))
    await mkdir(join(root, 'docs'))
    await writeFile(join(root, 'x.txt'), 'hello\n', 'utf8')
    await writeFile(join(root, 'docs', 'a.md'), '# doc\n', 'utf8')
    await writeFile(join(outside, 'secret.txt'), 'secret\n', 'utf8')
    try {
      const { app } = createTestApp(new WorkspaceFilesRuntime(root))
      const fileUrl = (path: string) => `/api/workspaces/ws-1/file?path=${encodeURIComponent(path)}`

      const relative = await app.request(fileUrl('x.txt'))
      expect(relative.status).toBe(200)
      expect(await relative.json()).toMatchObject({ path: 'x.txt', kind: 'text', content: 'hello\n' })

      // Tool output carries the path of the machine it ran on, absolute or not.
      const absolute = await app.request(fileUrl(join(root, 'x.txt')))
      expect(absolute.status).toBe(200)
      expect(await absolute.json()).toMatchObject({ path: 'x.txt', content: 'hello\n' })

      const canonical = await app.request(fileUrl(join(await realpath(root), 'x.txt')))
      expect(canonical.status).toBe(200)
      expect(await canonical.json()).toMatchObject({ path: 'x.txt', content: 'hello\n' })

      const backslash = await app.request(fileUrl('docs\\a.md'))
      expect(backslash.status).toBe(200)
      expect(await backslash.json()).toMatchObject({ path: 'docs/a.md', content: '# doc\n' })

      const listing = await app.request(`/api/workspaces/ws-1/files?path=${encodeURIComponent(join(root, 'docs'))}`)
      expect(listing.status).toBe(200)
      expect((await listing.json()).entries).toEqual([{ name: 'a.md', path: 'docs/a.md', type: 'file', size: 6, modifiedAt: expect.any(Number), mimeType: 'text/markdown' }])

      const asset = await app.request(`/api/workspaces/ws-1/asset?path=${encodeURIComponent(join(root, 'x.txt'))}`)
      expect(asset.status).toBe(200)
      expect(await asset.text()).toBe('hello\n')

      // A path that leaves the workspace stays unreachable.
      const escaped = await app.request(fileUrl(join(outside, 'secret.txt')))
      expect(escaped.status).toBe(400)
      expect(await escaped.json()).toMatchObject({ code: 'INVALID_INPUT', error: '工作区路径无效' })

      const traversal = await app.request(fileUrl('../secret.txt'))
      expect(traversal.status).toBe(403)
      expect(await traversal.json()).toMatchObject({ code: 'FORBIDDEN', error: '不能访问工作区以外的路径' })

      // A drive letter names a location on Windows only, elsewhere it must not resolve to a file.
      const foreign = process.platform === 'win32' ? '\\\\server\\share\\secret.txt' : 'D:\\2026\\dolynk\\dolynk-base-device\\docs\\a.md'
      const foreignPath = await app.request(fileUrl(foreign))
      expect(foreignPath.status).toBe(400)
      expect(await foreignPath.json()).toMatchObject({ code: 'INVALID_INPUT', error: '工作区路径无效' })
    } finally {
      await rm(root, { recursive: true, force: true })
      await rm(outside, { recursive: true, force: true })
    }
  })

  it('answers a missing workspace file with 404 instead of a server failure', async () => {
    // 模型写的路径常常指向另一个项目，文件被删掉也是常事：这两种都不是服务器故障。
    const root = await mkdtemp(join(tmpdir(), 'pi-web-workspace-'))
    await writeFile(join(root, 'x.txt'), 'hello\n', 'utf8')
    try {
      const { app } = createTestApp(new WorkspaceFilesRuntime(root))
      const missing = await app.request('/api/workspaces/ws-1/file?path=missing.md')
      expect(missing.status).toBe(404)
      expect(await missing.json()).toMatchObject({ code: 'NOT_FOUND', error: '文件不存在或已被删除：missing.md' })

      const missingAsset = await app.request('/api/workspaces/ws-1/asset?path=missing.md')
      expect(missingAsset.status).toBe(404)

      const missingDirectory = await app.request('/api/workspaces/ws-1/files?path=nope')
      expect(missingDirectory.status).toBe(404)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('opens a file the answer named without its directory', async () => {
    // 模型在回答里常只写文件名，文件其实在子目录里：按路径后缀找回来。
    const root = await mkdtemp(join(tmpdir(), 'pi-web-workspace-'))
    await mkdir(join(root, 'docs', 'push'), { recursive: true })
    await writeFile(join(root, 'docs', 'webpush-protocol.html'), '<h1>protocol</h1>\n', 'utf8')
    await writeFile(join(root, 'docs', 'push', 'design.md'), '# design\n', 'utf8')
    await writeFile(join(root, 'ba.md'), 'wrong\n', 'utf8')
    try {
      const { app } = createTestApp(new WorkspaceFilesRuntime(root))
      const bare = await app.request('/api/workspaces/ws-1/file?path=webpush-protocol.html')
      expect(bare.status).toBe(200)
      expect(await bare.json()).toMatchObject({ path: 'docs/webpush-protocol.html', content: '<h1>protocol</h1>\n' })

      const suffix = await app.request('/api/workspaces/ws-1/file?path=push/design.md')
      expect(suffix.status).toBe(200)
      expect(await suffix.json()).toMatchObject({ path: 'docs/push/design.md', content: '# design\n' })

      // 名字相同但不是同一段路径，不能误配。
      const partial = await app.request('/api/workspaces/ws-1/file?path=a.md')
      expect(partial.status).toBe(404)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('lists the candidates when a bare name matches several files', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pi-web-workspace-'))
    await mkdir(join(root, 'apps'), { recursive: true })
    await mkdir(join(root, 'libs'), { recursive: true })
    await writeFile(join(root, 'apps', 'index.ts'), 'app\n', 'utf8')
    await writeFile(join(root, 'libs', 'index.ts'), 'lib\n', 'utf8')
    try {
      const { app } = createTestApp(new WorkspaceFilesRuntime(root))
      const ambiguous = await app.request('/api/workspaces/ws-1/file?path=index.ts')
      expect(ambiguous.status).toBe(404)
      const body = await ambiguous.json() as { error: string }
      expect(body.error).toContain('多个同名文件')
      expect(body.error).toContain('apps/index.ts')
      expect(body.error).toContain('libs/index.ts')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('lists a directory the answer pointed at', async () => {
    // 回答里的路径有时是目录：给出目录内容，让检查器直接列出它。
    const root = await mkdtemp(join(tmpdir(), 'pi-web-workspace-'))
    await mkdir(join(root, 'src', 'server'), { recursive: true })
    await writeFile(join(root, 'src', 'server', 'runtime.ts'), 'export {}\n', 'utf8')
    try {
      const { app } = createTestApp(new WorkspaceFilesRuntime(root))
      const directory = await app.request('/api/workspaces/ws-1/file?path=src/server')
      expect(directory.status).toBe(200)
      expect(await directory.json()).toMatchObject({
        path: 'src/server',
        kind: 'directory',
        entries: [{ name: 'runtime.ts', path: 'src/server/runtime.ts', type: 'file' }],
      })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('refuses a workspace path that leaves the workspace through a symlink', async () => {
    // Creating symlinks needs extra privileges on Windows, where the path rules reject the link anyway.
    if (process.platform === 'win32') return
    const root = await mkdtemp(join(tmpdir(), 'pi-web-workspace-'))
    const outside = await mkdtemp(join(tmpdir(), 'pi-web-outside-'))
    await writeFile(join(outside, 'secret.txt'), 'secret\n', 'utf8')
    try {
      await symlink(outside, join(root, 'link'), 'dir')
      const { app } = createTestApp(new WorkspaceFilesRuntime(root))
      const linked = await app.request(`/api/workspaces/ws-1/file?path=${encodeURIComponent(join(root, 'link', 'secret.txt'))}`)
      expect(linked.status).toBe(403)
      expect(await linked.json()).toMatchObject({ code: 'FORBIDDEN', error: '工作区文件路径不能经过符号链接' })
    } finally {
      await rm(root, { recursive: true, force: true })
      await rm(outside, { recursive: true, force: true })
    }
  })
})

describe('application state file', () => {
  const legacyWorkspace = { id: 'ws-legacy', name: 'Legacy', path: '/tmp/pi-web-legacy', createdAt: NOW, updatedAt: NOW }
  const legacyState = {
    version: 1,
    settings: {
      theme: 'light', locale: 'zh', fontSize: 14, codeFontSize: 11, terminalFontSize: 11,
      transcriptView: 'detailed', collapseTiming: 'completion', performanceUsage: 'detailed',
      codingViews: true, busySendMode: 'followUp', defaultThinkingLevel: 'medium', defaultAccessMode: 'fullAccess',
    },
    workspaces: [legacyWorkspace],
    plugins: {}, presets: [], automations: [], feedback: {},
  }

  it('reads a legacy state file whose feedback record predates the entries array', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pi-web-app-state-'))
    await writeFile(join(root, 'app-state.json'), JSON.stringify(legacyState))
    try {
      const store = await AppStateStore.open({ dataDir: root, defaultWorkspace: legacyWorkspace })
      expect(store.path).toBe(join(root, 'app-state.json'))
      expect(store.snapshot().feedback).toEqual([])
      await store.recordFeedback({ text: 'first', createdAt: NOW })
      expect(JSON.parse(await readFile(store.path, 'utf8')).feedback).toEqual([{ text: 'first', createdAt: NOW }])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('drops the oldest feedback entries past the cap and rewrites a missing configuration file', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pi-web-app-state-'))
    await writeFile(join(root, 'app-state.json'), JSON.stringify(legacyState))
    try {
      const store = await AppStateStore.open({ dataDir: root, defaultWorkspace: legacyWorkspace })
      for (let index = 0; index < 205; index += 1) await store.recordFeedback({ text: `entry-${index}`, createdAt: NOW + index })
      const stored = store.snapshot().feedback
      expect(stored).toHaveLength(200)
      expect(stored[0]?.text).toBe('entry-5')
      expect(stored.at(-1)?.text).toBe('entry-204')

      await rm(store.path)
      expect(await store.ensureFile()).toBe(true)
      expect(JSON.parse(await readFile(store.path, 'utf8')).feedback).toHaveLength(200)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

const JSON_BODY_LIMIT_FOR_TEST = 16 * 1024 * 1024 + 1
