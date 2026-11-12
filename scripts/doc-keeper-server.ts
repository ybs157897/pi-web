// doc-keeper A2A 独立进程入口：装配 pi-web runtime，把知识文档维护能力经 A2A 协议对外暴露。
// Agent Card 公开（/.well-known/agent-card.json）；设置 DOC_KEEPER_API_KEY 后 JSON-RPC 端点
// 要求 Authorization: Bearer <key>。与 bot 团队并存：同一 runtime 装配，扩展互不注入普通会话。
//
// 用法：
//   PI_WEB_DATA_DIR=/path/to/data PI_WEB_WORKSPACE=/path/to/repo \
//   DOC_KEEPER_PORT=41250 DOC_KEEPER_API_KEY=secret npx tsx scripts/doc-keeper-server.ts
//
// 模型配置（models.json/auth.json/settings.json）从 PI_WEB_PI_DIR 读取，缺省为数据目录
// （与主应用 createRuntime 的 piDir ?? dataDir 语义一致）。维护请求可用 model 字段指定模型，
// 缺省走 settings.defaultModel。
import { resolve } from 'node:path'
import type { Server } from 'node:http'
import { AGENT_CARD_PATH } from '@a2a-js/sdk'
import { createRuntime } from '../src/server/runtime/index.ts'
import { createDocKeeperApp } from '../src/server/doc-keeper/server.ts'
import { piWebHome } from '../src/server/state/home.ts'

const host = '127.0.0.1'

function parsePort(value: string | undefined): number {
  if (value === undefined || value === '') return 41250
  if (!/^\d+$/.test(value)) throw new Error('DOC_KEEPER_PORT must be an integer between 0 and 65535')
  const port = Number(value)
  if (!Number.isSafeInteger(port) || port < 0 || port > 65535) throw new Error('DOC_KEEPER_PORT must be an integer between 0 and 65535')
  return port
}

const port = parsePort(process.env.DOC_KEEPER_PORT)
const dataDir = resolve(process.env.PI_WEB_DATA_DIR ?? piWebHome())
const workspace = process.env.PI_WEB_WORKSPACE === undefined ? undefined : resolve(process.env.PI_WEB_WORKSPACE)
const piDir = process.env.PI_WEB_PI_DIR === undefined ? dataDir : resolve(process.env.PI_WEB_PI_DIR)
const apiKey = process.env.DOC_KEEPER_API_KEY

const runtime = await createRuntime({ dataDir, ...(workspace === undefined ? {} : { workspace }), piDir })
let server: Server
try {
  const app = createDocKeeperApp({
    runMaintenance: runtime.runDocKeeperMaintenance,
    url: `http://${host}:${port}/`,
    ...(apiKey === undefined || apiKey === '' ? {} : { apiKey }),
  })
  server = await new Promise<Server>((resolveListen, rejectListen) => {
    const listener = app.listen(port, host)
    listener.once('error', rejectListen)
    listener.once('listening', () => resolveListen(listener))
  })
} catch (error) {
  await runtime.close().catch(() => undefined)
  throw error
}

console.info(`doc-keeper A2A listening at http://${host}:${port}`)
console.info(`Agent Card: http://${host}:${port}/${AGENT_CARD_PATH}`)
if (apiKey === undefined || apiKey === '') {
  console.warn('未设置 DOC_KEEPER_API_KEY：JSON-RPC 端点无鉴权，请仅在本机回环地址使用')
}

let closePromise: Promise<void> | undefined
const close = (): Promise<void> => {
  closePromise ??= (async () => {
    await new Promise<void>(resolveClose => {
      if (!server.listening) {
        resolveClose()
        return
      }
      server.close(() => resolveClose())
    })
    await runtime.close()
  })()
  return closePromise
}
const onSignal = () => {
  void close().catch(() => {
    process.exitCode = 1
    console.error('doc-keeper failed to close cleanly')
  })
}
process.once('SIGINT', onSignal)
process.once('SIGTERM', onSignal)
