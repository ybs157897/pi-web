/**
 * 读取用户级 Pi MCP 文件（`mcp.json`，Pi 1.3.0 导入的 `{ mcpServers: { ... } }` 形状）。
 *
 * 浏览器永远看不到这个文件里的机密：只有 `view()` 跨协议，且不带 `env`、`headers`
 * 与命令行。解析刻意宽容：无效文件或条目不会让运行时启动失败，而是经 `error`
 * 上报，有效条目保持可用。
 */
import { readFile } from 'node:fs/promises'
import { resolve as resolvePath } from 'node:path'
import { z } from 'zod'
import { MCP_EXPOSURES, type McpExposure } from '../../shared/types.ts'

/** 一条 `toolExposure` 规则：精确工具名或带 `*` 的名称模式，按配置顺序生效。 */
export interface McpToolExposureRule {
  pattern: string
  exposure: McpExposure
}

/** 一条校验通过的 `mcpServers` 条目，transport 已解析。 */
export interface McpServerConfig {
  name: string
  transport: 'stdio' | 'http'
  enabled: boolean
  /** How the server's tools reach the model unless a `toolExposure` rule overrides them. */
  exposure: McpExposure
  description?: string
  /** Per-request timeout handed to `McpClient`, in milliseconds. */
  timeoutMs: number
  command?: string
  args: readonly string[]
  env?: Readonly<Record<string, string>>
  cwd?: string
  url?: string
  headers?: Readonly<Record<string, string>>
  /** Per-tool overrides, exact names first, then `*` patterns in config order. */
  toolExposure: readonly McpToolExposureRule[]
}

/** 读取一个 MCP 配置文件的结果。绝不 reject：坏文件返回空目录加 `error`。 */
export interface LoadedMcpConfig {
  /** Absolute path of the file that was read (or attempted). */
  configPath: string
  configExists: boolean
  servers: McpServerConfig[]
  /** File-level problem (invalid JSON, invalid entries, unresolved `${VAR}`s). */
  error?: string
}

const DEFAULT_TIMEOUT_SECONDS = 15
const SERVER_NAME = /^[A-Za-z0-9_-]+$/
const ENV_VARIABLE = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g

const exposureSchema = z.enum(MCP_EXPOSURES)
const stringRecord = z.record(z.string(), z.string())

/**
 * 严格条目 schema：未知键被拒绝，这样拼写错误（`exposures`、`tool_exposure`）会被
 * 报告而不是静默忽略。这里每个字段都可选；transport 要求在其后再检查。
 */
const serverEntrySchema = z.object({
  type: z.enum(['stdio', 'http', 'streamable-http']).optional(),
  command: z.string().min(1).optional(),
  args: z.array(z.string()).optional(),
  env: stringRecord.optional(),
  cwd: z.string().min(1).optional(),
  url: z.string().min(1).optional(),
  headers: stringRecord.optional(),
  enabled: z.boolean().optional(),
  exposure: exposureSchema.optional(),
  toolExposure: z.record(z.string().min(1), exposureSchema).optional(),
  description: z.string().optional(),
  timeout: z.number().positive().max(600).optional(),
}).strict()

type ServerEntry = z.infer<typeof serverEntrySchema>

/**
 * 功能：读取并校验 MCP 配置文件。
 * @param configPath mcp.json 的路径（相对路径按 cwd 解析）
 * @returns LoadedMcpConfig：文件缺失 → `configExists: false` + 空目录 + 无 error；
 * JSON 或条目畸形 → `error` 加上校验通过的条目；非 ENOENT 的读取失败 → `error`
 * （文件存在但不可用）
 */
export async function loadMcpConfig(configPath: string): Promise<LoadedMcpConfig> {
  const absolute = resolvePath(configPath)
  let text: string
  try {
    text = await readFile(absolute, 'utf8')
  } catch (error) {
    if (isNotFound(error)) return { configPath: absolute, configExists: false, servers: [] }
    return {
      configPath: absolute,
      configExists: true,
      servers: [],
      error: `MCP configuration could not be read: ${describeError(error)}`,
    }
  }

  let root: unknown
  try {
    root = JSON.parse(text)
  } catch (error) {
    return {
      configPath: absolute,
      configExists: true,
      servers: [],
      error: `MCP configuration is not valid JSON: ${describeError(error)}`,
    }
  }
  if (!isPlainObject(root)) {
    return { configPath: absolute, configExists: true, servers: [], error: 'MCP configuration must be a JSON object' }
  }

  const rawServers = root.mcpServers
  if (rawServers === undefined) return { configPath: absolute, configExists: true, servers: [] }
  if (!isPlainObject(rawServers)) {
    return { configPath: absolute, configExists: true, servers: [], error: '`mcpServers` must be an object' }
  }

  const servers: McpServerConfig[] = []
  const errors: string[] = []
  for (const [name, rawEntry] of Object.entries(rawServers)) {
    if (!SERVER_NAME.test(name)) {
      errors.push(`server "${name}": names may only contain A-Z, a-z, 0-9, "_" and "-"`)
      continue
    }
    const parsed = serverEntrySchema.safeParse(rawEntry)
    if (!parsed.success) {
      errors.push(`server "${name}": ${formatIssues(parsed.error)}`)
      continue
    }
    const entry = parsed.data
    const transport = resolveTransport(entry)
    if (typeof transport !== 'string') {
      errors.push(`server "${name}": ${transport.error}`)
      continue
    }

    const missing = new Set<string>()
    const expand = (value: string): string => expandEnvironment(value, missing)
    const server: McpServerConfig = {
      name,
      transport,
      enabled: entry.enabled ?? true,
      exposure: entry.exposure ?? 'codemode',
      timeoutMs: Math.round((entry.timeout ?? DEFAULT_TIMEOUT_SECONDS) * 1000),
      toolExposure: Object.entries(entry.toolExposure ?? {}).map(([pattern, exposure]) => ({ pattern, exposure })),
      args: [],
      ...(entry.description !== undefined ? { description: entry.description } : {}),
    }
    if (transport === 'stdio') {
      server.command = expand(entry.command!)
      server.args = (entry.args ?? []).map(expand)
      if (entry.cwd !== undefined) server.cwd = expand(entry.cwd)
      if (entry.env !== undefined) server.env = expandRecord(entry.env, expand)
    } else {
      server.url = entry.url!
      if (entry.headers !== undefined) server.headers = expandRecord(entry.headers, expand)
    }
    if (missing.size > 0) {
      errors.push(`server "${name}": environment variable${missing.size === 1 ? '' : 's'} ${[...missing].map(variable => `"${variable}"`).join(', ')} not set; kept as literal text`)
    }
    servers.push(server)
  }

  return {
    configPath: absolute,
    configExists: true,
    servers,
    ...(errors.length > 0 ? { error: errors.join('; ') } : {}),
  }
}

/**
 * transport 由 `type` 声明，或按 `command`/`url` 的存在推断。
 * @returns 解析出的 transport，或人类可读的错误对象
 */
function resolveTransport(entry: ServerEntry): 'stdio' | 'http' | { error: string } {
  switch (entry.type) {
    case 'stdio':
      return entry.command ? 'stdio' : { error: '"type" is "stdio" but "command" is missing' }
    case 'http':
    case 'streamable-http':
      return entry.url ? 'http' : { error: `"type" is "${entry.type}" but "url" is missing` }
    case undefined:
      if (entry.command && !entry.url) return 'stdio'
      if (entry.url && !entry.command) return 'http'
      if (entry.command && entry.url) return { error: 'both "command" and "url" are set; declare "type" to choose the transport' }
      return { error: 'needs "command" (stdio) or "url" (http)' }
  }
}

/** 从进程环境展开 `${VAR}` 引用；未解析的引用保持字面量并记入 missing 集合供上报。 */
function expandEnvironment(value: string, missing: Set<string>): string {
  return value.replace(ENV_VARIABLE, (match, variable: string) => {
    const resolved = process.env[variable]
    if (resolved === undefined) {
      missing.add(variable)
      return match
    }
    return resolved
  })
}

/** 对 record 的每个值做环境变量展开。 */
function expandRecord(record: Readonly<Record<string, string>>, expand: (value: string) => string): Record<string, string> {
  return Object.fromEntries(Object.entries(record).map(([key, value]) => [key, expand(value)]))
}

/** 把 zod 校验错误拼成一条可读字符串（带字段路径）。 */
function formatIssues(error: z.ZodError): string {
  return error.issues
    .map(issue => issue.path.length > 0 ? `${issue.path.join('.')}: ${issue.message}` : issue.message)
    .join('; ')
}

/** 判断值是否为普通对象（非 null、非数组）。 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 判断错误是否为「路径不存在」（ENOENT / ENOTDIR）。 */
function isNotFound(error: unknown): boolean {
  if (typeof error !== 'object' || error === null || !('code' in error)) return false
  const code = (error as { code?: unknown }).code
  return code === 'ENOENT' || code === 'ENOTDIR'
}

/** 取错误的 message 文本。 */
function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
