import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import assert from 'node:assert/strict'
import type { ConversationDetail, ModelCatalog } from '../src/shared/types.ts'

const dir = await mkdtemp(join(tmpdir(), 'pi-web-http-smoke-'))
let child: ChildProcess | undefined
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
async function json<T>(base: string, path: string, method = 'GET', body?: unknown): Promise<T> {
  const response = await fetch(base + path, { method, headers: body === undefined ? {} : { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
  const value = await response.json()
  assert.equal(response.ok, true, JSON.stringify(value))
  return value as T
}
try {
  let base = await launch()
  const health = await json<{ ok: boolean; demo: boolean }>(base, '/api/health')
  assert.deepEqual(health, { ok: true, demo: true })
  const catalog = await json<ModelCatalog>(base, '/api/models')
  assert.ok(catalog.defaultModel)
  const created = await json<ConversationDetail>(base, '/api/conversations', 'POST', { title: '恢复验收', model: catalog.defaultModel })
  const id = created.conversation.id
  const controller = new AbortController()
  const events = await fetch(`${base}/api/conversations/${id}/events`, { signal: controller.signal })
  assert.equal(events.status, 200)
  const firstFrame = await events.body!.getReader().read()
  assert.match(new TextDecoder().decode(firstFrame.value), /snapshot/)
  controller.abort()
  const input = { text: '请写入 hello.txt，再读取，最后用 Markdown 总结。', requestId: 'smoke-idempotency-1' }
  const first = await json<{ submissionId: string }>(base, `/api/conversations/${id}/messages`, 'POST', input)
  const repeat = await json<{ submissionId: string }>(base, `/api/conversations/${id}/messages`, 'POST', input)
  assert.equal(first.submissionId, repeat.submissionId)
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
  await json(base, `/api/conversations/${id}`, 'PATCH', { title: '重启后保留', pinned: true, archived: true })
  const rejected = await fetch(base + '/api/conversations', { method: 'POST', headers: { Origin: 'https://untrusted.example', 'Content-Type': 'application/json' }, body: '{}' })
  assert.equal(rejected.status, 403)
  await shutdown()
  base = await launch()
  const restored = await json<ConversationDetail>(base, `/api/conversations/${id}`)
  assert.equal(restored.conversation.title, '重启后保留')
  assert.equal(restored.conversation.pinned, true)
  assert.equal(restored.conversation.archived, true)
  assert.deepEqual(restored.messages, detail.messages)
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
