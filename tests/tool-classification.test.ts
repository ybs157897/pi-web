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
    expect(build('list_files', { path: '.' }).title).toBe('已列出目录')
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
  it('keeps the settled rows and the English wording unchanged', () => {
    expect(build('bash', { command: 'pwd' }).title).toBe('已执行')
    expect(toolRowTitle('list_files', en)).toBe('Listed directory')
    expect(toolRowTitle('todo_write', en)).toBe('Todos')
    expect(toolRowTitle('skill', en)).toBe('Skill')
    expect(toolRowTitle('task_stop', en)).toBe('Stop task')
  })
})

describe('tool row summaries', () => {
  it('keeps nested file targets available without turning a script into a single-file row', () => {
    const artifacts = [{ kind: 'read', path: '/project/input.txt' }, { kind: 'write', path: '/project/output.txt' }] as const
    const model = build('codemode', { code: 'await tools.read({path: "input.txt"})' }, {
      artifacts: [...artifacts], blocks: [{ type: 'text', text: 'read then wrote' }],
    })
    expect(model.artifacts).toEqual(artifacts)
    expect(model.title).toBe('已运行脚本')
    expect(model.path).toBeUndefined()
    expect(model.read).toBeUndefined()
    expect(model.diffs).toBeUndefined()
  })

  it('opens a direct edit and its diff at the path resolved by the file tool', () => {
    const model = build('edit', { path: 'notes.txt', oldText: 'one', newText: 'two' }, {
      details: { resolvedPath: '/project/notes.txt' },
    })
    expect(model.path).toBe('/project/notes.txt')
    expect(model.diffs?.[0]?.path).toBe('/project/notes.txt')
  })

  it('summarizes what directory was listed without exposing raw arguments', () => {
    expect(build('list_files', { path: '.', maxEntries: 60 }).summary).toBe('工作区根目录')
    expect(build('list_files', { path: '.', recursive: true }).summary).toBe('工作区根目录，包含子目录')
    expect(build('list_files', { path: 'docs/notes' }).summary).toBe('docs/notes')
    expect(build('list_files', {}).summary).toBe('工作区根目录')
    expect(build('codemode', { code: 'await tools.list_files({path: "."})' }, { details: {
      calls: [{ id: 1, name: 'list_files', args: '{"path":"."}', status: 'ok' }],
    } }).summary).toBe('列出 工作区根目录')
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
    expect(build('read', { path: '/some/long/private/path/docs/a.ts' }).summary).toBe('…/docs/a.ts')
  })

  it('uses diagnostics from persisted and live results to explain failures', () => {
    expect(build('read', { path: 'sample.txt' }, {
      isError: true,
      blocks: [{ type: 'text', text: "<harness>\n[error] ENOENT: no such file or directory, open '/work/sample.txt'\n</harness>" }],
    })).toMatchObject({ title: '读取文件失败', summary: 'sample.txt', failureReason: '找不到文件' })
    expect(build('grep', { pattern: '村', path: '/work/source' }, {
      status: 'error', details: { diagnostics: [{ severity: 'error', message: 'Workspace paths must be relative and no longer than 1024 characters.' }] },
    })).toMatchObject({ title: '搜索失败', summary: '查找 村', failureReason: '工作区路径需为相对路径，且至多 1024 个字符' })
    expect(build('bash', { command: 'npm test' }, {
      isError: true, details: { exitCode: 2 },
    })).toMatchObject({ title: '命令未成功完成', summary: 'npm', failureReason: '命令返回退出码 2' })
    const unknown = build('read', { path: 'sample.txt' }, {
      isError: true, blocks: [{ type: 'text', text: '<harness>\n[error] Unclassified internal error\n</harness>' }],
    })
    expect(unknown.failureReason).toBeUndefined()
    expect(unknown.read).toBeUndefined()
  })
})
