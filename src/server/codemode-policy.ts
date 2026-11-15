import { createCodemodeExtension, CODEMODE_TOOL_NAME, type CodemodeToolOptions } from '@earendil-works/pi-durable/codemode'
import type { Extension } from '@earendil-works/pi-durable'

/** codemode 内嵌工具声明的字符预算：仅限嵌套（不直接提供完整声明的）工具；直接工具本身已带完整 schema。 */
export const CODEMODE_INLINE_BUDGET = 1_200

/**
 * 功能：创建 pi-web 运行时的 codemode 扩展，并在其 section 渲染层附加路由约束说明。
 * 贡献：贡献 codemode 工具与其相关 section（由 pi-durable 的 createCodemodeExtension 提供），
 * pi-web 额外改写每个 section 渲染，注入直接工具与嵌套工具的使用约定。
 * @param options 透传给 createCodemodeExtension 的选项；inlineBudget 被强制覆写为 CODEMODE_INLINE_BUDGET。
 * @returns 改写后的扩展；若原 section 存在，渲染时会拼接本请求的路由政策文本。
 * 内部逻辑：先把直接工具集排除后交给原渲染（避免重复声明），再按"是否只有 codemode 工具"给出不同首行，
 * 并在存在可直接调用的共享工具时列出它们；未暴露 codemode 工具时该 section 返回 undefined。
 */
export function createRuntimeCodemodeExtension(options: CodemodeToolOptions): Extension {
  const extension = createCodemodeExtension({ ...options, inlineBudget: CODEMODE_INLINE_BUDGET })
  return {
    ...extension,
    sections: extension.sections?.map(item => ({
      ...item,
      render: async (input, context) => {
        // 扩展已安装不代表 codemode 工具一定暴露给了本请求。
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
