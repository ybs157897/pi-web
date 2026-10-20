import { readFileSync } from 'node:fs'
import { CODEMODE_TOOL_NAME } from '@earendil-works/pi-durable/codemode'
import { defineExtension, section, type Extension } from '@earendil-works/pi-durable'
import { Plans } from './plan-tools.ts'

export const WORK_POLICY_EXTENSION_NAME = 'runtime-policy'

// Read once when the server module loads. This is the canonical core prompt for this process;
// documentation and Preset instructions are not consulted at request time.
export const RUNTIME_CORE_PROMPT = readFileSync(new URL('./prompts/runtime-core.md', import.meta.url), 'utf8').trim()

type TodoRoute = 'direct' | 'codemode'

function todoRoute(input: {
  agent: {
    tools: readonly { name: string }[]
    callable: readonly { name: string }[]
  }
}): TodoRoute | undefined {
  if (input.agent.tools.some(tool => tool.name === 'todo_write')) return 'direct'

  const codemodeEnabled = input.agent.tools.some(tool => tool.name === CODEMODE_TOOL_NAME)
  const todoCallable = input.agent.callable.some(tool => tool.name === 'todo_write')
  return codemodeEnabled && todoCallable ? 'codemode' : undefined
}

function todoPolicy(route: TodoRoute | undefined): string {
  if (route === 'direct') {
    return [
      '本请求提供直接待办工具 `todo_write`。',
      '非平凡的多步工作在开始实施前，用它列出具体步骤和必要验证；首次更新时将马上开始的第一步设为 `in_progress`，其余步骤按依赖列为 `pending`。简单问题或单步改动跳过待办。',
      '只有彼此独立且确有并行价值的步骤才并行处理；待办在串行时只标一个 `in_progress`，只有真实并行时才标多个。每完成一步立即更新；新发现改变范围或顺序时及时修订。没有对应证据，不得把实现或验证标为完成。',
    ].join('\n')
  }

  if (route === 'codemode') {
    return [
      '本请求可通过 `codemode` 调用 `todo_write`，仅在脚本内使用 `await tools.todo_write({ todos: [...] })`。',
      '非平凡的多步工作在开始实施前，用它列出具体步骤和必要验证；首次更新时将马上开始的第一步设为 `in_progress`，其余步骤按依赖列为 `pending`。简单问题或单步改动跳过待办。',
      '只有彼此独立且确有并行价值的步骤才并行处理；待办在串行时只标一个 `in_progress`，只有真实并行时才标多个。每完成一步立即更新；新发现改变范围或顺序时及时修订。没有对应证据，不得把实现或验证标为完成。',
    ].join('\n')
  }

  return [
    '本请求没有可调用的执行待办工具。多步工作用简短消息说明已完成、当前和下一步；简单任务无需过程播报。不要编造或要求调用当前不可用的工具。',
  ].join('\n')
}

function projectScope(input: { env: { cwd?: string } | undefined }): string {
  const cwd = input.env?.cwd
  if (typeof cwd !== 'string' || cwd.trim() === '') return '本请求未提供工作区路径，不推测项目位置。'
  return `当前工作区（默认当前项目）由 Host 提供：${JSON.stringify(cwd)}。把此目录作为本次任务的项目范围。`
}

const runtimeCoreSection = section('runtime-core', () => RUNTIME_CORE_PROMPT)

const workPolicySection = section('work-policy', async (input, context) => {
  const plan = await input.read.snapshot(Plans, input.conversationId, context)
  if (plan?.active === true) {
    return [
      projectScope(input),
      '计划模式已开启：只读研究并形成或修订计划，不实施、不维护执行待办，也不启动自动续跑工作目标。使用本请求实际提供的计划提交能力；若没有，则在答复中给出计划并结束本轮，等待用户决定。用户要求修改时先修订；只有 Host 确认计划模式已关闭后才实施，口头同意本身不改变模式。研究进展或受阻时用简短文字说明已完成、当前和下一步。',
    ].join('\n\n')
  }

  return [projectScope(input), todoPolicy(todoRoute(input))].join('\n\n')
})

/** Default behavior policy. This extension deliberately contributes no tools or hooks. */
export function createWorkPolicyExtension(): Extension {
  return defineExtension({
    name: WORK_POLICY_EXTENSION_NAME,
    sections: [runtimeCoreSection, workPolicySection],
  })
}
