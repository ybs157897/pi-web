import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { createRuntime } from '../src/server/runtime.ts'
import type { Runtime } from '../src/server/contracts.ts'
import type { ConversationDetail } from '../src/shared/types.ts'

const root = await mkdtemp(join(tmpdir(), 'pi-web-live-skills-'))
const workspace = join(root, 'workspace')
const evidencePath = 'artifacts/live-skills-check.json'
const textOf = (message: ConversationDetail['messages'][number]) => message.blocks.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
function redact(text: string) {
  return text.replace(/\bBearer\s+\S+/gi, 'Bearer [redacted]').replace(/\b(?:sk|key|token|secret)[-_][A-Za-z0-9._~+/-]{8,}/gi, '[redacted]')
}
async function run(runtime: Runtime, id: string, text: string) {
  await runtime.submit(id, { text, requestId: randomUUID() })
  const deadline = Date.now() + 180_000
  while (Date.now() < deadline) {
    const detail = await runtime.detail(id)
    if (detail.error) throw new Error(redact(detail.error))
    if (!detail.conversation.busy && detail.messages.some(message => message.role === 'assistant' && !message.streaming)) return detail
    await delay(200)
  }
  await runtime.stop(id)
  throw new Error('Real-model Skill turn exceeded 180 seconds')
}

let runtime: Runtime | undefined
const evidence: Record<string, unknown> = { result: 'failed', verifiedAt: new Date().toISOString() }
try {
  runtime = await createRuntime({ dataDir: join(root, 'data'), workspace, mcpConfigPath: join(root, 'no-external-mcp.json') })
  const catalog = await runtime.catalog()
  assert.ok(catalog.defaultModel, 'Configure the intended default model before running this check')
  assert.match(catalog.defaultModel.modelId, /deepseek/i, 'This repository requires DeepSeek for real-model acceptance; no model was changed')
  evidence.model = catalog.defaultModel
  // Direct tool calls make discovery/loading evidence unambiguous; normal code mode is tested separately.
  await runtime.updateSettings({ codemodeMode: 'off' })
  const creator = await runtime.create({ title: 'Skill creator acceptance', model: catalog.defaultModel, accessMode: 'fullAccess' })
  const created = await run(runtime, creator.conversation.id, [
    '请使用内置 skill-creator，创建一个名为 live-issue-check 的项目技能，并通过技能保存工具保存、校验。',
    '用途：当用户要求“本地问题单样例核验”时触发。行为：只读取当前工作区根目录 evidence.txt，逐字返回其中的验证标识；不修改文件。',
    '只需要 SKILL.md，name/description 和正文完整即可；这是隔离验收工作区，本次先完成创建和校验，不试运行、不追问、不执行 shell。',
  ].join('\n'))
  const creationTools = created.messages.filter(message => message.role === 'tool')
  assert.ok(creationTools.some(message => message.toolName === 'skill_load' && !message.isError && textOf(message).includes('skill-creator')), 'The model did not load the builtin creator')
  assert.ok(creationTools.some(message => message.toolName === 'skill_save' && !message.isError), 'The model did not successfully save the skill')
  assert.ok(creationTools.some(message => message.toolName === 'skill_validate' && !message.isError), 'The model did not validate the saved skill')
  const saved = await readFile(join(workspace, '.agents/skills/live-issue-check/SKILL.md'), 'utf8')
  assert.ok(saved.includes('live-issue-check'))
  const workspaceId = creator.conversation.workspaceId!
  assert.equal((await runtime.validateSkill(workspaceId, 'agents:live-issue-check')).valid, true)
  evidence.creationTools = creationTools.map(message => ({ name: message.toolName, isError: message.isError ?? false }))

  const marker = `VERIFIED_${randomUUID()}`
  await writeFile(join(workspace, 'evidence.txt'), marker + '\n')
  await runtime.close()
  runtime = await createRuntime({ dataDir: join(root, 'data'), workspace, mcpConfigPath: join(root, 'no-external-mcp.json') })
  const verifier = await runtime.create({ title: 'Use skill after restart', model: catalog.defaultModel, accessMode: 'readOnly' })
  const used = await run(runtime, verifier.conversation.id, '请做一次本地问题单样例核验，使用匹配的项目技能，返回验证标识。')
  const useTools = used.messages.filter(message => message.role === 'tool')
  assert.ok(useTools.some(message => message.toolName === 'skill_load' && !message.isError && textOf(message).includes('live-issue-check')), 'New conversation did not discover and load the created skill')
  assert.ok(useTools.some(message => message.toolName === 'read' && !message.isError && textOf(message).includes(marker)), 'Verification did not read the real evidence file')
  assert.ok(used.messages.some(message => message.role === 'assistant' && textOf(message).includes(marker)), 'Final answer did not contain the observed marker')
  evidence.useTools = useTools.map(message => ({ name: message.toolName, isError: message.isError ?? false }))
  evidence.result = 'passed'
  evidence.verified = ['creator loaded', 'skill saved and validated', 'restart', 'new read-only conversation discovered and used skill', 'real disk marker returned']
} catch (cause) {
  evidence.error = redact(cause instanceof Error ? cause.message : String(cause))
  process.exitCode = 1
} finally {
  await runtime?.close()
  await mkdir('artifacts', { recursive: true })
  await writeFile(evidencePath, JSON.stringify(evidence, null, 2) + '\n')
  console.log(JSON.stringify(evidence, null, 2))
  await rm(root, { recursive: true, force: true })
}
