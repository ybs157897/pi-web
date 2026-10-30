import { chmod, copyFile, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

/** The app's global home. `PI_WEB_HOME` may point it elsewhere without touching code. */
export function piWebHome(env: NodeJS.ProcessEnv = process.env): string {
  return resolve(env.PI_WEB_HOME ?? join(homedir(), '.pi-web'))
}

/** Pi's old global directory, read once by the migration only. */
export function legacyPiHome(): string {
  return join(homedir(), '.pi', 'agent')
}

const PI_FILES = ['settings.json', 'models.json', 'auth.json', 'mcp.json'] as const
const APP_FILES = ['app-state.json', 'pi-durable.sqlite', 'pi-durable.sqlite-wal', 'pi-durable.sqlite-shm'] as const

async function exists(path: string): Promise<boolean> {
  try { await stat(path); return true } catch { return false }
}

async function readJson(path: string): Promise<Record<string, unknown> | undefined> {
  try {
    const value: unknown = JSON.parse(await readFile(path, 'utf8'))
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') return undefined
    throw new Error(`无法读取有效的配置文件：${path}`)
  }
}

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

/** Copy one file without ever replacing something the user already put in the global home. */
async function copyMissing(from: string, to: string, migrated: string[]): Promise<void> {
  if (await exists(to) || !(await exists(from))) return
  await mkdir(dirname(to), { recursive: true, mode: 0o700 })
  await copyFile(from, to)
  await chmod(to, 0o600).catch(() => undefined)
  migrated.push(to)
}

/**
 * One-time import into `~/.pi-web`: Pi's old global files, this app's legacy
 * `.data` providers/credentials, and the legacy app state and conversation
 * database. The caller stops the old server first so SQLite/WAL are copied
 * without a live writer. A marker makes this idempotent.
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

  // The old app layer held the directory the user actually edited. Merge it
  // over the Pi files only when the global destination was not already owned
  // by the user, and keep the Pi provider entry's unknown fields.
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
