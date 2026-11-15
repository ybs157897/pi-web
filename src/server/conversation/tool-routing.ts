import { CODEMODE_TOOL_NAME } from '@earendil-works/pi-durable/codemode'

/** 提示词渲染时模型侧可见的 agent 工具目录：`tools` 为直接工具集，`callable` 为 codemode 脚本内可调用集。 */
export type ToolCatalog = {
  tools: readonly { name: string }[]
  callable: readonly { name: string }[]
}

/** 一个工具在本请求中的调用路由：直接调用 / 经 codemode 脚本调用 / 本请求不可用。 */
export type ToolRoute = 'direct' | 'codemode' | 'unavailable'

/**
 * 功能：按 Pi 将随请求发给模型的 agent 目录，解析某工具在本请求中的真实调用路由。
 * @param agent 本请求可见的工具目录（直接工具集与 codemode 可调用集）。
 * @param name 工具名。
 * @returns 'direct' 出现在直接工具集；'codemode' codemode 开启且工具在其可调用集合中；'unavailable' 两者皆否。
 * 内部逻辑：先查直接工具集（短路返回），再要求 codemode 工具本身也在直接工具集内（脚本能力已开启）且目标工具可调用。
 */
export function resolveToolRoute(agent: ToolCatalog, name: string): ToolRoute {
  if (agent.tools.some(tool => tool.name === name)) return 'direct'
  if (agent.tools.some(tool => tool.name === CODEMODE_TOOL_NAME)
    && agent.callable.some(tool => tool.name === name)) return 'codemode'
  return 'unavailable'
}

/**
 * 功能：为一条当前请求确实可用的路由生成一行调用指引文案。
 * @param name 工具名。
 * @param route resolveToolRoute 的结果。
 * @param args 可选的参数示意（如 `path, offset`），插入调用示例中。
 * @param lang 文案语言，默认中文。
 * @returns 对应语言的调用写法；route 为 'unavailable' 时返回 undefined，由调用方过滤。
 * 内部逻辑：direct 给出直接调用形式；codemode 给出 `await tools.<name>(...)` 的脚本内调用形式。
 */
export function toolRouteInstruction(name: string, route: ToolRoute, args?: string, lang: 'en' | 'zh' = 'zh'): string | undefined {
  if (route === 'direct') return lang === 'zh'
    ? `直接调用 \`${name}${args === undefined ? '' : `(${args})`}\``
    : `Call \`${name}${args === undefined ? '' : `(${args})`}\` directly.`
  if (route === 'codemode') {
    if (lang === 'zh') return `在 \`${CODEMODE_TOOL_NAME}\` 脚本里调用 \`await tools.${name}(${args ?? '{ ... }'})\``
    return `Through \`${CODEMODE_TOOL_NAME}\`, call \`await tools.${name}(${args ?? '{ ... }'})\` inside the script.`
  }
  return undefined
}
