import { watch, type FSWatcher } from 'node:fs'
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
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
export interface RuntimeModels {
  models: MutableModels
  readonly defaultModel?: ModelRef
  readonly defaultThinkingLevel?: ThinkingLevel
  saveProvider(input: ProviderInput): Promise<void>
  provider(id: string): Promise<ProviderConfigSummary>
  deleteProvider(id: string): Promise<void>
  testProvider(id: string, modelId?: string): Promise<ProviderTestResult>
  discover(id: string): Promise<{ models: Array<{ id: string; name: string }> }>
  catalog(): Promise<ModelCatalog>
  /** Levels one configured model actually accepts, in escalation order. */
  supportedThinkingLevels(provider: string, modelId: string): ThinkingLevel[] | undefined
  /** Observe catalog reloads (a change, a save, or another instance's write). */
  subscribe(listener: () => void): () => void
  close(): void
}

type Model = PiModel<Api>
type ProviderModel = Model

const THINKING_LEVELS: ThinkingLevel[] = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']

/**
 * pi-ai's clamping rule over our own level list: keep the requested level when
 * the model supports it, otherwise take the nearest supported level above it,
 * then below it. This is what a generation would actually send.
 */
export function clampThinkingLevel(level: ThinkingLevel, supported: readonly ThinkingLevel[]): ThinkingLevel {
  if (supported.includes(level)) return level
  if (supported.length === 0) return 'off'
  const requested = THINKING_LEVELS.indexOf(level)
  if (requested === -1) return supported[0]!
  for (let index = requested; index < THINKING_LEVELS.length; index += 1) {
    if (supported.includes(THINKING_LEVELS[index]!)) return THINKING_LEVELS[index]!
  }
  for (let index = requested - 1; index >= 0; index -= 1) {
    if (supported.includes(THINKING_LEVELS[index]!)) return THINKING_LEVELS[index]!
  }
  return supported[0]!
}
const DEFAULT_API = 'openai-completions'
const SECRET_ENV_NAME = /^[A-Z_][A-Z0-9_]*$/
const API_NAME = /^[a-z0-9-]+$/
const PROVIDER_ID = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/
const MODEL_ID = /^[^\s\u0000-\u001f]{1,256}$/

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Translate declared reasoning levels into pi-ai's `thinkingLevelMap` the way
 * DSH's pi-ai adapter does: every level the user did not declare is pinned to
 * `null` instead of inheriting pi-ai's asymmetric defaulting, and an Off entry
 * with no wire value stays absent so "thinking off" sends no parameter.
 */
function pinnedThinkingLevelMap(value: JsonObject): Record<string, string | null> {
  // Off is the one level whose absence is meaningful: pi-ai reads a missing
  // Off as "supported, send nothing", while an explicit null means the model
  // cannot stop thinking. Every other absent level is pinned off the picker.
  const pinned: Record<string, string | null> = Object.fromEntries(
    THINKING_LEVELS.filter(level => level !== 'off').map(level => [level, null]),
  )
  let reasons = false
  for (const [level, wire] of Object.entries(value)) {
    if (wire === null) {
      pinned[level] = null
      continue
    }
    if (typeof wire !== 'string' || wire.length === 0) throw new Error('推理等级的参数值必须是非空字符串')
    pinned[level] = wire
    if (level !== 'off') reasons = true
  }
  if (!reasons) throw new Error('推理等级至少需要一个非 Off 档位')
  return pinned
}

/** A stored model that declares levels is a reasoning model even if an older save left `reasoning` false. */
function upgradeStoredModel(raw: JsonObject): JsonObject {
  if (!isObject(raw.thinkingLevelMap)) return raw
  try {
    return { ...raw, reasoning: true, thinkingLevelMap: pinnedThinkingLevelMap(raw.thinkingLevelMap) }
  } catch {
    return raw
  }
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

async function loadCredentials(piDir: string): Promise<InMemoryCredentialStore> {
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
  // An explicit (project or imported) provider entry owns its model directory.
  // Merging the builtin catalog in would resurrect models the user deleted.
  const modelsById = new Map(normalized.map((model) => [model.id, model]))
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

/**
 * Environment names a provider's own api-key auth would consult, in order.
 * Resolving against a context that answers every lookup with `undefined`
 * records the names without reading a value; a provider whose resolution
 * short-circuits on unconfigured input still reaches every candidate. Names
 * containing `oauth` are hidden, matching the settings page's "API key"
 * framing — OAuth sources are not API keys.
 */
async function providerEnvVars(provider: Provider): Promise<string[]> {
  const auth = provider.auth.apiKey
  if (auth === undefined) return []
  const names: string[] = []
  const seen = new Set<string>()
  try {
    await auth.resolve({
      ctx: {
        env: async (name) => {
          if (!seen.has(name)) { seen.add(name); names.push(name) }
          return undefined
        },
        fileExists: async () => false,
      },
      credential: undefined,
      signal: new AbortController().signal,
    })
  } catch { /* keep what the resolution asked for before it failed */ }
  return names.filter(name => !name.toLocaleLowerCase().includes('oauth'))
}

function configuredEnv(names: readonly string[]): string[] {
  return names.filter(name => {
    const value = process.env[name]
    return value !== undefined && value.trim() !== ''
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

function publicModel(
  model: ProviderModel,
  declared?: JsonObject,
  inherited?: { api?: string; baseUrl?: string },
): ProviderModelInput {
  const includeApi = declared === undefined ? model.api !== inherited?.api : Object.hasOwn(declared, 'api')
  const includeBaseUrl = declared === undefined
    ? model.baseUrl !== '' && model.baseUrl !== inherited?.baseUrl
    : Object.hasOwn(declared, 'baseUrl') && model.baseUrl !== ''
  return {
    id: model.id,
    name: model.name,
    reasoning: model.reasoning,
    contextWindow: model.contextWindow,
    ...(includeApi ? { api: model.api } : {}),
    ...(includeBaseUrl ? { baseUrl: model.baseUrl } : {}),
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
    const declared = model.thinkingLevelMap === undefined ? undefined : pinnedThinkingLevelMap(model.thinkingLevelMap)
    // Declaring levels is what makes a model reason, exactly like DSH's
    // `reasoningEfforts`. An explicit `reasoning: false` clears a map inherited
    // from the previous save; an omitted one keeps it.
    const reasoning = declared !== undefined ? true : model.reasoning === false ? false : model.reasoning === true || existing?.reasoning === true
    const carried: JsonObject = { ...(existing ?? {}) }
    if (declared !== undefined || model.reasoning === false) delete carried.thinkingLevelMap
    return {
      ...carried,
      ...model,
      id: model.id,
      name: model.name || model.id,
      reasoning,
      ...(declared !== undefined ? { thinkingLevelMap: declared } : {}),
      ...((model.contextWindow ?? existing?.contextWindow) !== undefined
        ? { contextWindow: positiveNumber(model.contextWindow ?? numberOr(existing?.contextWindow, 128_000), 128_000) }
        : {}),
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

interface ModelConfigState {
  credentials: Map<string, Credential>
  piProviders: JsonObject
  merged: Map<string, StoredProvider>
  defaultModel?: ModelRef
  defaultThinkingLevel?: ThinkingLevel
  /** Everything a reload reads, so an unchanged watch event never rebuilds the catalog. */
  signature: string
}

function providerApiKey(provider: StoredProvider, state: Pick<ModelConfigState, 'piProviders'>): string | undefined {
  const piProvider = state.piProviders[provider.id]
  return isObject(piProvider) && typeof piProvider.apiKey === 'string' ? resolvePiKey(piProvider.apiKey) : undefined
}

/** Read the global model, credential and default-selection files once. */
async function loadModelConfig(piDir: string): Promise<ModelConfigState> {
  const [settings, piModels] = await Promise.all([
    readObject(join(piDir, 'settings.json')),
    readObject(join(piDir, 'models.json')),
  ])
  const credentialStore = await loadCredentials(piDir)
  const credentials = new Map<string, Credential>()
  for (const info of await credentialStore.list()) {
    const credential = await credentialStore.read(info.providerId)
    if (credential) credentials.set(info.providerId, credential)
  }
  const piProviders = isObject(piModels?.providers) ? piModels.providers : {}
  const merged = new Map<string, StoredProvider>()
  for (const [id, raw] of Object.entries(piProviders)) {
    if (raw === false || !isObject(raw) || raw.enabled === false) continue
    if (!Array.isArray(raw.models)) continue
    const models = raw.models.filter(isObject).map(model => upgradeStoredModel(model))
    merged.set(id, {
      id,
      name: typeof raw.name === 'string' ? raw.name : id,
      // A model-level endpoint or the shipped provider may supply the base URL.
      baseUrl: typeof raw.baseUrl === 'string' ? raw.baseUrl : '',
      ...(typeof raw.api === 'string' ? { api: raw.api } : {}),
      ...(stringRecord(raw.headers) ? { headers: stringRecord(raw.headers) } : {}),
      ...(isObject(raw.compat) ? { compat: raw.compat } : {}),
      models,
    })
  }
  const defaultModel = configuredDefault(settings)
  const defaultThinkingLevel = configuredThinking(settings)
  return {
    credentials,
    piProviders,
    merged,
    defaultModel,
    defaultThinkingLevel,
    signature: JSON.stringify({
      piProviders,
      credentials: [...credentials],
      defaultModel,
      defaultThinkingLevel,
    }),
  }
}

export async function createModelRuntime(options: { dataDir: string; piDir?: string }): Promise<RuntimeModels> {
  const dataDir = resolve(options.dataDir)
  await mkdir(dataDir, { recursive: true, mode: 0o700 })
  await chmod(dataDir, 0o700)
  const piDir = resolve(options.piDir ?? dataDir)
  const credentials = await loadCredentials(piDir)
  const modelCollection = builtinModels({ credentials, authContext: defaultProviderAuthContext() })
  const builtinProviderIds = new Set(modelCollection.getProviders().map((provider) => provider.id))
  const builtinProviders = new Map(modelCollection.getProviders().map((provider) => [provider.id, provider]))

  let state = await loadModelConfig(piDir)
  const modelsPath = join(piDir, 'models.json')
  const authPath = join(piDir, 'auth.json')
  let defaultModel = state.defaultModel
  let defaultThinkingLevel = state.defaultThinkingLevel
  let saveChain: Promise<unknown> = Promise.resolve()
  const saveSerially = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = saveChain.then(operation, operation)
    saveChain = result.then(() => undefined, () => undefined)
    return result
  }
  const listeners = new Set<() => void>()
  let closed = false
  const notify = (): void => {
    for (const listener of [...listeners]) {
      try { listener() } catch { /* a client event handler must not break the reload */ }
    }
  }

  /**
   * Rebuild the live collection in place: Pi holds this exact `models` object
   * for the whole process, so replacing it would leave runs and compaction on
   * a stale catalog. Credentials are synced first, then every builtin provider
   * is restored and every configured provider layered over it.
   */
  const apply = async (next: ModelConfigState): Promise<void> => {
    const target = new Map<string, Credential>(next.credentials)
    const keys = new Map<string, string | undefined>()
    for (const provider of next.merged.values()) {
      const key = providerApiKey(provider, next)
      keys.set(provider.id, key)
      if (key !== undefined) target.set(provider.id, { type: 'api_key', key })
    }
    for (const info of await credentials.list()) {
      if (!target.has(info.providerId)) await credentials.delete(info.providerId)
    }
    for (const [id, credential] of target) await credentials.modify(id, async () => credential)
    modelCollection.clearProviders()
    for (const provider of builtinProviders.values()) modelCollection.setProvider(provider)
    for (const provider of next.merged.values()) {
      modelCollection.setProvider(customProvider(provider, keys.get(provider.id), builtinProviders.get(provider.id)))
    }
    state = next
    defaultModel = next.defaultModel
    defaultThinkingLevel = next.defaultThinkingLevel
  }
  await apply(state)

  const reloadNow = async (announce: boolean): Promise<void> => {
    if (closed) return
    const next = await loadModelConfig(piDir)
    if (next.signature === state.signature) return
    await apply(next)
    if (announce) notify()
  }
  const reload = (): Promise<void> => saveSerially(async () => {
    try { await reloadNow(true) } catch { /* keep the last good catalog while a file is mid-write or invalid */ }
  })

  // Saving through the API and editing the files on disk both land here. The
  // directory watcher catches atomic renames that a file watcher would miss.
  const watchedNames = new Set(['models.json', 'auth.json', 'settings.json'])
  const watchers: FSWatcher[] = []
  let reloadTimer: ReturnType<typeof setTimeout> | undefined
  const scheduleReload = (): void => {
    if (closed) return
    if (reloadTimer !== undefined) clearTimeout(reloadTimer)
    reloadTimer = setTimeout(() => {
      reloadTimer = undefined
      void reload().catch(() => undefined)
    }, 120)
    reloadTimer.unref?.()
  }
  try {
    const watcher = watch(piDir, { persistent: false }, (_event, filename) => {
      if (filename === null || watchedNames.has(String(filename))) scheduleReload()
    })
    watcher.on('error', () => undefined)
    watchers.push(watcher)
  } catch {
    // A missing or unwatchable directory keeps the catalog usable; the next
    // explicit refresh still picks the files up.
  }

  return {
    models: modelCollection,
    get defaultModel() { return defaultModel },
    get defaultThinkingLevel() { return defaultThinkingLevel },
    subscribe(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    close() {
      closed = true
      if (reloadTimer !== undefined) clearTimeout(reloadTimer)
      for (const watcher of watchers) watcher.close()
      listeners.clear()
    },
    async saveProvider(input) {
      const prior = state.merged.get(input.id)
      const provider = storedProviderFromInput(input, prior)
      return saveSerially(async () => {
        const current = await readObject(modelsPath) ?? {}
        const providers = isObject(current.providers) ? { ...current.providers } : {}
        const candidate = providers[provider.id]
        const raw: JsonObject = isObject(candidate) ? candidate : {}
        const entry: JsonObject = {
          ...raw,
          name: provider.name,
          api: provider.api,
          models: provider.models,
        }
        if (provider.baseUrl !== '') entry.baseUrl = provider.baseUrl
        else delete entry.baseUrl
        if (provider.headers !== undefined) entry.headers = provider.headers
        if (provider.compat !== undefined) entry.compat = provider.compat
        providers[provider.id] = entry
        await writeJsonAtomic(modelsPath, { ...current, providers })
        if (input.apiKey !== undefined) {
          const auth = await readObject(authPath) ?? {}
          auth[provider.id] = { type: 'api_key', key: input.apiKey }
          await writeJsonAtomic(authPath, auth)
        }
        try { await reloadNow(false) } catch { /* the write landed; keep the last good catalog */ }
        notify()
      })
    },
    async provider(id) {
      const provider = modelCollection.getProvider(id)
      if (!provider) throw new RuntimeError('NOT_FOUND', 'Provider 不存在')
      const configured = Object.prototype.hasOwnProperty.call(state.piProviders, id)
      const isCustom = !builtinProviderIds.has(id)
      const source = configured ? 'project' : !builtinProviderIds.has(id) ? 'pi' : 'builtin'
      const models = provider.getModels()
      const declaredProvider = state.merged.get(id)
      const declaredModels = new Map(declaredProvider?.models.map(model => [model.id, model]) ?? [])
      const inheritedApi = declaredProvider?.api ?? models[0]?.api ?? DEFAULT_API
      const inheritedBaseUrl = provider.baseUrl ?? ''
      let authConfigured = false
      try { authConfigured = await modelCollection.checkAuth(id) !== undefined }
      catch { throw new Error(`无法读取 ${provider.name} 的认证状态`) }
      const headers = safeHeaders(provider.headers as Record<string, string> | undefined)
      const compat = models[0]?.compat
      // A global entry can be reset to the catalog the provider shipped with.
      const shipped = configured ? builtinProviders.get(id) : undefined
      const shippedModels = shipped?.getModels() ?? []
      const defaults = shippedModels.map(model => publicModel(model, undefined, {
        api: shippedModels[0]?.api ?? DEFAULT_API,
        baseUrl: shipped?.baseUrl,
      }))
      const envVars = await providerEnvVars(provider)
      const envConfigured = configuredEnv(envVars)
      return {
        id: provider.id,
        name: provider.name,
        source,
        custom: isCustom,
        configured: authConfigured,
        credentialConfigured: authConfigured,
        ...(sanitizeBaseUrl(provider.baseUrl) ? { baseUrl: sanitizeBaseUrl(provider.baseUrl) } : {}),
        ...(envVars.length > 0 ? { envVars } : {}),
        ...(envConfigured.length > 0 ? { envConfigured } : {}),
        ...(state.credentials.has(id) ? { storedCredential: true } : {}),
        api: declaredProvider?.api ?? models[0]?.api ?? DEFAULT_API,
        models: models.map(model => publicModel(model, declaredModels.get(model.id), {
          api: inheritedApi,
          baseUrl: inheritedBaseUrl,
        })),
        ...(headers ? { headers } : {}),
        ...(compat ? { compat: { ...compat } } : {}),
        ...(defaults && defaults.length > 0 ? { defaults } : {}),
      }
    },
    async deleteProvider(id) {
      return saveSerially(async () => {
        if (!Object.prototype.hasOwnProperty.call(state.piProviders, id)) {
          throw new RuntimeError('UNSUPPORTED', '只能删除全局配置中的 Provider')
        }
        const current = await readObject(modelsPath) ?? {}
        const providers = isObject(current.providers) ? { ...current.providers } : {}
        delete providers[id]
        await writeJsonAtomic(modelsPath, { ...current, providers })
        // A custom route's credential belongs to it; a builtin override keeps
        // its key because removing the override restores the shipped route.
        if (!builtinProviders.has(id)) {
          const auth = await readObject(authPath)
          if (auth && auth[id] !== undefined) {
            delete auth[id]
            await writeJsonAtomic(authPath, auth)
          }
        }
        // The full reload restores the shipped catalog this override replaced.
        try { await reloadNow(false) } catch { /* the write landed; keep the last good catalog */ }
        notify()
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
    supportedThinkingLevels(provider, modelId) {
      const model = modelCollection.getModel(provider, modelId)
      if (!model) return undefined
      if (!model.reasoning) return ['off']
      return getSupportedThinkingLevels(model).filter((level): level is ThinkingLevel => THINKING_LEVELS.includes(level as ThinkingLevel))
    },
    async catalog() {
      // A catalog read is also a cheap freshness point: an editor or another
      // pi-web instance may have rewritten the configuration since the watcher
      // last fired. Serialized with saves so an in-flight write cannot be
      // overwritten by an older read.
      await reload()
      const providerList = modelCollection.getProviders()
      const authStatuses = await Promise.all(providerList.map(async (provider) => {
        try { return [provider.id, await modelCollection.checkAuth(provider.id)] as const }
        catch { throw new Error(`无法读取 ${provider.name} 的认证状态`) }
      }))
      const configured = new Map(authStatuses.map(([id, status]) => [id, status !== undefined]))
      const providers: ProviderSummary[] = await Promise.all(providerList.map(async (provider) => {
        const global = Object.prototype.hasOwnProperty.call(state.piProviders, provider.id)
        const envVars = await providerEnvVars(provider)
        const envConfigured = configuredEnv(envVars)
        return {
          id: provider.id,
          name: provider.name,
          configured: configured.get(provider.id) ?? false,
          source: global ? 'project' : !builtinProviderIds.has(provider.id) ? 'pi' : 'builtin',
          // "Custom" means hand-declared, not merely configured: a catalog
          // route with a stored profile keeps its shipped identity.
          custom: !builtinProviderIds.has(provider.id),
          ...(sanitizeBaseUrl(provider.baseUrl) ? { baseUrl: sanitizeBaseUrl(provider.baseUrl) } : {}),
          ...(envVars.length > 0 ? { envVars } : {}),
          ...(envConfigured.length > 0 ? { envConfigured } : {}),
          ...(state.credentials.has(provider.id) ? { storedCredential: true } : {}),
        }
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
