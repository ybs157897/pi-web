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
  fork: 'initial',
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
        'Record and update a task list to plan multi-step work and show progress; skip trivial single-step work.',
        'Add one concrete step per item before starting, including relevant verification.',
        'Replace the entire list on every call, so include every current item; anything omitted is removed.',
        'Update statuses promptly as work changes and mark an item completed as soon as it is done.',
        'Mark an item in_progress only while actively working on it; use multiple in_progress items only for work actually running in parallel.',
        'Do not use the list as a substitute for the plan-mode plan; it tracks steps you are actually carrying out.',
      ].join(' '),
      parameters: Type.Object({
        todos: Type.Array(Type.Object({ content: Type.String(), status: TODO_STATUS })),
      }),
      execute: async (args, api, context) => {
        const plan = await api.snapshot(Plans, api.conversationId, context)
        if (plan?.active === true) {
          throw new Error('Todo progress cannot be updated while plan mode is active. Finish planning and wait for approval before tracking implementation work.')
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
            throw new Error('Todo progress cannot be updated while plan mode is active. Finish planning and wait for approval before tracking implementation work.')
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
