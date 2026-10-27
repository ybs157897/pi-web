import { createHash } from 'node:crypto'
import { isAbsolute } from 'node:path'
import { z } from 'zod'
import { RuntimeError } from './runtime-errors.ts'

export const PLUGIN_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]{0,127}$/u
export const MARKETPLACE_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/u
export const PLUGIN_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,127}@[a-z0-9][a-z0-9._-]{0,63}$/u

export const MAX_MARKETPLACE_BYTES = 4 * 1024 * 1024
export const MAX_PLUGIN_ARCHIVE_BYTES = 100 * 1024 * 1024
export const MAX_PLUGIN_FILES = 20_000
export const MAX_PLUGIN_FILE_BYTES = 20 * 1024 * 1024
export const MAX_PLUGIN_MANIFEST_BYTES = 512 * 1024

export const PLUGIN_MANIFEST_DIRECTORIES = ['.pi-plugin', '.zcode-plugin', '.claude-plugin'] as const
export const UNSUPPORTED_CAPABILITIES = ['commands', 'agents', 'hooks', 'lspServers', 'outputStyles', 'channels'] as const

const SHA256 = /^[a-f0-9]{64}$/iu
const pluginName = z.string().regex(PLUGIN_NAME_PATTERN)
const relativePath = z.string().min(1).max(2_048)
const url = z.string().url().max(2_048)

const mcpServerSchema = z.object({
  command: z.string().min(1).max(1_024),
  args: z.array(z.string().max(2_048)).max(64).optional(),
  env: z.record(z.string().max(256), z.string().max(4_096)).optional(),
  exposure: z.enum(['direct', 'codemode', 'deferred', 'hidden']).optional(),
}).strict()

const uiSurfaceSchema = z.object({
  id: pluginName,
  title: z.string().min(1).max(120),
  server: z.string().min(1).max(128),
  resourceUri: z.string().min(1).max(2_048),
  availability: z.literal('session').optional(),
  icon: url.optional(),
}).strict()

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

const sourceSchema = z.union([
  z.string().min(1).max(2_048),
  z.object({ source: z.literal('directory'), path: relativePath }).strict(),
  z.object({ source: z.literal('url'), type: z.literal('zip'), url, sha256: z.string().regex(SHA256) }).strict(),
  z.object({ source: z.literal('github'), repo: z.string().min(1).max(500), ref: z.string().max(200).optional(), path: z.string().max(1_000).optional() }).passthrough(),
  z.object({ source: z.literal('git'), url: z.string().min(1).max(2_048), ref: z.string().max(200).optional(), path: z.string().max(1_000).optional() }).passthrough(),
  z.object({ source: z.literal('npm') }).passthrough(),
  z.object({ source: z.literal('pip') }).passthrough(),
])

const catalogPluginSchema = z.object({
  name: pluginName,
  version: z.string().min(1).max(64),
  description: z.string().max(2_000).optional(),
  category: z.string().max(80).optional(),
  source: sourceSchema,
  listing: catalogListingSchema.optional(),
}).passthrough()

export const catalogSchema = z.object({
  name: z.string().min(1).max(120),
  description: z.string().max(2_000).optional(),
  owner: z.object({ name: z.string().max(200) }).passthrough().optional(),
  featured: z.array(pluginName).max(200).optional(),
  plugins: z.array(catalogPluginSchema).max(2_000),
}).passthrough()

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

export const catalogCacheSchema = z.object({
  version: z.literal(1),
  fetchedAt: z.number().finite(),
  catalog: normalizedCatalogSchema,
}).strict()

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

export type CatalogListing = z.infer<typeof catalogListingSchema>
export type NormalizedPluginSource =
  | { kind: 'directory'; path: string; display: string }
  | { kind: 'zip'; url: string; sha256: string; display: string }
  | { kind: 'github'; repo: string; ref?: string; path?: string; display: string }
  | { kind: 'git'; url: string; ref?: string; path?: string; display: string }
  | { kind: 'unsupported'; display: string; reason: string }

export interface CatalogPluginEntry {
  name: string
  version: string
  description?: string
  category?: string
  source: NormalizedPluginSource
  listing?: CatalogListing
}

export interface NormalizedCatalog {
  name: string
  description?: string
  featured: string[]
  plugins: CatalogPluginEntry[]
}

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

/** One enabled plugin MCP server, with `${PLUGIN_ROOT}` / `${PLUGIN_DATA}` already expanded. */
export interface PluginMcpServerConfig {
  pluginId: string
  pluginName: string
  /** Manifest key (`mcpServers.<name>`). */
  serverKey: string
  /** Namespaced server name the MCP registry and code mode see (`plugin_<plugin>_<server>`). */
  serverName: string
  command: string
  args: string[]
  env: Record<string, string>
  cwd: string
  /** Plugin-private data directory, also exported as `PLUGIN_DATA`. */
  dataPath: string
  exposure: 'direct' | 'codemode' | 'deferred' | 'hidden'
  description?: string
}

export function pluginIdOf(name: string, marketplace: string): string {
  return `${name}@${marketplace}`
}

export function parsePluginId(value: string): { name: string; marketplace: string } {
  if (!PLUGIN_ID_PATTERN.test(value)) throw new RuntimeError('PLUGIN_NOT_FOUND', 'Plugin id is invalid')
  const delimiter = value.lastIndexOf('@')
  return { name: value.slice(0, delimiter), marketplace: value.slice(delimiter + 1) }
}

export function marketplaceIdFor(name: string): string {
  const slug = name.toLowerCase().replace(/[^a-z0-9._-]+/gu, '-').replace(/^-+|-+$/gu, '').slice(0, 48)
  if (slug.length === 0) return `marketplace-${createHash('sha256').update(name).digest('hex').slice(0, 8)}`
  return slug
}

/** `plugin_<plugin>_<server>`, matching the MCP namespace rules used elsewhere. */
export function pluginServerName(plugin: string, server: string): string {
  const sanitize = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/gu, '_').replace(/^_+|_+$/gu, '').slice(0, 60)
  return `plugin_${sanitize(plugin) || 'plugin'}_${sanitize(server) || 'server'}`
}

export function dataDirectoryName(pluginId: string): string {
  const { name } = parsePluginId(pluginId)
  const slug = name.toLowerCase().replace(/[^a-z0-9._-]+/gu, '-').replace(/^-+|-+$/gu, '').slice(0, 48)
  return `${slug || 'plugin'}-${createHash('sha256').update(pluginId).digest('hex').slice(0, 8)}`
}

const GITHUB_REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u
const GIT_REF = /^[A-Za-z0-9._/-]{1,200}$/u

function safeRef(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  if (!GIT_REF.test(value) || value.startsWith('-') || value.split('/').some(segment => segment === '..' || segment === '')) return 'invalid'
  return value
}

/**
 * A catalog source is a package inside a local marketplace directory, a checksummed remote zip,
 * a GitHub repository, or a git clone. npm/pip stay visible in the catalog but cannot be installed.
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

/** A plugin-relative path cannot be absolute, drive-qualified, or climb out of its root. */
export function safePluginRelativePath(value: string): string | undefined {
  if (value.includes('\0') || value.includes('\\') || isAbsolute(value) || /^[A-Za-z]:/u.test(value)) return undefined
  const segments = value.split('/').filter(segment => segment !== '' && segment !== '.')
  if (segments.length === 0 || segments.some(segment => segment === '..')) return undefined
  return segments.join('/')
}
