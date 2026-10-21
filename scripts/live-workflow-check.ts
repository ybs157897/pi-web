import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createHash, randomUUID } from 'node:crypto'
import { cp, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { createRuntime } from '../src/server/runtime.ts'
import { piWebHome } from '../src/server/home.ts'
import type { Runtime } from '../src/server/contracts.ts'
import type { ConversationDetail } from '../src/shared/types.ts'
import { WORKFLOW_MUTANTS, WORKFLOW_ORACLE, WORKFLOW_PROMPT, prepareWorkflowFixture, workflowMutantSource } from './workflow-fixture.ts'

const SHELL_TOOL = process.platform === 'win32' ? 'pwsh' : 'bash'
const execute = promisify(execFile)
const directory = await mkdtemp(join(tmpdir(), 'pi-web-live-workflow-'))
const workspace = join(directory, 'workspace')
const mode = process.env.PI_WEB_WORKFLOW_MODE ?? 'on'
assert.ok(mode === 'on' || mode === 'only' || mode === 'off', 'PI_WEB_WORKFLOW_MODE must be on, only or off')
const evidence: Record<string, unknown> = {
  result: 'failed', verifiedAt: new Date().toISOString(), codemodeMode: mode,
  prompt: WORKFLOW_PROMPT, promptHash: createHash('sha256').update(WORKFLOW_PROMPT).digest('hex'),
}
const textOf = (message: ConversationDetail['messages'][number]) => message.blocks.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
const redact = (text: string) => text.replace(/\bBearer\s+\S+/gi, 'Bearer [redacted]').replace(/\b(?:sk|key|token|secret)[-_][A-Za-z0-9._~+/-]{8,}/gi, '[redacted]')
let runtime: Runtime | undefined

function toolTrace(detail: ConversationDetail): Array<{ name: string; success: boolean; route: 'direct' | 'codemode'; error?: string }> {
  return detail.messages.flatMap(message => {
    if (message.role !== 'tool') return []
    const direct = {
      name: message.toolName ?? '', success: !message.isError, route: 'direct' as const,
      ...(message.isError ? { error: redact(textOf(message)).slice(0, 2_000) } : {}),
    }
    if (message.toolName !== 'codemode' || !message.details || typeof message.details !== 'object') return [direct]
    const calls = (message.details as { calls?: unknown }).calls
    return [direct, ...(Array.isArray(calls) ? calls.flatMap(call => {
      if (!call || typeof call !== 'object' || typeof call.name !== 'string') return []
      return [{
        name: call.name, success: call.status === 'ok', route: 'codemode' as const,
        ...(typeof call.error === 'string' ? { error: redact(call.error).slice(0, 2_000) } : {}),
      }]
    }) : [])]
  })
}

async function verifyGeneratedTests(): Promise<void> {
  const test = await execute(process.execPath, ['--test', '--test-reporter=tap'], { cwd: workspace, timeout: 30_000, maxBuffer: 512_000 })
  const count = Number(/^# tests (\d+)$/m.exec(test.stdout)?.[1] ?? 0)
  assert.ok(count > 0, 'The generated test command executed no tests')
  evidence.tests = test.stdout.slice(-8_000)
  const killed: string[] = []
  for (const [name, body] of Object.entries(WORKFLOW_MUTANTS)) {
    const mutant = join(directory, `mutant-${name}`)
    await cp(workspace, mutant, { recursive: true })
    await cp(join(mutant, 'calculator.mjs'), join(mutant, 'workflow-original.mjs'))
    await writeFile(join(mutant, 'calculator.mjs'), `${workflowMutantSource(body)}\n`)
    try {
      await execute(process.execPath, ['--test', '--test-reporter=tap'], { cwd: mutant, timeout: 30_000, maxBuffer: 512_000 })
      assert.fail(`Generated tests do not detect ${name}`)
    } catch (error) {
      // A timeout or runner failure is not evidence that an assertion caught the defect.
      const failure = error as { code?: unknown; stdout?: string }
      assert.equal(failure.code, 1, `Expected a test assertion failure for ${name}`)
      assert.match(failure.stdout ?? '', /^not ok \d+/m, `No failing test was reported for ${name}`)
      killed.push(name)
    }
  }
  evidence.testDefectsDetected = killed
}

async function run(id: string, text: string): Promise<ConversationDetail> {
  const previous = (await runtime!.detail(id)).messages.length
  await runtime!.submit(id, { text, requestId: randomUUID() })
  const deadline = Date.now() + 240_000
  let latest: ConversationDetail | undefined
  let observedTools = 0
  while (Date.now() < deadline) {
    const detail = await runtime!.detail(id)
    latest = detail
    const trace = toolTrace(detail)
    if (trace.length !== observedTools) {
      observedTools = trace.length
      console.log(`Workflow ${mode}: ${observedTools} tool results; latest ${trace.at(-1)?.name ?? 'none'}`)
    }
    if (detail.error) throw new Error(redact(detail.error))
    if (!detail.conversation.busy && detail.messages.slice(previous).some(message => message.role === 'assistant' && !message.streaming)) return detail
    await delay(200)
  }
  await runtime!.stop(id)
  if (latest) evidence.timeoutSnapshot = {
    tools: toolTrace(latest), goal: latest.goal,
    messages: latest.messages.filter(message => message.role === 'assistant').map(textOf).filter(Boolean).map(text => redact(text).slice(-4_000)),
  }
  throw new Error('Workflow turn exceeded 240 seconds')
}

try {
  await prepareWorkflowFixture(workspace)
  await writeFile(join(workspace, 'AGENTS.md'), 'README.md 必须包含二级标题“本地校验”，并在该节说明实际运行的 Node 测试命令。\n')
  runtime = await createRuntime({ dataDir: join(directory, 'data'), workspace, piDir: piWebHome(), mcpConfigPath: join(directory, 'no-mcp.json') })
  const catalog = await runtime.catalog()
  assert.ok(catalog.defaultModel, 'Configure the intended DeepSeek model first')
  assert.match(catalog.defaultModel.modelId, /deepseek/i, 'Acceptance requires an explicitly selected DeepSeek model; no model was changed')
  evidence.model = catalog.defaultModel
  await runtime.updateSettings({ codemodeMode: mode })
  const accessMode = runtime.capabilities().accessModes.includes('workspaceWrite') ? 'workspaceWrite' : 'fullAccess'
  const planning = await runtime.create({ title: 'Read-only planning acceptance', model: catalog.defaultModel, accessMode })
  await runtime.setPlan(planning.conversation.id, true)
  const before = await readFile(join(workspace, 'calculator.mjs'), 'utf8')
  const planned = await run(planning.conversation.id, '分析当前发票计算项目，给出修复 quantity 计算与补充测试的具体计划。先完成只读调查，再提交计划，不实施。')
  const planningTrace = toolTrace(planned)
  assert.ok(planningTrace.some(call => ['read', 'search_files'].includes(call.name) && call.success), 'The plan lacked source inspection')
  assert.ok(planningTrace.some(call => call.name === 'exit_plan_mode' && call.success), 'The model did not submit its plan for review')
  assert.equal(planned.plan?.active, true, 'The model left Plan without a user decision')
  assert.ok(!planningTrace.some(call => ['write', 'edit', SHELL_TOOL, 'skill_save', 'create_goal'].includes(call.name) && call.success), 'Plan performed an implementation action')
  assert.equal(await readFile(join(workspace, 'calculator.mjs'), 'utf8'), before)
  assert.deepEqual((await readdir(workspace)).sort(), ['AGENTS.md', 'calculator.mjs', 'invoice.json'])
  evidence.plan = { result: 'passed', trace: planningTrace, active: planned.plan?.active }
  const conversation = await runtime.create({ title: 'Default workflow acceptance', model: catalog.defaultModel, accessMode })
  const result = await run(conversation.conversation.id, WORKFLOW_PROMPT)
  const tools = toolTrace(result)
  evidence.tools = tools
  evidence.todos = result.todos
  evidence.goal = result.goal
  const assistants = result.messages.filter(message => message.role === 'assistant')
  evidence.progress = assistants.slice(0, -1).map(textOf).filter(Boolean)
  evidence.final = assistants.at(-1) ? textOf(assistants.at(-1)!) : ''
  assert.ok(tools.filter(call => call.name === 'todo_write' && call.success).length >= 2, 'The model did not create and update its task list')
  assert.ok(result.todos?.length && result.todos.every(item => item.status === 'completed'), 'The task list was not completed')
  assert.ok((evidence.progress as string[]).length > 0, 'No intermediate progress message was observed')
  assert.ok(tools.some(call => call.name === SHELL_TOOL && call.success), 'The model did not run its verification')
  const readme = await readFile(join(workspace, 'README.md'), 'utf8')
  assert.match(readme, /^## 本地校验\s*$/m, 'The workspace AGENTS.md instruction was not followed')
  const files = await readdir(workspace)
  assert.ok(files.some(name => /(?:test|spec)\.(?:mjs|cjs|js)$/.test(name)) || files.includes('test') || files.includes('tests'), 'No runnable test artifact was created')
  const artifactDirectory = join('artifacts', `live-workflow-${mode}-${Date.now()}`)
  await mkdir(artifactDirectory, { recursive: true })
  await cp(workspace, artifactDirectory, { recursive: true })
  evidence.generatedWorkspace = artifactDirectory
  await verifyGeneratedTests()
  const oracle = await execute(process.execPath, ['--input-type=module', '-e', WORKFLOW_ORACLE], { cwd: workspace, timeout: 10_000 })
  evidence.oracle = oracle.stdout.trim()
  assert.ok(!result.goal || result.goal.phase === 'complete', 'The model left its goal unfinished')

  const simple = await runtime.create({ title: 'Simple task acceptance', model: catalog.defaultModel, accessMode: 'readOnly' })
  const simpleResult = await run(simple.conversation.id, '17 乘 23 是多少？')
  assert.ok(!toolTrace(simpleResult).some(call => ['todo_write', 'create_goal'].includes(call.name)), 'A trivial question triggered formal planning')
  assert.ok(simpleResult.messages.some(message => message.role === 'assistant' && textOf(message).includes('391')))
  evidence.simpleTask = 'passed without formal planning'
  evidence.result = 'passed'
} catch (error) {
  evidence.error = redact(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
} finally {
  await runtime?.close()
  await mkdir('artifacts', { recursive: true })
  if (!evidence.generatedWorkspace) {
    const artifactDirectory = join('artifacts', `live-workflow-${mode}-${Date.now()}`)
    await mkdir(artifactDirectory, { recursive: true })
    await cp(workspace, artifactDirectory, { recursive: true }).catch(() => undefined)
    evidence.generatedWorkspace = artifactDirectory
  }
  const report = mode === 'on' ? 'artifacts/live-workflow-check.json' : `artifacts/live-workflow-check-${mode}.json`
  await writeFile(report, JSON.stringify(evidence, null, 2) + '\n')
  console.log(JSON.stringify(evidence, null, 2))
  await rm(directory, { recursive: true, force: true })
}
