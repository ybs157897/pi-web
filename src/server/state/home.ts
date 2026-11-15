import { chmod, copyFile, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

/**
 * 功能：返回应用全局主目录；`PI_WEB_HOME` 可在不改代码的情况下指向别处。
 * @param env 进程环境（默认 process.env，测试可注入）。
 * @returns 绝对路径：`$PI_WEB_HOME` 或 `~/.pi-web`。
 */
export function piWebHome(env: NodeJS.ProcessEnv = process.env): string {
  return resolve(env.PI_WEB_HOME ?? join(homedir(), '.pi-web'))
}

/** Pi 旧版全局目录，仅迁移逻辑一次性读取。 */
export function legacyPiHome(): string {
  return join(homedir(), '.pi', 'agent')
}

/** 从 `~/.pi/agent` 迁移的 Pi 全局文件清单。 */
const PI_FILES = ['settings.json', 'models.json', 'auth.json', 'mcp.json'] as const
/** 从旧版项目内 `.data` 目录迁移的本应用文件清单（含 SQLite 主库与 WAL/SHM）。 */
const APP_FILES = ['app-state.json', 'pi-durable.sqlite', 'pi-durable.sqlite-wal', 'pi-durable.sqlite-shm'] as const

/** 判断路径是否存在（stat 探测；任何错误一律视为不存在）。 */
async function exists(path: string): Promise<boolean> {
  try { await stat(path); return true } catch { return false }
}

/**
 * 功能：读取并解析一个 JSON 对象配置文件。
 * @param path 文件绝对路径。
 * @returns 顶层对象（不含数组）；文件不存在返回 undefined；存在但不是合法对象时抛错。
 * 内部逻辑：JSON.parse 后校验为非数组的普通对象；ENOENT 视为缺失，其他错误包装成带路径的中文错误。
 */
async function readJson(path: string): Promise<Record<string, unknown> | undefined> {
  try {
    const value: unknown = JSON.parse(await readFile(path, 'utf8'))
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') return undefined
    throw new Error(`无法读取有效的配置文件：${path}`)
  }
}

/**
 * 功能：原子写出 JSON 配置文件（美化缩进）。
 * @param path 目标绝对路径。
 * @param value 任意可 JSON 序列化的值。
 * 内部逻辑：临时文件 wx 独占创建（0600）→ chmod → rename；目录 0700；失败清理临时文件后抛出。
 */
async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  const dir = dirname(path)
  await mkdir(dir, { recursive: true, mode: 0o700 })
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
 * 功能：仅当目标不存在且源存在时复制一个文件——绝不覆盖用户已放进全局主目录的内容。
 * @param from 源路径。
 * @param to 目标路径。
 * @param migrated 已迁移文件路径的收集数组（成功时追加目标路径）。
 */
async function copyMissing(from: string, to: string, migrated: string[]): Promise<void> {
  if (await exists(to) || !(await exists(from))) return
  await mkdir(dirname(to), { recursive: true, mode: 0o700 })
  await copyFile(from, to)
  await chmod(to, 0o600).catch(() => undefined)
  migrated.push(to)
}

/**
 * 功能：一次性导入全局主目录 `~/.pi-web`：Pi 旧全局文件、本应用旧版 `.data` 的
 * providers/凭据、旧应用状态与会话数据库。调用方需先停掉旧服务，保证 SQLite/WAL
 * 在没有活跃写者时被复制。写入标记文件 `.migrated` 保证幂等。
 * @param home 全局主目录（piWebHome 的结果）。
 * @param legacyDataDir 旧版项目内数据目录（如 `.data`）。
 * @param options.piHome 可覆盖的 Pi 旧目录（默认 legacyPiHome()）。
 * @returns 本次实际迁移（复制/合并写出）的文件路径列表；已有标记时返回空数组。
 * 内部逻辑：先复制 PI_FILES 与 APP_FILES（copyMissing 不覆盖既有文件）；旧版
 * providers.json 仅在目标 models.json/auth.json 未被用户占用时合并——保留 Pi 条目
 * 的未知字段，按 id 去重合并 provider 与凭据；最后写时间戳标记，下次直接跳过。
 */
export async function migrateGlobalHome(
  home: string,
  legacyDataDir: string,
  options: { piHome?: string } = {},
): Promise<string[]> {
  const marker = join(home, '.migrated')
  if (await exists(marker)) return []
  await mkdir(home, { recursive: true, mode: 0o700 })
  await chmod(home, 0o700).catch(() => undefined)
  const migrated: string[] = []
  const piHome = options.piHome ?? legacyPiHome()
  const modelsPath = join(home, 'models.json')
  const authPath = join(home, 'auth.json')
  const modelsExisted = await exists(modelsPath)
  const authExisted = await exists(authPath)

  for (const name of PI_FILES) await copyMissing(join(piHome, name), join(home, name), migrated)
  for (const name of APP_FILES) await copyMissing(join(legacyDataDir, name), join(home, name), migrated)

  // 旧应用层保存的是用户实际编辑过的目录。仅在全局目标未被用户占用时才把它合并到 Pi 文件之上，
  // 并保留 Pi provider 条目中的未知字段。
  const legacyProvidersPath = join(legacyDataDir, 'providers.json')
  if ((!modelsExisted || !authExisted) && await exists(legacyProvidersPath)) {
    const legacy = await readJson(legacyProvidersPath)
    if (legacy && Array.isArray(legacy.providers) && !modelsExisted) {
      const target = await readJson(modelsPath) ?? {}
      const providers = typeof target.providers === 'object' && target.providers !== null && !Array.isArray(target.providers)
        ? { ...(target.providers as Record<string, unknown>) }
        : {}
      for (const entry of legacy.providers) {
        if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) continue
        const provider = entry as Record<string, unknown>
        if (typeof provider.id !== 'string' || provider.id === '') continue
        const existing = typeof providers[provider.id] === 'object' && providers[provider.id] !== null && !Array.isArray(providers[provider.id])
          ? providers[provider.id] as Record<string, unknown>
          : {}
        providers[provider.id] = {
          ...existing,
          ...(typeof provider.name === 'string' ? { name: provider.name } : {}),
          ...(typeof provider.baseUrl === 'string' && provider.baseUrl !== '' ? { baseUrl: provider.baseUrl } : {}),
          ...(typeof provider.api === 'string' ? { api: provider.api } : {}),
          ...(typeof provider.headers === 'object' && provider.headers !== null && !Array.isArray(provider.headers) ? { headers: provider.headers } : {}),
          ...(typeof provider.compat === 'object' && provider.compat !== null && !Array.isArray(provider.compat) ? { compat: provider.compat } : {}),
          models: Array.isArray(provider.models) ? provider.models : [],
        }
      }
      await writeJsonAtomic(modelsPath, { ...target, providers })
      migrated.push(modelsPath)
    }
    if (legacy && typeof legacy.credentials === 'object' && legacy.credentials !== null && !Array.isArray(legacy.credentials) && !authExisted) {
      const auth = await readJson(authPath) ?? {}
      for (const [id, credential] of Object.entries(legacy.credentials as Record<string, unknown>)) {
        if (id !== '' && typeof credential === 'object' && credential !== null && !Array.isArray(credential)) auth[id] = credential
      }
      await writeJsonAtomic(authPath, auth)
      migrated.push(authPath)
    }
  }

  await writeFile(marker, `${new Date().toISOString()}\n`, { encoding: 'utf8', mode: 0o600 })
  return migrated
}
