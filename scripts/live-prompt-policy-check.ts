import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { createRuntime } from '../src/server/runtime/index.ts'
import { piWebHome } from '../src/server/state/home.ts'
import { writeWetrackAnalysis } from '../src/server/automation/wetrack-analysis.ts'
import type { Runtime } from '../src/server/contracts.ts'
import type { ConversationDetail } from '../src/shared/types.ts'

// Natural-language probes complement deterministic request snapshots. Each run uses temporary
// app data and a temporary workspace; only the final redacted evidence is retained.
const root = await mkdtemp(join(tmpdir(), 'pi-web-live-policy-'))
const workspace = join(root, 'workspace')
const dataDir = join(root, 'data')
const report: Record<string, unknown> = { verifiedAt: new Date().toISOString(), result: 'failed', scenarios: {} }
const scenarios = report.scenarios as Record<string, unknown>
const selected = process.env.PI_WEB_POLICY_SCENARIOS?.split(',').map(item => item.trim()).filter(Boolean)
const textOf = (message: ConversationDetail['messages'][number]) => message.blocks.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
const answerOf = (detail: ConversationDetail) => detail.messages.filter(message => message.role === 'assistant').map(textOf).filter(Boolean).at(-1) ?? ''
const redact = (text: string) => text.replace(/\bBearer\s+\S+/gi, 'Bearer [redacted]').replace(/\b(?:sk|key|token|secret)[-_][A-Za-z0-9._~+/-]{8,}/gi, '[redacted]')
let runtime: Runtime | undefined

async function settled(id: string, previous: number): Promise<ConversationDetail> {
  const deadline = Date.now() + 180_000
  while (Date.now() < deadline) {
    const detail = await runtime!.detail(id)
    if (detail.error) throw new Error(redact(detail.error))
    if (!detail.conversation.busy && detail.messages.slice(previous).some(message => message.role === 'assistant' && !message.streaming)) return detail
    await delay(250)
  }
  await runtime!.stop(id)
  throw new Error('Policy scenario exceeded 180 seconds')
}

async function turn(id: string, text: string): Promise<ConversationDetail> {
  const previous = (await runtime!.detail(id)).messages.length
  await runtime!.submit(id, { text, requestId: randomUUID() })
  return settled(id, previous)
}

async function scenario(name: string, run: () => Promise<unknown>) {
  if (selected && !selected.includes(name)) return
  try {
    const evidence = await run()
    scenarios[name] = { passed: true, evidence }
    console.log(`${name}: passed`)
  } catch (error) {
    scenarios[name] = { passed: false, error: redact(error instanceof Error ? error.message : String(error)) }
    console.log(`${name}: failed`)
  }
}

try {
  await mkdir(workspace)
  await writeFile(join(workspace, 'README.md'), '业务流程入口：service.ts\n')
  await writeFile(join(workspace, 'evidence.txt'), 'POLICY_CHILD_EVIDENCE_20261104\n')
  runtime = await createRuntime({ dataDir, workspace, piDir: piWebHome(), mcpConfigPath: join(root, 'no-mcp.json') })
  const catalog = await runtime.catalog()
  assert.ok(catalog.defaultModel && /deepseek/i.test(catalog.defaultModel.modelId), 'An explicitly configured DeepSeek model is required')
  const model = catalog.defaultModel
  report.model = model
  const create = async (title: string) => (await runtime!.create({ title, model, accessMode: 'readOnly' })).conversation.id
  await runtime.updateSettings({ codemodeMode: 'off' })

  await scenario('ordinary-flow-does-not-load-statechart', async () => {
    const detail = await turn(await create('Ordinary flow lookup'), '只读查询：读取 README.md，告诉我“业务流程入口”那一行是什么。只返回该行，不做设计或修改。')
    assert.ok(answerOf(detail).includes('service.ts'))
    assert.ok(!JSON.stringify(detail.messages.filter(message => message.role === 'tool')).includes('# Statechart'))
    assert.ok(!detail.interactions?.some(item => item.status === 'pending'))
    return { answer: answerOf(detail), tools: detail.messages.filter(message => message.role === 'tool').map(message => message.toolName) }
  })

  await scenario('explicit-statechart-no-repeat-approval', async () => {
    const detail = await turn(await create('Explicit statechart review'), '请用 statechart 技能，只读检查这个状态机，列出完整状态×事件矩阵：状态 Closed/Open，事件 open/close；Closed+open→Open，Open+close→Closed，其余重复事件保持不变。这些语义已经确定，无须再批准。不要修改文件。')
    assert.ok(JSON.stringify(detail.messages.filter(message => message.role === 'tool')).includes('# Statechart'), 'statechart was not loaded')
    assert.ok(!detail.interactions?.some(item => item.status === 'pending'), 'a settled policy was unnecessarily asked again')
    assert.ok(answerOf(detail).includes('Closed') && answerOf(detail).includes('Open'))
    return { answer: answerOf(detail).slice(-1_500) }
  })

  for (const mode of ['off', 'only'] as const) {
    await runtime.updateSettings({ codemodeMode: mode })
    await scenario(`child-result-${mode}`, async () => {
      const id = await create(`Delegated read ${mode}`)
      const detail = await turn(id, '使用 subagent 委派一个 Explore 子智能体读取 evidence.txt，任务只需返回文件中的验证标记。主会话转述标记。不使用团队、不创建计划、不提问、不修改文件。')
      const children = await runtime!.children(id)
      assert.equal(children.length, 1)
      const child = await runtime!.detail(children[0]!.id)
      assert.ok(answerOf(child).includes('POLICY_CHILD_EVIDENCE_20261104'))
      assert.ok(answerOf(detail).includes('POLICY_CHILD_EVIDENCE_20261104'))
      assert.ok(!child.interactions?.some(item => item.status === 'pending'))
      assert.equal((await runtime!.children(children[0]!.id)).length, 0)
      return { childAnswer: answerOf(child), parentAnswer: answerOf(detail) }
    })
  }

  await runtime.updateSettings({ codemodeMode: 'off' })
  await scenario('read-only-approved-plan-stays-read-only', async () => {
    const id = await create('Read-only plan approval')
    await runtime!.setPlan(id, true)
    const planned = await turn(id, '为修改 README.md 中入口路径为 app.ts 提交一个简短实施计划。当前只做计划，通过 exit_plan_mode 提交，不改文件。')
    const review = planned.interactions?.find(item => item.kind === 'plan-review' && item.status === 'pending')
    assert.ok(review, 'plan was not submitted')
    const previous = planned.messages.length
    await runtime!.answerInteraction(id, review.id, [{ id: 'plan-review', selected: ['同意执行'] }])
    const approved = await settled(id, previous)
    assert.equal(approved.conversation.accessMode, 'readOnly')
    assert.equal(approved.plan?.active, false)
    assert.equal(await readFile(join(workspace, 'README.md'), 'utf8'), '业务流程入口：service.ts\n')
    assert.match(answerOf(approved), /只读|权限/u)
    return { answer: answerOf(approved) }
  })

  await scenario('blocked-attempt-preserves-conclusion', async () => {
    const defectNumber = 'DTS000009999'
    await writeWetrackAnalysis(dataDir, { defectNumber, status: 'analyzed', markdown: 'PREVIOUS_VERIFIED_CONCLUSION' }, { expectedRevision: 0 })
    const detail = await turn(await create('Blocked analysis attempt'), `本地存储回归：缺陷 ${defectNumber} 这一轮检索预算已经耗尽，未能形成新结论。不要访问远端或再搜索。请先读取已有分析记录，然后使用宿主分析保存工具记录一次 blocked、blockedReason=budget-exhausted 的尝试，写明本次未定论，保留已有可靠结论。`)
    const record = await runtime!.wetrackAnalysis(defectNumber)
    assert.equal(record?.status, 'analyzed')
    assert.equal(record?.markdown, 'PREVIOUS_VERIFIED_CONCLUSION')
    assert.equal(record?.latestAttempt?.status, 'blocked')
    assert.equal(record?.latestAttempt?.blockedReason, 'budget-exhausted')
    return { answer: answerOf(detail), status: record.status, attempt: record.latestAttempt.status }
  })
  assert.ok(Object.keys(scenarios).length > 0, 'No matching policy scenarios')
  report.result = Object.values(scenarios).every(item => (item as { passed: boolean }).passed) ? 'passed' : 'failed'
} catch (error) {
  report.error = redact(error instanceof Error ? error.message : String(error))
} finally {
  await runtime?.close()
  await mkdir('artifacts', { recursive: true })
  await writeFile('artifacts/live-prompt-policy-check.json', `${JSON.stringify(report, null, 2)}\n`)
  await rm(root, { recursive: true, force: true })
  console.log(JSON.stringify(report, null, 2))
  if (report.result !== 'passed') process.exitCode = 1
}
