/**
 * Pi MCP servers imported into a pi-web conversation.
 *
 * `McpRegistry.open()` reads the user-level `mcp.json`, merges the MCP servers declared by enabled
 * plugins, connects every server concurrently, lists its tools, and turns them into a synthetic
 * `mcp` extension plus code-mode namespaces. The registry is the single owner of the live
 * `McpClient` connections and can reload them in place when plugins are installed, disabled, or
 * removed.
 *
 * One server failing never fails startup: it is recorded as `status: 'error'` in `view()` and the
 * other servers keep working.
 */
import { createHash } from 'node:crypto'
import {
  McpClient,
  StdioTransport,
  StreamableHttpTransport,
  toLlmContent,
  type CallToolResult,
  type McpTransport,
  type ReadResourceResult,
  type Resource,
  type Tool as McpTool,
} from '@earendil-works/pi-mcp'
import type { JsonValue } from '@earendil-works/chord'
import type { CodemodeNamespace } from '@earendil-works/pi-durable/codemode'
import type { Extension, ToolExecutionResult, ToolRegistration } from '@earendil-works/pi-durable'
import { Type, type TSchema } from 'typebox'
import packageJson from '../../../package.json' with { type: 'json' }
import type { McpExposure, McpServerView, McpToolView, McpView } from '../../shared/types.ts'
import { pluginUiDescriptorFromMeta, type PluginUiDescriptor } from '../../shared/plugin-ui.ts'
import { loadMcpConfig, type LoadedMcpConfig, type McpServerConfig } from './config.ts'
import type { PluginMcpServerConfig } from '../plugins/types.ts'

export type { McpServerConfig, McpToolExposureRule } from './config.ts'

/** Extension name registered with the Pi Harness. */
export const MCP_EXTENSION_NAME = 'mcp'

const CLIENT_NAME = 'pi-web'
const CLIENT_VERSION: string = packageJson.version
const MAX_OUTPUT_BYTES = 100_000
/** Plugin servers get a longer request budget: their package runners start on first call. */
const PLUGIN_REQUEST_TIMEOUT_MS = 60_000
/**
 * Old clients stay open briefly after a reload so an in-flight tool call can finish on the
 * connection it started with. `close()` forces them shut immediately.
 */
const RELOAD_CLOSE_GRACE_MS = 10_000

export interface McpRegistryOptions {
  configPath: string
  /** Live projection of enabled plugin servers; `reload()` reads it again. */
  pluginServers?: () => readonly PluginMcpServerConfig[]
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
  /** Set for plugin-declared servers. */
  readonly pluginId?: string
}

/** `details` a tool result carries for the browser: which server/tool ran and how long it took. */
type McpToolDetails = {
  server: string
  tool: string
  isError: boolean
  durationMs: number
  structuredContent?: JsonValue
  /** Validated MCP Apps descriptor; plugin servers only, and never arbitrary `_meta`. */
  ui?: PluginUiDescriptor
}

interface RetiredClient {
  readonly client: McpClient
  readonly timer: NodeJS.Timeout
}

/**
 * Owns the imported MCP catalog. `view()`, `extension()`, and `namespaces()` are synchronous once
 * `open()` or `reload()` resolves: everything the Harness needs is resolved up front.
 */
export class McpRegistry {
  private servers: readonly ServerState[]
  private viewValue: McpView
  private extensionValue: Extension | undefined
  private namespaceList: readonly CodemodeNamespace[]
  private readonly retired: RetiredClient[] = []
  private reloadTail: Promise<void> = Promise.resolve()
  private closed = false
  private readonly options: McpRegistryOptions

  private constructor(options: McpRegistryOptions, loaded: LoadedMcpConfig, servers: readonly ServerState[]) {
    this.options = options
    this.servers = servers
    const { view, extension, namespaces } = buildPublished(loaded, servers)
    this.viewValue = view
    this.extensionValue = extension
    this.namespaceList = namespaces
  }

  static async open(options: McpRegistryOptions): Promise<McpRegistry> {
    const { loaded, servers } = await connectAll(options)
    return new McpRegistry(options, loaded, servers)
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

  /**
   * Re-read `mcp.json` and the plugin projection, connect the new server set, and publish it. Old
   * connections stay open for a short grace period so calls already in flight can finish.
   */
  reload(): Promise<void> {
    if (this.closed) return Promise.resolve()
    const run = this.reloadTail.then(() => this.reloadNow(), () => this.reloadNow())
    this.reloadTail = run.then(() => undefined, () => undefined)
    return run
  }

  private async reloadNow(): Promise<void> {
    if (this.closed) return
    const { loaded, servers } = await connectAll(this.options)
    if (this.closed) {
      await closeStates(servers)
      return
    }
    const previous = this.servers
    const { view, extension, namespaces } = buildPublished(loaded, servers)
    this.servers = servers
    this.viewValue = view
    this.extensionValue = extension
    this.namespaceList = namespaces
    this.retire(previous)
  }

  private retire(states: readonly ServerState[]): void {
    for (const state of states) {
      if (state.client === undefined) continue
      const client = state.client
      const entry: RetiredClient = {
        client,
        timer: setTimeout(() => {
          void client.close().catch(() => undefined)
          const index = this.retired.indexOf(entry)
          if (index >= 0) this.retired.splice(index, 1)
        }, RELOAD_CLOSE_GRACE_MS),
      }
      entry.timer.unref?.()
      this.retired.push(entry)
    }
  }

  /** Resources of one connected server, for the plugin UI host (P2). */
  async listResources(serverName: string): Promise<Resource[]> {
    return await this.requireClient(serverName).listResources()
  }

  /** One MCP resource of a connected server, for the plugin UI host (P2). */
  async readResource(serverName: string, uri: string): Promise<ReadResourceResult> {
    return await this.requireClient(serverName).readResource(uri)
  }

  /** A direct MCP call outside the model tool path; the caller applies Plan/read-only policy. */
  async callTool(serverName: string, tool: string, args: unknown, signal?: AbortSignal): Promise<CallToolResult> {
    return await this.requireClient(serverName).callTool(tool, toolArguments(args), signal ? { signal } : undefined)
  }

  private requireClient(serverName: string): McpClient {
    const state = this.servers.find(candidate => candidate.config.name === serverName)
    if (state === undefined) throw new Error(`MCP server "${serverName}" is not configured`)
    if (state.status !== 'connected' || state.client === undefined) {
      throw new Error(`MCP server "${serverName}" is ${state.status}${state.error === undefined ? '' : `: ${state.error}`}`)
    }
    return state.client
  }

  /** Close every connection. Idempotent; failures on one server do not block the others. */
  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    await this.reloadTail.catch(() => undefined)
    const retired = this.retired.splice(0)
    for (const entry of retired) clearTimeout(entry.timer)
    const current = this.servers
    this.servers = []
    await Promise.allSettled([
      ...current.map(state => state.client ? state.client.close() : Promise.resolve()),
      ...retired.map(entry => entry.client.close()),
    ])
  }
}

async function connectAll(options: McpRegistryOptions): Promise<{ loaded: LoadedMcpConfig; servers: ServerState[] }> {
  const loaded = await loadMcpConfig(options.configPath)
  const configured = effectiveServers(loaded, options.pluginServers?.() ?? [])
  const servers = await Promise.all(configured.map(server =>
    connectServer(server.config, options.transportFactory, server.pluginId)))
  return { loaded: { ...loaded, servers: configured.map(server => server.config) }, servers }
}

/** Config servers plus plugin servers; a plugin name that collides with a config name gets a suffix. */
function effectiveServers(
  loaded: LoadedMcpConfig,
  pluginServers: readonly PluginMcpServerConfig[],
): Array<{ config: McpServerConfig; pluginId?: string }> {
  const used = new Set(loaded.servers.map(server => server.name))
  const result: Array<{ config: McpServerConfig; pluginId?: string }> = loaded.servers.map(config => ({ config }))
  for (const plugin of pluginServers) {
    let name = plugin.serverName
    if (used.has(name)) {
      const suffix = createHash('sha256').update(`${plugin.pluginId}\u0000${plugin.serverKey}`).digest('hex').slice(0, 8)
      name = `${name}_${suffix}`
    }
    used.add(name)
    result.push({
      config: {
        name,
        transport: 'stdio',
        enabled: true,
        exposure: plugin.exposure,
        timeoutMs: PLUGIN_REQUEST_TIMEOUT_MS,
        command: plugin.command,
        args: plugin.args,
        env: plugin.env,
        cwd: plugin.cwd,
        toolExposure: [],
        ...(plugin.description === undefined ? {} : { description: plugin.description }),
      },
      pluginId: plugin.pluginId,
    })
  }
  return result
}

/** Connect one enabled server and list its tools; any failure becomes a recorded error state. */
async function connectServer(
  config: McpServerConfig,
  transportFactory: ((server: McpServerConfig) => McpTransport) | undefined,
  pluginId: string | undefined,
): Promise<ServerState> {
  if (!config.enabled) return { config, status: 'disabled', tools: [], ...(pluginId === undefined ? {} : { pluginId }) }
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
      ...(pluginId === undefined ? {} : { pluginId }),
    }
  } catch (error) {
    await client.close().catch(() => {})
    return {
      config,
      status: 'error',
      tools: [],
      error: describeError(error),
      ...(pluginId === undefined ? {} : { pluginId }),
    }
  }
}

async function closeStates(states: readonly ServerState[]): Promise<void> {
  await Promise.allSettled(states.map(state => state.client ? state.client.close() : Promise.resolve()))
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

function buildPublished(loaded: LoadedMcpConfig, servers: readonly ServerState[]): {
  view: McpView
  extension: Extension | undefined
  namespaces: readonly CodemodeNamespace[]
} {
  const { registrations, namespaces } = buildRegistrations(servers)
  return {
    view: buildView(loaded, servers),
    extension: registrations.length > 0 ? { name: MCP_EXTENSION_NAME, tools: registrations } : undefined,
    namespaces,
  }
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
      registrations.push(createRegistration(state.config, client, tool, exposure, registeredName, state.pluginId))
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
  pluginId: string | undefined,
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
      return executeMcpTool(server, client, tool, args, context.abortSignal, pluginId)
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
  pluginId: string | undefined,
): Promise<ToolExecutionResult<JsonValue>> {
  const startedAt = Date.now()
  try {
    const result = await client.callTool(tool.name, toolArguments(args), signal ? { signal } : undefined)
    // MCP reports tool failures in the result instead of as a protocol error.
    const isError = result.isError === true
    const structuredContent = result.structuredContent === undefined ? undefined : result.structuredContent as JsonValue
    // MCP Apps metadata reaches the transcript only through this validated descriptor.
    const ui = pluginUiDescriptorFromMeta(result._meta, { pluginId, serverName: server.name })
    return {
      output: toLlmContent(result),
      ...(isError ? { isError: true as const } : {}),
      details: toolDetails({
        server: server.name,
        tool: tool.name,
        isError,
        durationMs: Date.now() - startedAt,
        ...(structuredContent !== undefined ? { structuredContent } : {}),
        ...(ui === undefined ? {} : { ui }),
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
      ...(state.pluginId !== undefined ? { pluginId: state.pluginId } : {}),
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
