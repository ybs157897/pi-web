/**
 * 对话创建/管理钩子的全场景矩阵验收（真实模型）。
 *
 * 覆盖现有 live 脚本未覆盖的盲区：
 * - S1 用户级 + 明确指令：对话创建 user 级钩子，断言 dataDir/hooks.json 落盘；
 * - S2 弱指令：只说「帮弄个钩子：改文件后检查代码风格」，不给超时/级别提示——断言模型
 *   自觉发起超时确认问答（需求「必须告知用户确认时间」的行为面），回答后断言钩子落盘
 *   （级别允许 user 或 project，记录实际选择）；
 * - S3 对话管理生命周期：预置一条用户级钩子，依次「列出 → 超时改 30 秒 → 停用 → 删除」，
 *   每步断言配置文件真实变化。
 * - 每场景记录模型是否调用 skill_load 加载 hooks-creator（技能可发现性证据）。
 *
 * 失败条件：任一场景的阶段超时或断言失败（其余场景继续执行，最后统一报告并 exit 1）。
 * 运行前提：有效模型凭据。PI_WEB_LIVE_MODEL=provider/modelId 可覆盖模型。
 * 证据写入 artifacts/live-hooks-matrix-<model>.json。
 */
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { randomUUID } from 'node:crypto'
import assert from 'node:assert/strict'
import { createRuntime } from '../src/server/runtime/index.ts'
import { piWebHome } from '../src/server/state/home.ts'
import type { AskUserQuestionItem, ConversationDetail } from '../src/shared/types.ts'

/** 带 tags 的场景记录。 */
interface StepEvidence {
  scenario: string
  passed: boolean
  steps: Record<string, unknown>
  error?: string
}
const evidence: StepEvidence[] = []
const modelOverride = process.env.PI_WEB_LIVE_MODEL
const stamp = new Date().toISOString().replace(/[:.]/gu, '-')

/** 解析模型（默认取 catalog.defaultModel）。 */
function resolveModel(catalog: { defaultModel?: { provider: string; modelId: string } }) {
  if (modelOverride === undefined) return catalog.defaultModel
  const [provider, ...rest] = modelOverride.split('/')
  return { provider, modelId: rest.join('/') }
}

/** 轮询会话详情直到断言函数返回非 undefined；超时抛错。 */
async function waitDetail(runtime: Awaited<ReturnType<typeof createRuntime>>, id: string, probe: (detail: ConversationDetail) => unknown, what: string, timeoutMs = 150_000): Promise<ConversationDetail> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const detail = await runtime.detail(id)
    if (detail.error !== undefined) throw new Error(`${what}：${detail.error}`)
    if (probe(detail) !== undefined) return detail
    await delay(250)
  }
  throw new Error(`${what}：超时（${String(timeoutMs)}ms）`)
}

/** 已结算且 assistant 回答非空（本轮结束）。 */
function settled(detail: ConversationDetail): boolean {
  return !detail.conversation.busy && detail.messages.some(message => message.role === 'assistant' && !message.streaming)
}

/** 待答的 ask_user_question 交互（带问题）。 */
function pendingAsk(detail: ConversationDetail) {
  return detail.interactions?.find(item => item.status === 'pending' && item.questions !== undefined && item.questions.length > 0)
}

/** 模型是否调用过 skill_load（技能可发现性证据）。 */
function usedSkillLoad(detail: ConversationDetail): boolean {
  return detail.messages.some(message => message.role === 'tool' && message.toolName === 'skill_load')
}

/** 最后一条 assistant 文本。 */
function lastAnswer(detail: ConversationDetail): string {
  const answers = detail.messages.filter(message => message.role === 'assistant' && !message.streaming)
  const last = answers[answers.length - 1]
  if (last === undefined) return ''
  return last.blocks.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
}

/** 读 JSON 文件；缺失返回 undefined。 */
async function readJson(path: string): Promise<Record<string, unknown> | undefined> {
  try { return JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown> } catch { return undefined }
}

/** 某来源是否已有该事件的条目。 */
async function hasEvent(configPath: string, event: string): Promise<boolean> {
  const config = await readJson(configPath)
  const hooks = config?.hooks as { events?: Record<string, unknown[]> } | undefined
  return (hooks?.events?.[event]?.length ?? 0) > 0
}

/** 轮询文件条件。 */
async function waitFile(probe: () => Promise<boolean>, what: string, timeoutMs = 150_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await probe()) return
    await delay(250)
  }
  throw new Error(`${what}：超时（${String(timeoutMs)}ms）`)
}

/** 按问题内容选择答复：超时问题选 15 秒；级别问题选用户级；无选项时用 custom。 */
function answerFor(question: AskUserQuestionItem) {
  const labels = (question.options ?? []).map(option => option.label)
  const pick = (pattern: RegExp) => labels.find(label => pattern.test(label))
  const selected = /超时|秒|timeout/iu.test(question.question)
    ? pick(/15/u) ?? pick(/推荐/u)
    : /级别|级别|scope|用户|项目|user|project/iu.test(question.question)
      ? pick(/用户|user/iu) ?? pick(/推荐/u)
      : undefined
  const fallback = selected ?? labels[0]
  return fallback === undefined
    ? { id: question.id, selected: [], custom: '15 秒' }
    : { id: question.id, selected: [fallback] }
}

/** 回答一条待答交互，返回答复摘要。 */
async function answerPending(runtime: Awaited<ReturnType<typeof createRuntime>>, id: string) {
  const detail = await waitDetail(runtime, id, pendingAsk, '等待超时确认问答')
  const pending = pendingAsk(detail)!
  const answers = pending.questions!.map(answerFor)
  await runtime.answerInteraction(id, pending.id, answers)
  return { questions: pending.questions!.map(question => question.question), answers }
}

/** 在隔离环境跑一个场景；失败记录不中断其它场景。 */
async function scenario(name: string, run: (ctx: { runtime: Awaited<ReturnType<typeof createRuntime>>; workspace: string; dataDir: string; id: string }) => Promise<Record<string, unknown>>) {
  const directory = await mkdtemp(join(tmpdir(), `pi-web-live-hooks-matrix-${name}-`))
  const workspace = join(directory, 'workspace')
  const dataDir = join(directory, 'data')
  await mkdir(workspace, { recursive: true })
  const runtime = await createRuntime({ dataDir, workspace, piDir: piWebHome() })
  try {
    const catalog = await runtime.catalog()
    const model = resolveModel(catalog)
    assert.ok(model, 'Configure a default Pi model before running the matrix check')
    const conversation = await runtime.create({ title: `matrix ${name}`, model, accessMode: 'workspaceWrite' })
    const id = conversation.conversation.id
    const steps = await run({ runtime, workspace, dataDir, id })
    evidence.push({ scenario: name, passed: true, steps: { model, ...steps } })
    console.log(`[matrix] ${name} PASSED`)
  } catch (error) {
    evidence.push({ scenario: name, passed: false, steps: {}, error: error instanceof Error ? error.message : String(error) })
    console.error(`[matrix] ${name} FAILED: ${error instanceof Error ? error.message : String(error)}`)
  } finally {
    await runtime.close()
    await rm(directory, { recursive: true, force: true })
  }
}

// S1：用户级 + 明确指令（不预先给出答案——预给答案会让模型合理跳过提问）。
await scenario('S1-user-explicit', async ({ runtime, dataDir, id }) => {
  await runtime.submit(id, {
    requestId: randomUUID(),
    text: '帮我创建一个用户级钩子：每次修改文件后运行代码风格检查。创建前先用 ask_user_question 向我确认超时时间与级别，请用 manage_hooks 的 script 参数一站式落盘（process 型、node 脚本、事件 PostToolUse、matcher Write|Edit）。',
  })
  const answered = await answerPending(runtime, id)
  await waitFile(() => hasEvent(join(dataDir, 'hooks.json'), 'PostToolUse'), '用户级 hooks.json 出现 PostToolUse 条目')
  const detail = await waitDetail(runtime, id, settled, 'S1 轮次结束')
  return { answered, skillLoad: usedSkillLoad(detail), hookFile: join(dataDir, 'hooks.json'), answer: lastAnswer(detail).slice(0, 300) }
})

// S2：弱指令——不给超时/级别提示，断言模型自觉确认超时。
await scenario('S2-user-weak', async ({ runtime, workspace, dataDir, id }) => {
  await runtime.submit(id, {
    requestId: randomUUID(),
    text: '帮我弄个钩子：每次改了文件就检查一下代码风格。',
  })
  const answered = await answerPending(runtime, id)
  // 级别未指定：允许 user 或 project，记录实际落点。
  let location = ''
  await waitFile(async () => {
    if (await hasEvent(join(dataDir, 'hooks.json'), 'PostToolUse')) { location = 'user'; return true }
    if (await hasEvent(join(workspace, '.pi-web', 'hooks.json'), 'PostToolUse')) { location = 'project'; return true }
    return false
  }, '弱指令场景的钩子落盘')
  const detail = await waitDetail(runtime, id, settled, 'S2 轮次结束')
  return { answered, location, skillLoad: usedSkillLoad(detail), answer: lastAnswer(detail).slice(0, 300) }
})

// S3：对话管理生命周期——预置用户级钩子后依次列出/改超时/停用/删除。
await scenario('S3-manage-lifecycle', async ({ runtime, dataDir, id }) => {
  const hooksPath = join(dataDir, 'hooks.json')
  await mkdir(dataDir, { recursive: true })
  await writeFile(hooksPath, JSON.stringify({
    hooks: { enabled: true, events: { PostToolUse: [{ matcher: 'Bash', hooks: [{ type: 'process', command: 'node', args: ['hook-scripts/style.mjs'], timeoutMs: 15000 }] }] } },
  }, null, 2), 'utf8')
  const entry = async () => {
    const config = await readJson(hooksPath)
    const groups = (config?.hooks as { events?: { PostToolUse?: Array<{ hooks: Array<Record<string, unknown>> }> } } | undefined)?.events?.PostToolUse
    return groups?.[0]?.hooks?.[0]
  }
  const steps: Record<string, unknown> = {}
  const turn = async (text: string) => {
    const before = (await runtime.detail(id)).messages.length
    await runtime.submit(id, { requestId: randomUUID(), text })
    return await waitDetail(runtime, id, detail => detail.messages.length > before && settled(detail) ? true : undefined, '管理轮次结束')
  }
  const listed = await turn('列出我现在配置的钩子（用 manage_hooks 的 list 动作），告诉我事件名和 index。')
  steps.listAnswer = lastAnswer(listed).slice(0, 300)
  await turn('把刚才列出的那条钩子的超时改成 30000 毫秒。')
  await waitFile(async () => (await entry())?.timeoutMs === 30000, '超时改为 30000')
  steps.timeoutUpdated = true
  await turn('把那条钩子停用（enabled 设为 false）。')
  await waitFile(async () => (await entry())?.enabled === false, '钩子停用')
  steps.disabled = true
  await turn('把那条钩子删除。')
  await waitFile(async () => !(await hasEvent(hooksPath, 'PostToolUse')), '钩子删除')
  steps.deleted = true
  const detail = await runtime.detail(id)
  steps.skillLoad = usedSkillLoad(detail)
  return steps
})

// 汇总：写证据并报告。
const failed = evidence.filter(item => !item.passed)
const report = {
  result: failed.length === 0 ? 'passed' : 'failed',
  verifiedAt: new Date().toISOString(),
  model: evidence[0]?.steps.model ?? modelOverride ?? '(default)',
  scenarios: evidence,
}
await mkdir('artifacts', { recursive: true })
const safeModel = String((report.model as { provider?: string; modelId?: string } | undefined)?.modelId ?? modelOverride ?? 'default').replace(/[^\w.-]+/gu, '-')
await writeFile(`artifacts/live-hooks-matrix-${safeModel}-${stamp}.json`, JSON.stringify(report, null, 2) + '\n')
console.log(JSON.stringify(report, null, 2))
if (failed.length > 0) process.exitCode = 1