// 使用真实默认模型验证自动派发、结果返修、依赖解锁及真实程序验证。
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { promisify } from 'node:util'
import { createApp } from '../src/server/app.ts'
import { createRuntime } from '../src/server/runtime/index.ts'
import { piWebHome } from '../src/server/state/home.ts'
import type { DecisionMail, DecisionMailSummary } from '../src/shared/decision-inbox.ts'
import type { ConversationDetail } from '../src/shared/types.ts'
import type { WorkbenchView, WorkItem } from '../src/shared/workbench.ts'

const exec = promisify(execFile)
const isolated = await realpath(await mkdtemp(join(tmpdir(), 'pi-web-workbench-dependencies-')))
const workspace = join(isolated, 'fixture')
await mkdir(workspace)
const marker = `WORKBENCH-${randomUUID().slice(0, 8)}`
const initial = `${marker}-v1`
const revised = `${marker}-v2`
const checks: string[] = []
const report: Record<string, unknown> = { verifiedAt: new Date().toISOString(), result: 'failed', checks }
let stage = '读取真实模型'
let runtime: Awaited<ReturnType<typeof createRuntime>> | undefined
let app: ReturnType<typeof createApp> | undefined
let route: string

async function request<T>(path: string, payload?: unknown): Promise<T> {
  const response = await app!.request(`http://localhost${path}`, payload === undefined ? {} : {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
  })
  const body = await response.json()
  assert.ok(response.ok, `HTTP ${response.status} ${body.code ?? ''} ${body.error ?? ''}`)
  return body as T
}

async function snapshot(): Promise<WorkbenchView> {
  return request<WorkbenchView>(route)
}

async function resultFor(itemId: string): Promise<DecisionMailSummary | undefined> {
  const { mails } = await request<{ mails: DecisionMailSummary[] }>(`${route}/inbox`)
  return mails.find(mail => mail.kind === 'result' && mail.actionable && mail.link.workItemId === itemId)
}

async function until<T>(name: string, condition: (view: WorkbenchView) => Promise<T | undefined>): Promise<T> {
  stage = name
  console.log(name)
  const deadline = Date.now() + 150_000
  while (Date.now() < deadline) {
    const view = await snapshot()
    const error = view.messages.find(message => message.error)?.error ?? view.items.find(item => item.error)?.error
    if (error) throw new Error(error)
    const value = await condition(view)
    if (value !== undefined) return value
    await delay(750)
  }
  const view = await snapshot()
  report.timeout = {
    tasks: view.items.map(({ title, status, waitingOn, dependencies, verification }) => ({ title, status, waitingOn, dependencies, verification })),
  }
  throw new Error(`超过 ${150} 秒`)
}

function verifyBlocked(original: WorkItem, dependent: WorkItem) {
  assert.deepEqual(dependent.dependencies, [original.id])
  assert.equal(dependent.waitingOn.kind, 'dependencies')
  assert.equal(dependent.childId, undefined)
}

async function verifyProgram(expected: string, item: WorkItem, result: DecisionMailSummary) {
  assert.equal((await readFile(join(workspace, 'fixture.txt'), 'utf8')).trim(), expected)
  const { stdout } = await exec(process.execPath, ['--test', '--test-reporter=tap', 'fixture.test.mjs'], { cwd: workspace, timeout: 8_000 })
  assert.match(stdout, /# pass 1\b/u)
  const letter = await request<DecisionMail>(`${route}/inbox/${result.id}`)
  const child = await request<ConversationDetail>(`/api/conversations/${item.childId}`)
  const tools = child.messages
    .filter(message => message.role === 'tool' && ['bash', 'pwsh', 'codemode', 'shell_session'].includes(message.toolName ?? ''))
    .map(message => ({ name: message.toolName, error: message.isError, text: message.blocks
      .flatMap(block => block.type === 'text' ? [block.text] : []).join('\n').replaceAll(workspace, '<workspace>').slice(0, 240) }))
  report.lastCheck = { attempt: item.attempt, evidence: letter.evidence.map(({ kind, status, label }) => ({
    kind, status, label: label.replaceAll(workspace, '<workspace>'),
  })), tools }
  assert.match(letter.body ?? '', new RegExp(expected, 'u'))
  assert.ok(letter.evidence.some(evidence => evidence.kind === 'validation' && evidence.status === 'passed'
    && /node\s+--test\b[^\n]*fixture\.test\.mjs/u.test(evidence.label)), '邮件中缺少 Node 测试通过的实际工具证据')
  assert.equal(item.verification, 'recorded')
  return letter.evidence
}

try {
  runtime = await createRuntime({
    dataDir: join(isolated, 'state'), workspace, piDir: piWebHome(), mcpConfigPath: join(isolated, 'no-mcp.json'),
  })
  app = createApp(runtime)
  route = `/api/workbench/${runtime.workspaces()[0]!.id}`
  const model = (await runtime.catalog()).defaultModel
  assert.ok(model && model.provider !== 'demo', '未配置真实默认模型')
  report.model = model

  stage = '提交有显式依赖的两个工作项'
  await request(`${route}/messages`, {
    requestId: randomUUID(), model, accessMode: 'fullAccess', thinkingLevel: 'off',
    text: [
      '请明确拆成两个独立工作项，各有自己的子会话和结果。按职责自行选择执行智能体。',
      `A「编写并验证导入夹具」：在项目根目录创建 fixture.txt（独占一行 ${initial}，末尾有换行）和 fixture.test.mjs（只包含一个 node:test，用 assert.equal 验证读取的 fixture.txt 去掉首尾空白后等于 ${initial}）。用独立 shell 工具调用执行 node --test fixture.test.mjs，设置 workdir 为项目根目录，命令内不另用 cd 或拼接其他命令。在结果正文写出夹具值和测试结果。只改这两个文件。`,
      'B「分析验收后的夹具」：本工作项必须依赖 A 的人工验收，验收前不得派发。解除依赖后，用 read 工具读取项目根目录实际的 fixture.txt，原样报告读到的整行夹具值。不要改文件，不创建其他任务。',
      '两个工作项分别提交结果待我验收。第一个工作项无需咨询即可执行，第二个不能自行提前运行。',
    ].join('\n'),
  })
  const initialWork = await until('核对真实规划的工作项和依赖', async view => view.items.length ? view.items : undefined)
  report.plan = initialWork.map(({ id, title, type, assignee, waitingOn, dependencies }) => ({ id, title, type, assignee, waitingOn, dependencies }))
  assert.equal(initialWork.length, 2)
  const dependent = initialWork.find(item => item.dependencies.length > 0)
  assert.ok(dependent)
  const original = initialWork.find(item => item.id === dependent.dependencies[0])
  assert.ok(original)
  verifyBlocked(original, dependent)
  checks.push('使用真实模型自动派发，无 @ 指定，两个工作项带正确依赖')

  const first = await until('等待 A 的首次可核验交付', async view => {
    const a = view.items.find(item => item.id === original.id)!
    verifyBlocked(a, view.items.find(item => item.id === dependent.id)!)
    const result = await resultFor(a.id)
    return a.status === 'pending_review' && result ? { a, result } : undefined
  })
  await verifyProgram(initial, first.a, first.result)
  checks.push('A 首次生成文件，实际 Node 单测通过，结果邮件包含程序证据，B 未派发')

  stage = '退回 A 并核对旧邮件归档'
  const old = await request<DecisionMail>(`${route}/inbox/${first.result.id}/verdict`, {
    action: 'revise',
    feedback: `真实验收反馈：请把 fixture.txt 和 fixture.test.mjs 的目标值改为 ${revised}。在原项目根目录用独立的 shell 工具调用重新执行 node --test fixture.test.mjs。设置 workdir，命令内不拼接 cd。只改这两个文件，结果正文写出修订后的实际值及测试结果。`,
  })
  assert.equal(old.folder, 'archived')
  assert.equal(old.resolution, 'revise')
  const second = await until('等待同一子会话完成返修，下游继续等待', async view => {
    const a = view.items.find(item => item.id === original.id)!
    verifyBlocked(a, view.items.find(item => item.id === dependent.id)!)
    const result = await resultFor(a.id)
    return a.attempt === 2 && a.status === 'pending_review' && result ? { a, result } : undefined
  })
  assert.equal(second.a.childId, first.a.childId)
  assert.notEqual(second.result.id, first.result.id)
  const evidence = await verifyProgram(revised, second.a, second.result)
  const archived = await request<DecisionMail>(`${route}/inbox/${first.result.id}`)
  assert.equal(archived.resolution, 'revise')
  assert.match(archived.body ?? '', new RegExp(initial, 'u'))
  checks.push('返修复用 A 的子会话，保留原始邮件，重新对真实修订文件执行并记录测试')

  stage = '验收 A 第二次交付'
  const passed = await request<DecisionMail>(`${route}/inbox/${second.result.id}/verdict`, { action: 'accept' })
  assert.equal(passed.resolution, 'accepted')
  const downstream = await until('验证 A 验收后 B 解除依赖并读取修订成果', async view => {
    const b = view.items.find(item => item.id === dependent.id)!
    const result = await resultFor(b.id)
    return b.status === 'pending_review' && result ? { b, result } : undefined
  })
  const letter = await request<DecisionMail>(`${route}/inbox/${downstream.result.id}`)
  assert.match(letter.body ?? '', new RegExp(revised, 'u'))
  const [a, b] = await Promise.all([first.a.childId, downstream.b.childId].map(id => {
    assert.ok(id)
    return request<ConversationDetail>(`/api/conversations/${id}`)
  }))
  assert.ok(a && b)
  assert.notEqual(a.conversation.id, b.conversation.id)
  assert.notEqual(a.conversation.cwd, b.conversation.cwd)
  assert.notEqual(a.conversation.cwd, workspace)
  assert.notEqual(b.conversation.cwd, workspace)
  assert.ok(b.messages.some(message => message.role === 'tool' && message.toolName === 'read'
    && message.blocks.some(block => block.type === 'text' && block.text.includes(revised))), 'B 未用 read 工具读取修订后的实际文件')
  checks.push('仅 A 验收后启动 B，两子会话的运行目录各自独立，B 通过 read 工具看到真实 v2 文件')

  stage = '完成 B 的验收'
  await request(`${route}/inbox/${downstream.result.id}/verdict`, { action: 'accept' })
  const final = await snapshot()
  assert.ok(final.items.every(item => item.status === 'ended' && item.outcome?.decision === 'accepted'))
  const { pendingCount } = await request<{ pendingCount: number }>(`${route}/inbox`)
  assert.equal(pendingCount, 0)
  checks.push('A、B 结果都已验收，收件箱无待处理')
  report.delivery = {
    original: { workItemId: original.id, childId: first.a.childId, attempts: 2 },
    dependent: { workItemId: dependent.id, childId: downstream.b.childId, content: revised },
    evidence: evidence.map(({ kind, status }) => ({ kind, status })),
  }
  report.result = 'passed'
} catch (cause) {
  const message = (cause instanceof Error ? cause.message : String(cause))
    .replace(/Bearer\s+\S+|\bsk-\S+/giu, '[redacted]').slice(0, 800)
  report.failure = { stage, message }
  console.error(stage, message)
  process.exitCode = 1
} finally {
  await app?.shutdown()
  await runtime?.close()
  const artifacts = join('artifacts', 'agent-workbench')
  await mkdir(artifacts, { recursive: true })
  await writeFile(join(artifacts, 'live-dependencies.json'), JSON.stringify(report, null, 2) + '\n')
  await rm(isolated, { recursive: true, force: true })
}
