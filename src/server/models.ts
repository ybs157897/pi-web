import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import {
  createProvider,
  defaultProviderAuthContext,
  getSupportedThinkingLevels,
  InMemoryCredentialStore,
  lazyApi,
  type Api,
  type AuthResult,
  type Credential,
  type Model as PiModel,
  type MutableModels,
  type Provider,
  type ProviderStreams,
} from '@earendil-works/pi-ai'
import type { ModelRef } from '@earendil-works/pi-durable'
import { builtinModels } from '@earendil-works/pi-ai/providers/all'
import type { ModelCatalog, ModelOption, ProviderConfigSummary, ProviderInput, ProviderModelInput, ProviderSummary, ProviderTestResult, ThinkingLevel } from '../shared/types.ts'
import { RuntimeError } from './runtime-errors.ts'

interface JsonObject { [key: string]: unknown }
interface StoredProvider {
  id: string
  name: string
  baseUrl: string
  api?: string
  headers?: Record<string, string>
  compat?: JsonObject
  models: JsonObject[]
}
interface StoredProviders { providers: StoredProvider[]; credentials: Record<string, Credential> }
export interface RuntimeModels {
  models: MutableModels
  defaultModel?: ModelRef
  defaultThinkingLevel?: ThinkingLevel
  saveProvider(input: ProviderInput): Promise<void>
  provider(id: string): Promise<ProviderConfigSummary>
  deleteProvider(id: string): Promise<void>
  testProvider(id: string, modelId?: string): Promise<ProviderTestResult>
  discover(id: string): Promise<{ models: Array<{ id: string; name: string }> }>
  catalog(): Promise<ModelCatalog>
}

type Model = PiModel<Api>
type ProviderModel = Model

const THINKING_LEVELS: ThinkingLevel[] = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']
const DEFAULT_API = 'openai-completions'
const SECRET_ENV_NAME = /^[A-Z_][A-Z0-9_]*$/
const API_NAME = /^[a-z0-9-]+$/
const PROVIDER_ID = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/
const MODEL_ID = /^[^\s\u0000-\u001f]{1,256}$/

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

async function readObject(path: string): Promise<JsonObject | undefined> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, 'utf8'))
    if (!isObject(parsed)) throw new Error('invalid object')
    return parsed
  } catch (error) {
    if (isObject(error) && error.code === 'ENOENT') return undefined
    throw new Error(`无法读取有效的模型配置：${path}`)
  }
}

function configuredDefault(settings: JsonObject | undefined): ModelRef | undefined {
  if (!settings) return undefined
  const value = settings.defaultModel
  if (isObject(value) && typeof value.provider === 'string' && typeof value.modelId === 'string' && value.provider && value.modelId) {
    return { provider: value.provider, modelId: value.modelId }
  }
  if (typeof settings.defaultProvider === 'string' && settings.defaultProvider && typeof value === 'string' && value) {
    return { provider: settings.defaultProvider, modelId: value }
  }
  return undefined
}

function configuredThinking(settings: JsonObject | undefined): ThinkingLevel | undefined {
  const value = settings?.thinkingLevel
  return typeof value === 'string' && THINKING_LEVELS.includes(value as ThinkingLevel) ? value as ThinkingLevel : undefined
}

function resolvePiKey(value: string): string | undefined {
  if (value.startsWith('!')) return undefined
  return SECRET_ENV_NAME.test(value) ? process.env[value] : value
}

function isCredential(value: unknown): value is Credential {
  if (!isObject(value)) return false
  if (value.type === 'api_key') return value.key === undefined || typeof value.key === 'string'
  return value.type === 'oauth' && typeof value.access === 'string' && typeof value.refresh === 'string' && typeof value.expires === 'number'
}

async function loadCredentials(piDir: string, appCredentials: Record<string, Credential>): Promise<InMemoryCredentialStore> {
  const store = new InMemoryCredentialStore()
  const authFile = await readObject(join(piDir, 'auth.json'))
  for (const [providerId, raw] of Object.entries(authFile ?? {})) {
    if (!isObject(raw)) continue
    if (raw.type === 'api_key' && typeof raw.key === 'string') {
      const key = resolvePiKey(raw.key)
      if (key !== undefined) await store.modify(providerId, async () => ({ type: 'api_key', key }))
      continue
    }
    if (raw.type === 'oauth' && typeof raw.access === 'string' && typeof raw.refresh === 'string' && typeof raw.expires === 'number') {
      const credential: Credential = { ...raw, type: 'oauth', access: raw.access, refresh: raw.refresh, expires: raw.expires }
      await store.modify(providerId, async () => credential)
    }
  }
  for (const [providerId, credential] of Object.entries(appCredentials)) {
    await store.modify(providerId, async () => credential)
  }
  return store
}

function apiStreams(apiId: string): ProviderStreams {
  if (!API_NAME.test(apiId)) throw new Error('模型 API 类型无效')
  return lazyApi(async () => {
    const module = await import(`@earendil-works/pi-ai/api/${apiId}`)
    return module as ProviderStreams
  })
}

function stringRecord(value: unknown): Record<string, string> | undefined {
  if (!isObject(value)) return undefined
  const entries = Object.entries(value)
  if (!entries.every(([, item]) => typeof item === 'string')) return undefined
  return Object.fromEntries(entries.map(([key, item]) => [key, String(item)]))
}

function normalizeModel(providerId: string, providerEntry: JsonObject, raw: JsonObject): ProviderModel | undefined {
  if (typeof raw.id !== 'string' || !MODEL_ID.test(raw.id)) return undefined
  const apiId = typeof raw.api === 'string' ? raw.api : typeof providerEntry.api === 'string' ? providerEntry.api : DEFAULT_API
  if (!API_NAME.test(apiId)) throw new Error('模型 API 类型无效')
  const baseUrl = typeof raw.baseUrl === 'string' ? raw.baseUrl : typeof providerEntry.baseUrl === 'string' ? providerEntry.baseUrl : ''
  const input = Array.isArray(raw.input)
    ? raw.input.filter((item): item is 'text' | 'image' => item === 'text' || item === 'image')
    : []
  const model: Model = {
    id: raw.id,
    name: typeof raw.name === 'string' && raw.name ? raw.name : raw.id,
    api: apiId as Api,
    provider: providerId,
    baseUrl,
    input: input.length ? input : ['text'],
    cost: isObject(raw.cost)
      ? {
          input: numberOr(raw.cost.input, 0),
          output: numberOr(raw.cost.output, 0),
          cacheRead: numberOr(raw.cost.cacheRead, 0),
          cacheWrite: numberOr(raw.cost.cacheWrite, 0),
          ...(Array.isArray(raw.cost.tiers) ? { tiers: raw.cost.tiers.filter(isObject).map((tier) => ({
            input: numberOr(tier.input, 0),
            output: numberOr(tier.output, 0),
            cacheRead: numberOr(tier.cacheRead, 0),
            cacheWrite: numberOr(tier.cacheWrite, 0),
            inputTokensAbove: numberOr(tier.inputTokensAbove, 0),
          })) } : {}),
        }
      : { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    reasoning: raw.reasoning === true,
    contextWindow: positiveNumber(raw.contextWindow, 128_000),
    maxTokens: positiveNumber(raw.maxTokens, 16_384),
  }
  const headers = stringRecord(raw.headers)
  if (headers) model.headers = headers
  if (isObject(raw.inputLimits)) model.inputLimits = raw.inputLimits as Model['inputLimits']
  if (isObject(raw.thinkingLevelMap)) model.thinkingLevelMap = raw.thinkingLevelMap as Model['thinkingLevelMap']
  if (isObject(raw.promptCache)) model.promptCache = raw.promptCache as Model['promptCache']
  if (isObject(raw.samplingParams)) model.samplingParams = raw.samplingParams as Model['samplingParams']
  if (isObject(raw.samplingParamsByThinkingLevel)) model.samplingParamsByThinkingLevel = raw.samplingParamsByThinkingLevel as Model['samplingParamsByThinkingLevel']
  const compat = raw.compat ?? providerEntry.compat
  if (isObject(compat)) model.compat = compat as Model['compat']
  return model
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback
}

function positiveNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : fallback
}

function isStoredProvider(value: unknown): value is StoredProvider {
  return isObject(value) && typeof value.id === 'string' && typeof value.name === 'string' &&
    typeof value.baseUrl === 'string' && Array.isArray(value.models) && value.models.every(isObject)
}

function retainedStreams(provider: Provider): ProviderStreams {
  return {
    stream: provider.stream.bind(provider),
    streamSimple: provider.streamSimple.bind(provider),
    ...(provider.fetchDeferred ? { fetchDeferred: provider.fetchDeferred.bind(provider) } : {}),
    ...(provider.cancelDeferred ? { cancelDeferred: provider.cancelDeferred.bind(provider) } : {}),
  }
}

function customProvider(entry: StoredProvider, key: string | undefined, builtin?: Provider) {
  if (!PROVIDER_ID.test(entry.id)) throw new Error('Provider ID 无效')
  if (!entry.models.length) throw new Error(`Provider ${entry.id} 至少需要一个模型`)
  const providerEntry: JsonObject = { api: entry.api, baseUrl: entry.baseUrl, compat: entry.compat }
  const normalized = entry.models
    .map((raw) => normalizeModel(entry.id, providerEntry, raw))
    .filter((model): model is ProviderModel => model !== undefined)
  if (!normalized.length) throw new Error(`Provider ${entry.id} 没有有效模型`)
  const retained = builtin ? retainedStreams(builtin) : undefined
  const apis = new Map<string, ProviderStreams>()
  if (retained && builtin) {
    for (const model of builtin.getModels()) apis.set(model.api, retained)
  }
  for (const model of normalized) {
    if (!apis.has(model.api)) apis.set(model.api, apiStreams(model.api))
  }
  const modelsById = new Map((builtin?.getModels() ?? []).map((model) => [model.id, model]))
  for (const model of normalized) modelsById.set(model.id, model)
  return createProvider({
    id: entry.id,
    name: entry.name || entry.id,
    baseUrl: entry.baseUrl || builtin?.baseUrl,
    headers: entry.headers ?? builtin?.headers as Record<string, string> | undefined,
    auth: builtin?.auth ?? {
      apiKey: {
        name: `${entry.name || entry.id} API key`,
        resolve: async ({ credential }): Promise<AuthResult | undefined> => {
          const apiKey = credential?.key ?? key
          return apiKey ? { auth: { apiKey }, source: '本地 Provider 配置' } : undefined
        },
      },
    },
    api: Object.fromEntries(apis),
    models: [...modelsById.values()],
  })
}

function sanitizeBaseUrl(value: string | undefined): string | undefined {
  if (!value) return undefined
  try {
    const url = new URL(value)
    url.username = ''
    url.password = ''
    url.search = ''
    url.hash = ''
    return `${url.origin}${url.pathname.replace(/\/$/, '')}`
  } catch {
    return undefined
  }
}

function safeHeaders(value: Record<string, string> | undefined): Record<string, string> | undefined {
  if (!value) return undefined
  const entries = Object.entries(value).filter(([name]) => !/authorization|api[-_]?key|token|secret|cookie/i.test(name))
  return entries.length ? Object.fromEntries(entries) : undefined
}

function publicModel(model: ProviderModel): ProviderModelInput {
  return {
    id: model.id,
    name: model.name,
    reasoning: model.reasoning,
    contextWindow: model.contextWindow,
    api: model.api,
    baseUrl: model.baseUrl,
    input: [...model.input],
    maxTokens: model.maxTokens,
    cost: {
      input: model.cost.input,
      output: model.cost.output,
      cacheRead: model.cost.cacheRead,
      cacheWrite: model.cost.cacheWrite,
      ...(model.cost.tiers ? { tiers: structuredClone(model.cost.tiers) } : {}),
    },
    ...(safeHeaders(model.headers) ? { headers: safeHeaders(model.headers) } : {}),
    ...(model.inputLimits ? { inputLimits: { ...model.inputLimits } } : {}),
    ...(model.thinkingLevelMap ? { thinkingLevelMap: { ...model.thinkingLevelMap } } : {}),
    ...(model.promptCache ? { promptCache: { ...model.promptCache } } : {}),
    ...(model.samplingParams ? { samplingParams: { ...model.samplingParams } } : {}),
    ...(model.samplingParamsByThinkingLevel ? { samplingParamsByThinkingLevel: { ...model.samplingParamsByThinkingLevel } } : {}),
    ...(model.compat ? { compat: { ...model.compat } } : {}),
  }
}

function providerErrorText(value: string): string {
  return value
    .replace(/\bauthorization\s*[:=]\s*(?:bearer\s+)?[^\s,;]+/gi, 'Authorization: [redacted]')
    .replace(/\bbearer\s+[^\s,;]+/gi, 'Bearer [redacted]')
    .replace(/(["']?(?:api[_ -]?key|access[_ -]?token|refresh[_ -]?token|client[_ -]?secret)["']?\s*[:=]\s*["']?)[^"'\s,;}]+/gi, '$1[redacted]')
    .replace(/\b(?:sk|rk|pk|key|token|secret)[-_][A-Za-z0-9._~+/-]{8,}/gi, '[redacted]')
    .replace(/https?:\/\/[^\s/@:]+:[^\s/@]+@/gi, '[redacted]@')
    .replace(/[\r\n\t]+/g, ' ')
    .slice(0, 400)
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  const dir = dirname(path)
  await mkdir(dir, { recursive: true, mode: 0o700 })
  await chmod(dir, 0o700)
  const temp = join(dir, `.tmp-${process.pid}-${crypto.randomUUID()}`)
  try {
    await writeFile(temp, JSON.stringify(value, null, 2), { encoding: 'utf8', mode: 0o600, flag: 'wx' })
    await chmod(temp, 0o600)
    await rename(temp, path)
    await chmod(path, 0o600)
  } catch (error) {
    await rm(temp, { force: true }).catch(() => undefined)
    throw error
  }
}

function storedProviderFromInput(input: ProviderInput, previous?: StoredProvider): StoredProvider {
  if (!PROVIDER_ID.test(input.id)) throw new Error('Provider ID 无效')
  if (typeof input.name !== 'string' || input.name.trim().length === 0 || input.name.length > 128) throw new Error('Provider 名称无效')
  const declared = input.baseUrl?.trim() ?? ''
  if (declared !== '') {
    let url: URL
    try { url = new URL(declared) } catch { throw new Error('Provider Base URL 无效') }
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Provider Base URL 仅支持 HTTP 或 HTTPS')
  } else if (previous?.baseUrl === undefined || previous.baseUrl === '') {
    // Empty means "provider default": the saved models must then carry their own endpoint.
    const hasModelEndpoint = input.models.some(model => typeof model.baseUrl === 'string' && model.baseUrl !== '')
    if (!hasModelEndpoint) throw new Error('请填写接口地址，或为每个模型提供接口地址')
  }
  if (!Array.isArray(input.models) || input.models.length === 0 || input.models.length > 500) throw new Error('Provider 模型列表无效')
  const api = input.api ?? DEFAULT_API
  if (!API_NAME.test(api)) throw new Error('模型 API 类型无效')
  const models = input.models.map((model) => {
    if (!model || !MODEL_ID.test(model.id) || typeof model.name !== 'string' || model.name.length > 256) throw new Error('模型 ID 或名称无效')
    const existing = previous?.models.find((candidate) => candidate.id === model.id)
    return {
      ...(existing ?? {}),
      ...model,
      id: model.id,
      name: model.name || model.id,
      reasoning: model.reasoning === true || existing?.reasoning === true,
      ...((model.contextWindow ?? existing?.contextWindow) !== undefined
        ? { contextWindow: positiveNumber(model.contextWindow ?? numberOr(existing?.contextWindow, 128_000), 128_000) }
        : {}),
      api: typeof model.api === 'string' ? model.api : typeof existing?.api === 'string' ? existing.api : api,
    }
  })
  if (new Set(models.map((model) => model.id)).size !== models.length) throw new Error('模型 ID 不能重复')
  if (input.apiKey !== undefined && (typeof input.apiKey !== 'string' || input.apiKey.length === 0 || input.apiKey.length > 16_384)) throw new Error('API key 无效')
  return {
    id: input.id,
    name: input.name.trim(),
    baseUrl: input.baseUrl?.trim() ?? previous?.baseUrl ?? '',
    api,
    ...(input.headers ?? previous?.headers ? { headers: input.headers ?? previous?.headers } : {}),
    ...(input.compat ?? previous?.compat ? { compat: input.compat ?? previous?.compat } : {}),
    models,
  }
}

function appCredentials(value: unknown): Record<string, Credential> {
  if (!isObject(value)) return {}
  return Object.fromEntries(Object.entries(value).filter(([, item]) => isCredential(item))) as Record<string, Credential>
}

export async function createModelRuntime(options: { dataDir: string; piDir?: string }): Promise<RuntimeModels> {
  const dataDir = resolve(options.dataDir)
  await mkdir(dataDir, { recursive: true, mode: 0o700 })
  await chmod(dataDir, 0o700)
  const piDir = resolve(options.piDir ?? join(homedir(), '.pi', 'agent'))
  const providerPath = join(dataDir, 'providers.json')
  const [settings, providerFile, piModels] = await Promise.all([
    readObject(join(piDir, 'settings.json')),
    readObject(providerPath),
    readObject(join(piDir, 'models.json')),
  ])
  const localProviders = Array.isArray(providerFile?.providers) ? providerFile.providers.filter(isStoredProvider) : []
  let storedAppProviders = localProviders
  let storedAppCredentials = appCredentials(providerFile?.credentials)
  if (providerFile) await chmod(providerPath, 0o600)
  const importedCredentialStore = await loadCredentials(piDir, {})
  const importedCredentials = new Map<string, Credential>()
  for (const info of await importedCredentialStore.list()) {
    const credential = await importedCredentialStore.read(info.providerId)
    if (credential) importedCredentials.set(info.providerId, credential)
  }
  const credentials = await loadCredentials(piDir, storedAppCredentials)
  const modelCollection = builtinModels({ credentials, authContext: defaultProviderAuthContext() })
  const builtinProviderIds = new Set(modelCollection.getProviders().map((provider) => provider.id))
  const builtinProviders = new Map(modelCollection.getProviders().map((provider) => [provider.id, provider]))
  const piProviders = isObject(piModels?.providers) ? piModels.providers : {}
  const merged = new Map<string, StoredProvider>()
  for (const [id, raw] of Object.entries(piProviders)) {
    if (raw === false || !isObject(raw) || raw.enabled === false) continue
    if (typeof raw.baseUrl !== 'string' || !Array.isArray(raw.models)) continue
    const models = raw.models.filter(isObject).map((candidate) => ({ ...candidate }))
    merged.set(id, {
      id,
      name: typeof raw.name === 'string' ? raw.name : id,
      baseUrl: raw.baseUrl,
      ...(typeof raw.api === 'string' ? { api: raw.api } : {}),
      ...(stringRecord(raw.headers) ? { headers: stringRecord(raw.headers) } : {}),
      ...(isObject(raw.compat) ? { compat: raw.compat } : {}),
      models,
    })
  }
  const importedProviders = new Map(merged)
  for (const provider of storedAppProviders) merged.set(provider.id, provider)
  const configuredPiProviders = new Set(Object.keys(piProviders))
  for (const provider of merged.values()) {
    const localCredential = storedAppCredentials[provider.id]
    const key = localCredential?.type === 'api_key' ? localCredential.key : (() => {
      const piProvider = piProviders[provider.id]
      return isObject(piProvider) && typeof piProvider.apiKey === 'string' ? resolvePiKey(piProvider.apiKey) : undefined
    })()
    if (key) await credentials.modify(provider.id, async () => ({ type: 'api_key', key }))
    modelCollection.setProvider(customProvider(provider, key, modelCollection.getProvider(provider.id)))
  }

  const defaultModel = configuredDefault(settings)
  const defaultThinkingLevel = configuredThinking(settings)
  let saveChain: Promise<unknown> = Promise.resolve()
  const saveSerially = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = saveChain.then(operation, operation)
    saveChain = result.then(() => undefined, () => undefined)
    return result
  }

  return {
    models: modelCollection,
    defaultModel,
    defaultThinkingLevel,
    async saveProvider(input) {
      const prior = storedAppProviders.find((candidate) => candidate.id === input.id) ?? merged.get(input.id)
      const provider = storedProviderFromInput(input, prior)
      return saveSerially(async () => {
        const providers = [...storedAppProviders.filter((candidate) => candidate.id !== provider.id), provider]
        const nextCredentials: Record<string, Credential> = { ...storedAppCredentials }
        if (input.apiKey !== undefined) nextCredentials[provider.id] = { type: 'api_key', key: input.apiKey }
        const selectedCredential = nextCredentials[provider.id]
        const selectedKey = selectedCredential?.type === 'api_key' ? selectedCredential.key : undefined
        const candidate = customProvider(provider, selectedKey, modelCollection.getProvider(provider.id))
        const config: StoredProviders = { providers, credentials: nextCredentials }
        await writeJsonAtomic(providerPath, config)
        storedAppProviders = providers
        storedAppCredentials = nextCredentials
        if (selectedCredential) await credentials.modify(provider.id, async () => selectedCredential)
        modelCollection.setProvider(candidate)
        merged.set(provider.id, provider)
      })
    },
    async provider(id) {
      const provider = modelCollection.getProvider(id)
      if (!provider) throw new RuntimeError('NOT_FOUND', 'Provider 不存在')
      const isCustom = storedAppProviders.some((item) => item.id === id) || configuredPiProviders.has(id) || !builtinProviderIds.has(id)
      const source = storedAppProviders.some((item) => item.id === id) ? 'project' : configuredPiProviders.has(id) || !builtinProviderIds.has(id) ? 'pi' : 'builtin'
      const models = provider.getModels()
      let authConfigured = false
      try { authConfigured = await modelCollection.checkAuth(id) !== undefined }
      catch { throw new Error(`无法读取 ${provider.name} 的认证状态`) }
      const headers = safeHeaders(provider.headers as Record<string, string> | undefined)
      const compat = models[0]?.compat
      // A project override can be reset to the catalog the provider shipped with.
      // Only a shipped provider knows its out-of-the-box catalog; a project override reset to it.
      const shipped = source === 'project' ? builtinProviders.get(id) : undefined
      const defaults = shipped?.getModels().map(publicModel)
      return {
        id: provider.id,
        name: provider.name,
        source,
        custom: isCustom,
        configured: authConfigured,
        credentialConfigured: authConfigured,
        ...(sanitizeBaseUrl(provider.baseUrl) ? { baseUrl: sanitizeBaseUrl(provider.baseUrl) } : {}),
        api: models[0]?.api ?? DEFAULT_API,
        models: models.map(publicModel),
        ...(headers ? { headers } : {}),
        ...(compat ? { compat: { ...compat } } : {}),
        ...(defaults && defaults.length > 0 ? { defaults } : {}),
      }
    },
    async deleteProvider(id) {
      return saveSerially(async () => {
        if (!storedAppProviders.some((candidate) => candidate.id === id)) {
          throw new RuntimeError('UNSUPPORTED', '只能删除此应用创建的 Provider 配置')
        }
        const providers = storedAppProviders.filter((candidate) => candidate.id !== id)
        const nextCredentials: Record<string, Credential> = { ...storedAppCredentials }
        delete nextCredentials[id]
        await writeJsonAtomic(providerPath, { providers, credentials: nextCredentials } satisfies StoredProviders)
        storedAppProviders = providers
        storedAppCredentials = nextCredentials
        const builtin = builtinProviders.get(id)
        const imported = importedProviders.get(id)
        const importedCredential = importedCredentials.get(id)
        await credentials.modify(id, async () => importedCredential)
        if (imported) {
          const piProvider = piProviders[id]
          const modelKey = isObject(piProvider) && typeof piProvider.apiKey === 'string' ? resolvePiKey(piProvider.apiKey) : undefined
          const key = importedCredential?.type === 'api_key' ? importedCredential.key : modelKey
          modelCollection.setProvider(customProvider(imported, key, builtin))
          merged.set(id, imported)
        } else if (builtin) {
          modelCollection.setProvider(builtin)
          merged.delete(id)
        } else {
          modelCollection.deleteProvider(id)
          merged.delete(id)
        }
      })
    },
    async testProvider(id, modelId) {
      const provider = modelCollection.getProvider(id)
      const model = modelId ? modelCollection.getModel(id, modelId) : provider?.getModels()[0]
      const checkedAt = Date.now()
      if (!provider || !model) throw new RuntimeError('NOT_FOUND', '所选 Provider 或模型不存在')
      try {
        const result = await modelCollection.completeSimple(model, {
          messages: [{ role: 'user', content: 'Reply with OK.', timestamp: checkedAt }],
        }, { timeoutMs: 20_000, maxRetries: 0, maxTokens: 16, sessionId: `probe-${crypto.randomUUID()}` })
        const failure = result.stopReason === 'error' ? result.errorMessage ?? 'Provider returned an error' : undefined
        return {
          providerId: id,
          modelId: model.id,
          status: failure ? 'failed' : 'connected',
          checkedAt,
          ...(failure ? { message: providerErrorText(failure) } : {}),
        }
      } catch (error) {
        return {
          providerId: id,
          modelId: model.id,
          status: 'failed',
          checkedAt,
          message: providerErrorText(error instanceof Error ? error.message : 'Provider request failed'),
        }
      }
    },
    /** Ask the provider endpoint which model IDs it serves, so the directory can be filled in one step. */
    async discover(id) {
      const provider = modelCollection.getProvider(id)
      if (!provider) throw new RuntimeError('NOT_FOUND', 'Provider 不存在')
      const baseUrl = provider.baseUrl || provider.getModels()[0]?.baseUrl || ''
      if (baseUrl === '') throw new RuntimeError('INVALID_INPUT', '该提供商没有可访问的接口地址')
      const credential = await credentials.read(id)
      const apiKey = credential?.type === 'api_key' ? credential.key : undefined
      const endpoint = `${baseUrl.replace(/\/+$/u, '')}/models`
      let response: Response
      try {
        response = await fetch(endpoint, {
          headers: apiKey === undefined ? {} : { authorization: `Bearer ${apiKey}` },
          signal: AbortSignal.timeout(15_000),
        })
      } catch (error) {
        throw new RuntimeError('PROVIDER_ERROR', `无法访问 ${endpoint}：${error instanceof Error ? error.message : '请求失败'}`)
      }
      if (!response.ok) throw new RuntimeError('PROVIDER_ERROR', `${endpoint} 返回 HTTP ${response.status}`)
      const payload: unknown = await response.json().catch(() => undefined)
      const listed = isObject(payload) && Array.isArray(payload.data) ? payload.data : Array.isArray(payload) ? payload : []
      const models = listed.flatMap(model => {
        if (!isObject(model) || typeof model.id !== 'string' || model.id === '') return []
        return [{ id: model.id, name: typeof model.name === 'string' && model.name !== '' ? model.name : model.id }]
      })
      return { models }
    },
    async catalog() {
      const providerList = modelCollection.getProviders()
      const authStatuses = await Promise.all(providerList.map(async (provider) => {
        try { return [provider.id, await modelCollection.checkAuth(provider.id)] as const }
        catch { throw new Error(`无法读取 ${provider.name} 的认证状态`) }
      }))
      const configured = new Map(authStatuses.map(([id, status]) => [id, status !== undefined]))
      const providers: ProviderSummary[] = providerList.map((provider) => ({
        id: provider.id,
        name: provider.name,
        configured: configured.get(provider.id) ?? false,
        source: storedAppProviders.some((item) => item.id === provider.id) ? 'project' : configuredPiProviders.has(provider.id) || !builtinProviderIds.has(provider.id) ? 'pi' : 'builtin',
        custom: storedAppProviders.some((item) => item.id === provider.id) || configuredPiProviders.has(provider.id) || !builtinProviderIds.has(provider.id),
        ...(sanitizeBaseUrl(provider.baseUrl) ? { baseUrl: sanitizeBaseUrl(provider.baseUrl) } : {}),
      }))
      const modelOptions: ModelOption[] = modelCollection.getModels().map((model) => ({
        provider: model.provider,
        modelId: model.id,
        name: model.name,
        reasoning: model.reasoning,
        available: configured.get(model.provider) ?? false,
        ...(Number.isFinite(model.contextWindow) ? { contextWindow: model.contextWindow } : {}),
        ...(model.reasoning ? { thinkingLevels: getSupportedThinkingLevels(model).filter((level): level is ThinkingLevel => THINKING_LEVELS.includes(level as ThinkingLevel)) } : {}),
      }))
      return {
        models: modelOptions,
        providers,
        ...(defaultModel ? { defaultModel } : {}),
        thinkingLevels: THINKING_LEVELS,
      }
    },
  }
}
