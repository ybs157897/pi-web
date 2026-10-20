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
export function toolRouteInstruction(name: string, route: ToolRoute, args?: string): string | undefined {
  if (route === 'direct') return `Call \`${name}${args === undefined ? '' : `(${args})`}\` directly.`
  if (route === 'codemode') {
    return `Through \`${CODEMODE_TOOL_NAME}\`, call \`await tools.${name}(${args ?? '{ ... }'})\` inside the script.`
  }
  return undefined
}
