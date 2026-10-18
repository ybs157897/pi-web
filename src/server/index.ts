import { createServer } from 'node:http'
import { mkdir, access } from 'node:fs/promises'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer as createViteServer, type ViteDevServer } from 'vite'
import { createAdaptorServer, getRequestListener, type ServerType } from '@hono/node-server'
import { createApp } from './app.ts'
import { createRuntime } from './runtime.ts'

const host = '127.0.0.1'
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

function parsePort(value: string | undefined): number {
  if (value === undefined) return 4317
  if (!/^\d+$/.test(value)) throw new Error('PI_WEB_PORT must be an integer between 0 and 65535')
  const port = Number(value)
  if (!Number.isSafeInteger(port) || port < 0 || port > 65535) throw new Error('PI_WEB_PORT must be an integer between 0 and 65535')
  return port
}

function parsePortSafely(value: string | undefined): number {
  try {
    return parsePort(value)
  } catch {
    return 4317
  }
}

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

function errorCode(error: unknown): unknown {
  return typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined
}

function startFailureMessage(error: unknown, port: number, production: boolean): string {
  if (error instanceof Error && error.message === 'PI_WEB_PORT must be an integer between 0 and 65535') return error.message
  if (errorCode(error) === 'EADDRINUSE') return `Port ${port} is already in use. Set PI_WEB_PORT to choose another local port.`
  if (errorCode(error) === 'EACCES') return `Permission was denied while starting on port ${port} or creating local folders. Check permissions or choose another PI_WEB_PORT.`
  if (production && errorCode(error) === 'ENOENT') return 'Production client assets are missing. Run npm run build before starting the server.'
  if (errorCode(error) === 'EROFS') return 'Pi Web cannot write its local data or workspace directory. Check the selected directory permissions.'
  return 'Pi Web could not start. Check the local runtime and configuration.'
}

/** Starts the local web server and returns an idempotent graceful close operation. */
export async function startServer() {
  const port = parsePort(process.env.PI_WEB_PORT)
  const dataDir = resolve(process.env.PI_WEB_DATA_DIR ?? '.data')
  const workspace = resolve(process.env.PI_WEB_WORKSPACE ?? 'workspace')
  const demo = process.env.PI_WEB_DEMO === '1'
  const production = process.argv.includes('--production') || process.env.NODE_ENV === 'production'
  const distRoot = resolve(projectRoot, 'dist/web')

  await mkdir(dataDir, { recursive: true })
  await mkdir(workspace, { recursive: true })
  if (production) await access(resolve(distRoot, 'index.html'))

  const runtime = await createRuntime({ dataDir, workspace, demo })
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
