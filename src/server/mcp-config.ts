/**
 * Reads the user-level Pi MCP file (`mcp.json`, the `{ mcpServers: { ... } }` shape Pi 1.3.0 imports).
 *
 * The browser never sees this file's secrets: only `view()` crosses the protocol, and it carries no
 * `env`, `headers`, or command lines. Parsing is deliberately forgiving: an invalid file or entry never
 * fails runtime startup, it is reported through `error` while the valid entries stay usable.
 */
import { readFile } from 'node:fs/promises'
import { resolve as resolvePath } from 'node:path'
import { z } from 'zod'
import { MCP_EXPOSURES, type McpExposure } from '../shared/types.ts'

/** One `toolExposure` rule: an exact tool name or a name pattern with `*`, in config order. */
export interface McpToolExposureRule {
  pattern: string
  exposure: McpExposure
}

/** One validated `mcpServers` entry, with its transport resolved. */
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

/** Outcome of reading one MCP config file. Never a rejection: a broken file is an empty catalog plus `error`. */
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
 * Strict entry schema: unknown keys are rejected so a typo (`exposures`, `tool_exposure`) is reported
 * instead of silently ignored. Every field is optional here; transport requirements are checked after.
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
 * Read and validate an MCP config file. Missing file → `configExists: false` with an empty catalog and
 * no error; malformed JSON or entries → `error` plus whatever entries validated; a read failure other
 * than "not found" → `error` (the file exists but cannot be used).
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
 * The transport is either declared by `type` or inferred from the presence of `command`/`url`.
 * Returns the resolved transport or a human-readable error.
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

/** Expand `${VAR}` references from the process environment; unresolved references stay literal and are reported. */
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

function expandRecord(record: Readonly<Record<string, string>>, expand: (value: string) => string): Record<string, string> {
  return Object.fromEntries(Object.entries(record).map(([key, value]) => [key, expand(value)]))
}

function formatIssues(error: z.ZodError): string {
  return error.issues
    .map(issue => issue.path.length > 0 ? `${issue.path.join('.')}: ${issue.message}` : issue.message)
    .join('; ')
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isNotFound(error: unknown): boolean {
  if (typeof error !== 'object' || error === null || !('code' in error)) return false
  const code = (error as { code?: unknown }).code
  return code === 'ENOENT' || code === 'ENOTDIR'
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
