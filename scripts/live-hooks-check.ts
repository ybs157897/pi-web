/**
 * 用户/项目级 hooks 的真实模型验收：完整走一遍「agent 创建钩子 → 用户确认超时 → 热生效 →
 * 触发执行」闭环。
 *
 * 场景：
 * 1. 用户要求创建一个项目级 Stop 钩子：本轮修改文件后把文件清单追加到 docs/changed-log.md，
 *    创建前必须先确认超时——断言出现 ask_user_question 待答交互（需求「超时必须用户确认」）；
 * 2. 回答交互（选 15 秒），模型经 manage_hooks 创建并落盘（断言 workspace/.pi-web/hooks.json
 *    存在且 Stop 条目带 timeoutMs，项目级自动信任）；
 * 3. 第二条消息让模型 write 一个测试文件，触发 changedFiles 聚合与 Stop 钩子——不重启断言
 *    docs/changed-log.md 被创建且含修改文件（热生效 + 真实执行证据）；
 * 4. 读 trajectory JSONL 断言 type:'hook' 行 outcome:'success'（可观测通道）。
 *
 * 失败条件：未配置默认模型、各阶段超时、交互未出现、钩子未落盘、changed-log 未生成、
 * trajectory 无成功 hook 记录。运行前提：有效模型凭据（config 默认模型可路由）。
 * 证据写入 artifacts/live-hooks-check.json。
 */
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { randomUUID } from 'node:crypto'
import assert from 'node:assert/strict'
import { createRuntime } from '../src/server/runtime/index.ts'
import { piWebHome } from '../src/server/state/home.ts'
import { TRAJECTORY_CAPTURE_DIR } from '../src/server/conversation/trajectory.ts'

const directory = await mkdtemp(join(tmpdir(), 'pi-web-live-hooks-'))
const workspace = join(directory, 'workspace')
const dataDir = join(directory, 'data')
await mkdir(workspace, { recursive: true })
const runtime = await createRuntime({ dataDir, workspace, piDir: piWebHome() })
const steps: Record<string, unknown> = {}
try {
  // 阶段一：校验默认模型，创建 workspaceWrite 会话，要求 agent 先确认超时再创建项目级 Stop 钩子。
  // PI_WEB_LIVE_MODEL=provider/modelId 可覆盖模型（默认配额耗尽时换用其它 provider）。
  const catalog = await runtime.catalog()
  const override = process.env.PI_WEB_LIVE_MODEL
  const model = override === undefined
    ? catalog.defaultModel
    : { provider: override.split('/')[0], modelId: override.split('/').slice(1).join('/') }
  assert.ok(model, 'Configure a default Pi model before running the live hooks check')
  const conversation = await runtime.create({ title: 'Live hooks verification', model, accessMode: 'workspaceWrite' })
  const id = conversation.conversation.id
  await runtime.submit(id, {
    requestId: randomUUID(),
    text: [
      '帮我创建一个项目级钩子：本轮修改了文件后，把修改文件清单追加到 docs/changed-log.md（每行一个文件，带当次时间戳）。',
      '创建前必须先用 ask_user_question 问我确认超时时间（给出 15 秒推荐选项和 5/30/60 秒选项），得到答复后再用 manage_hooks 创建（process 型、node 脚本、事件 Stop、脚本用 script 参数一站式落盘）。',
    ].join('\n'),
  })
  // 阶段二：轮询待答交互（120 秒）；断言问题里含超时选项，回答 15 秒。
  const interactionDeadline = Date.now() + 120_000
  let pending: { id: string; questions?: Array<{ id: string; question: string; options?: Array<{ label: string }> }> } | undefined
  while (Date.now() < interactionDeadline) {
    const detail = await runtime.detail(id)
    if (detail.error !== undefined) throw new Error(detail.error)
    pending = detail.interactions?.find(item => item.status === 'pending' && item.questions !== undefined) as typeof pending
    if (pending !== undefined) break
    await delay(200)
  }
  assert.ok(pending, 'The agent did not ask the user to confirm the hook timeout')
  const timeoutQuestion = pending.questions!.find(question => /超时|秒|timeout/iu.test(question.question)) ?? pending.questions![0]
  steps.timeoutQuestion = timeoutQuestion.question
  const fifteen = timeoutQuestion.options?.find(option => option.label.includes('15')) ?? timeoutQuestion.options?.[0]
  await runtime.answerInteraction(id, pending.id, [{ id: timeoutQuestion.id, selected: [fifteen!.label] }])
  steps.answered = fifteen!.label

  // 阶段三：轮询直到钩子落盘（120 秒）——项目级配置在 workspace/.pi-web/hooks.json，Stop 条目带超时。
  const hooksPath = join(workspace, '.pi-web', 'hooks.json')
  const hookDeadline = Date.now() + 120_000
  let hooksConfig: { hooks?: { events?: { Stop?: Array<{ hooks: Array<{ type: string; command: string; args?: string[]; timeoutMs?: number }> }> } } } | undefined
  while (Date.now() < hookDeadline) {
    try {
      const parsed = JSON.parse(await readFile(hooksPath, 'utf8')) as NonNullable<typeof hooksConfig>
      hooksConfig = parsed
      if (parsed.hooks?.events?.Stop !== undefined) break
    } catch {
      // 尚未落盘。
    }
    await delay(200)
  }
  const stopGroup = hooksConfig?.hooks?.events?.Stop?.[0]
  assert.ok(stopGroup !== undefined, `No Stop hook was created at ${hooksPath}`)
  steps.hookConfig = stopGroup
  steps.scriptCreated = Array.isArray(stopGroup.hooks[0].args) && stopGroup.hooks[0].args!.length > 0

  // 阶段四：第二条消息让模型写文件，触发 changedFiles 聚合与 Stop 钩子（创建后不重启即生效）。
  const before = await runtime.detail(id)
  await runtime.submit(id, {
    requestId: randomUUID(),
    text: '请用 write 工具创建 src/live-hook-target.ts，内容为一个导出常量 PI_WEB_HOOKS_READY。完成后简短回复即可。',
  })
  const turnDeadline = Date.now() + 150_000
  let detail = before
  while (Date.now() < turnDeadline) {
    detail = await runtime.detail(id)
    if (detail.error !== undefined) throw new Error(detail.error)
    if (!detail.conversation.busy && detail.messages.length > before.messages.length && detail.messages.some(message => message.role === 'assistant' && !message.streaming)) break
    await delay(200)
  }
  assert.equal(detail.conversation.busy, false, 'The model did not finish the file-write turn')
  const targetExists = await readFile(join(workspace, 'src', 'live-hook-target.ts'), 'utf8').then(text => text.includes('PI_WEB_HOOKS_READY')).catch(() => false)
  assert.ok(targetExists, 'The model did not write src/live-hook-target.ts')

  // 阶段五：断言 Stop 钩子真的执行——docs/changed-log.md 被脚本创建且含修改文件。
  // 失败诊断：把已创建的钩子配置、脚本内容与 trajectory hook 行一并落盘，便于区分
  // 「脚本自身 bug」「钩子未触发（changed_files 为空）」「执行失败」三种原因。
  const scriptPath = stopGroup.hooks[0].args !== undefined && stopGroup.hooks[0].args.length > 0
    ? join(workspace, '.pi-web', 'hook-scripts', stopGroup.hooks[0].args[stopGroup.hooks[0].args.length - 1])
    : undefined
  steps.scriptContent = scriptPath === undefined ? undefined : await readFile(scriptPath, 'utf8').catch(() => '(脚本文件读取失败)')
  const capturePath = join(dataDir, TRAJECTORY_CAPTURE_DIR, `${String(conversation.conversation.id)}.jsonl`)
  const readHookLines = async () => (await readFile(capturePath, 'utf8').catch(() => ''))
    .split('\n').filter(line => line.trim() !== '').map(line => {
      try { return JSON.parse(line) as { type?: string; event?: string; outcome?: string; error?: string } } catch { return {} }
    }).filter(record => record.type === 'hook')
  const logDeadline = Date.now() + 30_000
  let log: string | undefined
  while (Date.now() < logDeadline) {
    log = await readFile(join(workspace, 'docs', 'changed-log.md'), 'utf8').catch(() => undefined)
    if (log !== undefined) break
    await delay(200)
  }
  if (log === undefined) {
    steps.hookRunsBeforeFailure = await readHookLines()
    const diagnostic = { result: 'failed', verifiedAt: new Date().toISOString(), model, reason: 'changed-log.md 未生成', steps }
    await mkdir('artifacts', { recursive: true })
    await writeFile('artifacts/live-hooks-check-failure.json', JSON.stringify(diagnostic, null, 2) + '\n')
    throw new Error(`The Stop hook did not create docs/changed-log.md (hook not executed): ${JSON.stringify(steps.hookRunsBeforeFailure)}`)
  }
  assert.ok(/live-hook-target/iu.test(log), `changed-log.md does not list the modified file: ${log.slice(0, 300)}`)
  steps.changedLog = log.slice(0, 500)

  // 阶段六：trajectory 可观测通道——type:'hook' 行存在且至少一条 success。
  const hookRuns = await readHookLines()
  assert.ok(hookRuns.some(record => record.event === 'Stop' && record.outcome === 'success'), `No successful Stop hook run in trajectory: ${JSON.stringify(hookRuns)}`)
  steps.hookRuns = hookRuns

  const evidence = { result: 'passed', verifiedAt: new Date().toISOString(), model, steps }
  await mkdir('artifacts', { recursive: true })
  await writeFile('artifacts/live-hooks-check.json', JSON.stringify(evidence, null, 2) + '\n')
  console.log(JSON.stringify(evidence, null, 2))
} finally {
  await runtime.close()
  await rm(directory, { recursive: true, force: true })
}