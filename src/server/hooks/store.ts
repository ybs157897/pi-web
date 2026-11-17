import { createHash } from 'node:crypto'
import { chmod, lstat, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join, resolve, sep } from 'node:path'
import { z } from 'zod'
import {
  configDefaults,
  hooksFileSchema,
  type HookEntry,
  type HookEvent,
  type HooksConfig,
} from './schema.ts'

/**
 * 功能：hooks 配置存储——用户级（~/.pi-web/hooks.json）与项目级（<workspace>/.pi-web/hooks.json）
 * 两来源的热读、原子写、脚本落盘，以及项目级 hook 的 digest 信任管理。
 * 内部逻辑：热读用 mtime+size 缓存（hook 触发频繁，stat 廉价）；信任三件套对齐 ZCode——
 * digest 覆盖全部执行参数、每次 dispatch 重验不缓存、trust store 损坏 fail-closed 全拒。
 * 用户级配置无信任门（用户本机自己写的，enabled 即执行）；项目级随仓库走，外部带来的
 * 声明（digest 不在信任集）一律 pending 不执行，须经设置页或 manage_hooks 创建时批准。
 */

/** 项目级配置与脚本在仓库内的根目录名。 */
export const PROJECT_HOOKS_DIR = '.pi-web'
/** 用户级脚本目录名（相对 home）。 */
export const USER_SCRIPTS_DIR = 'hook-scripts'

/** 一次配置加载的结果：config 为 undefined 表示来源缺失或损坏（error 带诊断）。 */
export interface LoadedConfig {
  path: string
  config: HooksConfig | undefined
  error?: string
}

/** 信任记录：workspaceId + digest 唯一键。 */
const trustRecordSchema = z.object({
  workspaceId: z.string().min(1),
  digest: z.string().regex(/^[0-9a-f]{64}$/),
  trustedAt: z.number().int(),
}).strict()
const trustFileSchema = z.object({
  version: z.literal(1),
  records: z.array(trustRecordSchema),
}).strict()

/**
 * 功能：计算单条 hook 的声明 digest。
 * 内部逻辑：固定字段序的规范化 JSON 取 sha256；覆盖 event/matcher/执行定义/生效超时与
 * 输出上限——改任何执行参数（含 timeout）都使 digest 失效、回落 pending（ZCode 同款）。
 * enabled 不参与：启停是管理操作，不改变执行内容。
 * @param event 事件名。
 * @param matcher 所在组的 matcher（缺省归一化为空串）。
 * @param entry hook 定义。
 * @param defaults 来源级生效默认值。
 * @returns 64 位十六进制 digest。
 */
export function hookDigest(
  event: HookEvent,
  matcher: string | undefined,
  entry: HookEntry,
  defaults: { timeoutMs: number; maxOutputBytes: number },
): string {
  const canonical = JSON.stringify({
    v: 1,
    event,
    matcher: matcher ?? '',
    type: entry.type,
    command: entry.command,
    args: entry.args ?? [],
    includeNested: entry.includeNested === true,
    timeoutMs: entry.timeoutMs ?? defaults.timeoutMs,
    maxOutputBytes: defaults.maxOutputBytes,
  })
  return createHash('sha256').update(canonical).digest('hex')
}

/**
 * 功能：原子写 JSON（tmp wx 独占 + rename，0600/0700），与 home.ts 同款约定。
 * @param path 目标绝对路径。
 * @param value 可 JSON 序列化的值。
 */
async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  const dir = dirname(path)
  await mkdir(dir, { recursive: true, mode: 0o700 })
  const temp = join(dir, `.tmp-${process.pid}-${crypto.randomUUID()}`)
  try {
    await writeFile(temp, JSON.stringify(value, null, 2), { encoding: 'utf8', mode: 0o600, flag: 'wx' })
    await chmod(temp, 0o600)
    await rename(temp, path)
  } catch (error) {
    await rm(temp, { force: true }).catch(() => undefined)
    throw error
  }
}

/** mtime+size 缓存条目：stat 不变则复用解析结果。 */
interface CacheEntry {
  mtimeMs: number
  size: number
  loaded: LoadedConfig
}

export class HooksStore {
  private readonly cache = new Map<string, CacheEntry>()
  /** trust store 损坏标记：一旦损坏，项目级全拒直到文件被修复或删除（fail-closed）。 */
  private trustCorrupt = false

  /**
   * @param home 用户级根目录（piWebHome()，~/.pi-web）。
   * @param dataDir 应用数据目录——trust store 存这里，绝不进仓库。
   */
  constructor(private readonly home: string, private readonly dataDir: string) {}

  /** 用户级配置文件路径。 */
  userConfigPath(): string {
    return join(this.home, 'hooks.json')
  }

  /** 项目级配置文件路径（随仓库走）。 */
  projectConfigPath(workspacePath: string): string {
    return join(workspacePath, PROJECT_HOOKS_DIR, 'hooks.json')
  }

  /** 用户级脚本目录。 */
  userScriptsDir(): string {
    return join(this.home, USER_SCRIPTS_DIR)
  }

  /** 项目级脚本目录（随仓库走）。 */
  projectScriptsDir(workspacePath: string): string {
    return join(workspacePath, PROJECT_HOOKS_DIR, USER_SCRIPTS_DIR)
  }

  /** trust store 路径（dataDir 下，不进仓库）。 */
  trustPath(): string {
    return join(this.dataDir, 'hooks-trust.json')
  }

  /**
   * 功能：热读一个配置来源（mtime+size 缓存）。
   * @param path 配置文件绝对路径。
   * @returns 加载结果；文件缺失返回空 config，损坏返回 error 诊断且不执行该来源。
   * 内部逻辑：stat 失败按缺失处理；JSON/schema 校验失败记诊断——单来源损坏不牵连另一来源。
   */
  async load(path: string): Promise<LoadedConfig> {
    let info: Awaited<ReturnType<typeof stat>>
    try {
      info = await stat(path)
    } catch {
      this.cache.delete(path)
      return { path, config: undefined }
    }
    const cached = this.cache.get(path)
    if (cached && cached.mtimeMs === info.mtimeMs && cached.size === info.size) return cached.loaded
    let loaded: LoadedConfig
    try {
      const parsed: unknown = JSON.parse(await readFile(path, 'utf8'))
      const file = hooksFileSchema.safeParse(parsed)
      loaded = file.success
        ? { path, config: file.data.hooks ?? {} }
        : { path, config: undefined, error: `hooks 配置校验失败：${path}` }
    } catch {
      loaded = { path, config: undefined, error: `hooks 配置不是合法 JSON：${path}` }
    }
    this.cache.set(path, { mtimeMs: info.mtimeMs, size: info.size, loaded })
    return loaded
  }

  /** 热读用户级配置。 */
  async loadUser(): Promise<LoadedConfig> {
    return this.load(this.userConfigPath())
  }

  /** 热读项目级配置。 */
  async loadProject(workspacePath: string): Promise<LoadedConfig> {
    return this.load(this.projectConfigPath(workspacePath))
  }

  /** 原子写用户级配置（整体替换 hooks 块）。 */
  async saveUser(config: HooksConfig): Promise<void> {
    await writeJsonAtomic(this.userConfigPath(), { hooks: config })
    this.cache.delete(this.userConfigPath())
  }

  /** 原子写项目级配置。 */
  async saveProject(workspacePath: string, config: HooksConfig): Promise<void> {
    const path = this.projectConfigPath(workspacePath)
    await writeJsonAtomic(path, { hooks: config })
    this.cache.delete(path)
  }

  /**
   * 功能：落盘 hook 脚本（manage_hooks 一站式创建用）。
   * 输入校验：name 仅允许安全文件名字符（禁路径分隔符与 ..）；目标须在脚本根内且非符号链接。
   * @param dir 脚本根目录（userScriptsDir / projectScriptsDir）。
   * @param name 脚本文件名（如 update-docs.mjs）。
   * @param content 脚本内容。
   * @returns 脚本绝对路径。
   */
  async writeScript(dir: string, name: string, content: string): Promise<string> {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(name)) {
      throw new Error(`非法脚本名：${name}（仅字母数字开头，可含 . _ -）`)
    }
    const root = resolve(dir)
    const target = resolve(root, name)
    if (!target.startsWith(root + sep)) throw new Error(`脚本路径越界：${name}`)
    await mkdir(root, { recursive: true, mode: 0o700 })
    // 禁符号链接：目标已存在且是链接时拒绝，防止借链接写出根外。
    try {
      const existing = await lstat(target)
      if (existing.isSymbolicLink()) throw new Error(`脚本路径是符号链接，拒绝写入：${target}`)
    } catch (error) {
      if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') {
        // 不存在，正常创建。
      } else if (error instanceof Error && error.message.startsWith('脚本路径是符号链接')) {
        throw error
      }
      // 其他 stat 错误不阻断创建（写入时自会暴露）。
    }
    await writeFile(target, content, { encoding: 'utf8', mode: 0o600 })
    return target
  }

  /**
   * 功能：读取信任集。
   * @returns digest 集合（按 workspaceId 过滤）；store 缺失返回空集；损坏返回 undefined
   * 并置 corrupt 标记——调用方对 undefined 必须 fail-closed 全拒项目级。
   */
  async trustedDigests(workspaceId: string): Promise<Set<string> | undefined> {
    if (this.trustCorrupt) return undefined
    let raw: string
    try {
      raw = await readFile(this.trustPath(), 'utf8')
    } catch {
      return new Set()
    }
    try {
      const file = trustFileSchema.parse(JSON.parse(raw))
      return new Set(file.records.filter(record => record.workspaceId === workspaceId).map(record => record.digest))
    } catch {
      this.trustCorrupt = true
      return undefined
    }
  }

  /**
   * 功能：批准一条项目级 hook（写 digest 进信任集）。
   * @param workspaceId 工作区 ID。
   * @param digest hookDigest 的结果。
   * 内部逻辑：读-改-写原子落盘；损坏的 store 拒绝批准（须先修复），fail-closed 一致。
   */
  async admit(workspaceId: string, digest: string): Promise<void> {
    const records = await this.readTrustRecords()
    if (records === undefined) throw new Error('hooks 信任存储损坏，拒绝批准；请修复或删除 hooks-trust.json')
    if (!records.some(record => record.workspaceId === workspaceId && record.digest === digest)) {
      records.push({ workspaceId, digest, trustedAt: Date.now() })
    }
    await writeJsonAtomic(this.trustPath(), { version: 1, records })
  }

  /**
   * 功能：撤销一条项目级 hook 的信任（删 digest）。
   * @returns 是否实际删除了记录。
   */
  async revoke(workspaceId: string, digest: string): Promise<boolean> {
    const records = await this.readTrustRecords()
    if (records === undefined) throw new Error('hooks 信任存储损坏，拒绝操作；请修复或删除 hooks-trust.json')
    const next = records.filter(record => !(record.workspaceId === workspaceId && record.digest === digest))
    if (next.length === records.length) return false
    await writeJsonAtomic(this.trustPath(), { version: 1, records: next })
    return true
  }

  /** 读信任记录原始数组；缺失返回空数组，损坏返回 undefined 并置标记。 */
  private async readTrustRecords(): Promise<Array<z.infer<typeof trustRecordSchema>> | undefined> {
    if (this.trustCorrupt) return undefined
    let raw: string
    try {
      raw = await readFile(this.trustPath(), 'utf8')
    } catch {
      return []
    }
    try {
      return trustFileSchema.parse(JSON.parse(raw)).records
    } catch {
      this.trustCorrupt = true
      return undefined
    }
  }
}

/**
 * 功能：枚举一个来源里某事件的全部可执行候选（matcher 过滤与 enabled 跳过在 runner 侧）。
 * @param config 来源配置。
 * @param event 事件名。
 * @returns 组数组（含 matcher 与组内 hooks）；来源禁用或缺失返回空。
 */
export function eventGroups(config: HooksConfig | undefined, event: HookEvent): Array<{ matcher?: string; hooks: HookEntry[] }> {
  if (!config || config.enabled === false) return []
  return config.events?.[event] ?? []
}

/** 来源级生效默认值的便捷重导出，供 runner/extension 统一取用。 */
export { configDefaults }

/**
 * 功能：把一个来源某事件的条目按「组顺序 → 组内顺序」展开为带 index 的扁平清单。
 * @param config 来源配置。
 * @param event 事件名。
 * @returns 扁平条目（index 从 0 起，跨组连续计数）——manage_hooks 工具与设置页共用同一定位口径。
 */
export function flattenEventEntries(config: HooksConfig | undefined, event: HookEvent): Array<{ matcher?: string; index: number; entry: HookEntry }> {
  const flat: Array<{ matcher?: string; index: number; entry: HookEntry }> = []
  for (const group of eventGroups(config, event)) {
    for (const entry of group.hooks) {
      flat.push({ matcher: group.matcher, index: flat.length, entry })
    }
  }
  return flat
}

/**
 * 功能：按事件内 index 定位条目所在的组与组内位置（写操作用）。
 * @param config 来源配置（须含该事件）。
 * @param event 事件名。
 * @param index flattenEventEntries 口径的序号。
 * @returns 组下标与组内下标；越界返回 undefined。
 */
export function locateEntry(config: HooksConfig, event: HookEvent, index: number): { groupIndex: number; hookIndex: number } | undefined {
  const groups = config.events?.[event]
  if (!groups) return undefined
  let cursor = 0
  for (let groupIndex = 0; groupIndex < groups.length; groupIndex++) {
    const group = groups[groupIndex]
    if (index < cursor + group.hooks.length) return { groupIndex, hookIndex: index - cursor }
    cursor += group.hooks.length
  }
  return undefined
}