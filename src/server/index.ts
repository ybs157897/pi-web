import { createServer } from 'node:http'
import { mkdir, access } from 'node:fs/promises'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer as createViteServer, type ViteDevServer } from 'vite'
import { createAdaptorServer, getRequestListener, type ServerType } from '@hono/node-server'
import { createApp } from './app.ts'
import { migrateGlobalHome, piWebHome } from './state/home.ts'
import { createRuntime } from './runtime/index.ts'

const host = '127.0.0.1'
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

/**
 * 功能：解析 PI_WEB_PORT 环境变量为监听端口。
 * @param value 环境变量原始值；undefined 时用默认端口 4317。
 * @returns 0–65535 的端口数字。
 * 内部逻辑：非纯数字、越界或非安全整数都会抛出格式提示错误。
 */
function parsePort(value: string | undefined): number {
  if (value === undefined) return 4317
  if (!/^\d+$/.test(value)) throw new Error('PI_WEB_PORT must be an integer between 0 and 65535')
  const port = Number(value)
  if (!Number.isSafeInteger(port) || port < 0 || port > 65535) throw new Error('PI_WEB_PORT must be an integer between 0 and 65535')
  return port
}

/**
 * 功能：容错版端口解析：任何非法值一律回落默认 4317（仅在启动失败消息路径使用）。
 * @param value 环境变量原始值。
 */
function parsePortSafely(value: string | undefined): number {
  try {
    return parsePort(value)
  } catch {
    return 4317
  }
}

/**
 * 功能：在指定端口监听并等待成功或失败。
 * @param server 待监听的服务器。
 * @param port 端口。
 * @returns 监听成功兑现；error 事件（如端口占用）拒绝。
 * 内部逻辑：临时挂一次性 error 监听，成功后摘除，避免把监听错误与后续错误混淆。
 */
function listen(server: ServerType, port: number): Promise<void> {
  return new Promise((resolveListen, rejectListen) => {
    const onError = (error: Error) => rejectListen(error)
    server.once('error', onError)
    server.listen(port, host, () => {
      server.off('error', onError)
      resolveListen()
    })
  })
}

/** 从未知错误对象中提取 `code` 字段（Node fs/net 错误约定），非对象返回 undefined。 */
function errorCode(error: unknown): unknown {
  return typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined
}

/**
 * 功能：把启动失败翻译成用户可读的一条消息。
 * @param error 启动过程中抛出的错误。
 * @param port 解析出的端口。
 * @param production 是否生产模式（影响缺资源提示）。
 * @returns 一行可操作的失败说明。
 * 内部逻辑：按错误码逐类映射——端口格式错误原样返回、EADDRINUSE、EACCES、
 * 生产模式缺前端资源（ENOENT）、EROFS（只读文件系统），其余回落通用提示。
 */
function startFailureMessage(error: unknown, port: number, production: boolean): string {
  if (error instanceof Error && error.message === 'PI_WEB_PORT must be an integer between 0 and 65535') return error.message
  if (errorCode(error) === 'EADDRINUSE') return `Port ${port} is already in use. Set PI_WEB_PORT to choose another local port.`
  if (errorCode(error) === 'EACCES') return `Permission was denied while starting on port ${port} or creating local folders. Check permissions or choose another PI_WEB_PORT.`
  if (production && errorCode(error) === 'ENOENT') return 'Production client assets are missing. Run npm run build before starting the server.'
  if (errorCode(error) === 'EROFS') return 'Pi Web cannot write its local data or workspace directory. Check the selected directory permissions.'
  return 'Pi Web could not start. Check the local runtime and configuration.'
}

/**
 * 功能：启动本地 Web 服务（API + 开发前端或生产静态资源），返回幂等的优雅关闭操作。
 * @returns 携带 host、port（实际端口）、server、runtime 与 close 的对象；close 幂等且会摘除信号监听。
 * 内部逻辑：顺序为——解析环境变量 → 首次全局主目录迁移（显式数据目录与 demo 跳过）→ 建目录/
 * 生产资源探测 → createRuntime + createApp → 按模式装配服务器（生产用 adaptor；开发把 /api
 * 之外的请求交给 Vite 中间件并做 HMR）→ 监听；任一步失败清理已创建的 runtime/vite/server 后抛出。
 * 启动成功后注册 SIGINT/SIGTERM 处理：关闭依次执行 app.shutdown、vite.close、server.close、
 * runtime.close，全部失败聚合为 AggregateError。
 */
export async function startServer() {
  const port = parsePort(process.env.PI_WEB_PORT)
  const home = piWebHome()
  const dataDir = resolve(process.env.PI_WEB_DATA_DIR ?? home)
  // 无隐式默认：没有 PI_WEB_WORKSPACE 时应用以空工作区列表启动，目录由用户在 UI 里添加。
  const workspace = process.env.PI_WEB_WORKSPACE === undefined ? undefined : resolve(process.env.PI_WEB_WORKSPACE)
  const demo = process.env.PI_WEB_DEMO === '1'
  // 把旧版项目内 `.data` 与 `~/.pi/agent` 一次性导入全局主目录。显式数据目录（测试/demo）不做迁移。
  if (!demo && process.env.PI_WEB_DATA_DIR === undefined) {
    try {
      const migrated = await migrateGlobalHome(home, resolve('.data'))
      if (migrated.length > 0) console.info(`Pi Web migrated ${migrated.length} file(s) into ${home}`)
    } catch (error) {
      console.warn(`Pi Web skipped the legacy import into ${home}: ${error instanceof Error ? error.message : 'unknown error'}`)
    }
  }
  // 被导入的 Pi MCP 文件的可选覆盖；未设置时 runtime 读取用户级 `mcp.json`
  // （demo 模式在数据目录下保留自己的副本）。
  const mcpConfigPath = process.env.PI_WEB_MCP_CONFIG === undefined ? undefined : resolve(process.env.PI_WEB_MCP_CONFIG)
  const production = process.argv.includes('--production') || process.env.NODE_ENV === 'production'
  const distRoot = resolve(projectRoot, 'dist/web')

  await mkdir(dataDir, { recursive: true })
  if (workspace !== undefined) await mkdir(workspace, { recursive: true })
  if (production) await access(resolve(distRoot, 'index.html'))

  const runtime = await createRuntime({ dataDir, ...(workspace === undefined ? {} : { workspace }), demo, ...(mcpConfigPath === undefined ? {} : { mcpConfigPath }) })
  const app = createApp(runtime, { demo, ...(production ? { staticRoot: distRoot } : {}) })
  let vite: ViteDevServer | undefined
  let server: ServerType | undefined

  try {
    if (production) {
      server = createAdaptorServer({ fetch: app.fetch, hostname: host })
    } else {
      const honoListener = getRequestListener(app.fetch, { hostname: host })
      const nodeServer = createServer((request, response) => {
        const pathname = new URL(request.url ?? '/', `http://${host}`).pathname
        if (pathname === '/api' || pathname.startsWith('/api/')) {
          void honoListener(request, response)
          return
        }
        vite?.middlewares(request, response, (error?: Error) => {
          if (error) {
            if (!response.headersSent) response.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' })
            if (!response.writableEnded) response.end('Internal server error')
            return
          }
          if (!response.headersSent && !response.writableEnded) void honoListener(request, response)
        })
      })
      vite = await createViteServer({
        configFile: resolve(projectRoot, 'vite.config.ts'),
        appType: 'spa',
        server: { middlewareMode: true, hmr: { server: nodeServer } },
      })
      server = nodeServer
    }

    await listen(server, port)
  } catch (error) {
    const cleanup = [runtime.close()]
    if (vite) cleanup.push(vite.close())
    if (server?.listening) {
      cleanup.push(new Promise<void>(resolveClose => server?.close(() => resolveClose())))
    }
    await Promise.allSettled(cleanup)
    throw error
  }

  const address = server.address()
  const actualPort = address && typeof address !== 'string' ? address.port : port
  let closePromise: Promise<void> | undefined
  const close = (): Promise<void> => {
    closePromise ??= (async () => {
      const failures: unknown[] = []
      try {
        await app.shutdown()
      } catch (error) {
        failures.push(error)
      }
      try {
        await vite?.close()
      } catch (error) {
        failures.push(error)
      }
      try {
        await new Promise<void>((resolveClose, rejectClose) => {
          if (!server?.listening) {
            resolveClose()
            return
          }
          server.close(error => error ? rejectClose(error) : resolveClose())
        })
      } catch (error) {
        failures.push(error)
      }
      try {
        await runtime.close()
      } catch (error) {
        failures.push(error)
      }
      if (failures.length > 0) throw new AggregateError(failures, 'Pi Web shutdown failed')
    })()
    return closePromise
  }

  console.info(`Pi Web listening at http://${host}:${actualPort}`)
  const onSignal = () => {
    void close().catch(() => {
      process.exitCode = 1
      console.error('Pi Web failed to close cleanly')
    })
  }
  process.once('SIGINT', onSignal)
  process.once('SIGTERM', onSignal)

  return {
    host,
    port: actualPort,
    server,
    runtime,
    close: async () => {
      process.off('SIGINT', onSignal)
      process.off('SIGTERM', onSignal)
      await close()
    },
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void startServer().catch(error => {
    console.error(startFailureMessage(error, parsePortSafely(process.env.PI_WEB_PORT), process.argv.includes('--production') || process.env.NODE_ENV === 'production'))
    process.exitCode = 1
  })
}
