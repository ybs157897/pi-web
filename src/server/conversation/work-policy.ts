import { readFileSync } from 'node:fs'
import { CODEMODE_TOOL_NAME } from '@earendil-works/pi-durable/codemode'
import { defineExtension, section, type Extension } from '@earendil-works/pi-durable'
import { Plans } from '../tools/plan.ts'
import { Subagents } from './subagent-policy.ts'
import { loadProjectInstructions, renderProjectInstructions } from '../workspace/instructions.ts'
import { readPersonalization, renderPersonalization } from '../state/personalization.ts'
import { resolveToolRoute, type ToolRoute } from './tool-routing.ts'

export const WORK_POLICY_EXTENSION_NAME = 'runtime-policy'

// Read once when the server module loads. This is the canonical core prompt for this process;
// documentation is not consulted at request time.
export const RUNTIME_CORE_PROMPT = readFileSync(new URL('./prompts/runtime-core.md', import.meta.url), 'utf8').trim()

type TodoRoute = 'direct' | 'codemode'

type PromptAgent = {
  tools: readonly { name: string }[]
  callable: readonly { name: string }[]
  model?: { provider: string; modelId: string }
}

function todoRoute(input: { agent: PromptAgent }): TodoRoute | undefined {
  if (input.agent.tools.some(tool => tool.name === 'todo_write')) return 'direct'

  const codemodeEnabled = input.agent.tools.some(tool => tool.name === CODEMODE_TOOL_NAME)
  const todoCallable = input.agent.callable.some(tool => tool.name === 'todo_write')
  return codemodeEnabled && todoCallable ? 'codemode' : undefined
}

const TODO_STEPS = [
  '非平凡的多步工作在开始前用它列出具体步骤和必要验证；首次更新时将马上开始的第一步设为 `in_progress`，其余步骤按依赖列为 `pending`。简单问题或单步改动跳过待办。',
  '只有彼此独立且确有并行价值的步骤才并行处理；待办在串行时只标一个 `in_progress`，只有真实并行时才标多个。每完成一步立即更新；新发现改变范围或顺序时及时修订。没有对应证据，不得把实现或验证标为完成。',
]

function todoPolicy(route: TodoRoute | undefined): string {
  if (route === 'direct') return ['本请求提供直接待办工具 `todo_write`。', ...TODO_STEPS].join('\n')
  if (route === 'codemode') {
    return ['本请求可通过 `codemode` 调用 `todo_write`，仅在脚本内使用 `await tools.todo_write({ todos: [...] })`。', ...TODO_STEPS].join('\n')
  }
  return '本请求没有可调用的执行待办工具；不要编造或要求调用不可用的工具。'
}

/** A direct tool already carries its own description, so `direct` is set only for facts that description lacks. */
function routeText(route: ToolRoute, direct: string | undefined, nested: string): string | undefined {
  if (route === 'direct') return direct === undefined ? undefined : `- ${direct}`
  if (route === 'codemode') return `- ${nested}`
  return undefined
}

function toolGuidance(input: { agent: PromptAgent }): string {
  const route = (name: string): ToolRoute => resolveToolRoute(input.agent, name)
  const lines = [
    routeText(route('glob'), undefined,
      '在 `codemode` 里用 `await tools.glob(...)` 找路径，不要用 shell `find` 或 `ls -R` 做项目发现。'),
    route('glob') === 'unavailable'
      ? routeText(route('list_files'),
        '找路径用 `list_files`（需要递归时显式传 `recursive: true`），不要用 shell `find` 或 `ls -R` 做项目发现。',
        '在 `codemode` 里用 `await tools.list_files(...)` 找路径，不要用 shell `find` 或 `ls -R` 做项目发现。')
      : undefined,
    routeText(route('grep'), undefined,
      '在 `codemode` 里用 `await tools.grep(...)` 搜内容，不要用 shell `grep`/`rg`。'),
    route('grep') === 'unavailable'
      ? routeText(route('search_files'),
        '搜内容用 `search_files`（字面量短语），不要用 shell `grep`/`rg`。',
        '在 `codemode` 里用 `await tools.search_files(...)` 搜内容，不要用 shell `grep`/`rg`。')
      : undefined,
    routeText(route('read'),
      '读文件用 `read`，不要用 shell `cat`/`head`/`tail`/`sed`；大文件用 `offset`/`limit` 继续读。',
      '在 `codemode` 里用 `await tools.read(...)` 读文件，不要用 shell `cat`/`head`/`tail`/`sed`。'),
    routeText(route('edit'),
      '改文件前先用 `read` 确认当前内容；优先用 `edit` 做定点替换，不要用 shell 重写文件。',
      '在 `codemode` 里改文件前先用 `tools.read` 确认内容；优先用 `tools.edit` 做定点替换。'),
    routeText(route('write'),
      '覆盖已有文件前先 `read`；能用 `edit` 就不要整文件 `write`。',
      '在 `codemode` 里覆盖已有文件前先用 `tools.read`；能用 `tools.edit` 就不要整文件 `tools.write`。'),
    routeText(route('pwsh'),
      'shell（`pwsh`）只用于构建、测试、git、进程等没有专用工具的操作。',
      '在 `codemode` 里用 `await tools.pwsh(...)` 执行 Windows 命令；传 `workdir` 而不是 `Set-Location`，并检查退出码。'),
    routeText(route('bash'),
      'shell 只用于构建、测试、git、进程等没有专用工具的操作。',
      '在 `codemode` 里用 `await tools.bash(...)` 执行没有专用工具的操作；传 `workdir` 而不是反复 `cd`，并检查退出码。'),
  ].filter((line): line is string => line !== undefined)

  return lines.length === 0 ? '' : ['本请求的工具使用约定：', ...lines].join('\n')
}

function sessionFacts(input: { agent: PromptAgent; env: { cwd?: string } | undefined }): string {
  const cwd = input.env?.cwd
  const platform = process.platform
  const shell = platform === 'win32'
    ? 'PowerShell（优先 `pwsh`，回退 Windows PowerShell）；路径用 `D:\\path`'
    : 'bash'
  const date = new Intl.DateTimeFormat('sv-SE', { year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date())
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'unknown'
  const model = input.agent.model ? `${input.agent.model.provider}/${input.agent.model.modelId}` : '未提供'
  const writable = resolveToolRoute(input.agent, 'write') !== 'unavailable' || resolveToolRoute(input.agent, 'edit') !== 'unavailable'
  const shellNames = platform === 'win32' ? ['pwsh'] : ['bash']
  const availableShells = shellNames.filter(name => resolveToolRoute(input.agent, name) !== 'unavailable')
  const shellAbility = availableShells.length === 0
    ? '不可执行 shell'
    : availableShells.every(name => resolveToolRoute(input.agent, name) === 'codemode')
      ? `仅可经 codemode 执行 shell（${availableShells.join('、')}）`
      : `可执行 shell（${availableShells.join('、')}）`
  const scope = typeof cwd === 'string' && cwd.trim() !== ''
    ? `当前工作区（默认当前项目）由系统提供：${JSON.stringify(cwd)}。把此目录作为本次任务的项目范围。`
    : '本请求未提供工作区路径，不推测项目位置。'
  return [
    scope,
    `平台：${platform}；命令解释器：${shell}。`,
    `当前日期：${date}（时区 ${timeZone}）。`,
    `本请求模型：${model}；${writable ? '可写工作区' : '只读'}；${shellAbility}。`,
  ].join('\n')
}

const runtimeCoreSection = section('runtime-core', () => RUNTIME_CORE_PROMPT)

/**
 * The user-level personalization file is re-read on every request, like the project one, so the
 * editor's save applies to the next request without restarting the process. Explore subagents
 * skip it for the same reason they skip the project file: they are read-only retrieval agents.
 */
function personalInstructionsSection(dataDir: string) {
  return section('personal-instructions', async (input, context) => {
    const identity = await input.read.snapshot(Subagents, input.conversationId, context)
    if (identity?.record?.profile === 'Explore') return undefined
    return renderPersonalization(await readPersonalization(dataDir))
  })
}

// Re-read on every request so edits to the workspace's root instructions take effect immediately.
const projectInstructionsSection = section('project-instructions', async (input, context) => {
  // Explore subagents are read-only retrieval agents (ZCode's injectAgentsMd: false): the project's
  // AGENTS.md stays out of their requests while every other conversation keeps it.
  const identity = await input.read.snapshot(Subagents, input.conversationId, context)
  if (identity?.record?.profile === 'Explore') return undefined
  return renderProjectInstructions(await loadProjectInstructions(input.env?.cwd))
})

const workPolicySection = section('work-policy', async (input, context) => {
  const [plan, identity] = await Promise.all([
    input.read.snapshot(Plans, input.conversationId, context),
    input.read.snapshot(Subagents, input.conversationId, context),
  ])
  const child = identity?.record != null
  if (plan?.active === true) {
    return [
      sessionFacts(input),
      child
        ? '计划模式已开启：只读研究，将结论交给委派方，不实施、不等待用户，也不维护执行待办。'
        : '计划模式已开启：按 `plan-policy` 只读研究并提交计划，不实施、不维护执行待办，也不启动自动续跑工作目标。',
    ].join('\n\n')
  }

  const enter = resolveToolRoute(input.agent, 'enter_plan_mode')
  const exit = resolveToolRoute(input.agent, 'exit_plan_mode')
  let planning: string | undefined
  if (!child) {
    if (enter === 'unavailable') {
      planning = '本请求不能自行进入计划模式。用户只要计划或方案时，完成只读调研后直接给出方案，不实施；用户明确要求计划审阅流程时，可提示其使用计划按钮或 /plan。'
    } else if (exit === 'unavailable') {
      planning = '本请求没有可调用的计划提交工具，不要自行进入计划模式；需要计划时先只读调研并直接给出方案。'
    } else if (enter === 'codemode') {
      planning = '非平凡实现任务可先进入计划模式：在 `codemode` 脚本里调用 `await tools.enter_plan_mode({})`，调用前用 `describeTool` 查看完整说明。简单查询、单点小改、明显 bug 修复和用户已给出明确详细指令时不需要计划模式。'
    }
  }

  return [
    sessionFacts(input),
    planning,
    toolGuidance(input),
    todoPolicy(todoRoute(input)),
  ].filter(Boolean).join('\n\n')
})

/** Default behavior policy. This extension deliberately contributes no tools or hooks. */
export function createWorkPolicyExtension(options: { dataDir: string }): Extension {
  return defineExtension({
    name: WORK_POLICY_EXTENSION_NAME,
    sections: [runtimeCoreSection, personalInstructionsSection(options.dataDir), projectInstructionsSection, workPolicySection],
  })
}
