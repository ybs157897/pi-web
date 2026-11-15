/**
 * 导入 pi-web 会话的 Pi MCP servers。
 *
 * `McpRegistry.open()` 读取用户级 `mcp.json`，合并已启用插件声明的 MCP servers，
 * 并发连接所有 server、列出其工具，把它们变成一个合成的 `mcp` 扩展加 code-mode
 * 命名空间。注册表是存活 `McpClient` 连接的唯一持有者，可在插件安装、停用或
 * 移除时原地重载。
 *
 * 单个 server 失败绝不让启动失败：在 `view()` 里记为 `status: 'error'`，其余
 * server 继续工作。
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

/** 注册到 Pi Harness 的扩展名。 */
export const MCP_EXTENSION_NAME = 'mcp'

const CLIENT_NAME = 'pi-web'
const CLIENT_VERSION: string = packageJson.version
const MAX_OUTPUT_BYTES = 100_000
/** 插件 server 请求预算更长：其包运行器在首次调用时才启动。 */
const PLUGIN_REQUEST_TIMEOUT_MS = 60_000
/**
 * 重载后旧客户端短暂保持打开，让在途的工具调用能在它出发的那条连接上收尾。
 * `close()` 会立即强制关闭。
 */
const RELOAD_CLOSE_GRACE_MS = 10_000

export interface McpRegistryOptions {
  configPath: string
  /** 已启用插件 server 的实时投影；reload() 会再读一次。 */
  pluginServers?: () => readonly PluginMcpServerConfig[]
  /** 测试注入：为单个 server 构造 transport，而不是 spawn 进程或开 HTTP。 */
  transportFactory?: (server: McpServerConfig) => McpTransport
}

type ServerStatus = 'connected' | 'error' | 'disabled'

/** 一个已配置 server 加上它的存活连接（如果有）。 */
interface ServerState {
  readonly config: McpServerConfig
  readonly status: ServerStatus
  /** server 列出的工具；仅 connected 时非空。 */
  readonly tools: readonly McpTool[]
  readonly client?: McpClient
  readonly error?: string
  /** initialize 结果里的 `instructions`，保留给 code-mode 命名空间描述。 */
  readonly instructions?: string
  /** 插件声明的 server 才有。 */
  readonly pluginId?: string
}

/** 工具结果带给浏览器的 `details`：哪个 server/tool 跑了、耗时多少。 */
type McpToolDetails = {
  server: string
  tool: string
  isError: boolean
  durationMs: number
  structuredContent?: JsonValue
  /** 校验过的 MCP Apps 描述符；仅插件 server，绝无任意 `_meta`。 */
  ui?: PluginUiDescriptor
}

/** 已退役等待关闭的客户端及其宽限计时器。 */
interface RetiredClient {
  readonly client: McpClient
  readonly timer: NodeJS.Timeout
}

/**
 * 持有导入的 MCP 目录。`open()` 或 `reload()` 完成后 `view()`、`extension()`、
 * `namespaces()` 都是同步的：Harness 需要的一切都提前解析好。
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

  /** 打开注册表：读配置 + 合并插件 server + 并发连接并列工具。 */
  static async open(options: McpRegistryOptions): Promise<McpRegistry> {
    const { loaded, servers } = await connectAll(options)
    return new McpRegistry(options, loaded, servers)
  }

  /** 面向浏览器的目录：连接状态与工具 exposure，绝无机密。 */
  view(): McpView {
    return this.viewValue
  }

  /** `mcp` 扩展；没有可注册给模型或脚本的工具时为 undefined。 */
  extension(): Extension | undefined {
    return this.extensionValue
  }

  /** code-mode 命名空间：每个至少暴露一个可调用工具的已连接 server 一个。 */
  namespaces(): readonly CodemodeNamespace[] {
    return this.namespaceList
  }

  /**
   * 功能：重读 mcp.json 与插件投影，连接新 server 集合并发布。
   * 内部逻辑：经 reloadTail 串行；旧连接进入 retire 宽限期（RELOAD_CLOSE_GRACE_MS）
   * 让在途调用收尾，之后自动关闭。
   */
  reload(): Promise<void> {
    if (this.closed) return Promise.resolve()
    const run = this.reloadTail.then(() => this.reloadNow(), () => this.reloadNow())
    this.reloadTail = run.then(() => undefined, () => undefined)
    return run
  }

  /** 实际重载：connectAll → 若已关闭则直接收尾 → 否则发布新集合并退役旧连接。 */
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

  /** 把旧连接放入宽限队列：计时器到点自动 close 并自清理；close() 会提前清空。 */
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

  /** 列出一个已连接 server 的资源，供插件 UI 宿主（P2）使用。 */
  async listResources(serverName: string): Promise<Resource[]> {
    return await this.requireClient(serverName).listResources()
  }

  /** 读一个已连接 server 的 MCP 资源，供插件 UI 宿主（P2）使用。 */
  async readResource(serverName: string, uri: string): Promise<ReadResourceResult> {
    return await this.requireClient(serverName).readResource(uri)
  }

  /** 模型工具路径之外的直接 MCP 调用；调用方负责套用 Plan/只读策略。 */
  async callTool(serverName: string, tool: string, args: unknown, signal?: AbortSignal): Promise<CallToolResult> {
    return await this.requireClient(serverName).callTool(tool, toolArguments(args), signal ? { signal } : undefined)
  }

  /** 按 server 名取客户端；未配置或未连接时抛带状态的错误。 */
  private requireClient(serverName: string): McpClient {
    const state = this.servers.find(candidate => candidate.config.name === serverName)
    if (state === undefined) throw new Error(`MCP server "${serverName}" is not configured`)
    if (state.status !== 'connected' || state.client === undefined) {
      throw new Error(`MCP server "${serverName}" is ${state.status}${state.error === undefined ? '' : `: ${state.error}`}`)
    }
    return state.client
  }

  /** 关闭全部连接（含退役队列）。幂等；单 server 失败不阻塞其他。 */
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

/** 配置 server 加插件 server；插件名与配置名冲突时追加哈希后缀。 */
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

/** 连接一个已启用 server 并列出工具；任何失败都变成记录在案的 error 状态。 */
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

/** 关闭一组 server 状态的客户端（allSettled，互不阻塞）。 */
async function closeStates(states: readonly ServerState[]): Promise<void> {
  await Promise.allSettled(states.map(state => state.client ? state.client.close() : Promise.resolve()))
}

/** 按配置构造 transport：stdio 走子进程（命令/参数/env/cwd），否则走 Streamable HTTP（url/headers）。 */
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

/** 构建 `mcp` 扩展的工具与 code-mode 命名空间，名称与 exposure 一次解析到位。 */
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

/** 把一个 MCP 工具包装成 Pi 工具注册项；hidden 工具在此之前已被过滤。 */
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
    // provider 要求 object schema，有些还拒绝没有 `properties` 的。
    parameters: Type.Unsafe({
      ...tool.inputSchema,
      type: 'object',
      properties: isPlainObject(tool.inputSchema.properties) ? tool.inputSchema.properties : {},
    }) as TSchema,
    outputLimits: { maxBytes: MAX_OUTPUT_BYTES },
    // code mode 的工具是 deferred：脚本可以调用，`tool_search` 可以交给模型。
    // `direct` 工具正常注册；`hidden` 根本到不了这里。
    ...(exposure === 'codemode' || exposure === 'deferred' ? { deferred: true as const } : {}),
    async execute(args, _api, context) {
      return executeMcpTool(server, client, tool, args, context.abortSignal, pluginId)
    },
  }
  return registration
}

/** 调用一个 MCP 工具，把结果映射到 Pi 的 output/details 通道，绝不抛出。 */
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
    // MCP 把工具失败报告在结果里，而不是作为协议错误。
    const isError = result.isError === true
    const structuredContent = result.structuredContent === undefined ? undefined : result.structuredContent as JsonValue
    // MCP Apps 元数据只经这个校验过的描述符进入会话记录。
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
    // 协议错误、超时、中止或 transport 断开：调用仍以错误结果的形式可见。
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

/** details 透传为 JsonValue。 */
function toolDetails(details: McpToolDetails): JsonValue {
  return details as unknown as JsonValue
}

/** 组装浏览器可见的视图：每个 server 的状态、工具与其 exposure（无机密）。 */
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
 * 解析一个工具以何种方式到达模型：精确 `toolExposure` 名优先于一切模式，其次按
 * 配置顺序匹配第一个 `*` 模式，最后落到 server 自身的 `exposure`。
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

/** `*` 通配符匹配：把模式转成正则后全串匹配。 */
function wildcardMatches(pattern: string, value: string): boolean {
  const expression = pattern.split('*').map(escapeRegExp).join('.*')
  return new RegExp(`^${expression}$`).test(value)
}

/** 正则元字符转义（wildcardMatches 用）。 */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** 保留 `[A-Za-z0-9_]`，其余映射为 `_`：provider 在工具名里接受的字符集。 */
function sanitizeName(value: string): string {
  return value.replace(/[^A-Za-z0-9_]/g, '_')
}

/**
 * 功能：生成不冲突且跨重启稳定的注册工具名。
 * 内部逻辑：基础名（`mcp__<server>__<tool>`）未占用即用；两个原始名净化后相同
 * 时，后者追加其原始 server/tool 身份的短哈希；仍冲突则哈希逐步加长，最后退化为
 * 递增数字后缀。
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

/** 参数收敛为普通对象（非对象按空参数处理），浅拷贝防上游改动。 */
function toolArguments(args: unknown): Record<string, unknown> {
  if (!isPlainObject(args)) return {}
  return { ...args }
}

/** 判断值是否为普通对象（非 null、非数组）。 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** server instructions 的首个非空行。 */
function firstLine(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  const line = value.split(/\r?\n/).map(part => part.trim()).find(part => part.length > 0)
  return line
}

/** 取错误的 message 文本。 */
function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
