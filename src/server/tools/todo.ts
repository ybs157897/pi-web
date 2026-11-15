import { defineDoc, defineExtension, defineTool, type Extension } from '@earendil-works/pi-durable'
import { Type } from '@earendil-works/pi-ai'
import type { TodoItem, TodoStatus } from '../../shared/types.ts'
import { Plans } from './plan.ts'

/** 单个待办列表允许的最大事项数。 */
export const MAX_TODO_ITEMS = 100

/** `status` 字段 schema：限定为 pending / in_progress / completed 三种枚举值。 */
const TODO_STATUS = Type.Union([Type.Literal('pending'), Type.Literal('in_progress'), Type.Literal('completed')])

/**
 * 功能：会话作用域的待办列表文档，保存最新一次任务列表快照。
 * 内部逻辑：`projectConversation` 把它投影进 `ConversationDetail.todos`；`runtime` 在
 * 收到新的用户输入时清空它，对应 DSH 的"新回合开始时列表归零"规则。history 取 latest，
 * 不做 fork 与 checkpoint。
 */
export const Todos = defineDoc<{ items: TodoItem[] | null; updatedAt: number }>({
  kind: 'pi-web.todos',
  version: 1,
  scope: 'conversation',
  history: 'latest',
  fork: 'initial', checkpointWhen: () => false,
  initial: () => ({ items: null, updatedAt: 0 }),
})

/**
 * 功能：统计待办列表中各状态（pending / in_progress / completed）的数量。
 * @param items 待办事项列表。
 * @returns 三种状态的计数对象。
 */
function countsFor(items: readonly TodoItem[]): { pending: number; inProgress: number; completed: number } {
  const counts = { pending: 0, inProgress: 0, completed: 0 }
  for (const item of items) {
    if (item.status === 'pending') counts.pending += 1
    else if (item.status === 'in_progress') counts.inProgress += 1
    else counts.completed += 1
  }
  return counts
}

/**
 * 功能：todo 工具扩展——DSH 待办列表以 Pi 工具形式呈现，一次调用整体替换列表并写入会话文档。
 * 本扩展只贡献 `todo_write` 一个工具，不贡献 section。
 */
export const TodoTools: Extension = defineExtension({
  name: 'todo',
  tools: [
    defineTool({
      name: 'todo_write',
      description: [
        '记录并更新任务列表，用于安排多步工作和展示进度；简单的单步工作跳过。',
        '开始前，每项列出一个具体步骤，包括相关验证。',
        '每次调用都会替换整个列表，必须包含所有当前事项；省略的事项会被删除。',
        '工作变化时及时更新状态；事项完成后立即标记 completed。',
        '仅将正在执行的事项标记为 in_progress；只有实际并行执行的工作，才可有多个 in_progress。',
        '不要用此列表代替计划模式中的计划；它跟踪正在实际执行的步骤。',
      ].join(' '),
      parameters: Type.Object({
        todos: Type.Array(Type.Object({ content: Type.String(), status: TODO_STATUS })),
      }),
      /**
       * 功能：整体替换当前会话的待办列表。
       * 输入校验：content 去空格后不得为空；条目数不超过 MAX_TODO_ITEMS；内容不得重复。
       * 权限/边界：计划模式开启时禁止更新（快照预检 + 事务内二次确认），事务提交时写入
       * Todos 文档并刷新 updatedAt。
       * @returns 汇总文本输出，details 中携带列表与各状态计数。
       */
      execute: async (args, api, context) => {
        const plan = await api.snapshot(Plans, api.conversationId, context)
        if (plan?.active === true) {
          throw new Error('计划模式开启时不能更新待办进度。先完成规划并等待批准，再跟踪实施工作。')
        }
        const items: TodoItem[] = []
        for (const todo of args.todos) {
          const content = todo.content.trim()
          if (content === '') throw new Error('Every todo item needs non-empty content.')
          items.push({ content, status: todo.status as TodoStatus })
        }
        if (items.length > MAX_TODO_ITEMS) throw new Error(`A todo list holds at most ${MAX_TODO_ITEMS} items.`)
        const seen = new Set<string>()
        for (const item of items) {
          if (seen.has(item.content)) throw new Error(`Duplicate todo content: ${item.content}`)
          seen.add(item.content)
        }
        await api.commit(async (tx) => {
          const currentPlan = await tx.doc(Plans, api.conversationId)
          if (currentPlan.active) {
            throw new Error('计划模式开启时不能更新待办进度。先完成规划并等待批准，再跟踪实施工作。')
          }
          const doc = await tx.doc(Todos, api.conversationId)
          doc.items = items
          doc.updatedAt = Date.now()
        }, context)
        const counts = countsFor(items)
        return {
          output: [{ type: 'text' as const, text: `Updated todo list: ${counts.pending} pending, ${counts.inProgress} in progress, ${counts.completed} completed.` }],
          details: { todos: items, counts },
        }
      },
    }),
  ],
})
