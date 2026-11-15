/**
 * 工作流编排能力的真实模型验收（DeepSeek），覆盖四个场景：
 * 1) 只读计划——计划模式下只调查并提交计划，不得实施；
 * 2) 默认工作流——按 WORKFLOW_PROMPT 修复缺陷，创建/完成待办，跑自己的测试，产出含「本地校验」的 README；
 * 3) 生成测试的变异判定——用三个 mutant 验证生成的测试真的能抓住缺陷，再用独立 oracle 复核实现；
 * 4) 简单问答——普通算术题不应触发正式规划（待办/目标）。
 * 环境变量 PI_WEB_WORKFLOW_MODE 控制 codemode 模式（on/only/off，默认 on）。
 * 证据写入 artifacts/live-workflow-check[-mode].json；失败条件为上述任一断言不满足。
 */
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createHash, randomUUID } from 'node:crypto'
import { cp, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { createRuntime } from '../src/server/runtime/index.ts'
import { piWebHome } from '../src/server/state/home.ts'
import type { Runtime } from '../src/server/contracts.ts'
import type { ConversationDetail } from '../src/shared/types.ts'
import { WORKFLOW_MUTANTS, WORKFLOW_ORACLE, WORKFLOW_PROMPT, prepareWorkflowFixture, workflowMutantSource } from './workflow-fixture.ts'

const SHELL_TOOL = process.platform === 'win32' ? 'pwsh' : 'bash'
const execute = promisify(execFile)
const directory = await mkdtemp(join(tmpdir(), 'pi-web-live-workflow-'))
const workspace = join(directory, 'workspace')
// codemode 模式作为本验收的自变量：on/only/off 三种合法取值。
const mode = process.env.PI_WEB_WORKFLOW_MODE ?? 'on'
assert.ok(mode === 'on' || mode === 'only' || mode === 'off', 'PI_WEB_WORKFLOW_MODE must be on, only or off')
// 证据对象记录提示词与其哈希，保证同一轮结果可复现对照。
const evidence: Record<string, unknown> = {
  result: 'failed', verifiedAt: new Date().toISOString(), codemodeMode: mode,
  prompt: WORKFLOW_PROMPT, promptHash: createHash('sha256').update(WORKFLOW_PROMPT).digest('hex'),
}
const textOf = (message: ConversationDetail['messages'][number]) => message.blocks.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
const redact = (text: string) => text.replace(/\bBearer\s+\S+/gi, 'Bearer [redacted]').replace(/\b(?:sk|key|token|secret)[-_][A-Za-z0-9._~+/-]{8,}/gi, '[redacted]')
let runtime: Runtime | undefined

/**
 * 功能：把会话消息展开成扁平的工具调用轨迹，供断言与证据使用。
 * @param detail 会话详情。
 * @returns 轨迹数组，每项含工具名、是否成功、路由（direct=直接调用 / codemode=脚本内嵌套调用）、脱敏错误（可选）。
 * 内部逻辑：tool 消息直接映射为 direct 条目；codemode 消息再从 details.calls 展开出 route=codemode 的嵌套调用，
 * 非 codemode 或缺 details 的消息只保留 direct 条目；错误文本经 redact 后截断到 2000 字符。
 */
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

/**
 * 功能：变异判定——验证模型生成的测试对缺陷真正敏感。
 * @returns 无返回值；通过即代表生成测试运行数 > 0 且杀掉全部 WORKFLOW_MUTANTS。
 * @throws 任一 mutant 未被断言级失败杀掉、或生成测试一条都没跑，则断言失败。
 * 内部逻辑：先在工作区实际运行生成的测试（node --test，TAP 报告）确认有测试且通过；
 * 再逐个 mutant：复制工作区、把原实现改名保存、注入变异体源码，要求测试以退出码 1 且出现
 * `not ok` 断言失败的方式倒掉——超时或 runner 崩溃不算杀掉（见分支注释）。
 */
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

/**
 * 功能：提交一条消息并等待该轮结束；期间实时打印工具调用进度，超时则停止会话并把现场快照写入证据。
 * @param id 会话 id。
 * @param text 提交给模型的消息文本。
 * @returns 结束后的会话详情。
 * @throws 240 秒内未结束抛错（错误消息已脱敏）；detail.error 也会抛出。
 * 内部逻辑：以提交前的消息数为基线，只认基线之后新出现的完整 assistant 消息；
 * 轨迹长度变化时打印进度行；超时路径先 stop 再把 toolTrace/goal/assistant 尾部文本存入
 * evidence.timeoutSnapshot 供事后排查。
 */
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
  // 场景 1（只读计划）：准备 fixture 与工作区 AGENTS.md 约束（README 需含「本地校验」节），
  // 起 runtime 并把 codemode 设为当前 mode，在计划模式会话里只要求调查与提交计划。
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
  // 场景 1 判分：要有成功的源码调查与 exit_plan_mode 提交、计划保持 active、
  // 全程没有实施类工具成功调用，且工作区文件与文件清单零变化。
  const planningTrace = toolTrace(planned)
  assert.ok(planningTrace.some(call => ['read', 'search_files'].includes(call.name) && call.success), 'The plan lacked source inspection')
  assert.ok(planningTrace.some(call => call.name === 'exit_plan_mode' && call.success), 'The model did not submit its plan for review')
  assert.equal(planned.plan?.active, true, 'The model left Plan without a user decision')
  assert.ok(!planningTrace.some(call => ['write', 'edit', SHELL_TOOL, 'skill_save', 'create_goal'].includes(call.name) && call.success), 'Plan performed an implementation action')
  assert.equal(await readFile(join(workspace, 'calculator.mjs'), 'utf8'), before)
  assert.deepEqual((await readdir(workspace)).sort(), ['AGENTS.md', 'calculator.mjs', 'invoice.json'])
  evidence.plan = { result: 'passed', trace: planningTrace, active: planned.plan?.active }
  // 场景 2（默认工作流）：全新会话执行 WORKFLOW_PROMPT 全流程任务。
  const conversation = await runtime.create({ title: 'Default workflow acceptance', model: catalog.defaultModel, accessMode })
  const result = await run(conversation.conversation.id, WORKFLOW_PROMPT)
  const tools = toolTrace(result)
  evidence.tools = tools
  evidence.todos = result.todos
  evidence.goal = result.goal
  const assistants = result.messages.filter(message => message.role === 'assistant')
  // 场景 2 判分：至少两次待办写入且全部完成、有中间进度消息、实际跑了 shell 验证、
  // README 遵守 AGENTS.md 约束、且产出了可运行的测试工件。
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
  // 场景 3：变异判定 + 独立 oracle 复核（oracle 与生成测试彼此独立，双保险确认实现正确）。
  await verifyGeneratedTests()
  const oracle = await execute(process.execPath, ['--input-type=module', '-e', WORKFLOW_ORACLE], { cwd: workspace, timeout: 10_000 })
  evidence.oracle = oracle.stdout.trim()
  assert.ok(!result.goal || result.goal.phase === 'complete', 'The model left its goal unfinished')

  // 场景 4（简单任务）：readOnly 会话问一道算术题，不应触发正式规划，回答要含正确乘积。
  const simple = await runtime.create({ title: 'Simple task acceptance', model: catalog.defaultModel, accessMode: 'readOnly' })
  const simpleResult = await run(simple.conversation.id, '17 乘 23 是多少？')
  assert.ok(!toolTrace(simpleResult).some(call => ['todo_write', 'create_goal'].includes(call.name)), 'A trivial question triggered formal planning')
  assert.ok(simpleResult.messages.some(message => message.role === 'assistant' && textOf(message).includes('391')))
  evidence.simpleTask = 'passed without formal planning'
  evidence.result = 'passed'
} catch (error) {
  // 任一场景失败：脱敏记录错误并以非零码退出；finally 中仍把现场工作区落盘为证据。
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
