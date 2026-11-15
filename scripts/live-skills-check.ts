/**
 * 技能（skill）全生命周期的真实模型验收，分两段执行：
 * 1) 创建段——fullAccess 会话用内置 skill-creator 创建 live-issue-check 项目技能并保存、校验；
 * 2) 使用段——重启 runtime 后在全新的 readOnly 会话里触发该技能，读真实 evidence.txt
 *    并把验证标识返回到最终回答。证据写入 artifacts/live-skills-check.json。
 * 失败条件：未配置 DeepSeek 默认模型、任一关键工具调用缺失/失败、保存的 SKILL.md 缺内容、
 * 重启后新会话未发现并使用技能、回答缺验证标识；全部错误信息经 redact 脱敏后写入证据。
 */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { createRuntime } from '../src/server/runtime/index.ts'
import { piWebHome } from '../src/server/state/home.ts'
import type { Runtime } from '../src/server/contracts.ts'
import type { ConversationDetail } from '../src/shared/types.ts'

const root = await mkdtemp(join(tmpdir(), 'pi-web-live-skills-'))
const workspace = join(root, 'workspace')
const evidencePath = 'artifacts/live-skills-check.json'
/** 把一条消息的全部 text 块拼成纯文本，供断言与证据记录。 */
const textOf = (message: ConversationDetail['messages'][number]) => message.blocks.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
/**
 * 功能：脱敏文本，防止凭据进入证据文件与日志。
 * @param text 原始文本（错误消息、回答等）。
 * @returns Bearer 令牌与 sk/key/token/secret 前缀的高熵串替换为 [redacted] 后的文本。
 */
function redact(text: string) {
  return text.replace(/\bBearer\s+\S+/gi, 'Bearer [redacted]').replace(/\b(?:sk|key|token|secret)[-_][A-Za-z0-9._~+/-]{8,}/gi, '[redacted]')
}
/**
 * 功能：提交一条消息并等待该轮结束（超时则主动停止会话再抛错）。
 * @param runtime 目标 runtime 实例。
 * @param id 会话 id。
 * @param text 提交给模型的消息文本。
 * @returns 结束后的会话详情（含全部消息）。
 * @throws 180 秒内未结束抛错（超时前先 stop 防止模型继续消耗）；detail.error 也会抛出（已脱敏）。
 */
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
// 证据对象初始为 failed，各阶段通过后逐步补齐，finally 中无论成败都落盘。
const evidence: Record<string, unknown> = { result: 'failed', verifiedAt: new Date().toISOString() }
try {
  // 阶段一（创建）：隔离 MCP 的 runtime，要求 DeepSeek 默认模型，并关闭 codemode，
  // 让工具调用直接可见、发现/加载证据无歧义（code mode 另有专项验收）。
  runtime = await createRuntime({ dataDir: join(root, 'data'), workspace, piDir: piWebHome(), mcpConfigPath: join(root, 'no-external-mcp.json') })
  const catalog = await runtime.catalog()
  assert.ok(catalog.defaultModel, 'Configure the intended default model before running this check')
  assert.match(catalog.defaultModel.modelId, /deepseek/i, 'This repository requires DeepSeek for real-model acceptance; no model was changed')
  evidence.model = catalog.defaultModel
  await runtime.updateSettings({ codemodeMode: 'off' })
  const creator = await runtime.create({ title: 'Skill creator acceptance', model: catalog.defaultModel, accessMode: 'fullAccess' })
  const created = await run(runtime, creator.conversation.id, [
    '请使用内置 skill-creator，创建一个名为 live-issue-check 的项目技能，并通过技能保存工具保存、校验。',
    '用途：当用户要求“本地问题单样例核验”时触发。行为：只读取当前工作区根目录 evidence.txt，逐字返回其中的验证标识；不修改文件。',
    '只需要 SKILL.md，name/description 和正文完整即可；这是隔离验收工作区，本次先完成创建和校验，不试运行、不追问、不执行 shell。',
  ].join('\n'))
  // 创建段判分：skill_load 载入内置 skill-creator、skill_save 保存成功、skill_validate 校验通过，
  // 且 SKILL.md 已真实落盘、runtime 级 validateSkill 亦确认有效。
  const creationTools = created.messages.filter(message => message.role === 'tool')
  assert.ok(creationTools.some(message => message.toolName === 'skill_load' && !message.isError && textOf(message).includes('skill-creator')), 'The model did not load the builtin creator')
  assert.ok(creationTools.some(message => message.toolName === 'skill_save' && !message.isError), 'The model did not successfully save the skill')
  assert.ok(creationTools.some(message => message.toolName === 'skill_validate' && !message.isError), 'The model did not validate the saved skill')
  const saved = await readFile(join(workspace, '.agents/skills/live-issue-check/SKILL.md'), 'utf8')
  assert.ok(saved.includes('live-issue-check'))
  const workspaceId = creator.conversation.workspaceId!
  assert.equal((await runtime.validateSkill(workspaceId, 'agents:live-issue-check')).valid, true)
  evidence.creationTools = creationTools.map(message => ({ name: message.toolName, isError: message.isError ?? false }))

  // 阶段二（使用）：写入带唯一标记的 evidence.txt，重启 runtime，在全新 readOnly 会话触发技能。
  const marker = `VERIFIED_${randomUUID()}`
  await writeFile(join(workspace, 'evidence.txt'), marker + '\n')
  await runtime.close()
  runtime = await createRuntime({ dataDir: join(root, 'data'), workspace, piDir: piWebHome(), mcpConfigPath: join(root, 'no-external-mcp.json') })
  const verifier = await runtime.create({ title: 'Use skill after restart', model: catalog.defaultModel, accessMode: 'readOnly' })
  // 使用段判分：新会话发现并加载了刚创建的技能、read 读到了真实标记、最终回答包含标记。
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
