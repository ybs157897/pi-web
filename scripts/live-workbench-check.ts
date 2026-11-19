// 用当前配置的真实模型，经产品 HTTP 路径验证派发、人工裁决、子会话结果和验收归档。
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { createApp } from '../src/server/app.ts'
import { createRuntime } from '../src/server/runtime/index.ts'
import { piWebHome } from '../src/server/state/home.ts'
import type { DecisionMail, DecisionMailSummary } from '../src/shared/decision-inbox.ts'
import type { ConversationDetail } from '../src/shared/types.ts'
import type { WorkbenchView } from '../src/shared/workbench.ts'

const directory = await mkdtemp(join(tmpdir(), 'pi-web-live-workbench-'))
const workspace = join(directory, '导入验收')
await mkdir(workspace)
const marker = 'WB-' + randomUUID().slice(0, 8)
await writeFile(join(workspace, 'sample.txt'), '本批次校验码 ' + marker + '\n')
const options = { dataDir: join(directory, 'data'), workspace, piDir: piWebHome(), mcpConfigPath: join(directory, 'no-mcp.json') }
let runtime = await createRuntime(options)
let app = createApp(runtime)
const workspaceId = runtime.workspaces()[0]!.id
const route = '/api/workbench/' + workspaceId
const report: Record<string, unknown> = { verifiedAt: new Date().toISOString(), result: 'failed' }
let stage = '读取默认模型'
const checks: string[] = []
report.checks = checks

async function api<T>(path: string, payload?: unknown): Promise<T> {
  const res = await app.request('http://localhost' + path, payload === undefined ? {} : {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
  })
  const data = await res.json()
  assert.ok(res.ok, `${stage}: HTTP ${res.status} ${data.code ?? ''} ${data.error ?? ''}`)
  return data as T
}
async function inbox() {
  return api<{ pendingCount: number; mails: DecisionMailSummary[] }>(route + '/inbox')
}
async function until<T>(name: string, read: () => Promise<T | undefined>): Promise<T> {
  stage = name
  console.log(name)
  const deadline = Date.now() + 180_000
  while (Date.now() < deadline) {
    const value = await read()
    if (value !== undefined) return value
    const snapshot = await api<WorkbenchView>(route)
    const failure = snapshot.messages.find(message => message.error)?.error ?? snapshot.items.find(item => item.error)?.error
    if (failure) throw new Error(name + '：' + failure)
    await delay(600)
  }
  const snapshot = await api<WorkbenchView>(route)
  report.timeout = { items: snapshot.items.map(({ status, waitingOn, verification }) => ({ status, waitingOn, verification })), mailKinds: (await inbox()).mails.map(mail => mail.kind) }
  throw new Error(name + '超时')
}

try {
  const model = (await runtime.catalog()).defaultModel
  assert.ok(model && model.provider !== 'demo', '真实默认模型尚未配置')
  report.model = model
  const requestId = randomUUID()
  const input = {
    requestId, mention: 'import', accessMode: 'readOnly', thinkingLevel: 'off', model,
    text: '这是一项单一的只读交付：为本批次记录导入格式和校验码。业务方尚未决定用 CSV 还是 JSON，且明确要求必须由我选择，不能代选。请先把这项真实需求歧义作为选择题发到收件箱，给出 CSV、JSON 两个选项，等我回答后才交付。然后读当前工作目录的 sample.txt，将所选格式和文件内的实际校验码一起写入最终正文，不改文件。',
  }
  let view = await api<WorkbenchView>(route)
  report.parentId = view.main.conversation.id
  stage = '主线提交与重试去重'
  await api(route + '/messages', input)
  await api(route + '/messages', input)
  const question = await until('等待真实模型提出业务歧义', async () => (await inbox()).mails.find(mail => mail.kind === 'choice' && mail.actionable))
  const letter = await api<DecisionMail>(route + '/inbox/' + encodeURIComponent(question.id))
  assert.equal(letter.reason, 'requirement_ambiguity')
  assert.ok(letter.why.trim())
  assert.ok(letter.questions?.length)
  const optionsAnswers = letter.questions.map(question => {
    const label = question.options?.find(option => /JSON/iu.test(option.label))?.label
    assert.ok(label, '未提供 JSON 选择')
    return { id: question.id, selected: [label] }
  })
  view = await api<WorkbenchView>(route)
  assert.equal(view.messages.filter(message => message.requestId === requestId).length, 1)
  const matching = view.items.filter(item => item.requestId === requestId)
  assert.equal(matching.length, 1)
  const item = matching[0]!
  assert.equal(item.assignee, 'import')
  assert.equal(item.childId, letter.link.conversationId)
  assert.ok(item.childId && item.childId !== item.parentId)
  report.workItemId = item.id
  report.childId = item.childId
  checks.push('真实派发、定向接单、重复提交仅产生一个工作项、子会话提出裁决')
  assert.ok(letter.link.interactionId)
  const answerPath = '/api/conversations/' + item.childId + '/interactions/' + encodeURIComponent(letter.link.interactionId) + '/answer'
  stage = '回答并核对原会话和收件箱'
  const replied = await api<ConversationDetail>(answerPath, { answers: optionsAnswers })
  assert.equal(replied.interactions?.find(i => i.id === letter.link.interactionId)?.status, 'answered')
  const settled = await api<DecisionMail>(route + '/inbox/' + encodeURIComponent(question.id))
  assert.equal(settled.actionable, false)
  checks.push('同一 Interaction 的会话和邮件状态同步关闭')
  const result = await until('等待读文件和真实子会话结果', async () => (await inbox()).mails.find(mail => mail.link.workItemId === item.id && mail.kind === 'result' && mail.actionable))
  const resultPath = route + '/inbox/' + encodeURIComponent(result.id)
  const details = await api<DecisionMail>(resultPath)
  assert.ok(details.body?.includes(marker) && /JSON/iu.test(details.body), '结果未包含真实文件校验码和用户选定的格式')
  const child = await api<ConversationDetail>('/api/conversations/' + item.childId)
  const assistantText = child.messages.filter(message => message.role === 'assistant').flatMap(message =>
    message.blocks.flatMap(block => block.type === 'text' ? [block.text] : [])).join('\n')
  assert.ok(assistantText.includes(marker))
  report.delivery = { format: 'JSON', marker, resultMailId: details.id, evidence: details.evidence.map(e => ({ kind: e.kind, status: e.status })) }
  checks.push('子会话交付包含随机文件校验码，结果邮件对应同一工作项')
  stage = '验收归档'
  const accepted = await api<DecisionMail>(resultPath + '/verdict', { action: 'accept' })
  assert.equal(accepted.folder, 'archived')
  assert.equal((await inbox()).pendingCount, 0)
  assert.equal((await api<WorkbenchView>(route)).items.find(i => i.id === item.id)?.status, 'ended')
  checks.push('验收后工作项结束，邮件归档，待处理归零')
  stage = '重启恢复'
  await app.shutdown()
  await runtime.close()
  runtime = await createRuntime(options)
  app = createApp(runtime)
  assert.equal((await api<DecisionMail>(resultPath)).resolution, 'accepted')
  assert.equal((await api<WorkbenchView>(route)).main.conversation.id, item.parentId)
  checks.push('服务重启后保留主线和已验收结果')
  report.result = 'passed'
} catch (cause) {
  const message = (cause instanceof Error ? cause.message : String(cause)).replace(/Bearer\s+\S+|\bsk-\S+/giu, '[redacted]').slice(0, 400)
  report.failure = { stage, message }
  console.error(stage, message)
  process.exitCode = 1
} finally {
  await app.shutdown()
  await runtime.close()
  const artifactDir = join('artifacts', 'agent-workbench')
  await mkdir(artifactDir, { recursive: true })
  await writeFile(join(artifactDir, 'live.json'), JSON.stringify(report, null, 2) + '\n')
  if (process.env.PI_WEB_KEEP_ACCEPTANCE === '1') console.log('验收数据', directory)
  else await rm(directory, { recursive: true, force: true })
}
