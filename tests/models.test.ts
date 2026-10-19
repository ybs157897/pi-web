import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createRuntime } from '../src/server/runtime.ts'
import { isValidAllowlistEntry, modelWithinAllowlist, normalizeModelAllowlist } from '../src/server/model-allowlist.ts'

const fixtures: Array<{ root: string; closers: Array<() => Promise<void>> }> = []

/** Two synthetic providers so the assertions never depend on the shipped catalog's model ids. */
const WL_MODELS = {
  providers: {
    'wl-alpha': {
      name: 'Allowlist Alpha',
      baseUrl: 'https://alpha.example/v1',
      apiKey: 'test-key',
      models: [
        { id: 'deepseek-a', name: 'DeepSeek A' },
        { id: 'deepseek-b', name: 'DeepSeek B' },
        { id: 'glm-x', name: 'GLM X' },
      ],
    },
    'wl-beta': {
      name: 'Allowlist Beta',
      baseUrl: 'https://beta.example/v1',
      apiKey: 'test-key',
      models: [{ id: 'glm-x', name: 'GLM X' }],
    },
  },
}

async function fixture(options: { demo?: boolean; models?: unknown; piSettings?: unknown } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'pi-durable-web-models-'))
  const dataDir = join(root, 'data')
  const workspace = join(root, 'workspace')
  const piDir = join(root, 'pi')
  await Promise.all([mkdir(dataDir, { recursive: true }), mkdir(workspace, { recursive: true }), mkdir(piDir, { recursive: true })])
  await writeFile(join(piDir, 'settings.json'), JSON.stringify(options.piSettings ?? {}))
  if (options.models !== undefined) await writeFile(join(piDir, 'models.json'), JSON.stringify(options.models))
  const runtime = await createRuntime({ dataDir, workspace, piDir, demo: options.demo === true })
  const cleanup = { root, closers: [() => runtime.close()] }
  fixtures.push(cleanup)
  return { root, dataDir, workspace, piDir, runtime, cleanup }
}

afterEach(async () => {
  const pending = fixtures.splice(0)
  await Promise.all(pending.map(async ({ closers, root }) => {
    await Promise.all(closers.map(close => close()))
    await rm(root, { recursive: true, force: true })
  }))
})

const nameOf = (model: { provider: string; modelId: string }): string => `${model.provider}/${model.modelId}`

describe('model allowlist patterns', () => {
  it('matches exact entries and trailing-star prefixes, and filters nothing when empty', () => {
    const deepseek = { provider: 'opencode-go', modelId: 'deepseek-v4.1-flash' }
    expect(modelWithinAllowlist(undefined, deepseek)).toBe(true)
    expect(modelWithinAllowlist([], deepseek)).toBe(true)
    expect(modelWithinAllowlist(['opencode-go/deepseek-v4.1-flash'], deepseek)).toBe(true)
    expect(modelWithinAllowlist(['opencode-go/deepseek-v4.1'], deepseek)).toBe(false)
    expect(modelWithinAllowlist(['opencode-go/deepseek*'], deepseek)).toBe(true)
    expect(modelWithinAllowlist(['opencode-go/other*'], deepseek)).toBe(false)
    expect(modelWithinAllowlist(['other-go/deepseek*'], deepseek)).toBe(false)
    // The demo provider ignores the allowlist: the scripted instance stays usable.
    expect(modelWithinAllowlist(['opencode-go/deepseek*'], { provider: 'pi-web-demo', modelId: 'demo-model' })).toBe(true)
  })

  it('accepts only provider/model entries whose star may only close the entry', () => {
    expect(isValidAllowlistEntry('opencode-go/deepseek-v4.1-flash')).toBe(true)
    expect(isValidAllowlistEntry('opencode-go/deepseek*')).toBe(true)
    expect(isValidAllowlistEntry('openrouter/deepseek/deepseek-chat')).toBe(true)
    expect(isValidAllowlistEntry('')).toBe(false)
    expect(isValidAllowlistEntry('opencode-go')).toBe(false)
    expect(isValidAllowlistEntry('/deepseek')).toBe(false)
    expect(isValidAllowlistEntry('opencode-go/')).toBe(false)
    expect(isValidAllowlistEntry('opencode-go/deep*seek')).toBe(false)
    expect(isValidAllowlistEntry('opencode-go/deep seek')).toBe(false)
  })

  it('normalizes entries by trimming, dropping blanks and de-duplicating', () => {
    expect(normalizeModelAllowlist([' opencode-go/deepseek* ', '', 'opencode-go/deepseek*', 'wl-alpha/deepseek-a']))
      .toEqual(['opencode-go/deepseek*', 'wl-alpha/deepseek-a'])
  })
})

describe('model directory edits', () => {
  it('persists a deleted model in the project override across a restart and restores it from the shipped catalog', async () => {
    const { runtime, dataDir, workspace, piDir, cleanup } = await fixture()
    const shipped = await runtime.provider('opencode-go')
    expect(shipped.source).toBe('builtin')
    expect(shipped.models.length).toBeGreaterThan(1)
    const removed = shipped.models[0]!
    const kept = shipped.models.slice(1)

    await runtime.saveProvider({
      id: shipped.id, name: shipped.name, baseUrl: shipped.baseUrl, api: shipped.api, models: kept,
    })
    const afterSave = await runtime.catalog()
    expect(afterSave.models.some(model => model.provider === shipped.id && model.modelId === removed.id)).toBe(false)
    expect(afterSave.models.some(model => model.provider === shipped.id && model.modelId === kept[0]!.id)).toBe(true)

    // A fresh runtime reads providers.json, and the deleted model stays gone.
    await runtime.close()
    const reopened = await createRuntime({ dataDir, workspace, piDir })
    cleanup.closers.push(() => reopened.close())
    const afterRestart = await reopened.catalog()
    expect(afterRestart.models.some(model => model.provider === shipped.id && model.modelId === removed.id)).toBe(false)

    // Restoring the shipped directory writes every default model back.
    const customized = await reopened.provider(shipped.id)
    expect(customized.source).toBe('project')
    expect(customized.defaults?.some(model => model.id === removed.id)).toBe(true)
    await reopened.saveProvider({
      id: customized.id, name: customized.name, baseUrl: customized.baseUrl, api: customized.api, models: customized.defaults!,
    })
    const restored = await reopened.catalog()
    expect(restored.models.some(model => model.provider === shipped.id && model.modelId === removed.id)).toBe(true)
  })

  it('keeps allowlist-hidden models when the visible directory is saved', async () => {
    const { runtime } = await fixture()
    await runtime.updateSettings({ modelAllowlist: ['opencode-go/deepseek*'] })
    const visible = await runtime.provider('opencode-go')
    const visibleModels = visible.models.map(model => model.id)
    expect(visibleModels.length).toBeGreaterThan(1)
    const removed = visibleModels[0]!
    const kept = visible.models.filter(model => model.id !== removed)

    await runtime.saveProvider({ id: visible.id, name: visible.name, baseUrl: visible.baseUrl, api: visible.api, models: kept })

    // Clearing the allowlist reveals the models the editor could not show;
    // only the row the operator actually removed is gone.
    await runtime.updateSettings({ modelAllowlist: [] })
    const catalog = await runtime.catalog()
    const ids = catalog.models.filter(model => model.provider === visible.id).map(model => model.modelId)
    expect(ids).toContain(kept[0]!.id)
    expect(ids).not.toContain(removed)
    expect(ids).toContain('glm-5.2')
  })
})

describe('model allowlist in the runtime', () => {
  it('filters the catalog and corrects a default that fell outside the allowlist', async () => {
    const { runtime, dataDir } = await fixture({
      models: WL_MODELS,
      piSettings: { defaultProvider: 'wl-beta', defaultModel: 'glm-x' },
    })
    const unfiltered = await runtime.catalog()
    expect(unfiltered.models.some(model => nameOf(model) === 'wl-beta/glm-x')).toBe(true)
    expect(nameOf(unfiltered.defaultModel ?? { provider: '', modelId: '' })).toBe('wl-beta/glm-x')

    await runtime.updateSettings({ modelAllowlist: ['wl-alpha/deepseek*'] })
    const filtered = await runtime.catalog()
    expect(filtered.models.map(nameOf).sort()).toEqual(['wl-alpha/deepseek-a', 'wl-alpha/deepseek-b'])
    expect(filtered.providers.map(provider => provider.id)).toContain('wl-alpha')
    expect(filtered.providers.map(provider => provider.id)).not.toContain('wl-beta')
    // The out-of-scope default resolves to the first available allowed model and is persisted.
    expect(nameOf(filtered.defaultModel ?? { provider: '', modelId: '' })).toBe('wl-alpha/deepseek-a')
    expect(runtime.settings().defaultModel).toEqual({ provider: 'wl-alpha', modelId: 'deepseek-a' })
    const persisted = JSON.parse(await readFile(join(dataDir, 'app-state.json'), 'utf8')) as { settings: { defaultModel?: unknown } }
    expect(persisted.settings.defaultModel).toEqual({ provider: 'wl-alpha', modelId: 'deepseek-a' })
  })

  it('refuses out-of-scope models at every selection point', async () => {
    // The Pi-configured default sits outside the allowlist, so the derived
    // model in buildAgentChange has to fall back instead of failing the create.
    const { runtime } = await fixture({ models: WL_MODELS, piSettings: { defaultProvider: 'wl-beta', defaultModel: 'glm-x' } })
    await runtime.updateSettings({ modelAllowlist: ['wl-alpha/deepseek*'] })

    await expect(runtime.create({ model: { provider: 'wl-beta', modelId: 'glm-x' } }))
      .rejects.toMatchObject({ code: 'MODEL_UNAVAILABLE', message: expect.stringContaining('所选模型不在模型白名单内') })
    await expect(runtime.createPreset({
      name: 'Scoped', instructions: 'instructions', extensions: [], tools: [],
      model: { provider: 'wl-beta', modelId: 'glm-x' }, accessMode: 'fullAccess',
    })).rejects.toMatchObject({ code: 'MODEL_UNAVAILABLE', message: expect.stringContaining('Preset 模型不在模型白名单内') })
    await expect(runtime.createAutomation({
      name: 'Scoped', prompt: 'prompt', model: { provider: 'wl-beta', modelId: 'glm-x' },
    })).rejects.toMatchObject({ code: 'MODEL_UNAVAILABLE', message: expect.stringContaining('Automation 模型不在模型白名单内') })
    await expect(runtime.updateSettings({ defaultModel: { provider: 'wl-beta', modelId: 'glm-x' } }))
      .rejects.toMatchObject({ code: 'MODEL_UNAVAILABLE', message: expect.stringContaining('默认模型不在模型白名单内') })

    // Creating without an explicit model resolves the corrected default.
    const created = await runtime.create({ title: 'Allowed' })
    expect(nameOf(created.conversation.model ?? { provider: '', modelId: '' })).toBe('wl-alpha/deepseek-a')
    await expect(runtime.update(created.conversation.id, { model: { provider: 'wl-beta', modelId: 'glm-x' } }))
      .rejects.toMatchObject({ code: 'MODEL_UNAVAILABLE', message: expect.stringContaining('所选模型不在模型白名单内') })
  })

  it('blocks runs and reconfiguration on a conversation bound to an outside model', async () => {
    const { runtime } = await fixture({ models: WL_MODELS })
    const created = await runtime.create({ title: 'Legacy', model: { provider: 'wl-beta', modelId: 'glm-x' } })
    const id = created.conversation.id
    await runtime.updateSettings({ modelAllowlist: ['wl-alpha/deepseek*'] })

    await expect(runtime.submit(id, { text: 'run', requestId: 'outside-run' }))
      .rejects.toMatchObject({ code: 'MODEL_UNAVAILABLE', message: expect.stringContaining('会话模型不在模型白名单内') })
    await expect(runtime.compact(id)).rejects.toMatchObject({ code: 'MODEL_UNAVAILABLE', message: expect.stringContaining('会话模型不在模型白名单内') })
    await expect(runtime.update(id, { title: 'Rename' })).resolves.toMatchObject({ conversation: { title: 'Rename' } })

    // Switching to an allowed model recovers the conversation.
    const switched = await runtime.update(id, { model: { provider: 'wl-alpha', modelId: 'deepseek-a' } })
    expect(nameOf(switched.conversation.model ?? { provider: '', modelId: '' })).toBe('wl-alpha/deepseek-a')
  })

  it('filters provider configuration and refuses out-of-scope connection probes', async () => {
    const { runtime } = await fixture({ models: WL_MODELS })
    await runtime.updateSettings({ modelAllowlist: ['wl-alpha/deepseek*'] })
    const config = await runtime.provider('wl-alpha')
    expect(config.models.map(model => model.id).sort()).toEqual(['deepseek-a', 'deepseek-b'])
    await expect(runtime.provider('wl-beta')).resolves.toMatchObject({ models: [] })
    await expect(runtime.testProvider('wl-alpha', 'glm-x'))
      .rejects.toMatchObject({ code: 'MODEL_UNAVAILABLE', message: expect.stringContaining('所选模型不在模型白名单内') })
    await expect(runtime.testProvider('wl-beta')).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('validates and stores the allowlist through the settings route logic', async () => {
    const { runtime } = await fixture({ models: WL_MODELS })
    await expect(runtime.updateSettings({ modelAllowlist: ['wl-alpha'] }))
      .rejects.toMatchObject({ code: 'INVALID_INPUT', message: expect.stringContaining('模型白名单条目无效') })
    await expect(runtime.updateSettings({ modelAllowlist: ['wl-alpha/deep*x'] }))
      .rejects.toMatchObject({ code: 'INVALID_INPUT' })
    await runtime.updateSettings({ modelAllowlist: [' wl-alpha/deepseek* ', 'wl-alpha/deepseek*', ''] })
    expect(runtime.settings().modelAllowlist).toEqual(['wl-alpha/deepseek*'])
    await runtime.updateSettings({ modelAllowlist: [] })
    expect((await runtime.catalog()).models.some(model => nameOf(model) === 'wl-beta/glm-x')).toBe(true)
  })

  it('keeps the scripted demo model selectable whatever the allowlist says', async () => {
    const { runtime } = await fixture({ demo: true })
    await runtime.updateSettings({ modelAllowlist: ['opencode-go/deepseek-v4.1-flash'] })
    const catalog = await runtime.catalog()
    expect(catalog.models.map(nameOf)).toEqual(['pi-web-demo/demo-model'])
    expect(catalog.providers.map(provider => provider.id)).toEqual(['pi-web-demo'])
    expect(nameOf(catalog.defaultModel ?? { provider: '', modelId: '' })).toBe('pi-web-demo/demo-model')
    const created = await runtime.create({ title: 'Demo' })
    expect(nameOf(created.conversation.model ?? { provider: '', modelId: '' })).toBe('pi-web-demo/demo-model')
  })
})
