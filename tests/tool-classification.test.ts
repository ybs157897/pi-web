import { describe, expect, it } from 'vitest'
import type { ChatMessage } from '../src/shared/types.ts'
import type { ToolItem } from '../src/web/render-model.ts'
import { buildToolRenderModel, toolRowTitle } from '../src/web/tool-render-model.ts'

/** Chinese-only translator, mirroring the app's own locale switch. */
const zh = (chinese: string): string => chinese

/** English-only translator, to pin the DSH wording of the same rows. */
const en = (_chinese: string, english: string): string => english

function assistant(blocks: ChatMessage['blocks']): ChatMessage {
  return { id: 'assistant-tool', role: 'assistant', blocks, timestamp: 200 }
}

/** Build the render model of one tool call, the way the transcript builds its rows. */
const build = (
  name: string,
  args: Record<string, unknown>,
  result: Partial<ChatMessage> = {},
  t: (chinese: string, english: string) => string = zh,
): ReturnType<typeof buildToolRenderModel> => {
  const message = assistant([{ type: 'toolCall', id: `call:${name}`, name, arguments: args }])
  const item: ToolItem = {
    key: `tool:call:${name}`,
    message,
    call: { type: 'toolCall', id: `call:${name}`, name, arguments: args },
    result: {
      id: `result:${name}`, role: 'tool', blocks: [], timestamp: 300,
      toolCallId: `call:${name}`, toolName: name, ...result,
    } satisfies ChatMessage,
    children: [],
    order: 0,
  }
  return buildToolRenderModel(item, t, false)
}

describe('tool row titles', () => {
  it('names the listing, todo, skill, and stop-task rows instead of leaving them generic', () => {
    expect(build('list_files', { path: '.' }).title).toBe('搜索列表')
    expect(build('todo_write', { todos: [] }).title).toBe('待办')
    expect(build('skill', { name: 'demo' }).title).toBe('技能')
    expect(build('task_stop', { task_id: 't-1' }).title).toBe('停止任务')
  })

  it('gives every plan-category tool the todo title', () => {
    for (const name of ['todo_write', 'create_goal', 'update_goal', 'get_goal', 'exit_plan_mode']) {
      expect(toolRowTitle(name, zh)).toBe('待办')
    }
  })

  it('keeps the settled rows and the English wording unchanged', () => {
    expect(build('bash', { command: 'pwd' }).title).toBe('运行命令')
    expect(toolRowTitle('list_files', en)).toBe('List files')
    expect(toolRowTitle('todo_write', en)).toBe('Todos')
    expect(toolRowTitle('skill', en)).toBe('Skill')
    expect(toolRowTitle('task_stop', en)).toBe('Stop task')
  })
})

describe('tool row summaries', () => {
  it('shows the raw list_files request instead of a paraphrased directory', () => {
    expect(build('list_files', { path: '.' }).summary).toBe('{ "name": "list_files", "arguments": { "path": "." } }')
    expect(build('list_files', { path: '.', maxEntries: 60 }).summary).toBe('{ "name": "list_files", "arguments": { "path": ".", "maxEntries": 60 } }')
    expect(build('list_files', {}).summary).toBe('{ "name": "list_files", "arguments": {} }')
  })

  it('names the query of a search row before the path it searched', () => {
    const grep = build('grep', { pattern: 'hello', path: 'src' }, { blocks: [{ type: 'text', text: 'a.ts:3:hello world' }] })
    expect(grep.summary).toBe('查找 hello')
    // The summary change must not disturb the match card the result parses into.
    expect(grep.search).toMatchObject({ kind: 'matches', files: [{ path: 'a.ts' }] })

    expect(build('glob', { pattern: '**/*.ts', path: 'src' }).summary).toBe('查找 **/*.ts')
    expect(build('grep', { pattern: 'hello', path: 'src' }, {}, en).summary).toBe('Find hello')
    // Without a query the row falls back to the path it did search.
    expect(build('glob', { path: 'src' }).summary).toBe('src')
  })

  it('keeps path-first summaries for file reads', () => {
    expect(build('read', { path: 'a.ts' }).summary).toBe('a.ts')
  })
})
