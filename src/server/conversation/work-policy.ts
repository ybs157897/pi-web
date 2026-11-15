import { readFileSync } from 'node:fs'
import { CODEMODE_TOOL_NAME } from '@earendil-works/pi-durable/codemode'
import { defineExtension, section, type Extension } from '@earendil-works/pi-durable'
import { Plans } from '../tools/plan.ts'
import { Subagents } from './subagent-policy.ts'
import { loadProjectInstructions, renderProjectInstructions } from '../workspace/instructions.ts'
import { readPersonalization, renderPersonalization } from '../state/personalization.ts'
import { resolveToolRoute, type ToolRoute } from './tool-routing.ts'

/** 默认行为政策扩展的注册名（runtime-policy），供装配与测试引用。 */
export const WORK_POLICY_EXTENSION_NAME = 'runtime-policy'

/**
 * 核心行为提示词（runtime-core.md）。
 * 功能：每个模型请求无条件注入的固定核心政策。
 * 内部逻辑：进程加载模块时一次性读取文件内容（运行时不查文档），保证全文稳定且零请求开销。
 */
export const RUNTIME_CORE_PROMPT = readFileSync(new URL('./prompts/runtime-core.md', import.meta.url), 'utf8').trim()

type TodoRoute = 'direct' | 'codemode'

/** section 渲染时模型侧可见的 agent 摘要：直接工具集、codemode 可调用集、当前模型。 */
type PromptAgent = {
  tools: readonly { name: string }[]
  callable: readonly { name: string }[]
  model?: { provider: string; modelId: string }
}

/**
 * 判定本请求的待办工具路由。
 * @param input 携带 `agent`（PromptAgent）的渲染输入。
 * @returns 'direct'——todo_write 是本请求的直接工具；'codemode'——todo_write 仅可经 codemode 脚本调用；undefined——没有可执行的待办工具。
 * 内部逻辑：先看直接工具集里是否有 todo_write；否则在 codemode 工具开启且 todo_write 出现在可调用集合时返回 codemode。
 */
function todoRoute(input: { agent: PromptAgent }): TodoRoute | undefined {
  if (input.agent.tools.some(tool => tool.name === 'todo_write')) return 'direct'

  const codemodeEnabled = input.agent.tools.some(tool => tool.name === CODEMODE_TOOL_NAME)
  const todoCallable = input.agent.callable.some(tool => tool.name === 'todo_write')
  return codemodeEnabled && todoCallable ? 'codemode' : undefined
}

/** 待办使用的两条通用约定，与路由无关，供 todoPolicy 按路由拼装。 */
const TODO_STEPS = [
  '非平凡的多步工作在开始前用它列出具体步骤和必要验证；首次更新时将马上开始的第一步设为 `in_progress`，其余步骤按依赖列为 `pending`。简单问题或单步改动跳过待办。',
  '只有彼此独立且确有并行价值的步骤才并行处理；待办在串行时只标一个 `in_progress`，只有真实并行时才标多个。每完成一步立即更新；新发现改变范围或顺序时及时修订。没有对应证据，不得把实现或验证标为完成。',
]

/**
 * 按待办路由渲染使用约定文本。
 * @param route todoRoute 的判定结果（direct / codemode / undefined）。
 * @returns 首行说明路由形态，后接 TODO_STEPS 通用约定；无工具时提示不要编造工具。
 * 内部逻辑：三个分支各自拼接首行与通用约定，直接工具与 codemode 的调用写法不同。
 */
function todoPolicy(route: TodoRoute | undefined): string {
  if (route === 'direct') return ['本请求提供直接待办工具 `todo_write`。', ...TODO_STEPS].join('\n')
  if (route === 'codemode') {
    return ['本请求可通过 `codemode` 调用 `todo_write`，仅在脚本内使用 `await tools.todo_write({ todos: [...] })`。', ...TODO_STEPS].join('\n')
  }
  return '本请求没有可调用的执行待办工具；不要编造或要求调用不可用的工具。'
}

/**
 * 按路由生成一行工具指引。
 * @param route resolveToolRoute 的结果（'direct' / 'codemode' / 'unavailable'）。
 * @param direct 直接工具的补充说明；仅当该事实是工具自带 description 缺失时才给（direct 工具已带自己的描述）。
 * @param nested codemode 场景下整行使用的文案。
 * @returns 拼好的一行文案；unavailable 或（direct 且无补充）时返回 undefined，由调用方过滤。
 * 内部逻辑：direct 只在有补充事实时输出 `- ${direct}`；codemode 固定输出 nested；其余情况不输出。
 */
function routeText(route: ToolRoute, direct: string | undefined, nested: string): string | undefined {
  if (route === 'direct') return direct === undefined ? undefined : `- ${direct}`
  if (route === 'codemode') return `- ${nested}`
  return undefined
}

/**
 * 汇总本请求全部工具的使用约定。
 * @param input 携带 `agent`（PromptAgent）的渲染输入，工具路由逐个经 resolveToolRoute 判定。
 * @returns 「本请求的工具使用约定：」+ 各行文案；全部路由不可用时返回空串（调用方以 filter(Boolean) 剔除）。
 * 内部逻辑：glob/grep 仅在不可用时才渲染 list_files/search_files 的兜底文案（可用时兜底工具不占提示词）；
 * read/edit/write 与 shell（按平台取 pwsh 或 bash）各按 direct/codemode 输出对应写法。
 */
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

/**
 * 渲染本请求的会话事实（工作区、平台、日期、模型、写权限、shell 能力）。
 * @param input 携带 `agent`（PromptAgent，取当前模型）与 `env.cwd`（工作区路径）的渲染输入。
 * @returns 四行事实文本：工作区范围、平台与命令解释器、当前日期与时区、模型与权限。
 * 内部逻辑：平台为 win32 时 shell 描述为 PowerShell 并提示 `D:\path` 写法，否则为 bash；
 * 日期用 sv-SE locale 格式化为 YYYY-MM-DD；可写权限由 write/edit 任一可路由判定；
 * shell 能力分三态——无 shell、仅可经 codemode、可直接执行。
 */
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

/** runtime-core section：无条件返回模块加载时读好的核心提示词，无每请求逻辑。 */
const runtimeCoreSection = section('runtime-core', () => RUNTIME_CORE_PROMPT)

/**
 * 中文思考开关的注入文案常量。
 * 功能：用户在设置里开启「中文思考」后，随 personal-instructions 注入的推理语言要求。
 * 内部逻辑（为什么并入本 section）：live 验证（2026-11-15）显示夹在工具政策中段的独立 section 会被模型无视，
 * 而 personal-instructions 的位置（紧跟 runtime-core、用户级权威框定）是 A/B 实验验证过遵从的。
 */
export const CHINESE_REASONING_INSTRUCTION = '思考（reasoning）全程使用中文；代码标识符、文件路径、命令、专有名词保留原文。'

/**
 * 渲染设置开关对应的注入段。
 * @returns 与 renderPersonalization 同构的文本：权威框定句 + `<personal_instructions>` 包裹的指令。
 * 内部逻辑：刻意复用个性化文件的框定句式与标签——模型只在该框架下遵从语言指令（live 验证：自创框定被无视）。
 */
function renderChineseReasoningSetting(): string {
  return [
    '用户设置适用于所有工作区。发生冲突时，项目指令和明确的任务指令优先：',
    '<personal_instructions>',
    CHINESE_REASONING_INSTRUCTION,
    '</personal_instructions>',
  ].join('\n')
}

/**
 * 构建 personal-instructions section（用户级指令，每次请求渲染）。
 * @param dataDir 数据目录，个性化文件（AGENTS.md）所在位置。
 * @param chineseReasoning 每请求读取「中文思考」开关的闭包——读快照而非缓存，设置切换后下一请求即生效。
 * @returns section 渲染函数；返回 undefined 时不向提示词贡献任何字节。
 * 内部逻辑：Explore 子会话直接跳过（与项目文件同理——它们是只读检索智能体，不注入用户级指令）；
 * 个性化文件每请求重读（设置页保存后下一请求生效）；两个来源都存在时拼接，个性化内容在前。
 */
function personalInstructionsSection(dataDir: string, chineseReasoning: () => boolean) {
  return section('personal-instructions', async (input, context) => {
    const identity = await input.read.snapshot(Subagents, input.conversationId, context)
    if (identity?.record?.profile === 'Explore') return undefined
    const personalization = renderPersonalization(await readPersonalization(dataDir))
    const reasoning = chineseReasoning() ? renderChineseReasoningSetting() : undefined
    if (personalization === undefined) return reasoning
    if (reasoning === undefined) return personalization
    return `${personalization}\n\n${reasoning}`
  })
}

// 每次请求重读，使工作区根指令的编辑即时生效。
/**
 * project-instructions section：每请求重读工作区根 AGENTS.md 并渲染其内容。
 * 内部逻辑：Explore 子会话不注入项目指令（对齐 ZCode 的 injectAgents.md: false）；
 * 与个性化文件同理每请求重读，编辑即时生效、无需重启。
 */
const projectInstructionsSection = section('project-instructions', async (input, context) => {
  // Explore 子会话是只读检索智能体（对齐 ZCode 的 injectAgentsMd: false）：它们的请求不注入
  // 项目 AGENTS.md，其余会话照常携带。
  const identity = await input.read.snapshot(Subagents, input.conversationId, context)
  if (identity?.record?.profile === 'Explore') return undefined
  return renderProjectInstructions(await loadProjectInstructions(input.env?.cwd))
})

/**
 * work-policy section：本请求的工作政策（会话事实、计划模式提示、工具使用约定、待办约定）。
 * 内部逻辑：并行读 Plans 与 Subagents 快照——计划模式激活时只渲染会话事实 + 只读约束（子会话与
 * 主会话文案不同）；非计划模式按 enter/exit_plan_mode 的路由决定计划模式引导文案（子会话不引导）；
 * 其余按顺序拼装 sessionFacts、planning、toolGuidance、todoPolicy，空段用 filter(Boolean) 剔除。
 */
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

/**
 * 装配 runtime-policy 扩展（默认行为政策）。
 * @param options.dataDir 数据目录，personal-instructions section 用它定位个性化文件。
 * @param options.chineseReasoning 每请求读取「中文思考」设置的闭包，透传给 personalInstructionsSection。
 * @returns 只含四个 section（runtime-core、personal-instructions、project-instructions、work-policy）的扩展；
 * 有意不贡献任何工具或 hook——纯提示词侧政策，工具面完全由其他扩展提供。
 */
export function createWorkPolicyExtension(options: { dataDir: string; chineseReasoning: () => boolean }): Extension {
  return defineExtension({
    name: WORK_POLICY_EXTENSION_NAME,
    sections: [runtimeCoreSection, personalInstructionsSection(options.dataDir, options.chineseReasoning), projectInstructionsSection, workPolicySection],
  })
}
