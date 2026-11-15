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
import type { ModelCatalog, ModelOption, ProviderConfigSummary, ProviderInput, ProviderModelInput, ProviderSummary, ProviderTestResult, ThinkingLevel } from '../../shared/types.ts'
import { RuntimeError } from '../runtime-errors.ts'

/** 任意 JSON 对象的宽松形状。 */
interface JsonObject { [key: string]: unknown }
/** 落盘 models.json 的单个 Provider 记录形状。 */
interface StoredProvider {
  id: string
  name: string
  baseUrl: string
  api?: string
  headers?: Record<string, string>
  compat?: JsonObject
  models: JsonObject[]
}
/** 模型运行时契约：pi-ai 模型集合加 Provider 管理面。 */
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
  /** 某个已配置模型实际接受的等级，按升序排列。 */
  supportedThinkingLevels(provider: string, modelId: string): ThinkingLevel[] | undefined
  /** 观察目录重载（变更、保存或另一个实例的写入）。 */
  subscribe(listener: () => void): () => void
  close(): void
}

type Model = PiModel<Api>
type ProviderModel = Model

/** 运行时接受的思考等级全集（升序）。 */
const THINKING_LEVELS: ThinkingLevel[] = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']

/**
 * 功能：把请求的思考等级收敛到模型支持集合（pi-ai 的收敛规则套在自己的等级表上）。
 * @param level 请求的等级
 * @param supported 模型支持的等级列表（升序）
 * @returns 收敛后的等级；支持列表为空时返回 'off'
 * 内部逻辑：支持原级直接返回；否则先向上找最近的支持等级，再向下找；请求级
 * 不在全集表时取支持列表首项。
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
/** Provider 未显式指定时的默认 API 协议。 */
const DEFAULT_API = 'openai-completions'
/** 合法环境变量名的模式（resolvePiKey 用于区分「值即环境变量名」）。 */
const SECRET_ENV_NAME = /^[A-Z_][A-Z0-9_]*$/
/** 合法 API 协议名。 */
const API_NAME = /^[a-z0-9-]+$/
/** 合法 Provider ID。 */
const PROVIDER_ID = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/
/** 合法模型 ID。 */
const MODEL_ID = /^[^\s\u0000-\u001f]{1,256}$/

/** 类型收窄：非数组普通对象。 */
function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * 功能：把用户声明的推理等级翻译为 pi-ai 的 `thinkingLevelMap`，行为对齐 DSH 的
 * pi-ai 适配器。
 * @param value 用户声明的等级映射（raw JSON）
 * @returns 补全后的映射：未声明的等级钉在 `null`
 * 内部逻辑：用户未声明的等级一律置 null 而不是继承 pi-ai 的不对称默认；Off 条目
 * 没有线上参数值时保持缺席——「思考关闭」就不发参数。pi-ai 把缺席的 Off 读作
 * 「支持、不发参数」，显式 null 才表示无法停止思考；至少要声明一个非 Off 档位。
 */
function pinnedThinkingLevelMap(value: JsonObject): Record<string, string | null> {
  // Off 是唯一缺席有意义的等级：pi-ai 把缺席的 Off 读作「支持、不发参数」，
  // 显式 null 才表示模型无法停止思考。其余缺席的等级一律从选择器上钉掉。
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

/** 声明了等级的存量模型视为推理模型，即使旧保存把 `reasoning` 留成了 false。 */
function upgradeStoredModel(raw: JsonObject): JsonObject {
  if (!isObject(raw.thinkingLevelMap)) return raw
  try {
    return { ...raw, reasoning: true, thinkingLevelMap: pinnedThinkingLevelMap(raw.thinkingLevelMap) }
  } catch {
    return raw
  }
}

/** 读取一个 JSON 对象文件；ENOENT 返回 undefined，其余解析/读取失败抛出。 */
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

/** 从 settings.json 解析默认模型：兼容 `{provider, modelId}` 对象形与旧的 provider+modelId 字符串形。 */
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

/** 从 settings.json 解析默认思考等级；不在支持表内的值返回 undefined。 */
function configuredThinking(settings: JsonObject | undefined): ThinkingLevel | undefined {
  const value = settings?.thinkingLevel
  return typeof value === 'string' && THINKING_LEVELS.includes(value as ThinkingLevel) ? value as ThinkingLevel : undefined
}

/** 解析 Pi 凭据的 key 字段：`!` 前缀表示字面值不解析，全大写样式视为环境变量名。 */
function resolvePiKey(value: string): string | undefined {
  if (value.startsWith('!')) return undefined
  return SECRET_ENV_NAME.test(value) ? process.env[value] : value
}

/** 读取 pi 目录的 auth.json，把 api_key/oauth 凭据载入内存凭据存储。 */
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

/** 按协议名惰性加载 pi-ai 的流式 API 实现；非法名称抛出。 */
function apiStreams(apiId: string): ProviderStreams {
  if (!API_NAME.test(apiId)) throw new Error('模型 API 类型无效')
  return lazyApi(async () => {
    const module = await import(`@earendil-works/pi-ai/api/${apiId}`)
    return module as ProviderStreams
  })
}

/** 把 unknown 收敛为 `Record<string, string>`；任一值非字符串即 undefined。 */
function stringRecord(value: unknown): Record<string, string> | undefined {
  if (!isObject(value)) return undefined
  const entries = Object.entries(value)
  if (!entries.every(([, item]) => typeof item === 'string')) return undefined
  return Object.fromEntries(entries.map(([key, item]) => [key, String(item)]))
}

/**
 * 功能：把一条存档模型记录归一化为 pi-ai Model。
 * @param providerId 所属 Provider ID
 * @param providerEntry Provider 级字段（api/baseUrl/compat 作回退）
 * @param raw 模型级存档记录
 * @returns 归一化模型；模型 ID 非法时返回 undefined（该条目被丢弃）
 * 内部逻辑：api/baseUrl 逐级回退（模型 → Provider → 默认）；input 过滤出合法
 * 枚举、缺省 text；cost 各项带非负回退、支持分层计价；contextWindow/maxTokens
 * 带正整数回退；可选的 headers/inputLimits/thinkingLevelMap 等按存在性透传。
 */
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

/** 非负有限数取值，否则用回退值。 */
function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback
}

/** 正安全整数取值，否则用回退值。 */
function positiveNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : fallback
}

/** 保留内置 Provider 的流式方法绑定（自定义 Provider 复用其实现）。 */
function retainedStreams(provider: Provider): ProviderStreams {
  return {
    stream: provider.stream.bind(provider),
    streamSimple: provider.streamSimple.bind(provider),
    ...(provider.fetchDeferred ? { fetchDeferred: provider.fetchDeferred.bind(provider) } : {}),
    ...(provider.cancelDeferred ? { cancelDeferred: provider.cancelDeferred.bind(provider) } : {}),
  }
}

/**
 * 功能：由存档记录构建一个自定义（或覆盖内置）Provider。
 * @param entry 落盘的 Provider 记录
 * @param key models.json 里 Provider 级 apiKey（可缺省）
 * @param builtin 同 ID 的内置 Provider（覆盖场景复用其 baseUrl/headers/auth/流实现）
 * @returns 可交给 models.setProvider 的 Provider
 * 内部逻辑：模型目录完全以存档为准——与内置目录合并会把用户删掉的模型复活。
 * 内置 Provider 存在时保留其 auth；否则用本地 API key 解析器。
 */
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
  // 显式（项目或导入）的 Provider 条目独占其模型目录。与内置目录合并会把
  // 用户删掉的模型复活。
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
  } catch { /* 解析失败前问过的环境变量名仍然保留 */ }
  return names.filter(name => !name.toLocaleLowerCase().includes('oauth'))
}

/** 过滤出当前进程环境里已配置（非空）的环境变量名。 */
function configuredEnv(names: readonly string[]): string[] {
  return names.filter(name => {
    const value = process.env[name]
    return value !== undefined && value.trim() !== ''
  })
}

/** 清洗 Base URL 用于展示：去掉凭据、查询串与哈希，保留 origin + 路径。 */
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

/** 过滤掉敏感头（Authorization/api-key/token/secret/cookie）用于展示。 */
function safeHeaders(value: Record<string, string> | undefined): Record<string, string> | undefined {
  if (!value) return undefined
  const entries = Object.entries(value).filter(([name]) => !/authorization|api[-_]?key|token|secret|cookie/i.test(name))
  return entries.length ? Object.fromEntries(entries) : undefined
}

/**
 * 功能：把内部模型转成对客户端暴露的形状（ProviderConfigSummary.models 条目）。
 * @param model 内部模型
 * @param declared 该模型的存档声明；缺省表示「内置目录原样」
 * @param inherited Provider 级继承值，用于判断 api/baseUrl 是否需要单独列出
 * @returns 脱敏后的模型条目（headers 已过滤，成本/等级映射等浅拷贝）
 */
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

/** 对 Provider 错误文本脱敏（Authorization/Bearer/key/token/带凭据的 URL）并压平为 ≤400 字符。 */
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

/** 原子写 JSON 文件：临时文件（0600）+ rename，目录 0700，失败清理临时文件。 */
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

/**
 * 功能：把编辑器提交的 Provider 输入校验并归一化为存档形状。
 * @param input 编辑器提交的目录
 * @param previous 既有存档记录（继承字段与逐模型遗留字段）
 * @returns 落盘用的 StoredProvider
 * 内部逻辑：ID/名称/Base URL/模型列表逐项校验（≤500 个模型、URL 仅 http(s)）；
 * 空白 Base URL 表示「Provider 默认」，此时每个模型必须自带 endpoint。声明等级
 * 即成为推理模型（DSH 的 reasoningEfforts 语义），显式 reasoning:false 清除继承的
 * 映射；模型 ID 不重复；apiKey 限 16k。
 */
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
    // 声明等级就是让模型成为推理模型，与 DSH 的 reasoningEfforts 一致。显式
    // `reasoning: false` 清除上一次保存继承的映射；省略则保留。
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

/** 一次模型配置读取的结果快照：凭据、Provider 记录、默认选择与变更签名。 */
interface ModelConfigState {
  credentials: Map<string, Credential>
  piProviders: JsonObject
  merged: Map<string, StoredProvider>
  defaultModel?: ModelRef
  defaultThinkingLevel?: ThinkingLevel
  /** 重载读取的全部内容：签名不变时 watch 事件不重建目录。 */
  signature: string
}

/** 从 models.json 的 Provider 级字段解析 apiKey（支持环境变量引用）。 */
function providerApiKey(provider: StoredProvider, state: Pick<ModelConfigState, 'piProviders'>): string | undefined {
  const piProvider = state.piProviders[provider.id]
  return isObject(piProvider) && typeof piProvider.apiKey === 'string' ? resolvePiKey(piProvider.apiKey) : undefined
}

/** 功能：一次性读取全局模型、凭据与默认选择文件（settings.json / models.json / auth.json）。 */
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
      // 模型级 endpoint 或出厂 Provider 都可能补上 Base URL。
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

/**
 * 功能：创建真实模型运行时：加载全局配置与凭据、搭建内置目录、订阅配置文件变化，
 * 并暴露 Provider 保存/删除/测试/发现与目录读取。
 * @param options 应用数据目录与可选 pi 目录（默认同数据目录）
 * @returns RuntimeModels 实现；demo 运行不使用本工厂
 * 内部逻辑：models 对象整个进程只此一份（Pi 持有引用，替换会让运行中的请求落在
 * 旧目录上），重载原地重建；保存串行化（saveSerially），文件监视（目录级 watch +
 * 120ms 防抖）捕捉原子改名；目录读取兼作新鲜度检查点。
 */
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
  /** 把落盘操作串行化到同一条链上，避免并发写互相覆盖。 */
  const saveSerially = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = saveChain.then(operation, operation)
    saveChain = result.then(() => undefined, () => undefined)
    return result
  }
  const listeners = new Set<() => void>()
  let closed = false
  /** 通知全部目录订阅者；单个客户端事件处理不得中断重载。 */
  const notify = (): void => {
    for (const listener of [...listeners]) {
      try { listener() } catch { /* 客户端事件处理失败不得中断重载 */ }
    }
  }

  /**
   * 功能：把新配置状态应用到活集合。
   * @param next loadModelConfig 的新快照
   * @returns 无返回；应用完成后更新 state 与默认模型/等级
   * 内部逻辑：原地重建活的集合——Pi 整个进程持有这个 `models` 对象，替换它会让
   * 运行与压缩落在旧目录上。先同步凭据（删除消失的、写入新的），再恢复全部内置
   * Provider，最后把每个已配置 Provider 覆盖上去。
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

  /** 重读配置并按签名去重应用；announce 控制是否通知订阅者。 */
  const reloadNow = async (announce: boolean): Promise<void> => {
    if (closed) return
    const next = await loadModelConfig(piDir)
    if (next.signature === state.signature) return
    await apply(next)
    if (announce) notify()
  }
  /** 串行化重载；文件写入中途或损坏时保留上一个可用目录。 */
  const reload = (): Promise<void> => saveSerially(async () => {
    try { await reloadNow(true) } catch { /* 文件写入中途或损坏时保留上一个可用目录 */ }
  })

  // 经 API 保存与直接编辑磁盘文件都会落到这里。目录级监视器能捕捉
  // 文件监视器会漏掉的原子改名。
  const watchedNames = new Set(['models.json', 'auth.json', 'settings.json'])
  const watchers: FSWatcher[] = []
  let reloadTimer: ReturnType<typeof setTimeout> | undefined
  /** 120ms 防抖的重载排程；连续写只触发一次。 */
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
    // 目录缺失或不可监视时目录仍可用；下一次显式刷新仍会读取这些文件。
  }

  return {
    models: modelCollection,
    get defaultModel() { return defaultModel },
    get defaultThinkingLevel() { return defaultThinkingLevel },
    /** 订阅目录重载通知，返回取消订阅函数。 */
    subscribe(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    /** 关闭监视器与通知集合；已关闭后重载为无操作。 */
    close() {
      closed = true
      if (reloadTimer !== undefined) clearTimeout(reloadTimer)
      for (const watcher of watchers) watcher.close()
      listeners.clear()
    },
    /**
     * 功能：保存一个 Provider 配置并即时生效。
     * @param input 编辑器提交的目录
     * @returns 无返回；写盘成功即重载并通知
     * 内部逻辑：先由 storedProviderFromInput 校验归一化，再串行写 models.json
     * （原子写）、按需写 auth.json，随后 reloadNow 应用并 notify。
     */
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
    /**
     * 功能：读取单个 Provider 的配置摘要（编辑器渲染所需）。
     * @param id Provider ID
     * @returns 摘要：来源（project/pi/builtin）、凭据状态、环境变量、脱敏模型与恢复列表
     * 内部逻辑：declared 逐模型决定 api/baseUrl 是否单独列出；configured 时附
     * 出厂目录 defaults 供「恢复出厂」；认证状态读取失败抛错。
     */
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
      // 全局条目可以重置到 Provider 出厂时的目录。
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
    /**
     * 功能：删除全局配置中的一个 Provider 覆盖。
     * @param id Provider ID
     * @returns 无返回；只允许删除全局配置中的 Provider
     * 内部逻辑：串行写 models.json 移除条目；自定义 Provider 的凭据一并删除，
     * 内置覆盖保留 key（移除覆盖即恢复出厂路由）；随后整目录重载恢复出厂数据。
     */
    async deleteProvider(id) {
      return saveSerially(async () => {
        if (!Object.prototype.hasOwnProperty.call(state.piProviders, id)) {
          throw new RuntimeError('UNSUPPORTED', '只能删除全局配置中的 Provider')
        }
        const current = await readObject(modelsPath) ?? {}
        const providers = isObject(current.providers) ? { ...current.providers } : {}
        delete providers[id]
        await writeJsonAtomic(modelsPath, { ...current, providers })
        // 自定义路由的凭据属于它；内置覆盖保留 key，因为移除覆盖即恢复出厂路由。
        if (!builtinProviders.has(id)) {
          const auth = await readObject(authPath)
          if (auth && auth[id] !== undefined) {
            delete auth[id]
            await writeJsonAtomic(authPath, auth)
          }
        }
        // 完整重载恢复被覆盖替换的出厂目录。
        try { await reloadNow(false) } catch { /* 写盘已落地；保留上一个可用目录 */ }
        notify()
      })
    },
    /**
     * 功能：对指定 Provider/模型发一次极小探针请求以测试连通性。
     * @param id Provider ID
     * @param modelId 可选模型 ID，缺省用该 Provider 第一个模型
     * @returns connected/failed 与脱敏错误信息；永不抛出
     * 内部逻辑：20s 超时、无重试、16 token 上限；stopReason error 与异常都算失败。
     */
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
    /** 询问 Provider 端点提供的模型 ID 清单，供目录一键填入。 */
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
    /** 返回某模型支持的思考等级；非推理模型只有 off，模型未知返回 undefined。 */
    supportedThinkingLevels(provider, modelId) {
      const model = modelCollection.getModel(provider, modelId)
      if (!model) return undefined
      if (!model.reasoning) return ['off']
      return getSupportedThinkingLevels(model).filter((level): level is ThinkingLevel => THINKING_LEVELS.includes(level as ThinkingLevel))
    },
    /**
     * 功能：读取完整模型目录（Provider 摘要 + 模型选项 + 默认选择）。
     * @returns 目录快照；available 表示该 Provider 凭据已配置
     * 内部逻辑：先串行 reload 兼作廉价的新鲜度检查点（编辑器或另一个 pi-web 实例
     * 可能重写了配置），再逐 Provider 探测认证状态；custom 指「手工声明」而非
     * 「已配置」——带存档档案的目录路由保留其出厂身份。
     */
    async catalog() {
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
          // "custom" 指手工声明而非仅仅已配置：带存档档案的目录路由保留出厂身份。
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
