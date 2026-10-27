import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  isJsonRpcRequest,
  type JsonRpcId,
  type JsonRpcMessage,
  type McpTransport,
} from '@earendil-works/pi-mcp'
import { createInMemoryTransportPair } from '@earendil-works/pi-mcp/testing'
import type { Context } from '@earendil-works/chord/context'
import type { JsonValue } from '@earendil-works/chord'
import type { ToolExecutionApi, ToolExecutionResult, ToolRegistration } from '@earendil-works/pi-durable'
import { McpRegistry } from '../src/server/mcp.ts'
import type { McpServerConfig } from '../src/server/mcp-config.ts'
import type { PluginMcpServerConfig } from '../src/server/plugin-types.ts'

const temporaryDirectories: string[] = []
const openManagers: McpRegistry[] = []
const liveFakeServers: Array<{ close(): Promise<void> }> = []

const EMPTY_CONTEXT: Context = {
  abortSignal: undefined,
  value: () => undefined,
  toString: () => 'pi-web-mcp-test',
}

afterEach(async () => {
  await Promise.allSettled(openManagers.splice(0).map(manager => manager.close()))
  await Promise.allSettled(liveFakeServers.splice(0).map(server => server.close()))
  for (const directory of temporaryDirectories.splice(0)) await rm(directory, { recursive: true, force: true })
  delete process.env.MCP_TEST_TOKEN
})

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'pi-web-mcp-'))
  temporaryDirectories.push(directory)
  return directory
}

async function writeConfig(value: unknown): Promise<string> {
  const directory = await temporaryDirectory()
  const path = join(directory, 'mcp.json')
  await writeFile(path, typeof value === 'string' ? value : JSON.stringify(value), 'utf8')
  return path
}

function openManager(
  configPath: string,
  transportFactory?: (server: McpServerConfig) => McpTransport,
): Promise<McpRegistry> {
  return McpRegistry.open({ configPath, ...(transportFactory ? { transportFactory } : {}) }).then(manager => {
    openManagers.push(manager)
    return manager
  })
}

function extensionTools(manager: McpRegistry): readonly ToolRegistration[] {
  const extension = manager.extension()
  expect(extension?.name).toBe('mcp')
  return extension?.tools ?? []
}

function registeredTool(manager: McpRegistry, name: string) {
  const tool = extensionTools(manager).find(candidate => candidate.name === name)
  if (!tool) throw new Error(`tool is not registered: ${name}`)
  return tool
}

async function runTool(manager: McpRegistry, name: string, args: Record<string, unknown>): Promise<ToolExecutionResult<JsonValue>> {
  return registeredTool(manager, name).execute(args, {} as ToolExecutionApi, EMPTY_CONTEXT)
}

function outputText(result: ToolExecutionResult<JsonValue>): string {
  const block = result.output?.[0]
  return block?.type === 'text' ? block.text : ''
}

function detailsOf(result: ToolExecutionResult<JsonValue>): Record<string, unknown> {
  return result.details as Record<string, unknown>
}

// ---------------------------------------------------------------------------------------------
// A minimal MCP server over the in-memory transport. It answers initialize, tools/list and
// tools/call; notifications need no reply.
// ---------------------------------------------------------------------------------------------

interface FakeTool {
  name: string
  title?: string
  description?: string
  inputSchema?: Record<string, unknown>
}

type FakeCallHandler = (name: string, args: Record<string, unknown>) => unknown | Promise<unknown>

interface FakeServerOptions {
  tools?: FakeTool[]
  instructions?: string
  /** Reject initialize with a JSON-RPC error. */
  failInitialize?: boolean
  /** Never answer initialize, so the client request timeout fires. */
  ignoreInitialize?: boolean
  callTool?: FakeCallHandler
}

function startFakeServer(options: FakeServerOptions = {}) {
  const { client, server } = createInMemoryTransportPair()
  const calls: Array<{ name: string; args: Record<string, unknown> }> = []
  let closed = false
  server.onClose(() => {
    closed = true
  })

  const respond = async (
    id: JsonRpcId,
    payload: { result?: unknown; error?: { code: number; message: string } },
  ): Promise<void> => {
    if (closed) return
    try {
      await server.send(payload.error !== undefined
        ? { jsonrpc: '2.0', id, error: payload.error }
        : { jsonrpc: '2.0', id, result: payload.result })
    } catch {
      // The client closed the transport while this request was in flight.
    }
  }

  const handle = async (message: JsonRpcMessage): Promise<void> => {
    if (!isJsonRpcRequest(message)) return
    if (message.method === 'initialize' && options.ignoreInitialize) return
    try {
      if (message.method === 'initialize') {
        if (options.failInitialize) {
          await respond(message.id, { error: { code: -32603, message: 'initialize failed' } })
          return
        }
        await respond(message.id, {
          result: {
            protocolVersion: '2025-11-25',
            capabilities: { tools: {} },
            serverInfo: { name: 'fake-mcp-server', version: '1.0.0' },
            ...(options.instructions !== undefined ? { instructions: options.instructions } : {}),
          },
        })
        return
      }
      if (message.method === 'tools/list') {
        // MCP requires an inputSchema, so the fake fills an empty object schema when a tool omits one.
        const tools = (options.tools ?? []).map(tool => ({
          name: tool.name,
          ...(tool.title !== undefined ? { title: tool.title } : {}),
          ...(tool.description !== undefined ? { description: tool.description } : {}),
          inputSchema: tool.inputSchema ?? { type: 'object', properties: {} },
        }))
        await respond(message.id, { result: { tools } })
        return
      }
      if (message.method === 'tools/call') {
        const params = message.params as { name?: unknown; arguments?: unknown } | undefined
        const name = typeof params?.name === 'string' ? params.name : ''
        const args = isPlainObject(params?.arguments) ? params.arguments : {}
        calls.push({ name, args })
        const result = options.callTool
          ? await options.callTool(name, args)
          : { content: [{ type: 'text', text: `called ${name}` }] }
        await respond(message.id, { result })
        return
      }
      await respond(message.id, { error: { code: -32601, message: `method not found: ${message.method}` } })
    } catch (error) {
      await respond(message.id, {
        error: { code: -32603, message: error instanceof Error ? error.message : String(error) },
      })
    }
  }

  server.onMessage(message => {
    void handle(message)
  })
  void server.start()

  const fake = {
    transport: client as McpTransport,
    calls,
    get closed(): boolean {
      return closed
    },
    close: () => server.close(),
  }
  liveFakeServers.push(fake)
  return fake
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** A dependency-free MCP server for the real-spawn test: newline-delimited JSON-RPC over stdio. */
const STDIO_FIXTURE = `
import { createInterface } from 'node:readline'

const send = message => process.stdout.write(JSON.stringify(message) + '\\n')
const tools = [
  { name: 'echo', description: 'Echo back', inputSchema: { type: 'object', properties: { text: { type: 'string' } } } },
]

createInterface({ input: process.stdin }).on('line', line => {
  if (line.trim() === '') return
  const message = JSON.parse(line)
  if (message.id === undefined) return // notification, no reply
  if (message.method === 'initialize') {
    send({ jsonrpc: '2.0', id: message.id, result: {
      protocolVersion: '2025-11-25',
      capabilities: { tools: {} },
      serverInfo: { name: 'stdio-fixture', version: '1.0.0' },
    } })
    return
  }
  if (message.method === 'tools/list') {
    send({ jsonrpc: '2.0', id: message.id, result: { tools } })
    return
  }
  if (message.method === 'tools/call') {
    const args = message.params?.arguments ?? {}
    send({ jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: 'stdio:' + (args.text ?? '') }] } })
    return
  }
  send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'method not found: ' + message.method } })
})
`

// ---------------------------------------------------------------------------------------------

describe('McpRegistry configuration', () => {
  it('reports a missing config file as an empty catalog without an error', async () => {
    const directory = await temporaryDirectory()
    const configPath = join(directory, 'mcp.json')
    const manager = await openManager(configPath)

    expect(manager.view()).toEqual({ configPath: resolve(configPath), configExists: false, servers: [] })
    expect(manager.extension()).toBeUndefined()
    expect(manager.namespaces()).toEqual([])
  })

  it('reports invalid JSON and stays usable', async () => {
    const configPath = await writeConfig('{ "mcpServers": ')
    const manager = await openManager(configPath)

    const view = manager.view()
    expect(view.configExists).toBe(true)
    expect(view.servers).toEqual([])
    expect(view.error).toMatch(/not valid JSON/)
    expect(manager.extension()).toBeUndefined()
  })

  it('skips invalid entries, summarizes them in error, and keeps the valid servers', async () => {
    const ok = startFakeServer({ tools: [{ name: 'ok' }] })
    const configPath = await writeConfig({
      mcpServers: {
        'node-ok': { command: 'node', args: ['ok.mjs'] },
        'bad name': { command: 'node' },
        empty: {},
        unknownField: { command: 'node', exposures: 'direct' },
        both: { command: 'node', url: 'https://example.invalid/mcp' },
        missingUrl: { type: 'http' },
      },
    })
    const manager = await openManager(configPath, () => ok.transport)

    const view = manager.view()
    expect(view.configExists).toBe(true)
    expect(view.servers.map(server => server.name)).toEqual(['node-ok'])
    expect(view.servers[0]?.status).toBe('connected')
    expect(view.error).toBeDefined()
    for (const problem of ['"bad name"', '"empty"', '"unknownField"', '"both"', '"missingUrl"']) {
      expect(view.error).toContain(problem)
    }
  })

  it('expands ${VAR} in env/headers/command/args and reports unresolved variables', async () => {
    process.env.MCP_TEST_TOKEN = 'super-secret-token'
    const expandedServer = startFakeServer({ tools: [] })
    const unresolvedServer = startFakeServer({ tools: [] })
    const configPath = await writeConfig({
      mcpServers: {
        expanded: {
          command: '${MCP_TEST_TOKEN}-node',
          args: ['server.mjs', '${MCP_TEST_TOKEN}'],
          env: { TOKEN: '${MCP_TEST_TOKEN}' },
        },
        unresolved: {
          command: 'node',
          env: { TOKEN: '${MCP_TEST_UNSET_VARIABLE}' },
        },
      },
    })
    const transports = new Map<string, McpTransport>([
      ['expanded', expandedServer.transport],
      ['unresolved', unresolvedServer.transport],
    ])
    const captured: McpServerConfig[] = []
    const manager = await openManager(configPath, server => {
      captured.push(server)
      return transports.get(server.name)!
    })

    const expanded = captured.find(server => server.name === 'expanded')
    expect(expanded?.command).toBe('super-secret-token-node')
    expect(expanded?.args).toEqual(['server.mjs', 'super-secret-token'])
    expect(expanded?.env).toEqual({ TOKEN: 'super-secret-token' })

    const unresolved = captured.find(server => server.name === 'unresolved')
    expect(unresolved?.env).toEqual({ TOKEN: '${MCP_TEST_UNSET_VARIABLE}' })
    expect(manager.view().error).toContain('MCP_TEST_UNSET_VARIABLE')
    expect(manager.view().error).toMatch(/not set/)
  })
})

describe('McpRegistry catalog', () => {
  it('builds the view, sanitizes tool names, resolves exposure, and registers deferred tools', async () => {
    process.env.MCP_TEST_TOKEN = 'super-secret-token'
    const demo = startFakeServer({
      tools: [
        { name: 'hello-world', description: 'Greets' },
        { name: 'hello_world', title: 'Second hello', description: 'Collides after sanitize' },
        { name: 'secret-tool', description: 'Hidden by pattern' },
      ],
    })
    const instruction = startFakeServer({
      tools: [
        { name: 'read_file', description: 'Read a file' },
        { name: 'read_other', description: 'Read something else' },
        { name: 'write_file', description: 'Write a file' },
      ],
      instructions: 'Instruction server heading\nSecond line',
    })
    const configPath = await writeConfig({
      mcpServers: {
        'demo-server': {
          command: 'node',
          args: ['fake.mjs', '${MCP_TEST_TOKEN}'],
          env: { FAKE_TOKEN: '${MCP_TEST_TOKEN}' },
          description: 'Demo server from the fixture',
          timeout: 5,
          exposure: 'codemode',
          toolExposure: { 'secret-*': 'hidden', 'hello-world': 'direct' },
        },
        'instruction-server': {
          type: 'streamable-http',
          url: 'https://example.invalid/mcp',
          headers: { Authorization: 'Bearer ${MCP_TEST_TOKEN}' },
          exposure: 'hidden',
          // Exact names beat patterns even when a matching pattern comes first.
          toolExposure: { 'read_*': 'deferred', read_file: 'direct', '*': 'hidden' },
        },
        'off-server': { command: 'node', enabled: false },
      },
    })
    const transports = new Map<string, McpTransport>([
      ['demo-server', demo.transport],
      ['instruction-server', instruction.transport],
    ])
    const captured: McpServerConfig[] = []
    const manager = await openManager(configPath, server => {
      captured.push(server)
      return transports.get(server.name)!
    })

    const view = manager.view()
    expect(view.configPath).toBe(resolve(configPath))
    expect(view.configExists).toBe(true)
    expect(view.error).toBeUndefined()
    expect(view.servers.map(server => server.name)).toEqual(['demo-server', 'instruction-server', 'off-server'])

    expect(view.servers[0]).toEqual({
      name: 'demo-server',
      transport: 'stdio',
      enabled: true,
      description: 'Demo server from the fixture',
      exposure: 'codemode',
      status: 'connected',
      tools: [
        { name: 'hello-world', description: 'Greets', exposure: 'direct' },
        { name: 'hello_world', title: 'Second hello', description: 'Collides after sanitize', exposure: 'codemode' },
        { name: 'secret-tool', description: 'Hidden by pattern', exposure: 'hidden' },
      ],
    })
    expect(view.servers[1]).toEqual({
      name: 'instruction-server',
      transport: 'http',
      enabled: true,
      exposure: 'hidden',
      status: 'connected',
      tools: [
        { name: 'read_file', description: 'Read a file', exposure: 'direct' },
        { name: 'read_other', description: 'Read something else', exposure: 'deferred' },
        { name: 'write_file', description: 'Write a file', exposure: 'hidden' },
      ],
    })
    expect(view.servers[2]).toEqual({
      name: 'off-server',
      transport: 'stdio',
      enabled: false,
      exposure: 'codemode',
      status: 'disabled',
      tools: [],
    })

    // Secrets stay on the server side: headers/env never cross the protocol.
    const serialized = JSON.stringify(view)
    expect(serialized).not.toContain('super-secret-token')
    expect(serialized).not.toContain('FAKE_TOKEN')
    expect(serialized).not.toContain('Authorization')
    expect(captured.find(server => server.name === 'demo-server')?.env).toEqual({ FAKE_TOKEN: 'super-secret-token' })
    expect(captured.find(server => server.name === 'demo-server')?.args)
      .toEqual(['fake.mjs', 'super-secret-token'])
    expect(captured.find(server => server.name === 'demo-server')?.timeoutMs).toBe(5000)
    expect(captured.find(server => server.name === 'instruction-server')?.headers)
      .toEqual({ Authorization: 'Bearer super-secret-token' })
    // The disabled server never got a transport.
    expect(captured.map(server => server.name)).toEqual(['demo-server', 'instruction-server'])

    // `mcp__<server>__<tool>`, characters outside [A-Za-z0-9_] replaced, collisions get a hash suffix.
    const names = extensionTools(manager).map(tool => tool.name)
    expect(names).toHaveLength(4)
    const twins = names.filter(name => name.startsWith('mcp__demo_server__hello_world'))
    expect(twins).toHaveLength(2)
    expect(twins).toContain('mcp__demo_server__hello_world')
    expect(twins).toContainEqual(expect.stringMatching(/^mcp__demo_server__hello_world__[0-9a-f]{8}$/))
    expect(names).toContain('mcp__instruction_server__read_file')
    expect(names).toContain('mcp__instruction_server__read_other')
    expect(names).not.toContain('mcp__demo_server__secret_tool')
    expect(names).not.toContain('mcp__instruction_server__write_file')
    expect(new Set(names).size).toBe(names.length)

    const direct = registeredTool(manager, 'mcp__demo_server__hello_world')
    expect(direct.deferred).toBeUndefined()
    const twin = extensionTools(manager).find(tool => /^mcp__demo_server__hello_world__[0-9a-f]{8}$/.test(tool.name))
    expect(twin?.deferred).toBe(true)
    expect(registeredTool(manager, 'mcp__instruction_server__read_file').deferred).toBeUndefined()
    expect(registeredTool(manager, 'mcp__instruction_server__read_other').deferred).toBe(true)

    // Code-mode namespaces cover connected servers with at least one callable tool.
    expect(manager.namespaces()).toEqual([
      { name: 'mcp__demo_server', prefix: 'mcp__demo_server__', description: 'Demo server from the fixture' },
      { name: 'mcp__instruction_server', prefix: 'mcp__instruction_server__', description: 'Instruction server heading' },
    ])
    for (const tool of extensionTools(manager)) {
      expect(tool.parameters).toMatchObject({ type: 'object' })
    }
  })

  it('keeps one failing server from breaking the others and times out a silent server', async () => {
    const good = startFakeServer({ tools: [{ name: 'ok-tool' }] })
    const broken = startFakeServer({ failInitialize: true })
    const silent = startFakeServer({ ignoreInitialize: true })
    const configPath = await writeConfig({
      mcpServers: {
        good: { command: 'node' },
        broken: { command: 'node', timeout: 5 },
        silent: { command: 'node', timeout: 0.2 },
      },
    })
    const transports = new Map<string, McpTransport>([
      ['good', good.transport],
      ['broken', broken.transport],
      ['silent', silent.transport],
    ])
    const manager = await openManager(configPath, server => transports.get(server.name)!)

    const view = manager.view()
    expect(view.error).toBeUndefined()
    expect(view.servers.map(server => [server.name, server.status])).toEqual([
      ['good', 'connected'],
      ['broken', 'error'],
      ['silent', 'error'],
    ])
    expect(view.servers[1]?.error).toContain('initialize failed')
    expect(view.servers[2]?.error).toMatch(/timed out/)
    expect(view.servers[2]?.tools).toEqual([])
    expect(extensionTools(manager).map(tool => tool.name)).toEqual(['mcp__good__ok_tool'])
    expect(manager.namespaces().map(namespace => namespace.name)).toEqual(['mcp__good'])
  })
})

describe('McpRegistry real stdio transport', () => {
  it('spawns a stdio server, lists its tools, and runs one', async () => {
    const directory = await temporaryDirectory()
    const fixturePath = join(directory, 'mcp-server.mjs')
    await writeFile(fixturePath, STDIO_FIXTURE, 'utf8')
    const configPath = await writeConfig({
      mcpServers: { real: { command: process.execPath, args: [fixturePath] } },
    })
    const manager = await openManager(configPath)

    const server = manager.view().servers[0]
    expect(server).toMatchObject({ name: 'real', transport: 'stdio', status: 'connected' })
    expect(server?.tools).toEqual([{ name: 'echo', description: 'Echo back', exposure: 'codemode' }])

    const result = await runTool(manager, 'mcp__real__echo', { text: 'hi' })
    expect(result.isError).toBeUndefined()
    expect(outputText(result)).toBe('stdio:hi')
    await manager.close()
  })
})

describe('McpRegistry tool execution', () => {
  it('maps successful, MCP-error, thrown, and structured-only results without throwing', async () => {
    const fake = startFakeServer({
      tools: [
        { name: 'echo', description: 'Echo', inputSchema: { type: 'object', properties: { message: { type: 'string' } } } },
        { name: 'fail', description: 'Fail with isError' },
        { name: 'crash', description: 'Fail with a protocol error' },
        { name: 'structured', description: 'Only structuredContent' },
      ],
      callTool: (name, args) => {
        if (name === 'echo') {
          return { content: [{ type: 'text', text: `pong:${String(args.message)}` }], structuredContent: { echoed: args.message } }
        }
        if (name === 'fail') return { content: [{ type: 'text', text: 'expected failure' }], isError: true }
        if (name === 'crash') throw new Error('kaboom')
        return { structuredContent: { only: 'data' } }
      },
    })
    const configPath = await writeConfig({ mcpServers: { exec: { command: 'node' } } })
    const manager = await openManager(configPath, () => fake.transport)

    const echoed = await runTool(manager, 'mcp__exec__echo', { message: 'hi' })
    expect(echoed.isError).toBeUndefined()
    expect(echoed.output).toEqual([{ type: 'text', text: 'pong:hi' }])
    expect(detailsOf(echoed)).toMatchObject({
      server: 'exec',
      tool: 'echo',
      isError: false,
      structuredContent: { echoed: 'hi' },
    })
    expect(typeof detailsOf(echoed).durationMs).toBe('number')
    expect(fake.calls).toEqual([{ name: 'echo', args: { message: 'hi' } }])

    const failed = await runTool(manager, 'mcp__exec__fail', {})
    expect(failed.isError).toBe(true)
    expect(outputText(failed)).toBe('expected failure')
    expect(detailsOf(failed)).toMatchObject({ server: 'exec', tool: 'fail', isError: true })

    const crashed = await runTool(manager, 'mcp__exec__crash', {})
    expect(crashed.isError).toBe(true)
    expect(outputText(crashed)).toContain('kaboom')
    expect(outputText(crashed)).toContain('MCP tool')

    const structured = await runTool(manager, 'mcp__exec__structured', {})
    expect(structured.isError).toBeUndefined()
    expect(JSON.parse(outputText(structured))).toEqual({ only: 'data' })
    expect(detailsOf(structured).structuredContent).toEqual({ only: 'data' })
  })

  it('closes every connection, idempotently', async () => {
    const first = startFakeServer({ tools: [{ name: 'one' }] })
    const second = startFakeServer({ tools: [{ name: 'two' }] })
    const configPath = await writeConfig({
      mcpServers: {
        first: { command: 'node' },
        second: { command: 'node' },
      },
    })
    const transports = new Map<string, McpTransport>([['first', first.transport], ['second', second.transport]])
    const manager = await openManager(configPath, server => transports.get(server.name)!)

    expect(first.closed).toBe(false)
    expect(second.closed).toBe(false)
    await manager.close()
    expect(first.closed).toBe(true)
    expect(second.closed).toBe(true)
    await expect(manager.close()).resolves.toBeUndefined()
  })
})

describe('McpRegistry plugin servers', () => {
  it('merges plugin-declared servers and reloads the connection set without a restart', async () => {
    const echoServer = startFakeServer({ tools: [{ name: 'echo', description: 'Echo back' }] })
    const drawServer = startFakeServer({ tools: [{ name: 'draw' }] })
    const configPath = await writeConfig({ mcpServers: {} })
    const projection: PluginMcpServerConfig[] = [{
      pluginId: 'demo@market',
      pluginName: 'demo',
      serverKey: 'echo',
      serverName: 'plugin_demo_echo',
      command: 'node',
      args: ['server.js'],
      env: { SECRET_TOKEN: 'hidden' },
      cwd: '/tmp/demo',
      dataPath: '/tmp/demo-data',
      exposure: 'codemode',
    }]
    const transports = new Map<string, McpTransport>([
      ['plugin_demo_echo', echoServer.transport],
      ['plugin_demo_draw', drawServer.transport],
    ])
    const registry = await McpRegistry.open({
      configPath,
      pluginServers: () => projection,
      transportFactory: server => transports.get(server.name)!,
    })
    openManagers.push(registry)

    expect(registry.view().servers).toEqual([
      expect.objectContaining({ name: 'plugin_demo_echo', pluginId: 'demo@market', status: 'connected' }),
    ])
    expect(registry.namespaces().map(namespace => namespace.name)).toEqual(['mcp__plugin_demo_echo'])
    const echo = extensionTools(registry).find(tool => tool.name === 'mcp__plugin_demo_echo__echo')
    expect(echo?.deferred).toBe(true)
    await echo!.execute({ text: 'hi' }, {} as ToolExecutionApi, EMPTY_CONTEXT)
    expect(echoServer.calls).toEqual([{ name: 'echo', args: { text: 'hi' } }])

    projection.splice(0, projection.length, {
      pluginId: 'painter@market',
      pluginName: 'painter',
      serverKey: 'draw',
      serverName: 'plugin_demo_draw',
      command: 'node',
      args: ['server.js'],
      env: {},
      cwd: '/tmp/painter',
      dataPath: '/tmp/painter-data',
      exposure: 'direct',
    })
    await registry.reload()

    expect(registry.view().servers).toEqual([
      expect.objectContaining({ name: 'plugin_demo_draw', status: 'connected', exposure: 'direct' }),
    ])
    expect(registry.namespaces().map(namespace => namespace.name)).toEqual(['mcp__plugin_demo_draw'])
    expect(extensionTools(registry).some(tool => tool.name.includes('plugin_demo_echo'))).toBe(false)
    expect(extensionTools(registry).find(tool => tool.name === 'mcp__plugin_demo_draw__draw')?.deferred).toBeUndefined()

    await registry.close()
    expect(echoServer.closed).toBe(true)
    expect(drawServer.closed).toBe(true)
  })
})
