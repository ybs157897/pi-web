import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { createRuntime } from '../src/server/runtime.ts'
import { piWebHome } from '../src/server/home.ts'
import type { Runtime } from '../src/server/contracts.ts'
import type { ConversationDetail } from '../src/shared/types.ts'
import { WORKFLOW_ORACLE, WORKFLOW_PROMPT, prepareWorkflowFixture } from './workflow-fixture.ts'

const execute = promisify(execFile)
const directory = await mkdtemp(join(tmpdir(), 'pi-web-live-workflow-'))
const workspace = join(directory, 'workspace')
const evidence: Record<string, unknown> = {
  result: 'failed', verifiedAt: new Date().toISOString(),
  prompt: WORKFLOW_PROMPT, promptHash: createHash('sha256').update(WORKFLOW_PROMPT).digest('hex'),
}
const textOf = (message: ConversationDetail['messages'][number]) => message.blocks.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
const redact = (text: string) => text.replace(/\bBearer\s+\S+/gi, 'Bearer [redacted]').replace(/\b(?:sk|key|token|secret)[-_][A-Za-z0-9._~+/-]{8,}/gi, '[redacted]')
let runtime: Runtime | undefined

async function run(id: string, text: string): Promise<ConversationDetail> {
  await runtime!.submit(id, { text, requestId: randomUUID() })
  const deadline = Date.now() + 240_000
  while (Date.now() < deadline) {
    const detail = await runtime!.detail(id)
    if (detail.error) throw new Error(redact(detail.error))
    if (!detail.conversation.busy && detail.messages.some(message => message.role === 'assistant' && !message.streaming)) return detail
    await delay(200)
  }
  await runtime!.stop(id)
  throw new Error('Workflow turn exceeded 240 seconds')
}

try {
  await prepareWorkflowFixture(workspace)
  runtime = await createRuntime({ dataDir: join(directory, 'data'), workspace, piDir: piWebHome(), mcpConfigPath: join(directory, 'no-mcp.json') })
  const catalog = await runtime.catalog()
  assert.ok(catalog.defaultModel, 'Configure the intended DeepSeek model first')
  assert.match(catalog.defaultModel.modelId, /deepseek/i, 'Acceptance requires an explicitly selected DeepSeek model; no model was changed')
  evidence.model = catalog.defaultModel
  // Stable direct-tool trace; codemode-only capability routing is covered by runtime-policy tests.
  await runtime.updateSettings({ codemodeMode: 'off' })
  const accessMode = runtime.capabilities().accessModes.includes('workspaceWrite') ? 'workspaceWrite' : 'fullAccess'
  const conversation = await runtime.create({ title: 'Default workflow acceptance', model: catalog.defaultModel, accessMode })
  const result = await run(conversation.conversation.id, WORKFLOW_PROMPT)
  const tools = result.messages.filter(message => message.role === 'tool')
  evidence.tools = tools.map(message => ({ name: message.toolName, isError: message.isError ?? false }))
  evidence.todos = result.todos
  evidence.goal = result.goal
  const assistants = result.messages.filter(message => message.role === 'assistant')
  evidence.progress = assistants.slice(0, -1).map(textOf).filter(Boolean)
  evidence.final = assistants.at(-1) ? textOf(assistants.at(-1)!) : ''
  assert.ok(tools.filter(message => message.toolName === 'todo_write' && !message.isError).length >= 2, 'The model did not create and update its task list')
  assert.ok(result.todos?.length && result.todos.every(item => item.status === 'completed'), 'The task list was not completed')
  assert.ok((evidence.progress as string[]).length > 0, 'No intermediate progress message was observed')
  assert.ok(tools.some(message => message.toolName === 'bash' && !message.isError), 'The model did not run its verification')
  assert.ok((await readFile(join(workspace, 'README.md'), 'utf8')).trim(), 'README was not created')
  const files = await readdir(workspace)
  assert.ok(files.some(name => /(?:test|spec)\.(?:mjs|cjs|js)$/.test(name)) || files.includes('test') || files.includes('tests'), 'No runnable test artifact was created')
  const test = await execute(process.execPath, ['--test'], { cwd: workspace, timeout: 30_000, maxBuffer: 512_000 })
  const oracle = await execute(process.execPath, ['--input-type=module', '-e', WORKFLOW_ORACLE], { cwd: workspace, timeout: 10_000 })
  evidence.tests = test.stdout.slice(-8_000)
  evidence.oracle = oracle.stdout.trim()
  assert.ok(!result.goal || result.goal.phase === 'complete', 'The model left its goal unfinished')

  const simple = await runtime.create({ title: 'Simple task acceptance', model: catalog.defaultModel, accessMode: 'readOnly' })
  const simpleResult = await run(simple.conversation.id, '17 乘 23 是多少？')
  assert.ok(!simpleResult.messages.some(message => message.role === 'tool' && ['todo_write', 'create_goal'].includes(message.toolName ?? '')), 'A trivial question triggered formal planning')
  assert.ok(simpleResult.messages.some(message => message.role === 'assistant' && textOf(message).includes('391')))
  evidence.simpleTask = 'passed without formal planning'
  evidence.result = 'passed'
} catch (error) {
  evidence.error = redact(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
} finally {
  await runtime?.close()
  await mkdir('artifacts', { recursive: true })
  await writeFile('artifacts/live-workflow-check.json', JSON.stringify(evidence, null, 2) + '\n')
  console.log(JSON.stringify(evidence, null, 2))
  await rm(directory, { recursive: true, force: true })
}
