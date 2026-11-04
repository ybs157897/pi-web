import { CODEMODE_TOOL_NAME } from '@earendil-works/pi-durable/codemode'

export type ToolCatalog = {
  tools: readonly { name: string }[]
  callable: readonly { name: string }[]
}

export type ToolRoute = 'direct' | 'codemode' | 'unavailable'

/** Resolve a tool's actual request route from the agent catalog Pi will send to the model. */
export function resolveToolRoute(agent: ToolCatalog, name: string): ToolRoute {
  if (agent.tools.some(tool => tool.name === name)) return 'direct'
  if (agent.tools.some(tool => tool.name === CODEMODE_TOOL_NAME)
    && agent.callable.some(tool => tool.name === name)) return 'codemode'
  return 'unavailable'
}

/** Describe only a route that the current request can actually invoke. */
export function toolRouteInstruction(name: string, route: ToolRoute, args?: string, lang: 'en' | 'zh' = 'en'): string | undefined {
  if (route === 'direct') return lang === 'zh'
    ? `直接调用 \`${name}${args === undefined ? '' : `(${args})`}\``
    : `Call \`${name}${args === undefined ? '' : `(${args})`}\` directly.`
  if (route === 'codemode') {
    if (lang === 'zh') return `在 \`${CODEMODE_TOOL_NAME}\` 脚本里调用 \`await tools.${name}(${args ?? '{ ... }'})\``
    return `Through \`${CODEMODE_TOOL_NAME}\`, call \`await tools.${name}(${args ?? '{ ... }'})\` inside the script.`
  }
  return undefined
}
