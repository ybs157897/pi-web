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

/** 一个已注册市场的内存记录（marketplaces.json 的行）。 */
interface MarketplaceRecord {
  id: string
  name: string
  source: string
  kind: 'directory' | 'url'
  lastUpdated: number
  lastError?: string
}

/** 市场目录缓存：抓取时间 + 归一化目录。 */
interface CatalogCache {
  fetchedAt: number
  catalog: NormalizedCatalog
}

/** 一条已安装插件台账（installed.json 的行）。 */
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

/** 一次安装/更新操作的状态记录。 */
interface Operation {
  id: string
  pluginId: string
  status: 'running' | 'completed' | 'failed'
  error?: string
  startedAt: number
  finishedAt?: number
}

/**
 * 状态变更事件。`operation` 与 `marketplace` 不改变可运行能力集；运行时只在
 * `install`、`update`、`uninstall`、`enable` 时重载 MCP servers。
 */
export type PluginChangeEvent = {
  reason: 'operation' | 'marketplace' | 'install' | 'update' | 'uninstall' | 'enable'
  pluginIds: string[]
}

/** 一个已物化到 staging 的插件包（含其依赖闭包里的一项）。 */
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
  /** 每次状态变更后调用；运行时用它重载 MCP servers 并唤醒 SSE。 */
  onChange?: (event: PluginChangeEvent) => void
}

/** 插件技能根目录（SkillStore 扫描的输入之一）。 */
export interface PluginSkillRoot {
  source: 'plugin'
  path: string
  pluginId: string
  pluginName: string
}

/** 判断错误是否为 ENOENT（路径不存在）。 */
function isMissing(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT'
}

/** 取错误的 message 文本。 */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** 判断 target 是否位于 root 内（含等于 root），防路径逃逸。 */
function within(root: string, target: string): boolean {
  const path = relative(root, target)
  return path === '' || (path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path))
}

/**
 * 持有插件目录、安装台账与 P0 所需的能力投影。
 *
 * 来源物化规则与 staging：安装/更新先把「插件 + 缺失依赖闭包」物化到
 * `staging/<事务ID>`（目录复制 / 校验和 zip 解包 / GitHub zipball / git 浅克隆，
 * 见 source.ts），再逐个 rename 到 `cache/<市场>/<名称>/<版本>`，最后一次性提交
 * installed.json；任一步失败回滚已 rename 的目录并恢复备份，installed.json 不动。
 * 旧版本目录与备份只在台账提交后清理。
 */
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

  /**
   * 功能：打开（或初始化）插件存储：建目录、把根路径 canonical 化并从磁盘装载状态。
   * 内部逻辑：skill root 校验从文件系统根走起，因此把缓存路径 canonical 化，
   * 避免符号链接的数据目录（macOS `/var`）被误判为插件符号链接。
   */
  static async open(options: PluginStoreOptions): Promise<PluginStore> {
    const store = new PluginStore(options.dataDir)
    store.#onChange = options.onChange
    await mkdir(store.root, { recursive: true, mode: 0o700 })
    // skill root 的校验从文件系统根开始走；保持缓存路径 canonical，
    // 符号链接的数据目录（macOS `/var`）就不会被误认成插件符号链接。
    store.root = await realpath(store.root)
    await store.#load()
    return store
  }

  /** marketplaces.json 的路径。 */
  get marketplacesPath(): string {
    return join(this.root, 'marketplaces.json')
  }

  /** installed.json 的路径。 */
  get installedPath(): string {
    return join(this.root, 'installed.json')
  }

  /** 某个市场的目录缓存文件路径。 */
  #marketplaceCachePath(id: string): string {
    return join(this.root, 'marketplaces', `${id}.json`)
  }

  /** 某插件某版本的安装目录路径。 */
  #pluginCachePath(marketplace: string, name: string, version: string): string {
    return join(this.root, 'cache', marketplace, name, version)
  }

  /** 某插件全版本共用的家族目录路径（卸载时整体删除）。 */
  #pluginFamilyPath(marketplace: string, name: string): string {
    return join(this.root, 'cache', marketplace, name)
  }

  /** 插件私有数据目录路径（同时以 PLUGIN_DATA 暴露）。 */
  #dataPath(pluginId: string): string {
    return join(this.root, 'data', dataDirectoryName(pluginId))
  }

  /** 某事务的 staging 根路径。 */
  #stagingPath(transactionId: string): string {
    return join(this.root, 'staging', transactionId)
  }

  /**
   * 功能：从磁盘装载市场清单、目录缓存与安装台账。
   * 内部逻辑：先建全部子目录并清空上次崩溃残留的 staging；marketplaces.json /
   * installed.json 损坏时记入 loadDiagnostics（市场来源清空 / 无插件视为已安装）；
   * 缓存缺失的市场记 lastError 提示刷新；每条台账路径必须在根内且能加载 manifest，
   * 否则记诊断并跳过。
   */
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

  /** 路径是否存在（lstat，不跟随符号链接）。 */
  async #exists(path: string): Promise<boolean> {
    try {
      await lstat(path)
      return true
    } catch {
      return false
    }
  }

  /** 读 JSON 文件并用 schema 校验；文件缺失、JSON 损坏或校验不过都返回 undefined。 */
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

  /** 原子写 JSON：先写 `.tmp-*` 临时文件再 rename，失败清理临时文件。 */
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

  /** 串行锁：所有状态变更排进 #tail 队列依次执行，避免并发写台账。 */
  #withLock<T>(action: () => Promise<T>): Promise<T> {
    const run = this.#tail.then(action, action)
    this.#tail = run.then(() => undefined, () => undefined)
    return run
  }

  /** 广播状态变更事件；监听器抛错不影响已提交的变更。 */
  #emit(reason: PluginChangeEvent['reason'], pluginIds: readonly string[] = []): void {
    try {
      this.#onChange?.({ reason, pluginIds: [...pluginIds] })
    } catch {
      // 监听器不能打断已经提交的存储变更。
    }
  }

  /** 把市场清单写入 marketplaces.json。 */
  #persistMarketplaces(): Promise<void> {
    return this.#writeJson(this.marketplacesPath, { version: 1, marketplaces: this.#marketplaces })
  }

  /** 把安装台账写入 installed.json（可传完整数组，默认写内存现状）。 */
  #persistInstalled(records: readonly InstalledRecord[] = this.#installed): Promise<void> {
    return this.#writeJson(this.installedPath, { version: 1, plugins: records })
  }

  /** 按 id 取市场记录；不存在抛 MARKETPLACE_NOT_FOUND。 */
  #marketplace(id: string): MarketplaceRecord {
    const marketplace = this.#marketplaces.find(item => item.id === id)
    if (marketplace === undefined) throw new RuntimeError('MARKETPLACE_NOT_FOUND', 'Marketplace was not found')
    return marketplace
  }

  /** 取市场目录缓存；尚未缓存（未刷新）抛 MARKETPLACE_NOT_FOUND 并提示刷新。 */
  #catalog(id: string): CatalogCache {
    const cache = this.#catalogs.get(id)
    if (cache === undefined) throw new RuntimeError('MARKETPLACE_NOT_FOUND', 'Marketplace catalog is not cached yet; refresh it first')
    return cache
  }

  /** 按插件 ID 取安装台账；未安装抛 PLUGIN_NOT_FOUND。 */
  #record(pluginId: string): InstalledRecord {
    const record = this.#installed.find(item => item.id === pluginId)
    if (record === undefined) throw new RuntimeError('PLUGIN_NOT_FOUND', 'Plugin is not installed')
    return record
  }

  /** 落盘目录缓存并更新市场记录（名称、lastUpdated，清除 lastError）。 */
  async #storeCatalog(marketplace: MarketplaceRecord, catalog: NormalizedCatalog): Promise<void> {
    const fetchedAt = Date.now()
    await this.#writeJson(this.#marketplaceCachePath(marketplace.id), { version: 1, fetchedAt, catalog })
    this.#catalogs.set(marketplace.id, { fetchedAt, catalog })
    marketplace.name = catalog.name
    marketplace.lastUpdated = fetchedAt
    delete marketplace.lastError
  }

  /**
   * 功能：注册一个市场（本地目录或 URL）并缓存其目录。
   * @param sourceText 来源声明（绝对路径或 HTTPS URL）
   * @returns 注册后的完整概览
   * 内部逻辑：先加载并归一化目录，再由目录名生成市场 id；同 id 不同来源抛
   * CONFLICT；缓存写盘、记录入列并持久化，最后广播 marketplace 事件。
   */
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

  /**
   * 功能：注销市场：删除记录、目录缓存与缓存文件；不影响已安装插件。
   * @returns 注销后的完整概览；市场不存在抛 MARKETPLACE_NOT_FOUND
   */
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

  /**
   * 功能：重新加载市场目录：成功则更新缓存；失败把错误记进 lastError 后原样抛出。
   * @returns 刷新后的完整概览
   */
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

  /** 找某插件当前 running 的操作视图；没有返回 undefined。 */
  #operation(pluginId: string): PluginOperationView | undefined {
    return this.#operations.find(operation => operation.pluginId === pluginId && operation.status === 'running')
  }

  /**
   * 功能：启动一次安装（含依赖闭包）并立即返回；UI 轮询 overview() 看操作进度。
   * 内部逻辑：经 #startOperation 后台执行——#stageClosure 物化闭包到 staging，
   * #activateStaged 激活，finally 清理 staging 目录。
   */
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

  /** 按目录当前版本重新物化一个已安装插件（依赖只补缺，不重装已有依赖）。 */
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

  /**
   * 功能：登记并后台执行一次操作；同插件已有 running 操作时直接返回它（去重）。
   * @param pluginId 目标插件
   * @param reason 完成时广播的事件原因（install / update）
   * @param action 携带操作 ID 的后台动作
   * @returns 操作视图（running）；结束后依次广播 operation → reason → operation 事件
   */
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
   * 功能：把插件与其缺失依赖闭包物化到 staging（staging 阶段，尚未提交）。
   * @returns staging 条目列表与事务 ID
   * 内部逻辑：从目录条目出发按 dependencies 广搜；install 模式遇到已装插件：版本
   * 相同跳过、不同报 PLUGIN_ALREADY_INSTALLED；update 模式只物化根与缺失依赖；
   * 每项先清空再物化到独立 staging 目录，加载 manifest 并核对名称/版本与目录一致；
   * 闭包超过 64 个节点或依赖不在本市场内即报错；出错清理整个 staging。
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
   * 功能：激活 staging 里的包：逐插件 rename 进 cache，最后一次提交 installed.json。
   * @param marketplaceId 目标市场
   * @param items #stageClosure 的产物
   * @param transactionId 事务 ID（用于备份命名）
   * 内部逻辑（激活与回滚）：已安装且版本与指纹都没变的项直接进 unchanged 稍后清理；
   * 其余项先把旧目录 rename 成 `.prev-<事务ID>` 备份、再 rename staging 进目标，
   * rename 失败即还原备份；全部就绪后一次性写新台账并更新内存与 manifests，
   * 最后才删除旧版本目录与备份。任何失败按 activated 逆序回滚（删新目录、还原
   * 备份），installed.json 保持不动。
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

      // 旧版本目录与备份只在安装台账提交后才删除。
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

  /**
   * 功能：卸载插件：删除其整个版本家族目录与台账记录。
   * @param pluginId 插件 ID；未安装抛 PLUGIN_NOT_FOUND
   * @param keepData true 时保留插件私有数据目录（默认连数据一起删）
   * @returns 卸载后的完整概览
   */
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

  /**
   * 功能：启用或停用插件并持久化（不删文件）；返回概览并广播 enable 事件。
   */
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
   * 功能：投影已启用插件的 MCP servers，运行时路径已展开。
   * @returns PluginMcpServerConfig 数组；绝不跨越 HTTP 边界（对象含 env 值与绝对路径）
   * 内部逻辑：server 名基于 pluginServerName 生成，跨插件冲突时追加插件 ID 哈希
   * 前 8 位；`${PLUGIN_ROOT}` / `${PLUGIN_DATA}` 占位符在 command/args/env 中展开，
   * 并把这两个变量直接注入 env；cwd 是插件根。
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
   * 功能：投影已启用插件的 UI 面，供宿主打开。
   * 内部逻辑：server 名来自与 mcpServers() 相同的投影（含冲突改名），因此插件
   * server 改名后其页面仍然可达；引用未知 server 的面被跳过。
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

  /** 按带命名空间的 server 名找到拥有它的已启用插件（页面发起调用时做归属校验用）。 */
  pluginServer(serverName: string): { pluginId: string; pluginName: string; serverKey: string } | undefined {
    const server = this.mcpServers().find(item => item.serverName === serverName)
    if (server === undefined) return undefined
    return { pluginId: server.pluginId, pluginName: server.pluginName, serverKey: server.serverKey }
  }

  /**
   * 功能：描述一个候选（或已安装）插件的组成，供安装确认页展示。
   * @param pluginId 完整插件 ID
   * @returns PluginDescription：技能、MCP servers（含 exposure 与 env 键名）、UI 面、不支持能力与依赖
   * 内部逻辑：已安装且与目录版本一致时直接描述磁盘上的包，不重新物化；否则从
   * 市场临时物化到 staging（describe-* 目录，finally 清理）再描述；来源不支持抛错。
   */
  async describe(pluginId: string): Promise<PluginDescription> {
    const { name, marketplace } = parsePluginId(pluginId)
    const record = this.#installed.find(item => item.id === pluginId)
    const marketplaceRecord = this.#marketplaces.find(item => item.id === marketplace)
    const entry = marketplaceRecord === undefined
      ? undefined
      : this.#catalogs.get(marketplace)?.catalog.plugins.find(plugin => plugin.name === name)

    // 已安装且版本未变：直接描述磁盘上的包，而不是重新下载目录包。
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

  /** 同步投影已启用插件的技能根目录，SkillStore 每次目录请求都会读取。 */
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

  /** 裁剪操作历史：保留最近 OPERATION_HISTORY_LIMIT 条，且已结束条目需在保留期内；running 永远保留。 */
  #pruneOperations(): void {
    const cutoff = Date.now() - OPERATION_RETENTION_MS
    this.#operations = this.#operations
      .filter((operation, index) => index < OPERATION_HISTORY_LIMIT && (operation.status === 'running' || (operation.finishedAt ?? operation.startedAt) >= cutoff))
  }

  /**
   * 功能：组装面向前端的插件总览：市场摘要、插件列表（目录 + 已装但目录里没有的）、
   * 操作历史与诊断。
   * 内部逻辑：先裁剪操作历史；诊断 = 装载诊断 + 有 lastError 的市场；插件按目录
   * 逐市场投影（去重），再补上台账中目录已没有的已装插件；排序为精选优先、
   * 其次市场名与插件名。
   */
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

/** 空能力集（manifest 加载失败时的兜底投影）。 */
function emptyCapabilities(): PluginCapabilities {
  return { skills: [], mcpServers: [], uiSurfaces: [], unsupported: [] }
}

/** 把已加载的插件包转为 PluginDescription（describe 的通用收尾）。 */
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
