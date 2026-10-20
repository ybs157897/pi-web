/**
 * Pi MCP servers imported into a pi-web conversation.
 *
 * `McpManager.open()` reads the user-level `mcp.json`, connects every enabled server concurrently, lists
 * its tools, and turns them into a synthetic `mcp` extension plus code-mode namespaces. The manager is
 * the single owner of the live `McpClient` connections: the runtime keeps it alive for its own lifetime
 * and calls `close()` on shutdown.
 *
 * One server failing never fails startup: it is recorded as `status: 'error'` in `view()` and the other
 * servers keep working.
 */
import { createHash } from 'node:crypto'
import {
  McpClient,
  StdioTransport,
  StreamableHttpTransport,
  toLlmContent,
  type McpTransport,
  type Tool as McpTool,
} from '@earendil-works/pi-mcp'
import type { JsonValue } from '@earendil-works/chord'
import type { CodemodeNamespace } from '@earendil-works/pi-durable/codemode'
import type { Extension, ToolExecutionResult, ToolRegistration } from '@earendil-works/pi-durable'
import { Type, type TSchema } from 'typebox'
import packageJson from '../../package.json' with { type: 'json' }
import type { McpExposure, McpServerView, McpToolView, McpView } from '../shared/types.ts'
import { loadMcpConfig, type LoadedMcpConfig, type McpServerConfig } from './mcp-config.ts'

export type { McpServerConfig, McpToolExposureRule } from './mcp-config.ts'

/** Extension name registered with the Pi Harness. */
export const MCP_EXTENSION_NAME = 'mcp'

const CLIENT_NAME = 'pi-web'
const CLIENT_VERSION: string = packageJson.version
const MAX_OUTPUT_BYTES = 100_000

export interface McpManagerOptions {
  configPath: string
  /** Test injection: build the transport for one server instead of spawning a process or opening HTTP. */
  transportFactory?: (server: McpServerConfig) => McpTransport
}

type ServerStatus = 'connected' | 'error' | 'disabled'

/** One configured server plus its live connection, if it got one. */
interface ServerState {
  readonly config: McpServerConfig
  readonly status: ServerStatus
  /** Tools the server listed; empty unless connected. */
  readonly tools: readonly McpTool[]
  readonly client?: McpClient
  readonly error?: string
  /** The initialize result's `instructions`, kept for the code-mode namespace description. */
  readonly instructions?: string
}

/** `details` a tool result carries for the browser: which server/tool ran and how long it took. */
type McpToolDetails = {
  server: string
  tool: string
  isError: boolean
  durationMs: number
  structuredContent?: JsonValue
}

/**
 * Owns the imported MCP catalog. `view()`, `extension()`, and `namespaces()` are synchronous once
 * `open()` resolves: everything the Harness needs is resolved up front.
 */
export class McpManager {
  private readonly servers: readonly ServerState[]
  private readonly viewValue: McpView
  private readonly extensionValue: Extension | undefined
  private readonly namespaceList: readonly CodemodeNamespace[]
  private closed = false

  private constructor(loaded: LoadedMcpConfig, servers: readonly ServerState[]) {
    this.servers = servers
    this.viewValue = buildView(loaded, servers)
    const { registrations, namespaces } = buildRegistrations(servers)
    this.extensionValue = registrations.length > 0 ? { name: MCP_EXTENSION_NAME, tools: registrations } : undefined
    this.namespaceList = namespaces
  }

  static async open(options: McpManagerOptions): Promise<McpManager> {
    const loaded = await loadMcpConfig(options.configPath)
    const servers = await Promise.all(
      loaded.servers.map(server => connectServer(server, options.transportFactory)),
    )
    return new McpManager(loaded, servers)
  }

  /** The browser-facing catalog: connection state and tool exposure, never credentials. */
  view(): McpView {
    return this.viewValue
  }

  /** The `mcp` extension; `undefined` when no listed tool is registered with the model or scripts. */
  extension(): Extension | undefined {
    return this.extensionValue
  }

  /** Code-mode namespaces: one per connected server that exposed at least one callable tool. */
  namespaces(): readonly CodemodeNamespace[] {
    return this.namespaceList
  }

  /** Close every connection. Idempotent; failures on one server do not block the others. */
  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    await Promise.allSettled(this.servers.map(state => state.client ? state.client.close() : Promise.resolve()))
  }
}

/** Connect one enabled server and list its tools; any failure becomes a recorded error state. */
async function connectServer(
  config: McpServerConfig,
  transportFactory: ((server: McpServerConfig) => McpTransport) | undefined,
): Promise<ServerState> {
  if (!config.enabled) return { config, status: 'disabled', tools: [] }
  const client = new McpClient({ name: CLIENT_NAME, version: CLIENT_VERSION, requestTimeoutMs: config.timeoutMs })
  try {
    const transport = transportFactory ? transportFactory(config) : createTransport(config)
    await client.connect(transport)
    const tools = await client.listTools()
    return {
      config,
      status: 'connected',
      tools,
      client,
      ...(client.instructions !== undefined ? { instructions: client.instructions } : {}),
    }
  } catch (error) {
    await client.close().catch(() => {})
    return { config, status: 'error', tools: [], error: describeError(error) }
  }
}

function createTransport(config: McpServerConfig): McpTransport {
  if (config.transport === 'stdio') {
    return new StdioTransport({
      command: config.command!,
      args: config.args,
      ...(config.env !== undefined ? { env: { ...config.env } } : {}),
      ...(config.cwd !== undefined ? { cwd: config.cwd } : {}),
    })
  }
  return new StreamableHttpTransport({
    url: config.url!,
    ...(config.headers !== undefined ? { headers: { ...config.headers } } : {}),
  })
}

/** Build the `mcp` extension's tools and the code-mode namespaces, resolving names and exposure once. */
function buildRegistrations(servers: readonly ServerState[]): {
  registrations: ToolRegistration[]
  namespaces: CodemodeNamespace[]
} {
  const used = new Set<string>()
  const registrations: ToolRegistration[] = []
  const namespaces: CodemodeNamespace[] = []
  for (const state of servers) {
    const client = state.client
    if (state.status !== 'connected' || !client) continue
    const prefix = `mcp__${sanitizeName(state.config.name)}`
    const callableCount = state.tools.filter(tool => resolveToolExposure(state.config, tool.name) !== 'hidden').length
    if (callableCount > 0) {
      const description = state.config.description ?? firstLine(state.instructions)
      namespaces.push({
        name: prefix,
        prefix: `${prefix}__`,
        ...(description !== undefined ? { description } : {}),
      })
    }
    for (const tool of state.tools) {
      const exposure = resolveToolExposure(state.config, tool.name)
      if (exposure === 'hidden') continue
      const registeredName = uniqueToolName(
        `${prefix}__${sanitizeName(tool.name)}`,
        `${state.config.name}\u0000${tool.name}`,
        used,
      )
      registrations.push(createRegistration(state.config, client, tool, exposure, registeredName))
    }
  }
  return { registrations, namespaces }
}

/** Wrap one MCP tool as a Pi tool registration. Hidden tools are filtered out before this runs. */
function createRegistration(
  server: McpServerConfig,
  client: McpClient,
  tool: McpTool,
  exposure: McpExposure,
  registeredName: string,
): ToolRegistration {
  const registration: ToolRegistration = {
    name: registeredName,
    description: tool.description ?? tool.title ?? tool.name,
    // Providers require an object schema, and some reject one without `properties`.
    parameters: Type.Unsafe({
      ...tool.inputSchema,
      type: 'object',
      properties: isPlainObject(tool.inputSchema.properties) ? tool.inputSchema.properties : {},
    }) as TSchema,
    outputLimits: { maxBytes: MAX_OUTPUT_BYTES },
    // Code mode's tools are deferred: scripts can call them, and `tool_search` can hand them to the
    // model. `direct` tools are registered normally; `hidden` never reaches here.
    ...(exposure === 'codemode' || exposure === 'deferred' ? { deferred: true as const } : {}),
    async execute(args, _api, context) {
      return executeMcpTool(server, client, tool, args, context.abortSignal)
    },
  }
  return registration
}

/** Call one MCP tool and map the result onto Pi's output/details channels without throwing. */
async function executeMcpTool(
  server: McpServerConfig,
  client: McpClient,
  tool: McpTool,
  args: unknown,
  signal: AbortSignal | undefined,
): Promise<ToolExecutionResult<JsonValue>> {
  const startedAt = Date.now()
  try {
    const result = await client.callTool(tool.name, toolArguments(args), signal ? { signal } : undefined)
    // MCP reports tool failures in the result instead of as a protocol error.
    const isError = result.isError === true
    const structuredContent = result.structuredContent === undefined ? undefined : result.structuredContent as JsonValue
    return {
      output: toLlmContent(result),
      ...(isError ? { isError: true as const } : {}),
      details: toolDetails({
        server: server.name,
        tool: tool.name,
        isError,
        durationMs: Date.now() - startedAt,
        ...(structuredContent !== undefined ? { structuredContent } : {}),
      }),
    }
  } catch (error) {
    // A protocol error, timeout, abort, or transport drop: keep the call visible as an error result.
    return {
      output: [{ type: 'text', text: `MCP tool "${server.name}/${tool.name}" failed: ${describeError(error)}` }],
      isError: true,
      details: toolDetails({
        server: server.name,
        tool: tool.name,
        isError: true,
        durationMs: Date.now() - startedAt,
      }),
    }
  }
}

function toolDetails(details: McpToolDetails): JsonValue {
  return details as unknown as JsonValue
}

function buildView(loaded: LoadedMcpConfig, servers: readonly ServerState[]): McpView {
  const serverViews: McpServerView[] = servers.map(state => {
    const tools: McpToolView[] = state.status !== 'connected'
      ? []
      : state.tools.map(tool => ({
        name: tool.name,
        ...(tool.title !== undefined ? { title: tool.title } : {}),
        ...(tool.description !== undefined ? { description: tool.description } : {}),
        exposure: resolveToolExposure(state.config, tool.name),
      }))
    return {
      name: state.config.name,
      transport: state.config.transport,
      enabled: state.config.enabled,
      ...(state.config.description !== undefined ? { description: state.config.description } : {}),
      exposure: state.config.exposure,
      status: state.status,
      tools,
      ...(state.error !== undefined ? { error: state.error } : {}),
    }
  })
  return {
    configPath: loaded.configPath,
    configExists: loaded.configExists,
    servers: serverViews,
    ...(loaded.error !== undefined ? { error: loaded.error } : {}),
  }
}

/**
 * Resolve how one tool reaches the model: an exact `toolExposure` name wins over every pattern, then
 * the first `*` pattern in config order matches, then the server's own `exposure`.
 */
function resolveToolExposure(server: McpServerConfig, toolName: string): McpExposure {
  for (const rule of server.toolExposure) {
    if (rule.pattern === toolName) return rule.exposure
  }
  for (const rule of server.toolExposure) {
    if (rule.pattern.includes('*') && wildcardMatches(rule.pattern, toolName)) return rule.exposure
  }
  return server.exposure
}

function wildcardMatches(pattern: string, value: string): boolean {
  const expression = pattern.split('*').map(escapeRegExp).join('.*')
  return new RegExp(`^${expression}$`).test(value)
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Keep `[A-Za-z0-9_]`, map everything else to `_`: the character set providers accept in tool names. */
function sanitizeName(value: string): string {
  return value.replace(/[^A-Za-z0-9_]/g, '_')
}

/**
 * Names stay stable across restarts. When two raw names sanitize to the same tool name, the second
 * one gets a short hash of its raw server/tool identity; the suffix grows only if that also collides.
 */
function uniqueToolName(base: string, identity: string, used: Set<string>): string {
  if (!used.has(base)) {
    used.add(base)
    return base
  }
  const digest = createHash('sha256').update(identity).digest('hex')
  for (let length = 8; length <= digest.length; length += 4) {
    const candidate = `${base}__${digest.slice(0, length)}`
    if (!used.has(candidate)) {
      used.add(candidate)
      return candidate
    }
  }
  for (let suffix = 2; ; suffix += 1) {
    const candidate = `${base}__${suffix}`
    if (!used.has(candidate)) {
      used.add(candidate)
      return candidate
    }
  }
}

function toolArguments(args: unknown): Record<string, unknown> {
  if (!isPlainObject(args)) return {}
  return { ...args }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** First non-empty line of the server's instructions. */
function firstLine(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  const line = value.split(/\r?\n/).map(part => part.trim()).find(part => part.length > 0)
  return line
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
