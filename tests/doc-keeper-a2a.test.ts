// doc-keeper A2A 任务流集成测试：createDocKeeperApp + 原生 JSON-RPC。
// 注意：@a2a-js/sdk v1.3.0 原生方法名是 PascalCase（SendMessage/GetTask/SendStreamingMessage）；
// `message/send` 属 v0.3 兼容层，本服务未启用 legacyCompat，故不可用。
// state 的 JSON 序列化是枚举名字符串（如 "TASK_STATE_COMPLETED"），part 的 JSON 是扁平 {text}/{data}。
// 请求必须带 `A2A-Version: 1.0` 头：缺省时 SDK 按 0.3 校验并拒绝（VERSION_NOT_SUPPORTED）。
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { Server } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import type { DocKeeperRunInput, DocKeeperRunResult } from '../src/server/knowledge/service.ts'
import {
  DOC_PATH, cleanupKeeperFixtures, keeperFixture, registerKeeperCleanup, textTurn, toolTurn,
  type ProviderScript,
} from './keeper-fixtures.ts'

const { createDocKeeperApp } = await import('../src/server/doc-keeper/server.ts')
const { DOC_KEEPER_SKILL_ID } = await import('../src/server/doc-keeper/agent-card.ts')

afterEach(cleanupKeeperFixtures)

type RpcEnvelope = {
  jsonrpc: '2.0'
  id: number
  result?: Record<string, unknown>
  error?: { code: number; message: string }
}

async function rpc(origin: string, method: string, params: unknown, apiKey?: string): Promise<{ status: number; body: RpcEnvelope }> {
  const response = await fetch(`${origin}/`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'A2A-Version': '1.0', ...(apiKey === undefined ? {} : { authorization: `Bearer ${apiKey}` }) },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  })
  return { status: response.status, body: await response.json() as RpcEnvelope }
}

function messageParams(payload: unknown, via: 'data' | 'text' = 'data') {
  return {
    message: {
      role: 'ROLE_USER',
      messageId: randomUUID(),
      parts: [via === 'data' ? { data: payload } : { text: JSON.stringify(payload) }],
    },
  }
}

const stubResult: DocKeeperRunResult = {
  mode: 'check', health: 'fresh', detail: 'stub ok', changedFiles: [], commitCount: 0, updated: false, knowledgePath: DOC_PATH,
}

/** 起一个 stub runMaintenance 的 A2A 服务，记录收到的输入。url 为构造时配置的公开地址。 */
async function stubApp(options: { apiKey?: string; result?: DocKeeperRunResult } = {}): Promise<{ origin: string; url: string; calls: DocKeeperRunInput[] }> {
  const calls: DocKeeperRunInput[] = []
  const url = 'http://127.0.0.1:41250/'
  const app = createDocKeeperApp({
    runMaintenance: async input => {
      calls.push(input)
      return options.result ?? stubResult
    },
    url,
    ...(options.apiKey === undefined ? {} : { apiKey: options.apiKey }),
  })
  const server: Server = await new Promise((resolve, reject) => {
    const listener = app.listen(0, '127.0.0.1')
    listener.once('error', reject)
    listener.once('listening', () => resolve(listener))
  })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('A2A stub server did not bind a TCP port')
  registerKeeperCleanup(() => new Promise<void>(resolve => { server.close(() => resolve()) }))
  return { origin: `http://127.0.0.1:${address.port}`, url, calls }
}

function taskOf(body: RpcEnvelope): Record<string, any> {
  const task = (body.result as { task?: Record<string, any> } | undefined)?.task
  if (task === undefined) throw new Error(`响应里没有 task：${JSON.stringify(body)}`)
  return task
}

describe('A2A 表面：Agent Card 与鉴权', () => {
  it('Agent Card 公开可发现，含维护技能与接口地址', async () => {
    const { origin, url } = await stubApp({ apiKey: 'secret-key' })
    const response = await fetch(`${origin}/.well-known/agent-card.json`)
    expect(response.status).toBe(200)
    const card = await response.json() as Record<string, any>
    expect(card.name).toBe('doc-keeper')
    expect(card.skills[0].id).toBe(DOC_KEEPER_SKILL_ID)
    expect(card.supportedInterfaces[0].url).toBe(url)
    expect(card.supportedInterfaces[0].protocolBinding).toBe('JSONRPC')
  })

  it('设置 apiKey 后：无凭证/错误凭证 401，正确凭证放行', async () => {
    const { origin } = await stubApp({ apiKey: 'secret-key' })
    const params = messageParams({ globs: ['src/**'], knowledgePath: DOC_PATH, mode: 'check' })
    expect((await rpc(origin, 'SendMessage', params)).status).toBe(401)
    expect((await rpc(origin, 'SendMessage', params, 'wrong')).status).toBe(401)
    const ok = await rpc(origin, 'SendMessage', params, 'secret-key')
    expect(ok.status).toBe(200)
    expect(taskOf(ok.body).status.state).toBe('TASK_STATE_COMPLETED')
  })

  it('未设置 apiKey 时端点开放（仅限回环使用）', async () => {
    const { origin } = await stubApp()
    const ok = await rpc(origin, 'SendMessage', messageParams({ globs: ['src/**'], knowledgePath: DOC_PATH, mode: 'check' }))
    expect(ok.status).toBe(200)
    expect(taskOf(ok.body).status.state).toBe('TASK_STATE_COMPLETED')
  })
})

describe('A2A 任务流：SendMessage / GetTask', () => {
  it('data part 输入被完整解析，任务完成并产出结果 artifact', async () => {
    const { origin, calls } = await stubApp({ apiKey: 'k' })
    const payload = { repo: '/tmp/some-repo', globs: ['src/**', 'lib/**'], knowledgePath: DOC_PATH, mode: 'refresh', model: { provider: 'p', modelId: 'm' } }
    const sent = await rpc(origin, 'SendMessage', messageParams(payload), 'k')
    expect(sent.status).toBe(200)
    expect(calls).toEqual([payload])
    const task = taskOf(sent.body)
    expect(task.status.state).toBe('TASK_STATE_COMPLETED')
    expect(task.artifacts).toHaveLength(1)
    expect(task.artifacts[0].name).toBe('maintenance-result')
    const artifactText = task.artifacts[0].parts[0].text as string
    expect(JSON.parse(artifactText)).toEqual(stubResult)
    expect(task.history[0].messageId).toBeTruthy()

    // GetTask 能按 id 取回同一终态任务。
    const fetched = await rpc(origin, 'GetTask', { id: task.id }, 'k')
    expect(fetched.status).toBe(200)
    const fetchedTask = fetched.body.result as Record<string, any>
    expect(fetchedTask.id).toBe(task.id)
    expect(fetchedTask.status.state).toBe('TASK_STATE_COMPLETED')
  })

  it('JSON 文本 part 与 data part 等价', async () => {
    const { origin, calls } = await stubApp()
    const payload = { globs: ['src/**'], knowledgePath: DOC_PATH, mode: 'check' }
    const sent = await rpc(origin, 'SendMessage', messageParams(payload, 'text'))
    expect(sent.status).toBe(200)
    expect(calls).toEqual([payload])
    expect(taskOf(sent.body).status.state).toBe('TASK_STATE_COMPLETED')
  })

  it('缺必填字段 → 任务 FAILED 并带错误消息', async () => {
    const { origin, calls } = await stubApp()
    const sent = await rpc(origin, 'SendMessage', messageParams({ knowledgePath: DOC_PATH, mode: 'check' }))
    expect(sent.status).toBe(200)
    const task = taskOf(sent.body)
    expect(task.status.state).toBe('TASK_STATE_FAILED')
    expect(task.status.message.parts[0].text).toContain('globs')
    expect(calls).toEqual([])
  })

  it('非 JSON 文本 → 任务 FAILED', async () => {
    const { origin } = await stubApp()
    const sent = await rpc(origin, 'SendMessage', {
      message: { role: 'ROLE_USER', messageId: randomUUID(), parts: [{ text: '请维护一下文档' }] },
    })
    expect(taskOf(sent.body).status.state).toBe('TASK_STATE_FAILED')
  })

  it('维护结果带 error → 任务 FAILED', async () => {
    const { origin } = await stubApp({ result: { ...stubResult, error: '模型不可用' } })
    const sent = await rpc(origin, 'SendMessage', messageParams({ globs: ['src/**'], knowledgePath: DOC_PATH, mode: 'refresh' }))
    const task = taskOf(sent.body)
    expect(task.status.state).toBe('TASK_STATE_FAILED')
    expect(task.status.message.parts[0].text).toContain('模型不可用')
  })

  it('SendStreamingMessage 生命周期：task → working → artifact → completed', async () => {
    const { origin } = await stubApp()
    const response = await fetch(`${origin}/`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'A2A-Version': '1.0' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'SendStreamingMessage', params: messageParams({ globs: ['src/**'], knowledgePath: DOC_PATH, mode: 'check' }) }),
    })
    expect(response.status).toBe(200)
    const text = await response.text()
    const events = text.split('\n')
      .filter(line => line.startsWith('data: '))
      .map(line => JSON.parse(line.slice('data: '.length)) as { result?: Record<string, unknown> })
      .map(envelope => envelope.result ?? {})
    const kinds = events.map(event => Object.keys(event)[0])
    expect(kinds[0]).toBe('task')
    expect(kinds).toContain('statusUpdate')
    expect(kinds).toContain('artifactUpdate')
    const states = events.flatMap(event => {
      const update = event.statusUpdate as { status?: { state?: string } } | undefined
      return update?.status?.state === undefined ? [] : [update.status.state]
    })
    expect(states).toEqual(['TASK_STATE_WORKING', 'TASK_STATE_COMPLETED'])
    const firstTask = events[0].task as { status: { state: string } }
    expect(firstTask.status.state).toBe('TASK_STATE_SUBMITTED')
  })
})

describe('A2A 全链路：真实 runtime + 脚本模型驱动 refresh', () => {
  it('SendMessage refresh 经五工具写回知识文档', async () => {
    const newBody = '## 职责\n\n- 负责 server 模块。\n\n## 关键文件\n\n- `src/a.ts`：入口，导出 a=2。\n\n## 已知坑\n\n- 暂无。\n\n## changelog\n\n- 2026-11-12 A2A 增量刷新；1 条提交。\n'
    const script: ProviderScript = {
      turn: (_userText, toolCount) => {
        switch (toolCount) {
          case 0: return toolTurn('detect_changes', {})
          case 1: return toolTurn('read_knowledge', {})
          case 2: return toolTurn('git_diff', {})
          case 3: return toolTurn('read_code', { paths: ['src/a.ts'] })
          case 4: return toolTurn('write_knowledge', { body: newBody })
          default: return textTurn('A2A 刷新完成：a=2 已写入关键文件，1 条提交。')
        }
      },
    }
    const { runtime, workspace } = await keeperFixture(script)
    const app = createDocKeeperApp({
      runMaintenance: runtime.runDocKeeperMaintenance,
      url: 'http://127.0.0.1:0/',
      apiKey: 'full-stack-key',
    })
    const server: Server = await new Promise((resolve, reject) => {
      const listener = app.listen(0, '127.0.0.1')
      listener.once('error', reject)
      listener.once('listening', () => resolve(listener))
    })
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('A2A server did not bind a TCP port')
    registerKeeperCleanup(() => new Promise<void>(resolve => { server.close(() => resolve()) }))
    const origin = `http://127.0.0.1:${address.port}`

    const sent = await rpc(origin, 'SendMessage', messageParams({
      globs: ['src/**'], knowledgePath: DOC_PATH, mode: 'refresh', model: { provider: 'repro', modelId: 'repro-model' },
    }), 'full-stack-key')
    expect(sent.status).toBe(200)
    const task = taskOf(sent.body)
    expect(task.status.state).toBe('TASK_STATE_COMPLETED')
    const result = JSON.parse(task.artifacts[0].parts[0].text as string) as DocKeeperRunResult
    expect(result.updated).toBe(true)
    expect(result.health).toBe('fresh')
    expect(result.report).toContain('A2A 刷新完成')

    const onDisk = await readFile(join(workspace, DOC_PATH), 'utf8')
    expect(onDisk).toContain('botId: atlas')
    expect(onDisk.endsWith(newBody)).toBe(true)
  }, 30_000)
})
