import { defineDoc, defineExtension, defineTool, type Extension } from '@earendil-works/pi-durable'
import { Type } from '@earendil-works/pi-ai'
import type { TodoItem, TodoStatus } from '../../shared/types.ts'
import { Plans } from './plan.ts'

export const MAX_TODO_ITEMS = 100

const TODO_STATUS = Type.Union([Type.Literal('pending'), Type.Literal('in_progress'), Type.Literal('completed')])

/**
 * Conversation-scoped snapshot of the latest task list. `projectConversation` reads it into
 * `ConversationDetail.todos`; `runtime` clears it when a new user input is placed, which is DSH's
 * "a new turn starts without a list" rule.
 */
export const Todos = defineDoc<{ items: TodoItem[] | null; updatedAt: number }>({
  kind: 'pi-web.todos',
  version: 1,
  scope: 'conversation',
  history: 'latest',
  fork: 'initial', checkpointWhen: () => false,
  initial: () => ({ items: null, updatedAt: 0 }),
})

function countsFor(items: readonly TodoItem[]): { pending: number; inProgress: number; completed: number } {
  const counts = { pending: 0, inProgress: 0, completed: 0 }
  for (const item of items) {
    if (item.status === 'pending') counts.pending += 1
    else if (item.status === 'in_progress') counts.inProgress += 1
    else counts.completed += 1
  }
  return counts
}

/** DSH's todo list as a Pi tool: one call replaces the whole list and stores it in the conversation document. */
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
