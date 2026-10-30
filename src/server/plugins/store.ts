import { createHash, randomUUID } from 'node:crypto'
import { lstat, mkdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import type {
  PluginCapabilities,
  PluginDescription,
  PluginDiagnostic,
  PluginMarketplaceSummary,
  PluginOperationView,
  PluginOverview,
  PluginStoreItem,
} from '../../shared/plugins.ts'
import type { PluginUiSurfaceView } from '../../shared/plugin-ui.ts'
import { loadPluginPackage, type LoadedPluginPackage } from './manifest.ts'
import {
  catalogCacheSchema,
  installedFileSchema,
  marketplacesFileSchema,
  marketplaceIdFor,
  parsePluginId,
  pluginIdOf,
  pluginServerName,
  dataDirectoryName,
  type CatalogPluginEntry,
  type NormalizedCatalog,
  type PluginMcpServerConfig,
} from './types.ts'
import {
  loadMarketplace,
  materializePluginSource,
  parseMarketplaceSource,
  stagingDirectory,
} from './source.ts'
import { RuntimeError } from '../runtime-errors.ts'

const OPERATION_HISTORY_LIMIT = 20
const OPERATION_RETENTION_MS = 10 * 60 * 1000

interface MarketplaceRecord {
  id: string
  name: string
  source: string
  kind: 'directory' | 'url'
  lastUpdated: number
  lastError?: string
}

interface CatalogCache {
  fetchedAt: number
  catalog: NormalizedCatalog
}

type InstalledRecord = {
  id: string
  name: string
  marketplace: string
  version: string
  installPath: string
  installedAt: number
  updatedAt: number
  enabled: boolean
  sourceFingerprint: string
  dependencies: string[]
  transactionId: string
  sourceType: 'directory' | 'zip' | 'github' | 'git'
}

interface Operation {
  id: string
  pluginId: string
  status: 'running' | 'completed' | 'failed'
  error?: string
  startedAt: number
  finishedAt?: number
}

/**
 * What changed. `operation` and `marketplace` do not alter the runnable capability set; the runtime
 * only reloads MCP servers for `install`, `update`, `uninstall`, and `enable`.
 */
export type PluginChangeEvent = {
  reason: 'operation' | 'marketplace' | 'install' | 'update' | 'uninstall' | 'enable'
  pluginIds: string[]
}

interface StagedItem {
  entry: CatalogPluginEntry
  pluginId: string
  package: LoadedPluginPackage
  stagingPath: string
  fingerprint: string
  sourceType: 'directory' | 'zip' | 'github' | 'git'
  dependencies: string[]
}

export interface PluginStoreOptions {
  dataDir: string
  /** Called after every state mutation; the runtime uses it to reload MCP servers and wake SSE. */
  onChange?: (event: PluginChangeEvent) => void
}

export interface PluginSkillRoot {
  source: 'plugin'
  path: string
  pluginId: string
  pluginName: string
}

function isMissing(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT'
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function within(root: string, target: string): boolean {
  const path = relative(root, target)
  return path === '' || (path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path))
}

/** Owns the plugin directory, install records, and the capability projection P0 needs. */
export class PluginStore {
  root: string
  #marketplaces: MarketplaceRecord[] = []
  #catalogs = new Map<string, CatalogCache>()
  #installed: InstalledRecord[] = []
  #manifests = new Map<string, LoadedPluginPackage>()
  #operations: Operation[] = []
  #loadDiagnostics: PluginDiagnostic[] = []
  #tail: Promise<void> = Promise.resolve()
  #onChange: ((event: PluginChangeEvent) => void) | undefined

  private constructor(dataDir: string) {
    this.root = join(resolve(dataDir), 'plugins')
  }

  static async open(options: PluginStoreOptions): Promise<PluginStore> {
    const store = new PluginStore(options.dataDir)
    store.#onChange = options.onChange
    await mkdir(store.root, { recursive: true, mode: 0o700 })
    // Skill roots are validated by walking from the filesystem root; keep the cache path canonical
    // so a symlinked data directory (macOS `/var`) does not look like a plugin symlink.
    store.root = await realpath(store.root)
    await store.#load()
    return store
  }

  get marketplacesPath(): string {
    return join(this.root, 'marketplaces.json')
  }

  get installedPath(): string {
    return join(this.root, 'installed.json')
  }

  #marketplaceCachePath(id: string): string {
    return join(this.root, 'marketplaces', `${id}.json`)
  }

  #pluginCachePath(marketplace: string, name: string, version: string): string {
    return join(this.root, 'cache', marketplace, name, version)
  }

  #pluginFamilyPath(marketplace: string, name: string): string {
    return join(this.root, 'cache', marketplace, name)
  }

  #dataPath(pluginId: string): string {
    return join(this.root, 'data', dataDirectoryName(pluginId))
  }

  #stagingPath(transactionId: string): string {
    return join(this.root, 'staging', transactionId)
  }

  async #load(): Promise<void> {
    await mkdir(this.root, { recursive: true, mode: 0o700 })
    await mkdir(join(this.root, 'marketplaces'), { recursive: true, mode: 0o700 })
    await mkdir(join(this.root, 'cache'), { recursive: true, mode: 0o700 })
    await mkdir(join(this.root, 'data'), { recursive: true, mode: 0o700 })
    await rm(join(this.root, 'staging'), { recursive: true, force: true }).catch(() => undefined)
    await mkdir(join(this.root, 'staging'), { recursive: true, mode: 0o700 })

    const marketplaces = await this.#readJson(this.marketplacesPath, marketplacesFileSchema)
    if (marketplaces !== undefined) this.#marketplaces = marketplaces.marketplaces
    else if (await this.#exists(this.marketplacesPath)) {
      this.#loadDiagnostics.push({ code: 'marketplaces_invalid', message: 'marketplaces.json was unreadable; marketplace sources start empty' })
    }

    for (const marketplace of this.#marketplaces) {
      const cached = await this.#readJson(this.#marketplaceCachePath(marketplace.id), catalogCacheSchema)
      if (cached === undefined) {
        marketplace.lastError ??= 'The catalog cache is missing; refresh this marketplace'
        continue
      }
      this.#catalogs.set(marketplace.id, { fetchedAt: cached.fetchedAt, catalog: cached.catalog as NormalizedCatalog })
    }

    const installed = await this.#readJson(this.installedPath, installedFileSchema)
    if (installed !== undefined) this.#installed = installed.plugins
    else if (await this.#exists(this.installedPath)) {
      this.#loadDiagnostics.push({ code: 'installed_invalid', message: 'installed.json was unreadable; no plugins are treated as installed' })
    }

    for (const record of this.#installed) {
      if (!within(this.root, record.installPath)) {
        this.#loadDiagnostics.push({ code: 'plugin_path_invalid', message: `Install record for ${record.id} points outside the plugin cache`, pluginId: record.id })
        continue
      }
      try {
        const loaded = await loadPluginPackage(record.installPath, record.id)
        this.#manifests.set(record.id, loaded)
      } catch (error) {
        this.#loadDiagnostics.push({ code: 'plugin_manifest_invalid', message: `Installed plugin ${record.id} could not be loaded: ${errorMessage(error)}`, pluginId: record.id })
      }
    }
  }

  async #exists(path: string): Promise<boolean> {
    try {
      await lstat(path)
      return true
    } catch {
      return false
    }
  }

  async #readJson<T>(path: string, schema: { safeParse: (value: unknown) => { success: true; data: T } | { success: false } }): Promise<T | undefined> {
    let raw: string
    try {
      raw = await readFile(path, 'utf8')
    } catch {
      return undefined
    }
    try {
      const parsed = schema.safeParse(JSON.parse(raw))
      return parsed.success ? parsed.data : undefined
    } catch {
      return undefined
    }
  }

  async #writeJson(path: string, value: unknown): Promise<void> {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 })
    const temporary = join(dirname(path), `.tmp-${process.pid}-${randomUUID()}`)
    try {
      await writeFile(temporary, JSON.stringify(value, null, 2), { encoding: 'utf8', mode: 0o600 })
      await rename(temporary, path)
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => undefined)
      throw error
    }
  }

  #withLock<T>(action: () => Promise<T>): Promise<T> {
    const run = this.#tail.then(action, action)
    this.#tail = run.then(() => undefined, () => undefined)
    return run
  }

  #emit(reason: PluginChangeEvent['reason'], pluginIds: readonly string[] = []): void {
    try {
      this.#onChange?.({ reason, pluginIds: [...pluginIds] })
    } catch {
      // A listener must not break a store mutation that already committed.
    }
  }

  #persistMarketplaces(): Promise<void> {
    return this.#writeJson(this.marketplacesPath, { version: 1, marketplaces: this.#marketplaces })
  }

  #persistInstalled(records: readonly InstalledRecord[] = this.#installed): Promise<void> {
    return this.#writeJson(this.installedPath, { version: 1, plugins: records })
  }

  #marketplace(id: string): MarketplaceRecord {
    const marketplace = this.#marketplaces.find(item => item.id === id)
    if (marketplace === undefined) throw new RuntimeError('MARKETPLACE_NOT_FOUND', 'Marketplace was not found')
    return marketplace
  }

  #catalog(id: string): CatalogCache {
    const cache = this.#catalogs.get(id)
    if (cache === undefined) throw new RuntimeError('MARKETPLACE_NOT_FOUND', 'Marketplace catalog is not cached yet; refresh it first')
    return cache
  }

  #record(pluginId: string): InstalledRecord {
    const record = this.#installed.find(item => item.id === pluginId)
    if (record === undefined) throw new RuntimeError('PLUGIN_NOT_FOUND', 'Plugin is not installed')
    return record
  }

  async #storeCatalog(marketplace: MarketplaceRecord, catalog: NormalizedCatalog): Promise<void> {
    const fetchedAt = Date.now()
    await this.#writeJson(this.#marketplaceCachePath(marketplace.id), { version: 1, fetchedAt, catalog })
    this.#catalogs.set(marketplace.id, { fetchedAt, catalog })
    marketplace.name = catalog.name
    marketplace.lastUpdated = fetchedAt
    delete marketplace.lastError
  }

  async addMarketplace(sourceText: string): Promise<PluginOverview> {
    return this.#withLock(async () => {
      const source = parseMarketplaceSource(sourceText)
      const catalog = await loadMarketplace(source)
      const id = marketplaceIdFor(catalog.name)
      const existing = this.#marketplaces.find(item => item.id === id)
      if (existing !== undefined && existing.source !== source.source) {
        throw new RuntimeError('CONFLICT', `Marketplace id "${id}" already belongs to another source`)
      }
      const record: MarketplaceRecord = existing ?? {
        id,
        name: catalog.name,
        source: source.source,
        kind: source.kind,
        lastUpdated: 0,
      }
      await this.#storeCatalog(record, catalog)
      if (existing === undefined) this.#marketplaces.push(record)
      await this.#persistMarketplaces()
      this.#emit('marketplace')
      return this.overview()
    })
  }

  async removeMarketplace(id: string): Promise<PluginOverview> {
    return this.#withLock(async () => {
      const index = this.#marketplaces.findIndex(item => item.id === id)
      if (index < 0) throw new RuntimeError('MARKETPLACE_NOT_FOUND', 'Marketplace was not found')
      this.#marketplaces.splice(index, 1)
      this.#catalogs.delete(id)
      await rm(this.#marketplaceCachePath(id), { force: true }).catch(() => undefined)
      await this.#persistMarketplaces()
      this.#emit('marketplace')
      return this.overview()
    })
  }

  async refreshMarketplace(id: string): Promise<PluginOverview> {
    return this.#withLock(async () => {
      const marketplace = this.#marketplace(id)
      try {
        const source = parseMarketplaceSource(marketplace.source)
        const catalog = await loadMarketplace(source)
        await this.#storeCatalog(marketplace, catalog)
      } catch (error) {
        marketplace.lastError = errorMessage(error)
        await this.#persistMarketplaces().catch(() => undefined)
        this.#emit('marketplace')
        throw error
      }
      await this.#persistMarketplaces()
      this.#emit('marketplace')
      return this.overview()
    })
  }

  #operation(pluginId: string): PluginOperationView | undefined {
    return this.#operations.find(operation => operation.pluginId === pluginId && operation.status === 'running')
  }

  /** Start an install and return immediately; the UI polls `overview()` for the operation state. */
  startInstall(input: { marketplace: string; name: string }): PluginOperationView {
    const pluginId = pluginIdOf(input.name, input.marketplace)
    return this.#startOperation(pluginId, 'install', async (operationId) => {
      const { items, transactionId } = await this.#stageClosure(input.marketplace, input.name, 'install', operationId)
      try {
        await this.#activateStaged(input.marketplace, items, transactionId)
      } finally {
        await rm(this.#stagingPath(transactionId), { recursive: true, force: true }).catch(() => undefined)
      }
    })
  }

  /** Re-materialize one installed plugin from the catalog's current version. */
  startUpdate(input: { pluginId: string }): PluginOperationView {
    const record = this.#record(input.pluginId)
    return this.#startOperation(record.id, 'update', async (operationId) => {
      const { items, transactionId } = await this.#stageClosure(record.marketplace, record.name, 'update', operationId)
      try {
        await this.#activateStaged(record.marketplace, items, transactionId)
      } finally {
        await rm(this.#stagingPath(transactionId), { recursive: true, force: true }).catch(() => undefined)
      }
    })
  }

  #startOperation(
    pluginId: string,
    reason: 'install' | 'update',
    action: (operationId: string) => Promise<void>,
  ): PluginOperationView {
    const running = this.#operation(pluginId)
    if (running !== undefined) return { ...running }
    const operation: Operation = {
      id: randomUUID(),
      pluginId,
      status: 'running',
      startedAt: Date.now(),
    }
    this.#operations.unshift(operation)
    this.#emit('operation', [pluginId])
    void this.#withLock(async () => {
      try {
        await action(operation.id)
        operation.status = 'completed'
        this.#emit(reason, [pluginId])
      } catch (error) {
        operation.status = 'failed'
        operation.error = errorMessage(error).slice(0, 1_000)
      } finally {
        operation.finishedAt = Date.now()
        this.#emit('operation', [pluginId])
      }
    })
    return { ...operation }
  }

  /**
   * Materialize the plugin plus any missing dependencies into staging. Install skips anything already
   * installed; update re-materializes the root and only adds dependencies that are absent.
   */
  async #stageClosure(
    marketplaceId: string,
    name: string,
    mode: 'install' | 'update',
    operationId: string,
  ): Promise<{ items: StagedItem[]; transactionId: string }> {
    const marketplace = this.#marketplace(marketplaceId)
    const cache = this.#catalog(marketplaceId)
    const entry = cache.catalog.plugins.find(plugin => plugin.name === name)
    if (entry === undefined) throw new RuntimeError('PLUGIN_NOT_FOUND', 'Plugin is not listed in this marketplace')
    const marketplaceRoot = marketplace.kind === 'directory' ? parseMarketplaceSource(marketplace.source).root : undefined

    const transactionId = `tx-${Date.now()}-${operationId.slice(0, 8)}`
    const queue: CatalogPluginEntry[] = [entry]
    const queuedNames = new Set<string>([entry.name])
    const items: StagedItem[] = []
    try {
      for (let index = 0; index < queue.length; index += 1) {
        const candidate = queue[index]!
        if (queuedNames.size > 64) throw new RuntimeError('PLUGIN_DEPENDENCY_MISSING', 'Plugin dependency graph is too large')
        const pluginId = pluginIdOf(candidate.name, marketplaceId)
        const existingRecord = this.#installed.find(record => record.id === pluginId)
        if (mode === 'install') {
          if (existingRecord !== undefined) {
            if (existingRecord.version !== candidate.version) {
              throw new RuntimeError('PLUGIN_ALREADY_INSTALLED', `${existingRecord.id} is already installed at ${existingRecord.version}; uninstall it before installing ${candidate.version}`)
            }
            continue
          }
        } else if (candidate.name !== name && existingRecord !== undefined) {
          continue
        }

        const stagingPath = stagingDirectory(join(this.root, 'staging'), transactionId, candidate.name)
        await rm(stagingPath, { recursive: true, force: true }).catch(() => undefined)
        await mkdir(dirname(stagingPath), { recursive: true, mode: 0o700 })
        const materialized = await materializePluginSource(candidate.source, {
          ...(marketplaceRoot === undefined ? {} : { marketplaceRoot }),
          destination: stagingPath,
        })
        const loaded = await loadPluginPackage(stagingPath, pluginId)
        if (loaded.manifest.name !== candidate.name) {
          throw new RuntimeError('PLUGIN_SOURCE_INVALID', `plugin.json name "${loaded.manifest.name}" does not match the catalog entry "${candidate.name}"`)
        }
        if (loaded.manifest.version !== candidate.version) {
          throw new RuntimeError('PLUGIN_SOURCE_INVALID', `plugin.json version "${loaded.manifest.version}" does not match the catalog version "${candidate.version}"`)
        }
        const dependencies = loaded.manifest.dependencies.map(dependency => pluginIdOf(dependency, marketplaceId))
        items.push({
          entry: candidate,
          pluginId,
          package: loaded,
          stagingPath,
          fingerprint: materialized.fingerprint,
          sourceType: materialized.sourceType,
          dependencies,
        })
        for (const dependency of loaded.manifest.dependencies) {
          if (queuedNames.has(dependency)) continue
          const dependencyEntry = cache.catalog.plugins.find(plugin => plugin.name === dependency)
          if (dependencyEntry === undefined) {
            throw new RuntimeError('PLUGIN_DEPENDENCY_MISSING', `Plugin dependency "${dependency}" is not in this marketplace`)
          }
          queuedNames.add(dependency)
          queue.push(dependencyEntry)
        }
      }
      return { items, transactionId }
    } catch (error) {
      await rm(this.#stagingPath(transactionId), { recursive: true, force: true }).catch(() => undefined)
      throw error
    }
  }

  /**
   * Activate staged packages with a rename per plugin and one `installed.json` commit. Any failure
   * restores the previous directories and leaves `installed.json` untouched.
   */
  async #activateStaged(marketplaceId: string, items: readonly StagedItem[], transactionId: string): Promise<void> {
    if (items.length === 0) return
    const activated: Array<{ target: string; backup?: string }> = []
    const unchanged: string[] = []
    const previousPaths = new Map<string, string>()
    const prepared: Array<{ record: InstalledRecord; loaded: LoadedPluginPackage }> = []
    try {
      for (const item of items) {
        const existing = this.#installed.find(record => record.id === item.pluginId)
        if (existing !== undefined && existing.version === item.entry.version && existing.sourceFingerprint === item.fingerprint) {
          unchanged.push(item.stagingPath)
          continue
        }
        const target = this.#pluginCachePath(marketplaceId, item.entry.name, item.entry.version)
        const backup = `${target}.prev-${transactionId}`
        await mkdir(dirname(target), { recursive: true, mode: 0o700 })
        const hadTarget = await this.#exists(target)
        if (hadTarget) {
          await rm(backup, { recursive: true, force: true }).catch(() => undefined)
          await rename(target, backup)
        }
        try {
          await rename(item.stagingPath, target)
        } catch (error) {
          if (hadTarget) await rename(backup, target).catch(() => undefined)
          throw error
        }
        activated.push({ target, ...(hadTarget ? { backup } : {}) })
        const loaded = await loadPluginPackage(target, item.pluginId)
        if (existing !== undefined) previousPaths.set(item.pluginId, existing.installPath)
        prepared.push({
          loaded,
          record: {
            id: item.pluginId,
            name: item.entry.name,
            marketplace: marketplaceId,
            version: item.entry.version,
            installPath: target,
            installedAt: existing?.installedAt ?? Date.now(),
            updatedAt: Date.now(),
            enabled: existing?.enabled ?? true,
            sourceFingerprint: item.fingerprint,
            dependencies: item.dependencies,
            transactionId,
            sourceType: item.sourceType,
          },
        })
        await mkdir(this.#dataPath(item.pluginId), { recursive: true, mode: 0o700 })
      }

      if (prepared.length === 0) {
        for (const path of unchanged) await rm(path, { recursive: true, force: true }).catch(() => undefined)
        return
      }

      const nextInstalled = [...this.#installed]
      for (const { record } of prepared) {
        const index = nextInstalled.findIndex(item => item.id === record.id)
        if (index >= 0) nextInstalled[index] = record
        else nextInstalled.push(record)
      }
      await this.#persistInstalled(nextInstalled)
      this.#installed = nextInstalled
      for (const { record, loaded } of prepared) this.#manifests.set(record.id, loaded)

      // Old version directories and backups go only after the install record has committed.
      for (const [pluginId, oldPath] of previousPaths) {
        const current = nextInstalled.find(record => record.id === pluginId)
        if (current !== undefined && current.installPath !== oldPath && within(this.root, oldPath)) {
          await rm(oldPath, { recursive: true, force: true }).catch(() => undefined)
        }
      }
      for (const entry of activated) {
        if (entry.backup !== undefined) await rm(entry.backup, { recursive: true, force: true }).catch(() => undefined)
      }
      for (const path of unchanged) await rm(path, { recursive: true, force: true }).catch(() => undefined)
    } catch (error) {
      for (const entry of activated.reverse()) {
        await rm(entry.target, { recursive: true, force: true }).catch(() => undefined)
        if (entry.backup !== undefined) await rename(entry.backup, entry.target).catch(() => undefined)
      }
      throw error
    }
  }

  async uninstall(pluginId: string, keepData = false): Promise<PluginOverview> {
    return this.#withLock(async () => {
      const record = this.#record(pluginId)
      const nextInstalled = this.#installed.filter(item => item.id !== pluginId)
      await rm(this.#pluginFamilyPath(record.marketplace, record.name), { recursive: true, force: true })
      if (!keepData) await rm(this.#dataPath(pluginId), { recursive: true, force: true })
      await this.#persistInstalled(nextInstalled)
      this.#installed = nextInstalled
      this.#manifests.delete(pluginId)
      this.#emit('uninstall', [pluginId])
      return this.overview()
    })
  }

  async setEnabled(pluginId: string, enabled: boolean): Promise<PluginOverview> {
    return this.#withLock(async () => {
      const record = this.#record(pluginId)
      const nextInstalled = this.#installed.map(item => item.id === pluginId
        ? { ...item, enabled, updatedAt: Date.now() }
        : item)
      await this.#persistInstalled(nextInstalled)
      this.#installed = nextInstalled
      this.#emit('enable', [pluginId])
      return this.overview()
    })
  }

  /**
   * Enabled plugin MCP servers with runtime paths expanded. Never crosses the HTTP boundary: the
   * objects carry `env` values and absolute paths.
   */
  mcpServers(): PluginMcpServerConfig[] {
    const servers: PluginMcpServerConfig[] = []
    const used = new Set<string>()
    for (const record of this.#installed) {
      if (!record.enabled) continue
      const loaded = this.#manifests.get(record.id)
      if (loaded === undefined) continue
      const dataPath = this.#dataPath(record.id)
      for (const [serverKey, server] of Object.entries(loaded.manifest.mcpServers)) {
        const base = pluginServerName(loaded.manifest.name, serverKey)
        let serverName = base
        if (used.has(serverName)) {
          serverName = `${base}_${createHash('sha256').update(record.id).digest('hex').slice(0, 8)}`
        }
        used.add(serverName)
        const expand = (value: string): string => value
          .replaceAll('${PLUGIN_ROOT}', loaded.root)
          .replaceAll('${PLUGIN_DATA}', dataPath)
        servers.push({
          pluginId: record.id,
          pluginName: loaded.manifest.name,
          serverKey,
          serverName,
          command: expand(server.command),
          args: server.args.map(expand),
          env: {
            ...Object.fromEntries(Object.entries(server.env).map(([key, value]) => [key, expand(value)])),
            PLUGIN_ROOT: loaded.root,
            PLUGIN_DATA: dataPath,
          },
          cwd: loaded.root,
          dataPath,
          exposure: server.exposure,
          ...(loaded.manifest.description === undefined ? {} : { description: loaded.manifest.description }),
        })
      }
    }
    return servers
  }

  /**
   * Enabled UI surfaces as the host may open them. Each server name comes from the same projection
   * as `mcpServers()`, so a renamed plugin server keeps its surface reachable.
   */
  uiSurfaces(): PluginUiSurfaceView[] {
    const servers = this.mcpServers()
    const surfaces: PluginUiSurfaceView[] = []
    for (const record of this.#installed) {
      if (!record.enabled) continue
      const loaded = this.#manifests.get(record.id)
      if (loaded === undefined) continue
      for (const surface of loaded.manifest.uiSurfaces) {
        const server = servers.find(item => item.pluginId === record.id && item.serverKey === surface.server)
        if (server === undefined) continue
        surfaces.push({
          id: `${record.id}:${surface.id}`,
          pluginId: record.id,
          pluginName: loaded.manifest.name,
          title: surface.title,
          serverName: server.serverName,
          resourceUri: surface.resourceUri,
        })
      }
    }
    return surfaces
  }

  /** The enabled plugin owning one namespaced MCP server, for page-originated calls. */
  pluginServer(serverName: string): { pluginId: string; pluginName: string; serverKey: string } | undefined {
    const server = this.mcpServers().find(item => item.serverName === serverName)
    if (server === undefined) return undefined
    return { pluginId: server.pluginId, pluginName: server.pluginName, serverKey: server.serverKey }
  }

  /** Components of one candidate (or installed) plugin for the install confirmation. */
  async describe(pluginId: string): Promise<PluginDescription> {
    const { name, marketplace } = parsePluginId(pluginId)
    const record = this.#installed.find(item => item.id === pluginId)
    const marketplaceRecord = this.#marketplaces.find(item => item.id === marketplace)
    const entry = marketplaceRecord === undefined
      ? undefined
      : this.#catalogs.get(marketplace)?.catalog.plugins.find(plugin => plugin.name === name)

    // Installed and unchanged: describe what is on disk instead of downloading the catalog package.
    if (record !== undefined && (entry === undefined || entry.version === record.version)) {
      const loaded = this.#manifests.get(pluginId)
      if (loaded === undefined) throw new RuntimeError('PLUGIN_NOT_FOUND', 'Installed plugin files are unavailable; reinstall it')
      return describePackage(loaded, pluginId, record.version, record.sourceType, true)
    }

    if (marketplaceRecord === undefined) throw new RuntimeError('MARKETPLACE_NOT_FOUND', 'Marketplace was not found')
    if (entry === undefined) throw new RuntimeError('PLUGIN_NOT_FOUND', 'Plugin is not listed in this marketplace')
    if (entry.source.kind === 'unsupported') throw new RuntimeError('PLUGIN_UNSUPPORTED_SOURCE', entry.source.reason)
    const marketplaceRoot = marketplaceRecord.kind === 'directory' ? parseMarketplaceSource(marketplaceRecord.source).root : undefined
    const stagingPath = stagingDirectory(join(this.root, 'staging'), `describe-${randomUUID().slice(0, 8)}`, name)
    try {
      const materialized = await materializePluginSource(entry.source, {
        ...(marketplaceRoot === undefined ? {} : { marketplaceRoot }),
        destination: stagingPath,
      })
      const loaded = await loadPluginPackage(stagingPath, pluginId)
      return describePackage(loaded, pluginId, entry.version, materialized.sourceType, record !== undefined)
    } finally {
      await rm(dirname(stagingPath), { recursive: true, force: true }).catch(() => undefined)
    }
  }

  /** Synchronous projection read by `SkillStore` on each catalog request. */
  skillRoots(): PluginSkillRoot[] {
    const roots: PluginSkillRoot[] = []
    for (const record of this.#installed) {
      if (!record.enabled) continue
      const loaded = this.#manifests.get(record.id)
      if (loaded === undefined) continue
      for (const skillRoot of loaded.skillRoots) {
        roots.push({ source: 'plugin', path: skillRoot.path, pluginId: record.id, pluginName: loaded.manifest.name })
      }
    }
    return roots
  }

  #pruneOperations(): void {
    const cutoff = Date.now() - OPERATION_RETENTION_MS
    this.#operations = this.#operations
      .filter((operation, index) => index < OPERATION_HISTORY_LIMIT && (operation.status === 'running' || (operation.finishedAt ?? operation.startedAt) >= cutoff))
  }

  overview(): PluginOverview {
    this.#pruneOperations()
    const diagnostics: PluginDiagnostic[] = [...this.#loadDiagnostics]
    const marketplaces: PluginMarketplaceSummary[] = this.#marketplaces.map((marketplace) => {
      const cache = this.#catalogs.get(marketplace.id)
      return {
        id: marketplace.id,
        name: marketplace.name,
        source: marketplace.source,
        kind: marketplace.kind,
        pluginCount: cache?.catalog.plugins.length ?? 0,
        featured: cache?.catalog.featured ?? [],
        lastUpdated: marketplace.lastUpdated,
        ...(marketplace.lastError === undefined ? {} : { lastError: marketplace.lastError }),
      }
    })
    for (const marketplace of this.#marketplaces) {
      if (marketplace.lastError !== undefined) {
        diagnostics.push({ code: 'marketplace_unavailable', message: `${marketplace.name}: ${marketplace.lastError}`, marketplace: marketplace.id })
      }
    }

    const plugins: PluginStoreItem[] = []
    const seen = new Set<string>()
    for (const marketplace of this.#marketplaces) {
      const cache = this.#catalogs.get(marketplace.id)
      if (cache === undefined) continue
      for (const entry of cache.catalog.plugins) {
        const id = pluginIdOf(entry.name, marketplace.id)
        if (seen.has(id)) continue
        seen.add(id)
        const record = this.#installed.find(item => item.id === id)
        const loaded = this.#manifests.get(id)
        plugins.push({
          id,
          name: entry.name,
          marketplace: marketplace.id,
          version: entry.version,
          ...(entry.description === undefined ? {} : { description: entry.description }),
          ...(entry.listing?.displayName === undefined ? {} : { displayName: entry.listing.displayName }),
          ...(entry.category === undefined ? {} : { category: entry.category }),
          ...(entry.listing?.icon === undefined ? {} : { icon: entry.listing.icon }),
          ...(entry.listing?.homepage === undefined ? {} : { homepage: entry.listing.homepage }),
          featured: cache.catalog.featured.includes(entry.name),
          available: true,
          installed: record !== undefined,
          enabled: record?.enabled ?? false,
          ...(record === undefined ? {} : { installedVersion: record.version, installedAt: record.installedAt, updatedAt: record.updatedAt }),
          sourceType: entry.source.kind === 'zip'
            ? 'zip'
            : entry.source.kind === 'directory'
              ? 'directory'
              : entry.source.kind === 'github'
                ? 'github'
                : entry.source.kind === 'git'
                  ? 'git'
                  : 'unsupported',
          capabilities: loaded?.capabilities ?? emptyCapabilities(),
          dependencies: record?.dependencies ?? [],
        })
      }
    }
    for (const record of this.#installed) {
      if (seen.has(record.id)) continue
      const loaded = this.#manifests.get(record.id)
      plugins.push({
        id: record.id,
        name: record.name,
        marketplace: record.marketplace,
        version: record.version,
        installed: true,
        enabled: record.enabled,
        installedVersion: record.version,
        installedAt: record.installedAt,
        updatedAt: record.updatedAt,
        available: false,
        featured: false,
        sourceType: record.sourceType,
        capabilities: loaded?.capabilities ?? emptyCapabilities(),
        dependencies: record.dependencies,
        ...(loaded?.manifest.description === undefined ? {} : { description: loaded.manifest.description }),
        ...(loaded?.manifest.homepage === undefined ? {} : { homepage: loaded.manifest.homepage }),
      })
      if (loaded === undefined) {
        diagnostics.push({ code: 'plugin_manifest_invalid', message: `Installed plugin ${record.id} could not be loaded`, pluginId: record.id })
      }
    }
    plugins.sort((left, right) => Number(right.featured) - Number(left.featured) || left.marketplace.localeCompare(right.marketplace) || left.name.localeCompare(right.name))
    return {
      marketplaces,
      plugins,
      operations: this.#operations.map(operation => ({ ...operation })),
      diagnostics,
    }
  }
}

function emptyCapabilities(): PluginCapabilities {
  return { skills: [], mcpServers: [], uiSurfaces: [], unsupported: [] }
}

function describePackage(
  loaded: LoadedPluginPackage,
  pluginId: string,
  version: string,
  sourceType: PluginDescription['sourceType'],
  installed: boolean,
): PluginDescription {
  const { name, marketplace } = parsePluginId(pluginId)
  return {
    id: pluginId,
    name,
    marketplace,
    version,
    ...(loaded.manifest.description === undefined ? {} : { description: loaded.manifest.description }),
    ...(loaded.manifest.author === undefined ? {} : { author: loaded.manifest.author }),
    ...(loaded.manifest.homepage === undefined ? {} : { homepage: loaded.manifest.homepage }),
    sourceType,
    skills: [...loaded.capabilities.skills],
    mcpServers: Object.entries(loaded.manifest.mcpServers).map(([key, server]) => ({
      name: key,
      serverName: pluginServerName(loaded.manifest.name, key),
      command: server.command,
      args: [...server.args],
      envKeys: Object.keys(server.env).sort(),
      exposure: server.exposure,
    })),
    uiSurfaces: loaded.manifest.uiSurfaces.map(surface => ({
      id: surface.id,
      title: surface.title,
      server: surface.server,
      resourceUri: surface.resourceUri,
    })),
    unsupported: [...loaded.capabilities.unsupported],
    dependencies: [...loaded.manifest.dependencies],
    installed,
  }
}
