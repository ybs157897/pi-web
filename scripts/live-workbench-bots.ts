// 通过正常 HTTP 入口验证真实模型对新专长的孵化、复用，以及人工修订在下一单生效。
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { createRuntime } from '../src/server/runtime/index.ts'
import { createApp } from '../src/server/app.ts'
import { piWebHome } from '../src/server/state/home.ts'
import type { DecisionMailSummary } from '../src/shared/decision-inbox.ts'
import type { ConversationDetail } from '../src/shared/types.ts'
import type { WorkbenchAgent, WorkbenchView } from '../src/shared/workbench.ts'

const root = await mkdtemp(join(tmpdir(), 'pi-web-bot-roster-'))
const workspace = join(root, '藏品编目')
await mkdir(workspace)
const inventory = 'PI-' + randomUUID().slice(0, 8)
await writeFile(join(workspace, '登记.txt'), `登记号 ${inventory}\n名称 青花折枝纹盘\n材质 瓷\n`)
const runtime = await createRuntime({ workspace, dataDir: join(root, 'data'), piDir: piWebHome(), mcpConfigPath: join(root, 'no-mcp.json') })
const app = createApp(runtime)
const model = (await runtime.catalog()).defaultModel
const route = '/api/workbench/' + runtime.workspaces()[0]!.id
const checks: string[] = []
const report: Record<string, unknown> = { result: 'failed', verifiedAt: new Date().toISOString(), model, checks }
async function request<T>(path: string, method = 'GET', payload?: unknown): Promise<T> {
  const response = await app.request('http://localhost' + path, { method, ...(payload === undefined ? {} : {
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
  }) })
  const body = await response.json()
  assert.ok(response.ok, 'HTTP ' + response.status + ' ' + (body.code ?? '') + ' ' + (body.error ?? ''))
  return body as T
}
async function run(text: string, mention?: string) {
  const requestId = randomUUID()
  await request(route + '/messages', 'POST', { text, requestId, model, mention, accessMode: 'readOnly', thinkingLevel: 'off' })
  const deadline = Date.now() + 180_000
  while (Date.now() < deadline) {
    const view = await request<WorkbenchView>(route)
    const message = view.messages.find(entry => entry.requestId === requestId)
    assert.ok(!message?.error, message?.error)
    const items = view.items.filter(entry => entry.requestId === requestId)
    assert.ok(!items.some(item => item.error), items.find(item => item.error)?.error)
    if (items.length && items.every(item => item.status === 'pending_review')) {
      assert.equal(items.length, 1)
      return { view, item: items[0]!, message }
    }
    await delay(650)
  }
  throw new Error('等待交付超时')
}
try {
  assert.ok(model && model.provider !== 'demo', '需要已配置的真实默认模型')
  const initial = await request<WorkbenchView>(route)
  console.log('验证模型对长期专业编目任务的派发')
  const first = await run('今后这个空间会持续有博物馆藏品编目工作，每批都要同一位专员按藏品著录规范整理，保持登记号、器名、材质三字段的固定口径。请从工作区的登记.txt 读取第一件藏品，交付一行编目记录。只读，不写文件；这是一项会长期复用的专长。')
  const bot = first.view.agents.find(agent => agent.id === first.item.assignee)
  report.first = { title: first.item.title, name: bot?.name, origin: bot?.config?.origin, rosterSize: first.view.agents.length }
  assert.ok(bot?.config?.origin === 'agent', '本次模型没有孵化并派给新的专长 Bot')
  assert.equal(first.message?.createdBotId, bot.id)
  assert.equal(first.view.agents.length, initial.agents.length + 1)
  assert.ok(bot.config.instructions.trim() && bot.role.trim())
  assert.equal(bot.config.skillIds, null)
  assert.equal(bot.config.accessMode, runtime.capabilities().accessModes.includes('workspaceWrite') ? 'workspaceWrite' : 'readOnly')
  assert.equal(bot.model?.modelId, model.modelId)
  assert.ok(first.item.outcome?.summary.includes(inventory), '交付未含文件里的随机登记号')
  checks.push('未指定 Bot ID，真实模型孵化并派发新专长，默认继承模型、全部可用技能与平台工作区访问上限')
  const inbox = await request<{ mails: DecisionMailSummary[] }>(route + '/inbox')
  const result = inbox.mails.find(mail => mail.kind === 'result' && mail.link.workItemId === first.item.id)
  assert.ok(result?.actionable)
  const updated = await request<WorkbenchAgent>(route + '/bots/' + encodeURIComponent(bot.id), 'PATCH', {
    instructions: '按馆藏档案著录。每次交付必须在最后单独写出 ARCHIVE-CHECKED。', skillIds: [], accessMode: 'readOnly', model,
  })
  assert.deepEqual(updated.config?.skillIds, [])
  assert.equal((await request<WorkbenchView>(route)).items.find(item => item.id === first.item.id)?.status, 'pending_review')
  console.log('验证已有专长复用和配置生效')
  const second = await run('新的一单仍由我们的藏品编目专员处理：请独立读取登记.txt，按该专员的现有工作指令交付含登记号和材质的一行文本。不依赖上一单的交付，不写文件。')
  assert.equal(second.item.assignee, bot.id)
  assert.deepEqual(second.item.dependencies, [])
  assert.equal(second.view.items.find(item => item.id === first.item.id)?.status, 'pending_review')
  assert.equal(second.view.agents.length, first.view.agents.length)
  assert.equal(second.message?.createdBotId, undefined)
  assert.notEqual(second.item.childId, first.item.childId)
  assert.ok(second.item.outcome?.summary.includes('ARCHIVE-CHECKED') && second.item.outcome.summary.includes(inventory))
  const child = await request<ConversationDetail>('/api/conversations/' + second.item.childId)
  assert.equal(child.conversation.accessMode, 'readOnly')
  assert.deepEqual(child.conversation.model, model)
  checks.push('前一单待验收时，独立请求由同一 Bot 直接接手；新会话使用编辑后的指令、模型与只读权限，按指令给出指定尾标')
  await request(route + '/inbox/' + result.id + '/verdict', 'POST', { action: 'accept' })
  report.second = { title: second.item.title, reused: bot.id === second.item.assignee, firstStillPending: true, dependencyCount: 0, effectiveAccess: child.conversation.accessMode, markerVerified: true }

  console.log('验证显式 @ 通用智能体仅建档')
  const namedBot = '古籍校勘记录员'
  const created = await run('请创建一个长期核对古籍版本和刊刻年代的 Bot，名称为「古籍校勘记录员」。本次只在名册建档，不处理实际材料，也不要启动这个新 Bot 的业务。', 'general')
  assert.equal(created.item.assignee, 'general')
  const registered = created.view.agents.find(agent => agent.name === namedBot)
  assert.ok(registered?.config?.origin === 'agent')
  assert.equal(created.message?.createdBotId, registered.id)
  assert.equal(created.view.items.filter(item => item.assignee === registered.id).length, 0)
  assert.equal(created.view.agents.length, second.view.agents.length + 1)
  const provisioning = await request<ConversationDetail>('/api/conversations/' + created.item.childId)
  assert.ok(provisioning.messages.some(message => message.role === 'tool' && message.toolName === 'create_workbench_bot' && !message.isError))
  checks.push('显式 @通用智能体 后通过建档工具创建新 Bot，只产生通用建档工作项，新 Bot 未被派发业务')
  report.explicitCreation = { assignee: created.item.assignee, name: registered.name, origin: registered.config.origin, newBotBusinessRuns: 0 }
  report.result = 'passed'
} catch (error) {
  report.failure = error instanceof Error ? error.message.slice(0, 300) : '验收失败'
  process.exitCode = 1
  console.error(report.failure)
} finally {
  await app.shutdown()
  await runtime.close()
  const directory = join('artifacts', 'workbench-bots')
  await mkdir(directory, { recursive: true })
  await writeFile(join(directory, 'live-bots.json'), JSON.stringify(report, null, 2) + '\n')
  if (process.env.PI_WEB_KEEP_ACCEPTANCE === '1') console.log('验收数据', root)
  else await rm(root, { recursive: true, force: true })
}
