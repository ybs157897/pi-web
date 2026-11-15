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
        // An installed extension may be present without its tool being exposed.
        if (!input.agent.tools.some(tool => tool.name === CODEMODE_TOOL_NAME)) return undefined
        const direct = new Set(input.agent.tools.filter(tool => tool.name !== CODEMODE_TOOL_NAME).map(tool => tool.name))
        const shared = input.agent.callable.filter(tool => direct.has(tool.name))
        const nested = await item.render({
          ...input,
          agent: { ...input.agent, callable: input.agent.callable.filter(tool => !direct.has(tool.name)) },
        }, context)
        return [
          direct.size === 0
            ? '本请求只直接提供 codemode 工具，其他工具须在其脚本内调用。仍可输出普通助手文本：多步工作在第一次工具调用前，先在脚本外简短说明进度；工具输出和待办更新不能代替这条消息。'
            : '单项操作使用直接工具；批量操作或脚本编排有帮助时使用 codemode。两种调用方式具有相同权限。',
          '调用本请求中未提供完整声明的嵌套工具前，用 describeTool(name) 查看其参数和返回类型。不要根据工具名或使用示例猜测参数结构。',
          ...(shared.length === 0 ? [] : [
            `脚本也可以按相同的参数结构调用这些直接提供的工具：${shared.map(tool => tool.name).join(', ')}。`,
            '调用形式为 await tools.<name>(args)。用 describeTool(name) 查看脚本声明和返回类型；用 searchTools(query) 查找其他可调用工具。',
          ]),
          nested,
        ].filter(Boolean).join('\n')
      },
    })),
  }
}
