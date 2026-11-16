/**
 * 模型目录与白名单测试：allowlist 纯函数、provider 编辑持久化、端点继承往返、
 * 推理等级映射、默认模型解析与白名单在运行时的全链路过滤。
 *
 * 关键契约：
 * - allowlist 匹配：精确条目 / 尾星号前缀匹配；条目校验只允许星号收尾；归一化去空白去重；
 *   demo 提供方不受白名单约束；
 * - 目录编辑：删除模型写入项目覆盖并跨重启保留；saveProvider 不冻结继承端点（模型级
 *   baseUrl/api 只在显式覆盖时出现）；白名单隐藏的模型不会被编辑器误删；
 * - 推理等级：声明 thinkingLevelMap 即视为推理模型（未声明档位钉死不可选）、保存时补全
 *   缺失档位为 null、会话已存等级超出新地图时向上钳制、遗留 false+map 数据自动升级、
 *   外部改写 models.json 能触发 watchModels 通知；
 * - 默认模型：配置的默认缺失时回退到可选目录模型；显式请求不存在的模型仍拒绝；
 * - 白名单运行时：过滤目录/供应商配置、越界默认自动校正并持久化、create/automation/
 *   settings/submit/compact/provider/test 各入口全部拒绝越界模型、换到允许模型即恢复；
 * - openai 内置路由保存凭据后 configured=true 且保留 envVars 身份。
 */
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createRuntime } from '../src/server/runtime/index.ts'
import { createApp } from '../src/server/app.ts'
import { isValidAllowlistEntry, modelWithinAllowlist, normalizeModelAllowlist } from '../src/server/model/allowlist.ts'

/** 本文件创建的 runtime fixture 列表，afterEach 统一关闭并删除。 */
const fixtures: Array<{ root: string; closers: Array<() => Promise<void>> }> = []

/** 两个合成 provider，断言不依赖发行目录里的真实模型 id。 */
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

/**
 * 创建 runtime fixture：临时 data/workspace/pi 目录，可选写入 models.json 与 pi 设置。
 * @param options demo 模式、models.json 内容、settings.json 内容
 * @returns 目录路径、runtime 与 cleanup 句柄
 */
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

/** 清理：关闭所有 runtime 并删除临时目录。 */
afterEach(async () => {
  const pending = fixtures.splice(0)
  await Promise.all(pending.map(async ({ closers, root }) => {
    await Promise.all(closers.map(close => close()))
    await rm(root, { recursive: true, force: true })
  }))
})

/** 模型引用的 "provider/modelId" 标识形式。 */
const nameOf = (model: { provider: string; modelId: string }): string => `${model.provider}/${model.modelId}`

/** allowlist 纯函数（匹配/校验/归一化）测试。 */
describe('model allowlist patterns', () => {
  // 验证匹配规则：空/未配置放行一切；精确条目匹配；前缀相同但少一截不匹配（必须尾星号）；
  // 星号只在尾部生效；provider 不同不匹配；demo 提供方无视白名单。
  it('matches exact entries and trailing-star prefixes, and filters nothing when empty', () => {
    const deepseek = { provider: 'opencode-go', modelId: 'deepseek-v4.1-flash' }
    expect(modelWithinAllowlist(undefined, deepseek)).toBe(true)
    expect(modelWithinAllowlist([], deepseek)).toBe(true)
    expect(modelWithinAllowlist(['opencode-go/deepseek-v4.1-flash'], deepseek)).toBe(true)
    expect(modelWithinAllowlist(['opencode-go/deepseek-v4.1'], deepseek)).toBe(false)
    expect(modelWithinAllowlist(['opencode-go/deepseek*'], deepseek)).toBe(true)
    expect(modelWithinAllowlist(['opencode-go/other*'], deepseek)).toBe(false)
    expect(modelWithinAllowlist(['other-go/deepseek*'], deepseek)).toBe(false)
    // demo 提供方无视白名单：脚本化实例保持可用。
    expect(modelWithinAllowlist(['opencode-go/deepseek*'], { provider: 'pi-web-demo', modelId: 'demo-model' })).toBe(true)
  })

  // 验证条目校验：provider/model 形态（可含多级斜杠）、星号只允许收尾；
  // 空串、缺 model、缺 provider、星号在中间、含空格全部拒绝。
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

  // 验证归一化：去首尾空白、丢弃空串、去重。
  it('normalizes entries by trimming, dropping blanks and de-duplicating', () => {
    expect(normalizeModelAllowlist([' opencode-go/deepseek* ', '', 'opencode-go/deepseek*', 'wl-alpha/deepseek-a']))
      .toEqual(['opencode-go/deepseek*', 'wl-alpha/deepseek-a'])
  })
})

/** 模型目录编辑与持久化测试。 */
describe('model directory edits', () => {
  // 验证删除持久化：删除发行目录模型写入项目覆盖（source=project）→ 重启后仍被删；
  // defaults 里保留发行版本，恢复时把全部默认模型写回。
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

    // 新 runtime 读全局 models.json，被删模型保持消失。
    await runtime.close()
    const reopened = await createRuntime({ dataDir, workspace, piDir })
    cleanup.closers.push(() => reopened.close())
    const afterRestart = await reopened.catalog()
    expect(afterRestart.models.some(model => model.provider === shipped.id && model.modelId === removed.id)).toBe(false)

    // 恢复发行目录会把每个默认模型写回。
    const customized = await reopened.provider(shipped.id)
    expect(customized.source).toBe('project')
    expect(customized.defaults?.some(model => model.id === removed.id)).toBe(true)
    await reopened.saveProvider({
      id: customized.id, name: customized.name, baseUrl: customized.baseUrl, api: customized.api, models: customized.defaults!,
    })
    const restored = await reopened.catalog()
    expect(restored.models.some(model => model.provider === shipped.id && model.modelId === removed.id)).toBe(true)
  })

  // 验证白名单隐藏模型的保护：编辑器只看得见白名单内模型，保存可见目录后清空白名单，
  // 被隐藏的模型仍在目录中（只有操作者真正删除的那一行消失）。
  it('keeps allowlist-hidden models when the visible directory is saved', async () => {
    const { runtime } = await fixture()
    await runtime.updateSettings({ modelAllowlist: ['opencode-go/deepseek*'] })
    const visible = await runtime.provider('opencode-go')
    const visibleModels = visible.models.map(model => model.id)
    expect(visibleModels.length).toBeGreaterThan(1)
    const removed = visibleModels[0]!
    const kept = visible.models.filter(model => model.id !== removed)

    await runtime.saveProvider({ id: visible.id, name: visible.name, baseUrl: visible.baseUrl, api: visible.api, models: kept })

    // 清空白名单后，编辑器看不见的模型重新可见；只有操作者实际删除的那行消失。
    await runtime.updateSettings({ modelAllowlist: [] })
    const catalog = await runtime.catalog()
    const ids = catalog.models.filter(model => model.provider === visible.id).map(model => model.modelId)
    expect(ids).toContain(kept[0]!.id)
    expect(ids).not.toContain(removed)
    expect(ids).toContain('glm-5.2')
  })
})

/** provider 请求端点继承（模型级覆盖不冻结）测试。 */
describe('provider model request inheritance', () => {
  // 验证端点继承往返：未显式覆盖的模型不携带 api/baseUrl 字段（HTTP 响应、保存响应、
  // 磁盘 models.json、重开后读取四处一致）；显式覆盖保留原值；
  // 连通性探测按继承端点与显式端点分别打到正确的 mock 路径。
  it('round-trips inherited endpoints through HTTP without freezing them, while preserving explicit model overrides', async () => {
    const paths: string[] = []
    const mock = createServer((request, response) => {
      paths.push(request.url ?? '')
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      const event = (choice: Record<string, unknown>) => `data: ${JSON.stringify({
        id: 'chat_test', object: 'chat.completion.chunk', created: 1, model: 'inherit-model', choices: [choice],
      })}\n\n`
      response.end([
        event({ index: 0, delta: { role: 'assistant' }, finish_reason: null }),
        event({ index: 0, delta: { content: 'OK' }, finish_reason: null }),
        event({ index: 0, delta: {}, finish_reason: 'stop' }),
        'data: [DONE]\n\n',
      ].join(''))
    })
    await new Promise<void>((resolve, reject) => {
      mock.once('error', reject)
      mock.listen(0, '127.0.0.1', resolve)
    })
    const address = mock.address()
    if (!address || typeof address === 'string') throw new Error('Mock server did not bind a TCP port')
    const origin = `http://127.0.0.1:${address.port}`
    const initialBaseUrl = `${origin}/v1`
    const explicitBaseUrl = `${origin}/explicit/v1`
    const { runtime, dataDir, workspace, piDir, cleanup } = await fixture({ models: {
      providers: {
        'route-probe': {
          name: 'Route probe', baseUrl: initialBaseUrl, api: 'openai-responses',
          models: [
            { id: 'inherit-model', name: 'Inherited model' },
            { id: 'explicit-model', name: 'Explicit model', baseUrl: explicitBaseUrl, api: 'openai-completions' },
          ],
        },
      },
    } })
    let app = createApp(runtime)
    try {
      const initialResponse = await app.request('/api/providers/route-probe')
      expect(initialResponse.status).toBe(200)
      const initial = (await initialResponse.json() as { provider: { api: string; baseUrl: string; models: Array<Record<string, unknown>> } }).provider
      expect(initial.api).toBe('openai-responses')
      expect(initial.baseUrl).toBe(initialBaseUrl)
      expect(initial.models[0]).not.toHaveProperty('api')
      expect(initial.models[0]).not.toHaveProperty('baseUrl')
      expect(initial.models[1]).toMatchObject({ api: 'openai-completions', baseUrl: explicitBaseUrl })

      const nextBaseUrl = `${origin}/review-v2/v1`
      const save = await app.request('/api/providers', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          id: 'route-probe', name: 'Route probe', baseUrl: nextBaseUrl, api: 'openai-completions', apiKey: 'test-key',
          // 这是编辑器配置的往返提交：只携带实际的模型级覆盖。
          models: initial.models,
        }),
      })
      expect(save.status).toBe(200)

      const savedResponse = await app.request('/api/providers/route-probe')
      const saved = (await savedResponse.json() as { provider: { api: string; baseUrl: string; models: Array<Record<string, unknown>> } }).provider
      expect(saved.api).toBe('openai-completions')
      expect(saved.baseUrl).toBe(nextBaseUrl)
      expect(saved.models[0]).not.toHaveProperty('api')
      expect(saved.models[0]).not.toHaveProperty('baseUrl')
      expect(saved.models[1]).toMatchObject({ api: 'openai-completions', baseUrl: explicitBaseUrl })

      const file = JSON.parse(await readFile(join(piDir, 'models.json'), 'utf8')) as {
        providers: Record<string, { api: string; baseUrl: string; models: Array<Record<string, unknown>> }>
      }
      expect(file.providers['route-probe']?.models[0]).not.toHaveProperty('api')
      expect(file.providers['route-probe']?.models[0]).not.toHaveProperty('baseUrl')
      expect(file.providers['route-probe']?.models[1]).toMatchObject({ api: 'openai-completions', baseUrl: explicitBaseUrl })

      // 从持久化文件重开，探测证明磁盘上的模型条目仍继承 provider 端点与协议。
      await app.shutdown()
      await cleanup.closers.shift()?.()
      const reopenedRuntime = await createRuntime({ dataDir, workspace, piDir })
      cleanup.closers.push(() => reopenedRuntime.close())
      app = createApp(reopenedRuntime)
      const reloadedResponse = await app.request('/api/providers/route-probe')
      const reloaded = (await reloadedResponse.json() as { provider: { api: string; baseUrl: string; models: Array<Record<string, unknown>> } }).provider
      expect(reloaded.api).toBe('openai-completions')
      expect(reloaded.baseUrl).toBe(nextBaseUrl)
      expect(reloaded.models[0]).not.toHaveProperty('api')
      expect(reloaded.models[0]).not.toHaveProperty('baseUrl')
      expect(reloaded.models[1]).toMatchObject({ api: 'openai-completions', baseUrl: explicitBaseUrl })

      const inheritedProbe = await app.request('/api/providers/route-probe/test', { method: 'POST' })
      const inheritedResult = await inheritedProbe.json()
      expect(inheritedResult.status, JSON.stringify(inheritedResult)).toBe('connected')
      expect(paths).toContain('/review-v2/v1/chat/completions')
      const explicitProbe = await app.request('/api/providers/route-probe/test?modelId=explicit-model', { method: 'POST' })
      const explicitResult = await explicitProbe.json()
      expect(explicitResult.status, JSON.stringify(explicitResult)).toBe('connected')
      expect(paths).toContain('/explicit/v1/chat/completions')
    } finally {
      await app.shutdown()
      await new Promise<void>((resolve, reject) => mock.close(error => error ? reject(error) : resolve()))
    }
  })
})

/** provider 推理等级映射测试。 */
describe('provider reasoning levels', () => {
  // 验证等级映射生命周期：声明 thinkingLevelMap 即视为推理模型（picker 含 off + 已声明档位）；
  // 保存时补全缺失档位为 null（钉死不可选）；删除某行即从 picker 移除；
  // 关闭开关时 map 与 reasoning 标志一起消失。
  it('turns declared levels into a reasoning model with undeclared levels pinned off the picker', async () => {
    const { runtime } = await fixture()
    await runtime.saveProvider({
      id: 'probe', name: 'Probe', baseUrl: 'https://example.invalid/v1', api: 'openai-completions', apiKey: 'test-key',
      models: [{
        id: 'probe-a', name: 'Probe A', reasoning: false, input: ['text'],
        thinkingLevelMap: { low: 'low', medium: 'medium', high: 'high' },
      }],
    })
    const catalog = await runtime.catalog()
    const model = catalog.models.find(candidate => candidate.provider === 'probe' && candidate.modelId === 'probe-a')
    expect(model?.reasoning).toBe(true)
    expect(model?.thinkingLevels).toEqual(['off', 'low', 'medium', 'high'])

    const config = await runtime.provider('probe')
    const saved = config.models[0]!
    expect(saved.reasoning).toBe(true)
    expect(saved.thinkingLevelMap).toEqual({
      minimal: null, low: 'low', medium: 'medium', high: 'high', xhigh: null, max: null,
    })

    // 删除某行即从 picker 移除；缺席的基础档位保持钉死。
    await runtime.saveProvider({
      id: 'probe', name: 'Probe', baseUrl: 'https://example.invalid/v1', api: 'openai-completions',
      models: [{ id: 'probe-a', name: 'Probe A', reasoning: true, input: ['text'], thinkingLevelMap: { low: 'low', high: 'high' } }],
    })
    const narrowed = await runtime.catalog()
    expect(narrowed.models.find(candidate => candidate.modelId === 'probe-a')?.thinkingLevels).toEqual(['off', 'low', 'high'])

    // 关闭开关时 map 与 reasoning 标志一起消失。
    await runtime.saveProvider({
      id: 'probe', name: 'Probe', baseUrl: 'https://example.invalid/v1', api: 'openai-completions',
      models: [{ id: 'probe-a', name: 'Probe A', reasoning: false, input: ['text'] }],
    })
    const off = await runtime.catalog()
    const plain = off.models.find(candidate => candidate.modelId === 'probe-a')
    expect(plain?.reasoning).toBe(false)
    expect(plain?.thinkingLevels).toBeUndefined()
    expect((await runtime.provider('probe')).models[0]?.thinkingLevelMap).toBeUndefined()
  })

  // 验证等级钳制：地图收窄使已存的 medium 失去支持时，投影显示下一次请求实际会发送的档位
  // （pi-ai 先尝试向上钳制 → high）；新建会话按同样规则解析。
  it('clamps a stored level when the model map stops offering it', async () => {
    const { runtime } = await fixture()
    const save = (levels: Record<string, string>) => runtime.saveProvider({
      id: 'probe', name: 'Probe', baseUrl: 'https://example.invalid/v1', api: 'openai-completions', apiKey: 'test-key',
      models: [{ id: 'probe-a', name: 'Probe A', reasoning: true, input: ['text'], thinkingLevelMap: levels }],
    })
    await save({ low: 'low', medium: 'medium', high: 'high' })
    const created = await runtime.create({ model: { provider: 'probe', modelId: 'probe-a' }, thinkingLevel: 'medium' })
    expect(created.conversation.thinkingLevel).toBe('medium')

    // 地图收窄使 Medium 不受支持；投影显示下一次请求实际发送的档位（pi-ai 先向上钳制）。
    await save({ low: 'low', high: 'high' })
    expect((await runtime.detail(created.conversation.id)).conversation.thinkingLevel).toBe('high')

    const configured = await runtime.create({ model: { provider: 'probe', modelId: 'probe-a' }, thinkingLevel: 'medium' })
    expect(configured.conversation.thinkingLevel).toBe('high')
  })

  // 验证遗留数据升级：models.json 里 reasoning=false 但带 thinkingLevelMap 的旧数据
  // 加载时视为推理模型（off 档被 null 钉死所以不出现在 picker）。
  it('upgrades an existing saved map whose reasoning flag was left false', async () => {
    const { runtime, piDir } = await fixture()
    await writeFile(join(piDir, 'models.json'), JSON.stringify({
      providers: {
        legacy: {
          name: 'Legacy', baseUrl: 'https://example.invalid/v1', api: 'openai-completions',
          models: [{
            id: 'legacy-a', name: 'Legacy A', reasoning: false,
            thinkingLevelMap: { off: null, low: 'low', medium: 'medium', high: 'high' },
          }],
        },
      },
    }))
    await writeFile(join(piDir, 'auth.json'), JSON.stringify({ legacy: { type: 'api_key', key: 'test-key' } }))
    const model = (await runtime.catalog()).models.find(candidate => candidate.modelId === 'legacy-a')
    expect(model?.reasoning).toBe(true)
    expect(model?.thinkingLevels).toEqual(['low', 'medium', 'high'])
  })

  // 验证外部写入感知：服务运行期间外部改写 models.json 后，catalog 读取与 watchModels
  // 观察器汇聚到同一次重载并广播一次（新 provider 可用、等级映射生效）。
  it('picks up a model file written outside the running server and announces the change', async () => {
    const { runtime, piDir } = await fixture()
    const announced = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('the model catalog reload was not announced')), 5_000)
      const unsubscribe = runtime.watchModels(() => { clearTimeout(timer); unsubscribe(); resolve() })
    })
    await writeFile(join(piDir, 'models.json'), JSON.stringify({
      providers: {
        external: {
          name: 'External', baseUrl: 'https://example.invalid/v1', api: 'openai-completions',
          models: [{ id: 'external-a', name: 'External A', reasoning: true, thinkingLevelMap: { low: 'low', high: 'high' } }],
        },
      },
    }))
    await writeFile(join(piDir, 'auth.json'), JSON.stringify({ external: { type: 'api_key', key: 'test-key' } }))
    // catalog 读取是显式的新鲜度锚点：观察器与这次读取汇聚到同一次串行化重载，只广播一次。
    const catalog = await runtime.catalog()
    await announced
    const model = catalog.models.find(candidate => candidate.provider === 'external' && candidate.modelId === 'external-a')
    expect(model?.available).toBe(true)
    expect(model?.thinkingLevels).toEqual(['off', 'low', 'high'])
    expect(catalog.providers.some(provider => provider.id === 'external')).toBe(true)
  })
})

/** 默认模型解析测试。 */
describe('default model resolution', () => {
  // 验证缺失默认回退：配置指向不存在的模型时解析为可选目录模型并用于新会话。
  it('replaces a missing default with a selectable catalog model and uses it for a new conversation', async () => {
    const { runtime } = await fixture({
      models: WL_MODELS,
      piSettings: { defaultProvider: 'ghost', defaultModel: 'ghost-model' },
    })
    const catalog = await runtime.catalog()
    expect(catalog.defaultModel).toBeDefined()
    expect(catalog.defaultModel).not.toEqual({ provider: 'ghost', modelId: 'ghost-model' })
    expect(catalog.models.some(model => model.provider === catalog.defaultModel!.provider && model.modelId === catalog.defaultModel!.modelId)).toBe(true)

    const created = await runtime.create({ title: 'Fallback default' })
    const model = created.conversation.model
    expect(model).toBeDefined()
    expect(catalog.models.some(candidate => candidate.provider === model!.provider && candidate.modelId === model!.modelId)).toBe(true)
  })

  // 验证显式请求不回退：明确指定不存在的模型仍然拒绝（MODEL_UNAVAILABLE）。
  it('still refuses an explicitly requested model that does not exist', async () => {
    const { runtime } = await fixture({ models: WL_MODELS, piSettings: { defaultProvider: 'ghost', defaultModel: 'ghost-model' } })
    await expect(runtime.create({ model: { provider: 'ghost', modelId: 'ghost-model' } }))
      .rejects.toMatchObject({ code: 'MODEL_UNAVAILABLE' })
  })
})

/** 白名单在运行时的全链路过滤测试。 */
describe('model allowlist in the runtime', () => {
  // 验证目录过滤与默认校正：白名单生效后目录只剩允许模型、provider 列表相应增删；
  // 越界的默认模型校正为第一个可用允许模型并持久化到 app-state.json。
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
    // 越界默认解析为第一个可用允许模型并持久化。
    expect(nameOf(filtered.defaultModel ?? { provider: '', modelId: '' })).toBe('wl-alpha/deepseek-a')
    expect(runtime.settings().defaultModel).toEqual({ provider: 'wl-alpha', modelId: 'deepseek-a' })
    const persisted = JSON.parse(await readFile(join(dataDir, 'app-state.json'), 'utf8')) as { settings: { defaultModel?: unknown } }
    expect(persisted.settings.defaultModel).toEqual({ provider: 'wl-alpha', modelId: 'deepseek-a' })
  })

  it('refuses out-of-scope models at every selection point', async () => {
    // Pi 配置的默认在白名单之外，因此 buildAgentChange 推导出的模型必须回退而不是让 create 失败。
    const { runtime } = await fixture({ models: WL_MODELS, piSettings: { defaultProvider: 'wl-beta', defaultModel: 'glm-x' } })
    await runtime.updateSettings({ modelAllowlist: ['wl-alpha/deepseek*'] })

    await expect(runtime.create({ model: { provider: 'wl-beta', modelId: 'glm-x' } }))
      .rejects.toMatchObject({ code: 'MODEL_UNAVAILABLE', message: expect.stringContaining('所选模型不在模型白名单内') })
    await expect(runtime.createAutomation({
      name: 'Scoped', prompt: 'prompt', model: { provider: 'wl-beta', modelId: 'glm-x' },
    })).rejects.toMatchObject({ code: 'MODEL_UNAVAILABLE', message: expect.stringContaining('Automation 模型不在模型白名单内') })
    await expect(runtime.updateSettings({ defaultModel: { provider: 'wl-beta', modelId: 'glm-x' } }))
      .rejects.toMatchObject({ code: 'MODEL_UNAVAILABLE', message: expect.stringContaining('默认模型不在模型白名单内') })

    // 不带显式模型创建时解析为校正后的默认。
    const created = await runtime.create({ title: 'Allowed' })
    expect(nameOf(created.conversation.model ?? { provider: '', modelId: '' })).toBe('wl-alpha/deepseek-a')
    await expect(runtime.update(created.conversation.id, { model: { provider: 'wl-beta', modelId: 'glm-x' } }))
      .rejects.toMatchObject({ code: 'MODEL_UNAVAILABLE', message: expect.stringContaining('所选模型不在模型白名单内') })
  })

  // 验证既有会话阻断：绑定越界模型的会话无法 submit/compact，但改名等非模型配置仍可用；
  // 切换到允许模型后恢复可用。
  it('blocks runs and reconfiguration on a conversation bound to an outside model', async () => {
    const { runtime } = await fixture({ models: WL_MODELS })
    const created = await runtime.create({ title: 'Legacy', model: { provider: 'wl-beta', modelId: 'glm-x' } })
    const id = created.conversation.id
    await runtime.updateSettings({ modelAllowlist: ['wl-alpha/deepseek*'] })

    await expect(runtime.submit(id, { text: 'run', requestId: 'outside-run' }))
      .rejects.toMatchObject({ code: 'MODEL_UNAVAILABLE', message: expect.stringContaining('会话模型不在模型白名单内') })
    await expect(runtime.compact(id)).rejects.toMatchObject({ code: 'MODEL_UNAVAILABLE', message: expect.stringContaining('会话模型不在模型白名单内') })
    await expect(runtime.update(id, { title: 'Rename' })).resolves.toMatchObject({ conversation: { title: 'Rename' } })

    // 切换到允许的模型即可恢复会话。
    const switched = await runtime.update(id, { model: { provider: 'wl-alpha', modelId: 'deepseek-a' } })
    expect(nameOf(switched.conversation.model ?? { provider: '', modelId: '' })).toBe('wl-alpha/deepseek-a')
  })

  // 验证 provider 配置过滤：白名单内 provider 只列出允许模型；白名单外 provider 配置为空模型列表；
  // 越界连通性探测被拒、未知 provider 报 NOT_FOUND。
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

  // 验证设置入口校验：非法条目（缺 model、星号在中间）报 INVALID_INPUT；
  // 归一化后存储；清空白名单恢复完整目录。
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

  // 验证隐藏白名单清理：app-state 中存储的白名单在重新打开时被清空（避免用户不知情的持续过滤）。
  it('clears a hidden stored allowlist when the app state is reopened', async () => {
    const { runtime, dataDir, workspace, piDir, cleanup } = await fixture({ models: WL_MODELS })
    await runtime.updateSettings({ modelAllowlist: ['wl-alpha/deepseek*'] })
    expect(runtime.settings().modelAllowlist).toEqual(['wl-alpha/deepseek*'])
    await runtime.close()
    const reopened = await createRuntime({ dataDir, workspace, piDir })
    cleanup.closers.push(() => reopened.close())
    expect(reopened.settings().modelAllowlist).toEqual([])
    expect((await reopened.catalog()).models.some(model => nameOf(model) === 'wl-beta/glm-x')).toBe(true)
  })

  // 验证凭据环境名与目录身份：内置 openai 报告 envVars（OPENAI_API_KEY）与 builtin/custom=false；
  // 为发行路由保存带密钥的 profile 后 source=project、configured/storedCredential=true，envVars 保留。
  it('reports auth environment names and keeps catalog identity after a profile save', async () => {
    const { runtime } = await fixture()
    const openai = (await runtime.catalog()).providers.find(provider => provider.id === 'openai')
    expect(openai?.envVars).toContain('OPENAI_API_KEY')
    expect(openai).toMatchObject({ source: 'builtin', custom: false, configured: false })
    // 带存储凭据的发行路由算 configured，而不是手工声明。
    await runtime.saveProvider({
      id: 'openai', name: 'OpenAI', baseUrl: 'https://api.openai.com/v1', apiKey: 'test-key',
      models: [{ id: 'gpt-test', name: 'GPT Test' }],
    })
    const saved = (await runtime.catalog()).providers.find(provider => provider.id === 'openai')
    expect(saved).toMatchObject({ source: 'project', custom: false, configured: true, storedCredential: true })
    expect(saved?.envVars).toContain('OPENAI_API_KEY')
  })

  // 验证 demo 模型豁免：无论白名单内容如何，脚本化 demo 模型保持可选且为默认。
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
