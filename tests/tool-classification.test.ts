import { describe, expect, it } from 'vitest'
import type { ChatMessage } from '../src/shared/types.ts'
import type { ToolItem } from '../src/web/render-model.ts'
import { buildToolRenderModel, toolRowTitle } from '../src/web/tool-render-model.ts'

/** 仅中文翻译器，与应用自身的 locale 开关一致。 */
const zh = (chinese: string): string => chinese

/** 仅英文翻译器，用于固定（pin）同行标题的 DSH 英文措辞。 */
const en = (_chinese: string, english: string): string => english

/**
 * 构造一条助手消息 fixture。
 * @param blocks 消息块（通常是单个 toolCall 块）
 * @returns id 固定、时间戳 200 的 ChatMessage
 */
function assistant(blocks: ChatMessage['blocks']): ChatMessage {
  return { id: 'assistant-tool', role: 'assistant', blocks, timestamp: 200 }
}

/**
 * 按会话转录行的方式构造单次工具调用的渲染模型。
 * @param name 工具名
 * @param args 工具调用参数
 * @param result 覆盖工具结果消息默认字段的属性
 * @param t 翻译函数，默认中文
 * @returns buildToolRenderModel 的渲染模型（含 title/summary/search 等）
 */
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

/** 工具行分类契约测试：行标题（title）与摘要（summary）如何按工具名与参数生成。 */
describe('tool row titles', () => {
  // 反回归：这些高频工具行必须有具名标题，不允许退化为通用「工具」占位。
  it('names the listing, todo, skill, and stop-task rows instead of leaving them generic', () => {
    expect(build('list_files', { path: '.' }).title).toBe('搜索列表')
    expect(build('todo_write', { todos: [] }).title).toBe('待办')
    expect(build('skill', { name: 'demo' }).title).toBe('技能')
    expect(build('task_stop', { task_id: 't-1' }).title).toBe('停止任务')
  })

  // 计划类工具同族归并为「待办」标题，避免每种 goal 工具各造一个名字。
  it('gives every plan-category tool the todo title', () => {
    for (const name of ['todo_write', 'create_goal', 'update_goal', 'get_goal', 'exit_plan_mode']) {
      expect(toolRowTitle(name, zh)).toBe('待办')
    }
  })

  // 拆分后的技能工具按操作命名（加载/列表/保存/校验），中英双语都要成立。
  it('names each split skill tool by its operation', () => {
    expect(toolRowTitle('skill_load', zh)).toBe('技能')
    expect(toolRowTitle('skill_list', zh)).toBe('技能列表')
    expect(toolRowTitle('skill_save', zh)).toBe('保存技能')
    expect(toolRowTitle('skill_validate', zh)).toBe('校验技能')
    expect(toolRowTitle('skill_load', en)).toBe('Skill')
    expect(toolRowTitle('skill_validate', en)).toBe('Validate skill')
  })

  // 已定稿（settled）的行标题与英文措辞被显式 pin 住，防止无意改名。
  // 完成态动词对齐 ZCode summary 行（「已执行」）；list_files 保留有意偏离的「搜索列表」。
  it('keeps the settled rows and the English wording unchanged', () => {
    expect(build('bash', { command: 'pwd' }).title).toBe('已执行')
    expect(toolRowTitle('list_files', en)).toBe('List files')
    expect(toolRowTitle('todo_write', en)).toBe('Todos')
    expect(toolRowTitle('skill', en)).toBe('Skill')
    expect(toolRowTitle('task_stop', en)).toBe('Stop task')
  })
})

describe('tool row summaries', () => {
  // list_files 特例：摘要原样展示调用请求 JSON，不做「浏览目录」之类的意译。
  it('shows the raw list_files request instead of a paraphrased directory', () => {
    expect(build('list_files', { path: '.' }).summary).toBe('{ "name": "list_files", "arguments": { "path": "." } }')
    expect(build('list_files', { path: '.', maxEntries: 60 }).summary).toBe('{ "name": "list_files", "arguments": { "path": ".", "maxEntries": 60 } }')
    expect(build('list_files', {}).summary).toBe('{ "name": "list_files", "arguments": {} }')
  })

  // 搜索行摘要以查询词为先（「查找 hello」），路径退居次要；
  // 无查询词时回退为搜索过的路径。
  it('names the query of a search row before the path it searched', () => {
    const grep = build('grep', { pattern: 'hello', path: 'src' }, { blocks: [{ type: 'text', text: 'a.ts:3:hello world' }] })
    expect(grep.summary).toBe('查找 hello')
    // 摘要改动不得影响结果解析出的匹配卡片。
    expect(grep.search).toMatchObject({ kind: 'matches', files: [{ path: 'a.ts' }] })

    expect(build('glob', { pattern: '**/*.ts', path: 'src' }).summary).toBe('查找 **/*.ts')
    expect(build('grep', { pattern: 'hello', path: 'src' }, {}, en).summary).toBe('Find hello')
    // Without a query the row falls back to the path it did search.
    expect(build('glob', { path: 'src' }).summary).toBe('src')
  })

  // read 行维持「路径优先」摘要，与搜索行（查询优先）形成对照。
  it('keeps path-first summaries for file reads', () => {
    expect(build('read', { path: 'a.ts' }).summary).toBe('a.ts')
  })
})
