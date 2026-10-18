import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ConversationDetail, ConversationSummary, CreateConversationInput, ModelCatalog, ProviderInput, SubmitInput, UpdateConversationInput } from '../src/shared/types.ts'
import type { Runtime } from '../src/server/contracts.ts'
import type * as Protocol from '../src/shared/types.ts'
import { createApp } from '../src/server/app.ts'
import { RuntimeError } from '../src/server/runtime-errors.ts'

const NOW = 1_800_000_000_000

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
  readonly calls: string[] = []
  cleanupCount = 0
  closeCount = 0
  lastProvider: ProviderInput | undefined

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

  async stop(id: string): Promise<void> {
    this.calls.push(`stop:${id}`)
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

  async saveProvider(input: ProviderInput): Promise<void> {
    this.calls.push('saveProvider')
    this.lastProvider = input
  }

  settingsValue: Protocol.AppSettings = {
    theme: 'system', locale: 'zh', fontSize: 14, codeFontSize: 11, terminalFontSize: 13,
    processDisplay: 'detailed', collapseProcess: 'afterResponse', codingViews: true, busySendMode: 'followUp',
    defaultThinkingLevel: 'off', defaultAccessMode: 'workspaceWrite',
  }
  settings() { return this.settingsValue }
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
  async renameWorkspace(id: string, input: Protocol.RenameWorkspaceInput) { this.calls.push('workspace:' + id); return { ...this.workspaces()[0]!, name: input.name } }
  async workspaceFiles(_id: string, path: string): Promise<Protocol.WorkspaceFileEntry[]> { return [{ name: 'test.txt', path: path ? path + '/test.txt' : 'test.txt', type: 'file', size: 4 }] }
  async searchWorkspace(id: string, query: string) { this.calls.push('search:' + query); return this.workspaceFiles(id, '') }
  async workspaceFile(_id: string, path: string): Promise<Protocol.WorkspaceFile> { return { path, kind: 'text', content: 'text', size: 4, modifiedAt: NOW, mimeType: 'text/plain' } }
  async workspaceAsset(_id: string, path: string) { return { mimeType: path.endsWith('.html') ? 'text/html' : 'application/octet-stream', data: new TextEncoder().encode('<script>unsafe()</script>') } }
  plugins(): Protocol.PluginSummary[] { return [{ id: 'coding', name: 'Coding tools', builtin: true, enabled: true, tools: [{ name: 'read', enabled: true }] }] }
  async updatePlugin(id: string, input: Protocol.UpdatePluginInput) { this.calls.push('plugin:' + id + ':' + JSON.stringify(input)); return { ...this.plugins()[0]!, ...input, tools: this.plugins()[0]!.tools } }
  presets(): Protocol.AgentPreset[] { return [{ id: 'preset-1', name: 'Preset', instructions: '', extensions: ['coding'], tools: ['read'], accessMode: 'readOnly' }] }
  async createPreset(input: Protocol.CreateAgentPresetInput) { return { ...input, id: input.id ?? 'preset-new' } }
  async updatePreset(id: string, input: Protocol.UpdateAgentPresetInput) { return { ...this.presets()[0]!, ...input, id } }
  async deletePreset(id: string) { this.calls.push('delete-preset:' + id) }
  async provider(id: string): Promise<Protocol.ProviderConfigSummary> { return { id, name: 'Test', source: 'project', configured: true, custom: true, credentialConfigured: true, api: 'openai-completions', models: [{ id: 'model-1', name: 'Model' }], baseUrl: 'https://example.test/v1' } }
  async deleteProvider(id: string) { this.calls.push('delete-provider:' + id) }
  async testProvider(id: string, modelId = 'model-1'): Promise<Protocol.ProviderTestResult> { return { providerId: id, modelId, status: 'connected', checkedAt: NOW } }
  async editQueued(id: string, submissionId: string, input: Protocol.EditQueueInput) { this.calls.push(`edit-queue:${id}:${submissionId}:${input.whenBusy}`); return { submissionId: 'new-submission' } }
  async feedback(id: string, entryId: string, rating: 'up' | 'down' | null) { this.calls.push(`feedback:${id}:${entryId}:${rating}`) }
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
    expect(await health.json()).toEqual({ ok: true, demo: true })

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

  it('updates settings, workspace bindings, plugin selection and presets through typed routes', async () => {
    const { app, runtime } = createTestApp()
    expect((await (await app.request('/api/capabilities')).json()).accessModes).toContain('workspaceWrite')
    const settings = await app.request('/api/settings', json('PATCH', { locale: 'en', fontSize: 16, defaultModel: null, shortcuts: { search: 'Mod+p' } }))
    expect(settings.status).toBe(200)
    expect((await settings.json()).locale).toBe('en')
    expect((await app.request('/api/settings', json('PATCH', { fontSize: 100 }))).status).toBe(400)
    expect((await app.request('/api/settings', json('PATCH', { shortcuts: { arbitraryAction: 'x' } }))).status).toBe(400)
    const workspace = await app.request('/api/workspaces', json('POST', { path: '/tmp/pi-web-test', name: 'Project' }))
    expect(workspace.status).toBe(201)
    expect((await workspace.json()).workspace.name).toBe('Project')
    expect((await (await app.request('/api/workspaces/ws-1/files?path=src')).json()).entries[0].path).toBe('src/test.txt')
    expect((await (await app.request('/api/workspaces/ws-1/search?q=test')).json()).entries).toHaveLength(1)
    expect((await app.request('/api/plugins/coding', json('PATCH', { tools: { read: false } }))).status).toBe(200)
    expect(runtime.calls.some(call => call.startsWith('plugin:coding:'))).toBe(true)
    expect((await app.request('/api/presets', json('POST', { name: 'Review', instructions: 'Review', tools: ['read'], extensions: ['coding'], accessMode: 'readOnly' }))).status).toBe(201)
    expect((await app.request('/api/presets/preset-1', { method: 'DELETE' })).status).toBe(200)
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
})

const JSON_BODY_LIMIT_FOR_TEST = 16 * 1024 * 1024 + 1
