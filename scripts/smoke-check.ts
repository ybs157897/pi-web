/**
 * HTTP 冒烟验收：以 --production 模式真实启动服务端进程（demo 环境），走 HTTP API 验证
 * 健康检查、模型目录、SSE 初始快照、提交幂等、真实工具结果、元数据修改、跨域拒绝、
 * 进程重启后消息原样恢复与历史分叉（fork）。证据写入 artifacts/http-smoke.json。
 * 失败条件：任一 API 响应非 2xx、SSE 首帧缺 snapshot、重复提交 submissionId 不一致、
 * 重启后消息与元数据不一致、fork 失败，或 20 秒内服务未就绪 / 10 秒内未优雅退出。
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir, userInfo } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import assert from 'node:assert/strict'
import type { ConversationDetail, ModelCatalog } from '../src/shared/types.ts'

const dir = await mkdtemp(join(tmpdir(), 'pi-web-http-smoke-'))
let child: ChildProcess | undefined
/**
 * 功能：启动服务端子进程并等待其打印监听地址。
 * @returns 服务监听的 http://127.0.0.1:<port> 地址。
 * @throws 20 秒内未就绪、子进程 error 或提前退出（错误信息附全部已捕获输出）。
 * 内部逻辑：demo 环境、端口 0（系统分配），从 stdout/stderr 流里正则解析非 :0 的地址。
 */
async function launch(): Promise<string> {
  child = spawn(process.execPath, ['--import', 'tsx', 'src/server/index.ts', '--production'], {
    cwd: process.cwd(), env: { ...process.env, PI_WEB_DEMO: '1', PI_WEB_PORT: '0', PI_WEB_DATA_DIR: join(dir, 'data'), PI_WEB_WORKSPACE: join(dir, 'workspace') }, stdio: ['ignore', 'pipe', 'pipe'],
  })
  const processHandle = child
  return await new Promise<string>((resolve, reject) => {
    let output = ''
    const timeout = setTimeout(() => reject(new Error(`Server did not become ready: ${output}`)), 20_000)
    const onOutput = (chunk: Buffer) => {
      output += chunk.toString()
      const url = output.match(/http:\/\/127\.0\.0\.1:(\d+)/)?.[0]
      if (url && !url.endsWith(':0')) { clearTimeout(timeout); resolve(url) }
    }
    processHandle.stdout!.on('data', onOutput)
    processHandle.stderr!.on('data', onOutput)
    processHandle.once('error', error => { clearTimeout(timeout); reject(error) })
    processHandle.once('exit', code => { clearTimeout(timeout); reject(new Error(`Server exited (${code}): ${output}`)) })
  })
}
/**
 * 功能：优雅停止子进程（SIGTERM），10 秒未退出则 SIGKILL 兜底并抛错。
 * @returns 无返回值；子进程不存在或已退出时直接返回。
 * @throws 优雅退出超时（进程已强制杀死）。
 */
async function shutdown() {
  const current = child
  if (!current || current.exitCode !== null) return
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => { current.kill('SIGKILL'); reject(new Error('Server did not shut down gracefully')) }, 10_000)
    current.once('exit', () => { clearTimeout(timeout); resolve() })
    current.kill('SIGTERM')
  })
  child = undefined
}
/**
 * 功能：发起 JSON API 请求并解析响应。
 * @param base 服务地址。
 * @param path API 路径。
 * @param method HTTP 方法（默认 GET）。
 * @param body 请求体（非 undefined 时以 JSON 序列化并带 Content-Type）。
 * @returns 解析后的响应 JSON。
 * @throws 响应非 ok——断言消息直接携带响应体，便于定位失败接口。
 */
async function json<T>(base: string, path: string, method = 'GET', body?: unknown): Promise<T> {
  const response = await fetch(base + path, { method, headers: body === undefined ? {} : { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
  const value = await response.json()
  assert.equal(response.ok, true, JSON.stringify(value))
  return value as T
}
try {
  // 第一段：起服务 → 健康检查（demo=true、当前用户名）→ 模型目录 → 建会话。
  let base = await launch()
  const health = await json<{ ok: boolean; demo: boolean }>(base, '/api/health')
  assert.deepEqual(health, { ok: true, demo: true, version: '0.1.0', user: userInfo().username })
  const catalog = await json<ModelCatalog>(base, '/api/models')
  assert.ok(catalog.defaultModel)
  const created = await json<ConversationDetail>(base, '/api/conversations', 'POST', { title: '恢复验收', model: catalog.defaultModel })
  const id = created.conversation.id
  // SSE 检查：订阅事件流，首帧必须是 snapshot；随后主动断开，避免占用连接。
  const controller = new AbortController()
  const events = await fetch(`${base}/api/conversations/${id}/events`, { signal: controller.signal })
  assert.equal(events.status, 200)
  const firstFrame = await events.body!.getReader().read()
  assert.match(new TextDecoder().decode(firstFrame.value), /snapshot/)
  controller.abort()
  // 幂等检查：同一 requestId 重复提交应得到相同 submissionId（不会重复触发一轮生成）。
  const input = { text: '请写入 hello.txt，再读取，最后用 Markdown 总结。', requestId: 'smoke-idempotency-1' }
  const first = await json<{ submissionId: string }>(base, `/api/conversations/${id}/messages`, 'POST', input)
  const repeat = await json<{ submissionId: string }>(base, `/api/conversations/${id}/messages`, 'POST', input)
  assert.equal(first.submissionId, repeat.submissionId)
  // 回合等待：30 秒内非 busy，且校验用户消息只入库一条、有真实工具结果、有非空回答。
  let detail: ConversationDetail = created
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    detail = await json<ConversationDetail>(base, `/api/conversations/${id}`)
    if (detail.error) throw new Error(detail.error)
    if (!detail.conversation.busy && detail.messages.some(message => message.role === 'assistant' && !message.streaming)) break
    await delay(80)
  }
  assert.equal(detail.conversation.busy, false)
  assert.equal(detail.messages.filter(message => message.role === 'user').length, 1)
  assert.ok(detail.messages.some(message => message.role === 'tool'), 'Expected real tool result entries')
  const assistant = detail.messages.filter(message => message.role === 'assistant').at(-1)
  assert.ok(assistant?.blocks.some(block => block.type === 'text' && block.text.length > 0))
  // 元数据与安全检查：PATCH 修改标题/置顶/归档生效；伪造 Origin 的跨域请求被 403 拒绝。
  await json(base, `/api/conversations/${id}`, 'PATCH', { title: '重启后保留', pinned: true, archived: true })
  const rejected = await fetch(base + '/api/conversations', { method: 'POST', headers: { Origin: 'https://untrusted.example', 'Content-Type': 'application/json' }, body: '{}' })
  assert.equal(rejected.status, 403)
  // 第二段：优雅停掉进程再重启，验证持久化——标题/置顶/归档与全部消息原样恢复。
  await shutdown()
  base = await launch()
  const restored = await json<ConversationDetail>(base, `/api/conversations/${id}`)
  assert.equal(restored.conversation.title, '重启后保留')
  assert.equal(restored.conversation.pinned, true)
  assert.equal(restored.conversation.archived, true)
  assert.deepEqual(restored.messages, detail.messages)
  // 恢复校验后分叉：从最后一条 assistant 的 entryId fork 出新会话，id 不同且带历史消息；
  // 全部通过则写证据文件并打印检查清单。
  assert.ok(assistant?.entryId)
  const fork = await json<ConversationDetail>(base, `/api/conversations/${id}/fork`, 'POST', { entryId: assistant!.entryId })
  assert.notEqual(fork.conversation.id, id)
  assert.ok(fork.messages.length > 0)
  const evidence = { result: 'passed', verifiedAt: new Date().toISOString(), checks: ['real Pi Durable + SQLite over HTTP', 'SSE initial snapshot and disconnect', 'idempotent input', 'real tool entries', 'metadata persists', 'process restart restores identical messages', 'fork history', 'cross-origin rejection'], messages: detail.messages.length }
  await mkdir('artifacts', { recursive: true })
  await writeFile('artifacts/http-smoke.json', JSON.stringify(evidence, null, 2) + '\n')
  console.log(JSON.stringify(evidence, null, 2))
} finally {
  await shutdown()
  await rm(dir, { recursive: true, force: true })
}
