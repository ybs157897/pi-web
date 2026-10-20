import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxThinking,
  fauxToolCall,
  type FauxResponseFactory,
} from '@earendil-works/pi-ai'
import type { ModelRef } from '@earendil-works/pi-durable'
import type { ModelCatalog, ProviderConfigSummary, ProviderInput, ProviderTestResult, ThinkingLevel } from '../shared/types.ts'
import type { RuntimeModels } from './models.ts'
import { RuntimeError } from './runtime-errors.ts'
import { SUBAGENT_TOOL } from './subagent-tools.ts'
import { skillsDemoResponse } from './demo-skills.ts'

interface ResponseGate {
  started: Promise<void>
  resolveStarted(): void
  released: Promise<void>
  resolveReleased(): void
}

let nextGate: ResponseGate | undefined
const DEMO_MODEL: ModelRef = { provider: 'pi-web-demo', modelId: 'demo-model' }
const THINKING_LEVELS: ThinkingLevel[] = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']
const requestObservers = new Set<(request: Parameters<FauxResponseFactory>[0]) => void>()

/** Observe requests reaching the explicit demo provider, for runtime wiring acceptance. */
export function observeDemoRequests(observer: (request: Parameters<FauxResponseFactory>[0]) => void): () => void {
  requestObservers.add(observer)
  return () => { requestObservers.delete(observer) }
}

/** Pause the next demo model response until released or the Pi request is aborted. */
export function holdNextDemoResponse(): { started: Promise<void>; release(): void } {
  if (nextGate) throw new Error('A demo response gate is already installed')
  let resolveStarted!: () => void
  let resolveReleased!: () => void
  const gate: ResponseGate = {
    started: new Promise<void>((resolve) => { resolveStarted = resolve }),
    resolveStarted: () => resolveStarted(),
    released: new Promise<void>((resolve) => { resolveReleased = resolve }),
    resolveReleased: () => resolveReleased(),
  }
  nextGate = gate
  return {
    started: gate.started,
    release() {
      if (nextGate === gate) nextGate = undefined
      gate.resolveReleased()
    },
  }
}

async function waitAtGate(signal: AbortSignal | undefined): Promise<void> {
  const gate = nextGate
  if (!gate) return
  nextGate = undefined
  gate.resolveStarted()
  if (signal?.aborted) return
  let onAbort: (() => void) | undefined
  const aborted = new Promise<void>((resolve) => {
    onAbort = () => resolve()
    signal?.addEventListener('abort', onAbort, { once: true })
  })
  try {
    await Promise.race([gate.released, aborted])
  } finally {
    if (onAbort) signal?.removeEventListener('abort', onAbort)
  }
}

function latestUserText(context: Parameters<FauxResponseFactory>[0]): string {
  const latest = [...context.messages].reverse().find((message) => message.role === 'user')
  if (!latest) return ''
  if (typeof latest.content === 'string') return latest.content
  return latest.content.filter((block) => block.type === 'text').map((block) => block.text).join('\n')
}

type DemoAnswerReply = { callId: string; answers: Array<{ id: string; selected: string[]; custom?: string }> }

/** Recognize the structured answer message the HTTP route steers into the conversation. */
function parseAnswerReply(text: string): DemoAnswerReply | undefined {
  if (!text.includes('answer_to_pending_question')) return undefined
  const start = text.indexOf('{')
  if (start < 0) return undefined
  try {
    const parsed = JSON.parse(text.slice(start)) as Record<string, unknown>
    if (parsed.kind !== 'answer_to_pending_question' || typeof parsed.callId !== 'string' || !Array.isArray(parsed.answers)) return undefined
    const answers = parsed.answers.flatMap(value => {
      const answer = typeof value === 'object' && value !== null ? value as Record<string, unknown> : undefined
      if (!answer || typeof answer.id !== 'string' || !Array.isArray(answer.selected)) return []
      return [{
        id: answer.id,
        selected: answer.selected.filter((item): item is string => typeof item === 'string'),
        ...(typeof answer.custom === 'string' && answer.custom.trim() ? { custom: answer.custom.trim() } : {}),
      }]
    })
    return answers.length ? { callId: parsed.callId, answers } : undefined
  } catch {
    return undefined
  }
}

function answerSummary(reply: DemoAnswerReply): string {
  return reply.answers.map(answer => {
    const value = [...answer.selected, ...(answer.custom ? [answer.custom] : [])]
    return `- ${answer.id}: ${value.length ? value.join('、') : '已跳过'}`
  }).join('\n')
}

/** The plan-review decision the answer route steers in; the question reply parser would misread it. */
function parsePlanReviewReply(text: string): { approved: boolean; feedback?: string } | undefined {
  if (!text.includes('plan-review')) return undefined
  const start = text.indexOf('{')
  if (start < 0) return undefined
  try {
    const parsed = JSON.parse(text.slice(start)) as Record<string, unknown>
    if (parsed.interactionKind !== 'plan-review' || typeof parsed.approved !== 'boolean') return undefined
    const feedback = typeof parsed.feedback === 'string' ? parsed.feedback.trim() : ''
    return { approved: parsed.approved, ...(feedback === '' ? {} : { feedback }) }
  } catch {
    return undefined
  }
}

/** Recognize the dismissal message the cancel route steers in; the answer parser never sees it. */
function parseDismissedReply(text: string): { callId: string } | undefined {
  if (!text.includes('dismissed_pending_question')) return undefined
  const start = text.indexOf('{')
  if (start < 0) return undefined
  try {
    const parsed = JSON.parse(text.slice(start)) as Record<string, unknown>
    if (parsed.kind !== 'dismissed_pending_question' || typeof parsed.callId !== 'string') return undefined
    return { callId: parsed.callId }
  } catch {
    return undefined
  }
}

/** The plan the demo model submits first, and the revision it submits after a change request. */const DEMO_PLAN = [
  '# 演示计划：分三步落地计划模式',
  '',
  '## 目标',
  '在演示会话里跑通「进入计划模式 → 提交计划 → 待审 → 批准执行」。',
  '',
  '## 步骤',
  '1. 只读调研现有问答交互协议与投影字段，不改动任何文件',
  '2. 用 exit_plan_mode 提交计划，等待用户在待审卡上确认',
  '3. 批准后执行计划并汇报结果',
  '',
  '## 验证',
  '- 提交后待审卡出现，标题与正文完整',
  '- 批准后计划模式关闭，模型输出执行结果',
].join('\n')

const DEMO_PLAN_REVISED = [
  '# 演示计划（修订）：补齐验证清单与回滚',
  '',
  '## 按反馈调整',
  '- 把验证步骤拆成可逐条核对的清单',
  '- 补上影响范围与回滚方式',
  '',
  '## 步骤',
  '1. 只读调研现有问答交互协议与投影字段，不改动任何文件',
  '2. 标注受影响的文件范围与回滚方式',
  '3. 用 exit_plan_mode 再次提交计划，等待用户确认',
  '',
  '## 验证',
  '- 待审卡显示修订后的标题与新增章节',
  '- 批准后计划模式自动关闭',
  '',
  '## 回滚',
  '- 只涉及会话文档字段，把 pi-web.plan 的 active 置回 false 即可',
].join('\n')

/** Teammate prompts carry their own marker so the child's faux script answers instead of delegating. */
const TEAM_CHILD_MARKER = '[team-child]'
const TEAM_FOLLOWUP_MARKER = '[team-child-followup]'
const TEAM_SLOW_MARKER = '[team-child-slow]'
const DEMO_TEAM_ANSWER = '已完成：团队面板需要的字段与状态映射已核对，结论写在共享任务里。'
const DEMO_TEAM_FOLLOWUP_ANSWER = '进度：资料已整理完，正在等待实现任务解除依赖。'

/** Abortable delay, so a closing runtime never waits out the slow demo teammate. */
async function demoDelay(ms: number, signal: AbortSignal | undefined): Promise<void> {
  if (signal?.aborted) return
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms)
    signal?.addEventListener('abort', () => { clearTimeout(timer); resolve() }, { once: true })
  })
}

/** The visible text of one tool result, used to recover the created task id. */
function toolResultText(message: { content: string | readonly { type: string; text?: string }[] }): string {
  if (typeof message.content === 'string') return message.content
  return message.content.flatMap(part => part.type === 'text' && typeof part.text === 'string' ? [part.text] : []).join('\n')
}

/** A deterministic checkpoint for compaction requests, so the mechanism is testable without a real model. */
const DEMO_COMPACTION_SUMMARY = [
  '## Goal',
  'Complete the demo task in this conversation.',
  '',
  '## Constraints & Preferences',
  '- Preserve the demo workspace and its files.',
  '',
  '## Progress',
  '### Done',
  '- [x] Reviewed the conversation and its tool results.',
  '',
  '### In Progress',
  '- [ ] Continue from the retained tail.',
  '',
  '### Blocked',
  '- (none)',
  '',
  '## Key Decisions',
  '- **Keep the retained tail verbatim**: it carries the active work.',
  '',
  '## Next Steps',
  '1. Read the retained messages and continue the task.',
  '',
  '## Critical Context',
  '- Demo compaction checkpoint; exact paths and errors are in the retained tail.',
].join('\n')

function demoCompactionResponse(context: Parameters<FauxResponseFactory>[0]) {
  const system = context.messages.filter(message => message.role === 'system').map(message => toolResultText(message)).join('\n')
  const lastUser = latestUserText(context)
  const isCompaction = system.includes('context compaction engine')
    || system.includes('context summarization assistant')
    || lastUser.includes('Write a checkpoint the next model will continue from')
  return isCompaction ? fauxAssistantMessage(fauxText(DEMO_COMPACTION_SUMMARY)) : undefined
}

/** The fixed delegation the `[subagent]` script submits, and the answer its child writes back. */
const DEMO_SUBAGENT_CHILD_MARKER = '[subagent-child]'
const DEMO_SUBAGENT_TASK = `${DEMO_SUBAGENT_CHILD_MARKER} 归纳子智能体一期机制：子会话如何创建、答案如何取回、面板如何挂上去。`
/** The parallel delegations the `[subagents]` script submits, so the one-line strip can be checked. */
const DEMO_PARALLEL_SUBAGENT_TASKS = [
  { task: `${DEMO_SUBAGENT_CHILD_MARKER} 写一篇关于春天的小作文，500 字左右。`, label: 'spring' },
  { task: `${DEMO_SUBAGENT_CHILD_MARKER} 写一篇关于城市清晨的小作文，500 字左右。`, label: 'city' },
  { task: `${DEMO_SUBAGENT_CHILD_MARKER} 写一篇关于一本书的小作文，500 字左右。`, label: 'book' },
]
const DEMO_SUBAGENT_ANSWER = [
  '子智能体一期机制小结：',
  '',
  '1. `subagent({ task, label })` 在 `api.commit` 里以 `ownership: { kind: \'task\', taskId: api.taskId }` 建子会话，子会话自动继承父会话的 agent 组合（工具、模型、工作目录）。',
  '2. 工具以稳定 `requestId` 提交任务并 `wait()`，再从子会话的 answer entry 取最后一条 assistant 文本作为本次调用的结果。',
  '3. UI 通过 `GET /api/conversations/:id/children` 读取子会话摘要，在会话头的计数触发器里展开、打开或停止。',
].join('\n')

const scriptedResponse: FauxResponseFactory = async (context, options) => {
  for (const observer of requestObservers) observer(context)
  await waitAtGate(options?.signal)
  const skillResponse = skillsDemoResponse(context)
  if (skillResponse) return skillResponse
  const compactionResponse = demoCompactionResponse(context)
  if (compactionResponse) return compactionResponse
  let lastUserIndex = -1
  for (let index = context.messages.length - 1; index >= 0; index--) {
    if (context.messages[index].role === 'user') {
      lastUserIndex = index
      break
    }
  }
  const currentResults = context.messages.slice(lastUserIndex + 1).filter((message) => message.role === 'toolResult')
  const userText = latestUserText(context).trim()
  if (userText.includes('[prompt-probe]')) return fauxAssistantMessage(fauxText('PROMPT_PROBE_OK'))
  const planReply = parsePlanReviewReply(userText)
  const answerReply = planReply === undefined ? parseAnswerReply(userText) : undefined
  if (planReply?.approved) {
    return fauxAssistantMessage([
      fauxThinking('用户已批准计划，计划模式已关闭，现在执行计划。'),
      fauxText([
        '计划已获批准，计划模式已关闭（顶部「计划」chip 会消失）。',
        '',
        '## 执行结果',
        '',
        '| 步骤 | 结果 |',
        '| --- | --- |',
        '| 只读调研 | 已核对交互协议与投影字段，未修改任何文件 |',
        '| 计划提交 | 两轮计划均已审阅，最终版本已批准 |',
        '| 验证 | 计划模式已关闭，可以开始实际改动 |',
        '',
        '演示执行完成。',
      ].join('\n')),
    ])
  }
  if (answerReply) {
    return fauxAssistantMessage([
      fauxThinking('用户通过问答卡片提交了回答，现在据此收尾。'),
      fauxText(`已收到你对问题 ${answerReply.callId} 的回答：\n\n${answerSummary(answerReply)}\n\n问答演示到此完成。`),
    ])
  }
  const dismissedReply = planReply === undefined && answerReply === undefined ? parseDismissedReply(userText) : undefined
  if (dismissedReply) {
    return fauxAssistantMessage([
      fauxThinking('用户放弃了这组问题，不再等待回答，本轮收尾。'),
      fauxText(`用户放弃了问题 ${dismissedReply.callId} 的整组问题（未提交回答）。我按放弃处理，不再等待，本轮到此结束。`),
    ])
  }
  if (userText.includes('[ask]')) {
    switch (currentResults.length) {
      case 0:
        return fauxAssistantMessage(fauxToolCall('ask_user_question', {
          questions: [
            {
              id: 'scope',
              header: '演示范围',
              question: '这次问答演示要覆盖哪一层？',
              options: [
                { label: '前端交互 (Recommended)', description: '卡片、选项与只读摘要' },
                { label: '后端接口', description: '校验与持久化' },
                { label: '全链路', description: '从工具调用到收尾回复' },
              ],
            },
            {
              id: 'notes',
              question: '还有什么补充要求？（可跳过）',
            },
          ],
        }, { id: `demo-ask-${String(context.messages.length)}` }), { stopReason: 'toolUse' })
      default:
        return fauxAssistantMessage([
          fauxThinking('问题已经交给用户，回答会以消息形式到达。'),
          fauxText('问题已交给用户。回答后会以消息形式送达，我会据此继续或收尾。'),
        ])
    }
  }
  if (userText.includes('[render-fixture]')) {
    const runToken = String(context.messages.length)
    switch (currentResults.length) {
      case 0:
        return fauxAssistantMessage(fauxToolCall('write', {
          path: 'render-fixture.md',
          content: '# Before\n\nA fixture paragraph with **bold** text.\n',
        }, { id: `fixture-write-${runToken}` }), { stopReason: 'toolUse' })
      case 1:
        return fauxAssistantMessage(fauxToolCall('edit', {
          path: 'render-fixture.md',
          edits: [{ oldText: 'Before', newText: 'After' }],
        }, { id: `fixture-edit-${runToken}` }), { stopReason: 'toolUse' })
      case 2:
        return fauxAssistantMessage(fauxToolCall('read', { path: 'render-fixture.md' }, { id: `fixture-read-${runToken}` }), { stopReason: 'toolUse' })
      case 3:
        return fauxAssistantMessage(fauxToolCall('bash', {
          command: 'printf "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/z0sAAAAASUVORK5CYII=" | base64 -d > render-fixture.png',
        }, { id: `fixture-image-${runToken}` }), { stopReason: 'toolUse' })
      case 4:
        return fauxAssistantMessage(fauxToolCall('read', { path: 'render-fixture.png' }, { id: `fixture-image-read-${runToken}` }), { stopReason: 'toolUse' })
      default:
        return fauxAssistantMessage([
          fauxThinking('演示按固定步骤写入、编辑、读取并检查了一张图片。'),
          fauxText('# Render fixture\n\nA paragraph with **bold**, *italic*, `inline code`, and a [citation](https://example.test/source).\n\n## List\n\n- First item\n- Second item\n\n| Surface | Result |\n| --- | --- |\n| Markdown | rendered |\n| Table | aligned |\n\n```ts\nconst rendered = true\n```\n\n$$\nx^2 + y^2 = z^2\n$$\n\nThe image output appears in the successful `read` tool result above.'),
        ])
    }
  }
  if (userText.includes('[codemode]')) {
    const codemodeResults = currentResults.filter((message) => message.toolName === 'codemode')
    if (codemodeResults.length === 0) {
      return fauxAssistantMessage(fauxToolCall('codemode', {
        code: 'const result = await tools.bash({ command: "printf codemode-ok" })\nreturn result.output',
      }, { id: `demo-codemode-${String(context.messages.length)}` }), { stopReason: 'toolUse' })
    }
    const latest = codemodeResults[codemodeResults.length - 1]
    const output = Array.isArray(latest.content)
      ? latest.content.flatMap((block) => block.type === 'text' ? [block.text] : []).join('\n')
      : ''
    return fauxAssistantMessage([
      fauxThinking('脚本已在 QuickJS 沙箱里调用 bash 并取回输出。'),
      fauxText(`codemode 演示完成。脚本输出：\n\n${output.includes('codemode-ok') ? 'codemode-ok' : output}`),
    ])
  }
  if (userText.includes('[direct-tool]')) {
    // With `codemode.mode: only` Pi offers the model just `codemode`, so a direct bash
    // call is refused; with `on` it is a normal tool call. The runtime test uses both.
    const bashResults = currentResults.filter((message) => message.toolName === 'bash')
    if (bashResults.length === 0) {
      return fauxAssistantMessage(fauxToolCall('bash', { command: 'printf direct-ok' },
        { id: `demo-direct-${String(context.messages.length)}` }), { stopReason: 'toolUse' })
    }
    return fauxAssistantMessage([
      fauxThinking('直接工具调用已被处理，本轮结束。'),
      fauxText('直接工具调用演示完成。'),
    ])
  }
  const completedTools = new Set(currentResults.map((message) => message.toolName))
  const runToken = String(context.messages.length)
  const planSubmissions = context.messages.filter((message) => message.role === 'toolResult' && message.toolName === 'exit_plan_mode' && !message.isError).length
  const beforeThisTurn = context.messages.slice(0, lastUserIndex)
  const lastResult = [...beforeThisTurn].reverse().find((message) => message.role === 'toolResult')
  // A refused call submitted nothing, so only a successful one leaves a plan waiting for review.
  const planAwaitingReview = lastResult?.toolName === 'exit_plan_mode' && !lastResult.isError
  const submittedThisTurn = currentResults.some((message) => message.toolName === 'exit_plan_mode')
  if (userText.includes('[plan]') || planReply !== undefined || planAwaitingReview) {
    if (submittedThisTurn) {
      const refused = [...currentResults].reverse().find((message) => message.toolName === 'exit_plan_mode')?.isError === true
      if (refused) {
        return fauxAssistantMessage([
          fauxThinking('exit_plan_mode 被拒绝：计划模式当前没有开启。'),
          fauxText('计划模式当前没有开启，exit_plan_mode 被拒绝。请在输入区点开「计划」chip（或输入 /plan）后再提交计划。'),
        ])
      }
      return fauxAssistantMessage([
        fauxThinking('计划已提交待审，等待用户在待审卡上确认。'),
        fauxText(planSubmissions >= 2
          ? '已按你的反馈把修订后的计划再次提交（第 2 轮）。请在待审卡上选择「要求修改」或「同意执行」。'
          : '计划已提交待审。请在待审卡上选择「要求修改」或「同意执行」；同意后我会开始执行。'),
      ])
    }
    if (planSubmissions >= 2) {
      return fauxAssistantMessage([
        fauxThinking('两轮计划都已提交待审，不再自动提交。'),
        fauxText('两轮计划都已提交待审，我不会再自动提交。请在待审卡上「同意执行」，或直接告诉我具体要调整哪一部分。'),
      ])
    }
    const revised = planSubmissions >= 1
    return fauxAssistantMessage([
      fauxThinking(revised
        ? `收到反馈（${planReply?.feedback ?? userText.slice(0, 60)}），修订计划后再次提交。`
        : '计划模式已开启：先只读调研，再把计划写成 Markdown 提交待审。'),
      fauxToolCall('exit_plan_mode', { plan: revised ? DEMO_PLAN_REVISED : DEMO_PLAN }, { id: `demo-plan-${revised ? 'b' : 'a'}-${runToken}` }),
    ], { stopReason: 'toolUse' })
  }
  if (userText.includes('[todo]')) {
    switch (currentResults.length) {
      case 0:
        return fauxAssistantMessage(fauxToolCall('todo_write', {
          todos: [
            { content: 'Draft the migration plan', status: 'in_progress' },
            { content: 'Update the copied fixtures', status: 'pending' },
            { content: 'Run the verification pass', status: 'pending' },
          ],
        }, { id: `demo-todo-a-${runToken}` }), { stopReason: 'toolUse' })
      case 1:
        return fauxAssistantMessage(fauxToolCall('todo_write', {
          todos: [
            { content: 'Draft the migration plan', status: 'completed' },
            { content: 'Update the copied fixtures', status: 'completed' },
            { content: 'Run the verification pass', status: 'in_progress' },
            { content: 'Hand the list back', status: 'pending' },
          ],
        }, { id: `demo-todo-b-${runToken}` }), { stopReason: 'toolUse' })
      default:
        return fauxAssistantMessage([
          fauxThinking('任务清单已经过两次写入，最后一条在进行中。'),
          fauxText('任务清单已更新：前两项完成，验证正在进行，最后一项待处理。'),
        ])
    }
  }
  if (userText.includes('[goal]')) {
    switch (currentResults.length) {
      case 0:
        return fauxAssistantMessage(fauxToolCall('create_goal', {
          objective: '完成演示迁移：核对清单、跑通验证并汇报结果',
          max_goal_rounds: 3,
        }, { id: `demo-goal-a-${runToken}` }), { stopReason: 'toolUse' })
      case 1:
        return fauxAssistantMessage(fauxToolCall('get_goal', {}, { id: `demo-goal-b-${runToken}` }), { stopReason: 'toolUse' })
      default:
        return fauxAssistantMessage([
          fauxThinking('目标已建立，先汇报本轮进度。'),
          fauxText('目标已建立（轮次上限 3）。本轮完成了清单核对与验证；若仍有未完成项，自动续跑轮次会继续推进，直到目标完成或达到上限。'),
        ])
    }
  }
  if (userText.startsWith('[goal ')) {
    return fauxAssistantMessage([
      fauxThinking('收到目标续跑轮次，继续推进目标。'),
      fauxText('继续推进目标：本轮核对了剩余条目并汇总了结果。仍有未完成项就等下一条续跑轮次；达到轮次上限后自动续跑停止，由用户决定下一步。'),
    ])
  }
  // The teammate's own markers, so a spawned member answers with text instead of acting as Lead.
  if (userText.includes(TEAM_SLOW_MARKER)) {
    await demoDelay(12_000, options?.signal)
    return fauxAssistantMessage([
      fauxThinking('缓慢的团队成员终于完成。'),
      fauxText('慢速成员完成：等待结束，结果已写入共享任务。'),
    ])
  }
  if (userText.includes(TEAM_FOLLOWUP_MARKER)) {
    return fauxAssistantMessage([
      fauxThinking('收到 Lead 的进度询问。'),
      fauxText(DEMO_TEAM_FOLLOWUP_ANSWER),
    ])
  }
  if (userText.includes(TEAM_CHILD_MARKER)) {
    return fauxAssistantMessage([
      fauxThinking('收到团队委派，给出简短结论。'),
      fauxText(DEMO_TEAM_ANSWER),
    ])
  }
  const teamResults = currentResults.filter((message) => message.role === 'toolResult')
  const teamCount = (name: string): number => teamResults.filter((message) => message.toolName === name).length
  if (userText.includes('[team-message]')) {
    if (teamCount('spawn_teammate') === 0) {
      return fauxAssistantMessage(fauxToolCall('spawn_teammate', {
        name: 'helper',
        description: '进度助手',
        prompt: `${TEAM_CHILD_MARKER} 先整理资料，等待 Lead 的进度询问。`,
        context: 'fresh',
      }, { id: `demo-team-msg-spawn-${runToken}` }), { stopReason: 'toolUse' })
    }
    if (teamCount('send_message') === 0) {
      return fauxAssistantMessage(fauxToolCall('send_message', {
        target: 'helper',
        message: `${TEAM_FOLLOWUP_MARKER} 请汇报当前进度。`,
      }, { id: `demo-team-msg-send-${runToken}` }), { stopReason: 'toolUse' })
    }
    if (teamCount('list_agents') === 0) {
      return fauxAssistantMessage(fauxToolCall('list_agents', {}, { id: `demo-team-msg-list-${runToken}` }), { stopReason: 'toolUse' })
    }
    return fauxAssistantMessage([
      fauxThinking('消息已投递，成员状态已列出。'),
      fauxText('已给 helper 投递进度询问，并重新列出成员状态；投递成功不代表对方已处理。'),
    ])
  }
  if (userText.includes('[team-task]')) {
    const createResult = teamResults.find((message) => message.toolName === 'team_task_create' && !message.isError)
    const taskId = /"id": "(task-\d+)"/u.exec(createResult === undefined ? '' : toolResultText(createResult))?.[1] ?? 'task-1'
    if (teamCount('team_task_create') === 0) {
      return fauxAssistantMessage(fauxToolCall('team_task_create', {
        subject: '整理演示数据',
        description: '把演示数据整理成共享任务需要的形状。',
        write_scopes: ['src/server'],
      }, { id: `demo-team-task-create-${runToken}` }), { stopReason: 'toolUse' })
    }
    if (teamCount('team_task_update') === 0) {
      return fauxAssistantMessage(fauxToolCall('team_task_update', {
        task_id: taskId, expected_revision: 1, action: 'claim',
      }, { id: `demo-team-task-claim-${runToken}` }), { stopReason: 'toolUse' })
    }
    if (teamCount('team_task_update') === 1) {
      // Deliberately stale: the claim committed revision 2, so this is rejected.
      return fauxAssistantMessage(fauxToolCall('team_task_update', {
        task_id: taskId, expected_revision: 1, action: 'release',
      }, { id: `demo-team-task-stale-${runToken}` }), { stopReason: 'toolUse' })
    }
    if (teamCount('team_task_update') === 2) {
      return fauxAssistantMessage(fauxToolCall('team_task_update', {
        task_id: taskId, expected_revision: 2, action: 'complete',
      }, { id: `demo-team-task-complete-${runToken}` }), { stopReason: 'toolUse' })
    }
    return fauxAssistantMessage([
      fauxThinking('任务已经 claim、完成，并验证了陈旧 revision 会被拒绝。'),
      fauxText('共享任务已从 pending 经 claim 进入 in_progress，再用当前 revision 完成；陈旧 revision 的那次调用被拒绝。'),
    ])
  }
  if (userText.includes('[team-wait-timeout]')) {
    if (teamCount('spawn_teammate') === 0) {
      return fauxAssistantMessage(fauxToolCall('spawn_teammate', {
        name: 'slow-worker',
        description: '慢速成员',
        prompt: `${TEAM_SLOW_MARKER} 故意等待 12 秒再完成。`,
        context: 'fresh',
      }, { id: `demo-team-timeout-spawn-${runToken}` }), { stopReason: 'toolUse' })
    }
    // One second of real work so the freshly spawned member's turn is live before the wait starts.
    if (teamCount('bash') === 0) {
      return fauxAssistantMessage(fauxToolCall('bash', { command: 'sleep 1' }, { id: `demo-team-timeout-sleep-${runToken}` }), { stopReason: 'toolUse' })
    }
    if (teamCount('wait_agent') === 0) {
      return fauxAssistantMessage(fauxToolCall('wait_agent', { timeout_ms: 10_000 }, { id: `demo-team-timeout-wait-${runToken}` }), { stopReason: 'toolUse' })
    }
    return fauxAssistantMessage([
      fauxThinking('有界等待到期，slow-worker 仍未完成。'),
      fauxText('等待超时：slow-worker 仍在运行，wait_agent 到时返回 timedOut=true；需要时重新 list_agents 再等。'),
    ])
  }
  if (userText.includes('[team-wait]')) {
    if (teamCount('wait_agent') === 0) {
      return fauxAssistantMessage(fauxToolCall('wait_agent', { timeout_ms: 10_000 }, { id: `demo-team-wait-${runToken}` }), { stopReason: 'toolUse' })
    }
    return fauxAssistantMessage([
      fauxThinking('没有活跃同伴，wait_agent 立即返回 noProgress。'),
      fauxText('当前没有运行中的成员，wait_agent 立即返回 no-active-peer；应先 list_agents，再用 send_message 唤醒需要的成员。'),
    ])
  }
  if (userText.includes('[team-replay]')) {
    // The same name and prompt twice in one run: the second call is the replay path and must
    // reuse the member the first one created instead of adding a second child conversation.
    if (teamCount('spawn_teammate') < 2) {
      return fauxAssistantMessage(fauxToolCall('spawn_teammate', {
        name: 'replayed',
        description: '重放成员',
        prompt: `${TEAM_CHILD_MARKER} 这是一次可重放的创建。`,
        context: 'fresh',
      }, { id: `demo-team-replay-spawn-${teamCount('spawn_teammate')}-${runToken}` }), { stopReason: 'toolUse' })
    }
    return fauxAssistantMessage([
      fauxThinking('同名成员已存在，复用同一子会话。'),
      fauxText('已复用同名成员的子会话。'),
    ])
  }
  if (userText.includes('[team-fork]')) {
    // One in-flight tool round before the spawn, so the test can prove the fork seed stops at
    // the previous completed turn instead of copying this turn's partial work.
    if (teamCount('bash') === 0) {
      return fauxAssistantMessage(fauxToolCall('bash', { command: 'echo inflight-turn' }, { id: `demo-team-fork-bash-${runToken}` }), { stopReason: 'toolUse' })
    }
    if (teamCount('spawn_teammate') === 0) {
      return fauxAssistantMessage(fauxToolCall('spawn_teammate', {
        name: 'forker',
        description: '继承成员',
        prompt: `${TEAM_CHILD_MARKER} 汇报你在上下文里看到的上一轮内容。`,
        context: 'fork',
      }, { id: `demo-team-fork-a-${runToken}` }), { stopReason: 'toolUse' })
    }
    if (teamCount('spawn_teammate') === 1) {
      return fauxAssistantMessage(fauxToolCall('spawn_teammate', {
        name: 'fresher',
        description: '全新成员',
        prompt: `${TEAM_CHILD_MARKER} 汇报你在上下文里看到的上一轮内容。`,
        context: 'fresh',
      }, { id: `demo-team-fork-b-${runToken}` }), { stopReason: 'toolUse' })
    }
    return fauxAssistantMessage([
      fauxThinking('继承成员与全新成员都已创建，可以对比两者的上下文。'),
      fauxText('已创建两个成员：`forker`（继承上一轮）与 `fresher`（全新上下文）。'),
    ])
  }
  if (userText.includes('[team]')) {
    const spawns = teamCount('spawn_teammate')
    if (spawns === 0) {
      return fauxAssistantMessage(fauxToolCall('spawn_teammate', {
        name: 'researcher',
        description: '资料调研',
        prompt: `${TEAM_CHILD_MARKER} 调研团队面板的成员与任务字段，给出三条结论。`,
        context: 'fresh',
      }, { id: `demo-team-spawn-a-${runToken}` }), { stopReason: 'toolUse' })
    }
    if (spawns === 1) {
      return fauxAssistantMessage(fauxToolCall('spawn_teammate', {
        name: 'writer',
        description: '面板实现',
        prompt: `${TEAM_CHILD_MARKER} 等资料调研完成后实现团队面板。`,
        context: 'fresh',
      }, { id: `demo-team-spawn-b-${runToken}` }), { stopReason: 'toolUse' })
    }
    if (teamCount('team_task_create') === 0) {
      return fauxAssistantMessage(fauxToolCall('team_task_create', {
        subject: '调研团队面板',
        description: '核对成员状态与共享任务字段，输出实现清单。',
        write_scopes: ['src/web'],
      }, { id: `demo-team-task-a-${runToken}` }), { stopReason: 'toolUse' })
    }
    if (teamCount('team_task_create') === 1) {
      return fauxAssistantMessage(fauxToolCall('team_task_create', {
        subject: '实现 TeamPanel',
        description: '按 DSH 面板实现成员区与共享任务区。',
        blocked_by: ['task-1'],
        write_scopes: ['src/web/TeamPanel.tsx'],
      }, { id: `demo-team-task-b-${runToken}` }), { stopReason: 'toolUse' })
    }
    if (teamCount('list_agents') === 0) {
      return fauxAssistantMessage(fauxToolCall('list_agents', {}, { id: `demo-team-list-${runToken}` }), { stopReason: 'toolUse' })
    }
    return fauxAssistantMessage([
      fauxThinking('团队成员和共享任务都已就绪。'),
      fauxText([
        '智能体团队已组建完成：',
        '',
        '- `researcher` 与 `writer` 两名成员已创建（fresh，各自独立子会话）',
        '- 共享任务 `task-1` 可开始，`task-2` 被 `task-1` 阻塞',
        '- 会话头右上角的「智能体团队」可以展开成员与共享任务、打开成员会话',
      ].join('\n')),
    ])
  }
  // The child's own marker, so a delegated task answers with text instead of delegating again.
  if (userText.includes(DEMO_SUBAGENT_CHILD_MARKER)) {
    return fauxAssistantMessage([
      fauxThinking('子会话收到委派任务，先给出结论。'),
      fauxText(DEMO_SUBAGENT_ANSWER),
    ])
  }
  if (userText.includes('[subagents]')) {
    if (currentResults.length < DEMO_PARALLEL_SUBAGENT_TASKS.length) {
      return fauxAssistantMessage([
        fauxThinking('开三个子智能体并行写作，用一行色块观察它们的运行状态。'),
        ...DEMO_PARALLEL_SUBAGENT_TASKS.map((entry, index) => fauxToolCall(SUBAGENT_TOOL, {
          task: entry.task,
          label: entry.label,
        }, { id: `demo-subagents-${runToken}-${index}` })),
      ], { stopReason: 'toolUse' })
    }
    return fauxAssistantMessage([
      fauxThinking('三个子智能体都已交稿。'),
      fauxText([
        '三个子智能体已并行完成：',
        '',
        '- 本轮的三次 `subagent` 调用在输入流里收成一行，每个子智能体一个颜色',
        '- 运行中显示转圈与已用时，完成后显示 tokens，失败会标红',
        '- 点任意一个色块可以打开它的完整子会话，再用会话头的面包屑回到父会话',
      ].join('\n')),
    ])
  }
  if (userText.includes('[subagent]')) {
    if (currentResults.length === 0) {
      return fauxAssistantMessage(fauxToolCall(SUBAGENT_TOOL, {
        task: DEMO_SUBAGENT_TASK,
        label: '机制归纳',
      }, { id: `demo-subagent-${runToken}` }), { stopReason: 'toolUse' })
    }
    return fauxAssistantMessage([
      fauxThinking('子智能体已返回结论，据此收尾。'),
      fauxText([
        '子智能体已完成委派任务并返回结论：',
        '',
        '- 子会话由 `subagent` 工具创建，继承父会话的工具、模型与工作目录',
        '- 工具在前台等待子会话的回答，并把答案作为本次调用的结果返回',
        '- 会话头右上角的「1 个子智能体」可以展开它、打开完整执行记录或停止运行',
      ].join('\n')),
    ])
  }
  if (!completedTools.has('write')) {
    return fauxAssistantMessage([
      fauxThinking('先写入目标文件，再用 read 和 bash 交叉核对。'),
      fauxToolCall('write', { path: 'hello.txt', content: 'Hello from Pi Durable Web.\n' }, { id: `demo-write-${runToken}` }),
    ], { stopReason: 'toolUse' })
  }
  if (!completedTools.has('read')) {
    return fauxAssistantMessage(fauxToolCall('read', { path: 'hello.txt' }, { id: `demo-read-${runToken}` }), { stopReason: 'toolUse' })
  }
  if (!completedTools.has('bash')) {
    return fauxAssistantMessage(fauxToolCall('bash', { command: 'cat hello.txt' }, { id: `demo-bash-${runToken}` }), { stopReason: 'toolUse' })
  }
  return fauxAssistantMessage([
    fauxThinking('文件已经通过 write、read 和 bash 三种工具操作核对。'),
    fauxText(`已完成“${userText || '演示任务'}”。\n\n| 检查方式 | 结果 |\n| --- | --- |\n| write | 文件已创建 |\n| read | 内容可读取 |\n| bash | 内容已在 shell 中核对 |\n\n文件内容：\n\n\`\`\`text\nHello from Pi Durable Web.\n\`\`\``),
  ])
}

/** Build an explicit deterministic demo catalog; production never falls back to it. */
export function createDemoModelRuntime(): RuntimeModels {
  const faux = fauxProvider({
    provider: DEMO_MODEL.provider,
    models: [{ id: DEMO_MODEL.modelId, name: '演示模型（不调用真实模型）', reasoning: true, input: ['text', 'image'] }],
    tokenSize: { min: 4, max: 8 },
  })
  faux.setResponses(Array.from({ length: 512 }, () => scriptedResponse))
  const models = createModels()
  models.setProvider(faux.provider)
  return {
    models,
    defaultModel: DEMO_MODEL,
    defaultThinkingLevel: 'medium',
    async saveProvider(_input: ProviderInput) {
      throw new Error('演示模式不保存 Provider 配置')
    },
    async provider(id): Promise<ProviderConfigSummary> {
      if (id !== DEMO_MODEL.provider) throw new RuntimeError('NOT_FOUND', 'Provider 不存在')
      return {
        id,
        name: '演示模型（不调用真实模型）',
        source: 'builtin',
        configured: true,
        credentialConfigured: true,
        custom: false,
        api: 'openai-completions',
        models: [{ id: DEMO_MODEL.modelId, name: '演示模型（不调用真实模型）', reasoning: true, contextWindow: 128_000, input: ['text', 'image'] }],
      }
    },
    async deleteProvider(id) {
      if (id !== DEMO_MODEL.provider) throw new RuntimeError('NOT_FOUND', 'Provider 不存在')
      throw new RuntimeError('UNSUPPORTED', '演示 Provider 不可删除')
    },
    async testProvider(id, modelId): Promise<ProviderTestResult> {
      if (id !== DEMO_MODEL.provider || (modelId !== undefined && modelId !== DEMO_MODEL.modelId)) throw new RuntimeError('NOT_FOUND', 'Provider 或模型不存在')
      return { providerId: id, modelId: DEMO_MODEL.modelId, status: 'failed', checkedAt: Date.now(), message: '演示模式不会发送真实 Provider 请求' }
    },
    async discover(id): Promise<{ models: Array<{ id: string; name: string }> }> {
      if (id !== DEMO_MODEL.provider) throw new RuntimeError('NOT_FOUND', 'Provider 不存在')
      throw new RuntimeError('UNSUPPORTED', '演示模式不会访问真实 Provider 接口')
    },
    async catalog(): Promise<ModelCatalog> {
      return {
        models: [{
          ...DEMO_MODEL,
          name: '演示模型（不调用真实模型）',
          reasoning: true,
          available: true,
          contextWindow: 128_000,
          thinkingLevels: [...THINKING_LEVELS],
        }],
        providers: [{ id: DEMO_MODEL.provider, name: '演示模型（不调用真实模型）', configured: true, custom: false, source: 'builtin' }],
        defaultModel: DEMO_MODEL,
        thinkingLevels: [...THINKING_LEVELS],
      }
    },
    supportedThinkingLevels(id, modelId) {
      return id === DEMO_MODEL.provider && modelId === DEMO_MODEL.modelId ? [...THINKING_LEVELS] : undefined
    },
    subscribe() { return () => undefined },
    close() { /* Nothing to release. */ },
  }
}
