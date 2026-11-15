import { createHash } from 'node:crypto'
import { isAbsolute } from 'node:path'
import { z } from 'zod'
import { RuntimeError } from '../runtime-errors.ts'

/** 插件名模式：小写字母/数字开头，可含 `.` `_` `-`，最长 128。 */
export const PLUGIN_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]{0,127}$/u
/** 市场 ID 模式：同插件名但最长 64。 */
export const MARKETPLACE_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/u
/** 完整插件 ID 模式：`名称@市场`。 */
export const PLUGIN_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,127}@[a-z0-9][a-z0-9._-]{0,63}$/u

/** marketplace.json 下载大小上限（4 MB）。 */
export const MAX_MARKETPLACE_BYTES = 4 * 1024 * 1024
/** 插件压缩包大小上限（100 MB）。 */
export const MAX_PLUGIN_ARCHIVE_BYTES = 100 * 1024 * 1024
/** 单个插件包文件数上限。 */
export const MAX_PLUGIN_FILES = 20_000
/** 插件包内单文件大小上限（20 MB）。 */
export const MAX_PLUGIN_FILE_BYTES = 20 * 1024 * 1024
/** plugin.json 大小上限（512 KB）。 */
export const MAX_PLUGIN_MANIFEST_BYTES = 512 * 1024

/** 兼容的 manifest 目录（按优先顺序探测 plugin.json）。 */
export const PLUGIN_MANIFEST_DIRECTORIES = ['.pi-plugin', '.zcode-plugin', '.claude-plugin'] as const
/** 本仓库尚不支持、manifest 中出现即列入 unsupported 的能力键。 */
export const UNSUPPORTED_CAPABILITIES = ['commands', 'agents', 'hooks', 'lspServers', 'outputStyles', 'channels'] as const

const SHA256 = /^[a-f0-9]{64}$/iu
const pluginName = z.string().regex(PLUGIN_NAME_PATTERN)
const relativePath = z.string().min(1).max(2_048)
const url = z.string().url().max(2_048)

/** plugin.json 中单个 MCP server 的声明。 */
const mcpServerSchema = z.object({
  command: z.string().min(1).max(1_024),
  args: z.array(z.string().max(2_048)).max(64).optional(),
  env: z.record(z.string().max(256), z.string().max(4_096)).optional(),
  exposure: z.enum(['direct', 'codemode', 'deferred', 'hidden']).optional(),
}).strict()

/** 插件 UI 面声明：页面绑定到某个 MCP server 的资源。 */
const uiSurfaceSchema = z.object({
  id: pluginName,
  title: z.string().min(1).max(120),
  server: z.string().min(1).max(128),
  resourceUri: z.string().min(1).max(2_048),
  availability: z.literal('session').optional(),
  icon: url.optional(),
}).strict()

/** plugin.json 顶层 schema；passthrough 保留未知键，不支持的键另行汇总进 unsupported。 */
const manifestSchema = z.object({
  name: pluginName,
  version: z.string().min(1).max(64),
  description: z.string().max(2_000).optional(),
  author: z.union([z.string().max(200), z.object({ name: z.string().max(200), url: url.optional() }).strict()]).optional(),
  homepage: url.optional(),
  skills: z.array(relativePath).max(32).optional(),
  mcpServers: z.record(z.string().min(1).max(128), mcpServerSchema).optional(),
  ui: z.object({ surfaces: z.array(uiSurfaceSchema).max(32) }).strict().optional(),
  dependencies: z.array(pluginName).max(32).optional(),
  commands: z.unknown().optional(),
  agents: z.unknown().optional(),
  hooks: z.unknown().optional(),
  lspServers: z.unknown().optional(),
  outputStyles: z.unknown().optional(),
  channels: z.unknown().optional(),
  npm: z.unknown().optional(),
  pip: z.unknown().optional(),
}).passthrough()

/** 目录条目的展示信息（名称、图标、示例提示词等）。 */
const catalogListingSchema = z.object({
  displayName: z.string().min(1).max(120).optional(),
  displayName_i18n: z.record(z.string().max(32), z.string().max(120)).optional(),
  icon: url.optional(),
  homepage: url.optional(),
  privacyPolicy: url.optional(),
  termsOfService: url.optional(),
  heroImage: url.optional(),
  examplePrompts: z.array(z.string().max(1_000)).max(20).optional(),
}).passthrough()

/** 原始来源声明：字符串（相对路径或 URL）或带 source 键的对象形式。 */
const sourceSchema = z.union([
  z.string().min(1).max(2_048),
  z.object({ source: z.literal('directory'), path: relativePath }).strict(),
  z.object({ source: z.literal('url'), type: z.literal('zip'), url, sha256: z.string().regex(SHA256) }).strict(),
  z.object({ source: z.literal('github'), repo: z.string().min(1).max(500), ref: z.string().max(200).optional(), path: z.string().max(1_000).optional() }).passthrough(),
  z.object({ source: z.literal('git'), url: z.string().min(1).max(2_048), ref: z.string().max(200).optional(), path: z.string().max(1_000).optional() }).passthrough(),
  z.object({ source: z.literal('npm') }).passthrough(),
  z.object({ source: z.literal('pip') }).passthrough(),
])

/** marketplace.json 中单个插件条目的 schema。 */
const catalogPluginSchema = z.object({
  name: pluginName,
  version: z.string().min(1).max(64),
  description: z.string().max(2_000).optional(),
  category: z.string().max(80).optional(),
  source: sourceSchema,
  listing: catalogListingSchema.optional(),
}).passthrough()

/** marketplace.json 顶层 schema；passthrough 保留未知键。 */
export const catalogSchema = z.object({
  name: z.string().min(1).max(120),
  description: z.string().max(2_000).optional(),
  owner: z.object({ name: z.string().max(200) }).passthrough().optional(),
  featured: z.array(pluginName).max(200).optional(),
  plugins: z.array(catalogPluginSchema).max(2_000),
}).passthrough()

/** 已注册市场清单文件（marketplaces.json）的 schema。 */
export const marketplacesFileSchema = z.object({
  version: z.literal(1),
  marketplaces: z.array(z.object({
    id: z.string().regex(MARKETPLACE_ID_PATTERN),
    name: z.string().min(1).max(120),
    source: z.string().min(1).max(4_096),
    kind: z.enum(['directory', 'url']),
    lastUpdated: z.number().finite(),
    lastError: z.string().max(1_000).optional(),
  }).strict()).max(200),
}).strict()

/** 归一化后的来源（按 kind 判别），无效来源归入 unsupported 并附原因。 */
const normalizedSourceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('directory'), path: z.string().min(1).max(2_048), display: z.literal('directory') }).strict(),
  z.object({ kind: z.literal('zip'), url: url, sha256: z.string().regex(SHA256), display: z.literal('zip') }).strict(),
  z.object({
    kind: z.literal('github'),
    repo: z.string().min(3).max(500),
    ref: z.string().max(200).optional(),
    path: z.string().max(1_000).optional(),
    display: z.literal('github'),
  }).strict(),
  z.object({
    kind: z.literal('git'),
    url: z.string().min(1).max(2_048),
    ref: z.string().max(200).optional(),
    path: z.string().max(1_000).optional(),
    display: z.literal('git'),
  }).strict(),
  z.object({ kind: z.literal('unsupported'), display: z.string().max(80), reason: z.string().max(500) }).strict(),
])

/** 归一化后的目录（strict），是缓存与展示统一使用的形状。 */
export const normalizedCatalogSchema = z.object({
  name: z.string().min(1).max(120),
  description: z.string().max(2_000).optional(),
  featured: z.array(pluginName).max(200),
  plugins: z.array(z.object({
    name: pluginName,
    version: z.string().min(1).max(64),
    description: z.string().max(2_000).optional(),
    category: z.string().max(80).optional(),
    source: normalizedSourceSchema,
    listing: catalogListingSchema.optional(),
  }).strict()).max(2_000),
}).strict()

/** 目录缓存文件 schema：记录抓取时间与归一化目录。 */
export const catalogCacheSchema = z.object({
  version: z.literal(1),
  fetchedAt: z.number().finite(),
  catalog: normalizedCatalogSchema,
}).strict()

/** 已安装插件台账（installed.json）的 schema，含来源指纹与事务 ID（供 staging 回滚）。 */
export const installedFileSchema = z.object({
  version: z.literal(1),
  plugins: z.array(z.object({
    id: z.string().regex(PLUGIN_ID_PATTERN),
    name: z.string().regex(PLUGIN_NAME_PATTERN),
    marketplace: z.string().regex(MARKETPLACE_ID_PATTERN),
    version: z.string().min(1).max(64),
    installPath: z.string().min(1),
    installedAt: z.number().finite(),
    updatedAt: z.number().finite(),
    enabled: z.boolean(),
    sourceFingerprint: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
    dependencies: z.array(z.string().regex(PLUGIN_ID_PATTERN)).max(64),
    transactionId: z.string().min(1).max(80),
    sourceType: z.enum(['directory', 'zip', 'github', 'git']),
  }).strict()).max(500),
}).strict()

/** 目录条目的展示信息类型。 */
export type CatalogListing = z.infer<typeof catalogListingSchema>
/** 归一化后的插件来源：本地目录 / 带校验和的 zip / GitHub / git 仓库，或带原因的 unsupported。 */
export type NormalizedPluginSource =
  | { kind: 'directory'; path: string; display: string }
  | { kind: 'zip'; url: string; sha256: string; display: string }
  | { kind: 'github'; repo: string; ref?: string; path?: string; display: string }
  | { kind: 'git'; url: string; ref?: string; path?: string; display: string }
  | { kind: 'unsupported'; display: string; reason: string }

/** 目录中的一个插件条目（归一化后）。 */
export interface CatalogPluginEntry {
  name: string
  version: string
  description?: string
  category?: string
  source: NormalizedPluginSource
  listing?: CatalogListing
}

/** 归一化后的市场目录：名称、描述、精选列表与插件条目。 */
export interface NormalizedCatalog {
  name: string
  description?: string
  featured: string[]
  plugins: CatalogPluginEntry[]
}

/** 解析并校验后的 plugin.json（默认值已填齐：args/env/exposure、uiSurfaces、dependencies）。 */
export interface PluginManifest {
  name: string
  version: string
  description?: string
  author?: string
  homepage?: string
  skills: string[]
  mcpServers: Record<string, { command: string; args: string[]; env: Record<string, string>; exposure: 'direct' | 'codemode' | 'deferred' | 'hidden' }>
  uiSurfaces: Array<{ id: string; title: string; server: string; resourceUri: string; icon?: string }>
  dependencies: string[]
  unsupported: string[]
}

/** 一个已启用的插件 MCP server 配置，`${PLUGIN_ROOT}` / `${PLUGIN_DATA}` 占位符已展开。 */
export interface PluginMcpServerConfig {
  pluginId: string
  pluginName: string
  /** manifest 里的键名（`mcpServers.<name>`）。 */
  serverKey: string
  /** MCP 注册表与 code mode 看到的带命名空间 server 名（`plugin_<plugin>_<server>`）。 */
  serverName: string
  command: string
  args: string[]
  env: Record<string, string>
  cwd: string
  /** 插件私有数据目录，同时以 `PLUGIN_DATA` 导出给 server 进程。 */
  dataPath: string
  exposure: 'direct' | 'codemode' | 'deferred' | 'hidden'
  description?: string
}

/** 拼出完整插件 ID：`名称@市场`。 */
export function pluginIdOf(name: string, marketplace: string): string {
  return `${name}@${marketplace}`
}

/**
 * 功能：把插件 ID 拆回名称与市场两部分。
 * @returns `{ name, marketplace }`；格式不匹配抛 PLUGIN_NOT_FOUND
 */
export function parsePluginId(value: string): { name: string; marketplace: string } {
  if (!PLUGIN_ID_PATTERN.test(value)) throw new RuntimeError('PLUGIN_NOT_FOUND', 'Plugin id is invalid')
  const delimiter = value.lastIndexOf('@')
  return { name: value.slice(0, delimiter), marketplace: value.slice(delimiter + 1) }
}

/**
 * 功能：由市场名称生成稳定的市场 ID（slug）。
 * 内部逻辑：小写、非法字符替换为 `-`、去首尾 `-`、截断到 48 字符；清空后
 * 回退为 `marketplace-<名称哈希前 8 位>`。
 */
export function marketplaceIdFor(name: string): string {
  const slug = name.toLowerCase().replace(/[^a-z0-9._-]+/gu, '-').replace(/^-+|-+$/gu, '').slice(0, 48)
  if (slug.length === 0) return `marketplace-${createHash('sha256').update(name).digest('hex').slice(0, 8)}`
  return slug
}

/** 生成 `plugin_<plugin>_<server>` 形式的 server 名，与其余 MCP 命名空间规则一致；非法字符归一为 `_`，空段回退占位词。 */
export function pluginServerName(plugin: string, server: string): string {
  const sanitize = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/gu, '_').replace(/^_+|_+$/gu, '').slice(0, 60)
  return `plugin_${sanitize(plugin) || 'plugin'}_${sanitize(server) || 'server'}`
}

/** 由插件 ID 生成数据目录名：`<名称slug>-<插件ID哈希前8位>`，避免同名不同市场冲突。 */
export function dataDirectoryName(pluginId: string): string {
  const { name } = parsePluginId(pluginId)
  const slug = name.toLowerCase().replace(/[^a-z0-9._-]+/gu, '-').replace(/^-+|-+$/gu, '').slice(0, 48)
  return `${slug || 'plugin'}-${createHash('sha256').update(pluginId).digest('hex').slice(0, 8)}`
}

const GITHUB_REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u
const GIT_REF = /^[A-Za-z0-9._/-]{1,200}$/u

/** 校验 git/GitHub ref：含非法字符、以 `-` 开头或路径段为 `..`/空时返回 'invalid'，undefined 原样通过。 */
function safeRef(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  if (!GIT_REF.test(value) || value.startsWith('-') || value.split('/').some(segment => segment === '..' || segment === '')) return 'invalid'
  return value
}

/**
 * 功能：把目录条目的原始来源归一化为可执行的物化指令（各来源物化规则见 source.ts）。
 * @param value 原始 source 值（字符串或对象）
 * @param marketplaceKind 市场本身是本地目录还是 URL，决定相对路径包是否合法
 * @returns NormalizedPluginSource；无法支持的来源返回 unsupported 并附模型可读原因
 * 内部逻辑：裸字符串 http(s) 视为未签名 URL 拒绝（zip 必须带 sha256）；本地市场的
 * 裸字符串/ directory 条目解析为本地目录包；url 市场不允许相对路径包；zip 校验和
 * 转小写；github 校验 owner/repo 形状与 ref/path 安全性；git 同理；npm/pip 暂不支持。
 */
export function normalizePluginSource(value: unknown, marketplaceKind: 'directory' | 'url'): NormalizedPluginSource {
  const parsed = sourceSchema.safeParse(value)
  if (!parsed.success) return { kind: 'unsupported', display: 'invalid', reason: 'The catalog source entry is invalid' }
  const source = parsed.data
  if (typeof source === 'string') {
    if (/^https?:\/\//iu.test(source)) {
      return { kind: 'unsupported', display: 'url', reason: 'Remote zips must declare a sha256 checksum' }
    }
    if (marketplaceKind === 'url') {
      return { kind: 'unsupported', display: 'relative', reason: 'Relative package paths need a local marketplace directory' }
    }
    return { kind: 'directory', path: source, display: 'directory' }
  }
  if (source.source === 'directory') {
    if (marketplaceKind === 'url') return { kind: 'unsupported', display: 'directory', reason: 'Directory packages need a local marketplace' }
    return { kind: 'directory', path: source.path, display: 'directory' }
  }
  if (source.source === 'url' && source.type === 'zip') {
    return { kind: 'zip', url: source.url, sha256: source.sha256.toLowerCase(), display: 'zip' }
  }
  if (source.source === 'github') {
    if (!GITHUB_REPO.test(source.repo)) {
      return { kind: 'unsupported', display: 'github', reason: 'GitHub sources must name "owner/repository"' }
    }
    const ref = safeRef(source.ref)
    if (ref === 'invalid') return { kind: 'unsupported', display: 'github', reason: 'The GitHub ref is invalid' }
    const path = source.path === undefined ? undefined : safePluginRelativePath(source.path)
    if (source.path !== undefined && path === undefined) {
      return { kind: 'unsupported', display: 'github', reason: 'The GitHub package path must stay inside the repository' }
    }
    return { kind: 'github', repo: source.repo, ...(ref === undefined ? {} : { ref }), ...(path === undefined ? {} : { path }), display: 'github' }
  }
  if (source.source === 'git') {
    const ref = safeRef(source.ref)
    if (ref === 'invalid') return { kind: 'unsupported', display: 'git', reason: 'The git ref is invalid' }
    const path = source.path === undefined ? undefined : safePluginRelativePath(source.path)
    if (source.path !== undefined && path === undefined) {
      return { kind: 'unsupported', display: 'git', reason: 'The git package path must stay inside the repository' }
    }
    return { kind: 'git', url: source.url, ...(ref === undefined ? {} : { ref }), ...(path === undefined ? {} : { path }), display: 'git' }
  }
  return { kind: 'unsupported', display: String(source.source), reason: `Source "${String(source.source)}" is not supported yet` }
}

/**
 * 功能：解析 marketplace.json 为归一化目录，逐条目归一化来源。
 * @param value 待解析的 JSON 值
 * @param marketplaceKind 市场类型，透传给 normalizePluginSource
 * @returns NormalizedCatalog；顶层 schema 不符抛 PLUGIN_SOURCE_INVALID
 */
export function normalizeCatalog(value: unknown, marketplaceKind: 'directory' | 'url'): NormalizedCatalog {
  const parsed = catalogSchema.safeParse(value)
  if (!parsed.success) throw new RuntimeError('PLUGIN_SOURCE_INVALID', `marketplace.json is invalid: ${parsed.error.issues[0]?.message ?? 'schema mismatch'}`)
  const catalog = parsed.data
  const plugins: CatalogPluginEntry[] = []
  for (const entry of catalog.plugins) {
    plugins.push({
      name: entry.name,
      version: entry.version,
      ...(entry.description === undefined ? {} : { description: entry.description }),
      ...(entry.category === undefined ? {} : { category: entry.category }),
      source: normalizePluginSource(entry.source, marketplaceKind),
      ...(entry.listing === undefined ? {} : { listing: entry.listing }),
    })
  }
  return {
    name: catalog.name,
    ...(catalog.description === undefined ? {} : { description: catalog.description }),
    featured: catalog.featured ?? [],
    plugins,
  }
}

/**
 * 功能：解析并校验 plugin.json，填齐默认值并交叉验证 UI 面引用。
 * @param value 待解析的 JSON 值
 * @returns PluginManifest（args/env 空缺补空、exposure 默认 codemode、skills/dependencies 空缺补空数组）
 * 内部逻辑：schema 不符抛 PLUGIN_SOURCE_INVALID；manifest 中出现 UNSUPPORTED_CAPABILITIES
 * 里的键即记入 unsupported；每个 uiSurface 必须引用已声明的 MCP server，否则报错。
 */
export function parsePluginManifest(value: unknown): PluginManifest {
  const parsed = manifestSchema.safeParse(value)
  if (!parsed.success) throw new RuntimeError('PLUGIN_SOURCE_INVALID', `plugin.json is invalid: ${parsed.error.issues[0]?.message ?? 'schema mismatch'}`)
  const manifest = parsed.data
  const unsupported = UNSUPPORTED_CAPABILITIES.filter(key => manifest[key] !== undefined)
  const mcpServers: PluginManifest['mcpServers'] = {}
  for (const [name, server] of Object.entries(manifest.mcpServers ?? {})) {
    mcpServers[name] = {
      command: server.command,
      args: server.args ?? [],
      env: server.env ?? {},
      exposure: server.exposure ?? 'codemode',
    }
  }
  const uiSurfaces = manifest.ui?.surfaces ?? []
  for (const surface of uiSurfaces) {
    if (mcpServers[surface.server] === undefined) {
      throw new RuntimeError('PLUGIN_SOURCE_INVALID', `UI surface "${surface.id}" references unknown MCP server "${surface.server}"`)
    }
  }
  const author = typeof manifest.author === 'string' ? manifest.author : manifest.author?.name
  return {
    name: manifest.name,
    version: manifest.version,
    ...(manifest.description === undefined ? {} : { description: manifest.description }),
    ...(author === undefined ? {} : { author }),
    ...(manifest.homepage === undefined ? {} : { homepage: manifest.homepage }),
    skills: manifest.skills ?? [],
    mcpServers,
    uiSurfaces: uiSurfaces.map(surface => ({
      id: surface.id,
      title: surface.title,
      server: surface.server,
      resourceUri: surface.resourceUri,
      ...(surface.icon === undefined ? {} : { icon: surface.icon }),
    })),
    dependencies: manifest.dependencies ?? [],
    unsupported,
  }
}

/** 插件内相对路径安全化：拒绝 NUL、反斜杠、绝对路径、盘符与 `..` 上跳；返回归一化路径，非法时 undefined。 */
export function safePluginRelativePath(value: string): string | undefined {
  if (value.includes('\0') || value.includes('\\') || isAbsolute(value) || /^[A-Za-z]:/u.test(value)) return undefined
  const segments = value.split('/').filter(segment => segment !== '' && segment !== '.')
  if (segments.length === 0 || segments.some(segment => segment === '..')) return undefined
  return segments.join('/')
}
