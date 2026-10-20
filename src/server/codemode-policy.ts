import { createCodemodeExtension, CODEMODE_TOOL_NAME, type CodemodeToolOptions } from '@earendil-works/pi-durable/codemode'
import type { Extension } from '@earendil-works/pi-durable'

/** Nested-only declarations stay bounded; direct tools already carry their complete schemas. */
export const CODEMODE_INLINE_BUDGET = 1_200

export function createRuntimeCodemodeExtension(options: CodemodeToolOptions): Extension {
  const extension = createCodemodeExtension({ ...options, inlineBudget: CODEMODE_INLINE_BUDGET })
  return {
    ...extension,
    sections: extension.sections?.map(item => ({
      ...item,
      render: async (input, context) => {
        // A Preset can select an extension without exposing its tool.
        if (!input.agent.tools.some(tool => tool.name === CODEMODE_TOOL_NAME)) return undefined
        const direct = new Set(input.agent.tools.filter(tool => tool.name !== CODEMODE_TOOL_NAME).map(tool => tool.name))
        const shared = input.agent.callable.filter(tool => direct.has(tool.name))
        const nested = await item.render({
          ...input,
          agent: { ...input.agent, callable: input.agent.callable.filter(tool => !direct.has(tool.name)) },
        }, context)
        return [
          direct.size === 0
            ? 'Only codemode is directly offered in this request. Invoke other tools inside its scripts. Ordinary assistant text is still available: for multi-step work, send a short progress message outside scripts before the first tool call. Tool output and todo updates do not replace this message.'
            : 'Use direct tools for individual operations; use codemode when batching or scripting helps. Both routes have the same permissions.',
          'Before calling a nested tool whose full declaration is absent from this request, use describeTool(name) to inspect its arguments and return type. Do not guess a schema from the tool name or a usage example.',
          ...(shared.length === 0 ? [] : [
            `Scripts can also call these directly offered tools with the same argument schemas: ${shared.map(tool => tool.name).join(', ')}.`,
            'Call them as await tools.<name>(args). Use describeTool(name) for the script declaration and return type; searchTools(query) finds other callable tools.',
          ]),
          nested,
        ].filter(Boolean).join('\n')
      },
    })),
  }
}
