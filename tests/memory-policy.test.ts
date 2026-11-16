import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Extension, ToolRegistration } from '@earendil-works/pi-durable'
import { createMemoryExtension, memoryInstructions, MEMORY_EXTENSION_NAME } from '../src/server/memory/policy.ts'
import { resolveMemoryRoot } from '../src/server/memory/store.ts'

/** 临时目录清理队列，用例结束后逆序删除。 */
const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

/**
 * 构造记忆扩展夹具：临时 dataDir/workspace、可配置开关与工具面，并提供 render/wrap 便捷入口。
 * @param options enabled=记忆开关；planActive=Plan 激活；tools=工具白名单；memory=预置的 MEMORY.md 内容
 * @returns 夹具对象（含 extension、render、wrap、memoryRoot 等）
 */
async function fixture(options: { enabled?: boolean; planActive?: boolean; tools?: string[]; memory?: string } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'pi-web-memory-policy-'))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  const dataDir = join(root, 'data')
  const workspace = join(root, 'workspace')
  await mkdir(workspace, { recursive: true })
  const memoryRoot = resolveMemoryRoot({ dataDir, workspacePath: workspace })
  const extension = createMemoryExtension({ dataDir, memoryEnabled: () => options.enabled ?? true })
  const input = {
    conversationId: 1,
    env: { cwd: workspace },
    shown: {},
    agent: { tools: (options.tools ?? ['write', 'edit', 'read']).map(name => ({ name })), callable: [] },
    read: { snapshot: async () => ({ active: options.planActive ?? false, updatedAt: 1 }) },
  }
  /**
   * 按 section key 渲染扩展 section。
   * @param key section 标识（memory / memory-index）
   * @returns 渲染文本；section 不存在时抛错
   */
  const render = async (key: string): Promise<string | undefined> => {
    const item = extension.sections?.find(section => section.key === key)
    if (item === undefined) throw new Error(`missing section ${key}`)
    return await item.render(input as never, {} as never)
  }
  /**
   * 取 write/edit 的包装器。
   * @param name 工具名（write 或 edit）
   * @returns 把 ToolRegistration 包上戳记逻辑的函数；wrap 不存在时抛错
   */
  const wrap = (name: 'write' | 'edit') => {
    const entry = extension.wraps?.find(item => 'tool' in item && item.tool === name) as
      | { tool: string; wrap(tool: ToolRegistration): ToolRegistration }
      | undefined
    if (entry === undefined) throw new Error(`missing wrap ${name}`)
    return (tool: ToolRegistration) => entry.wrap(tool)
  }
  return { root, dataDir, workspace, memoryRoot, extension, render, wrap, input }
}

/**
 * 记忆扩展身份测试：扩展贡献两个 section（memory、memory-index）与 write/edit 两个戳记包装，
 * 不注册任何工具。
 */
describe('memory extension identity', () => {
  // 扩展名、section 键列表（memory 在 memory-index 前）、wrap 工具列表（write、edit）与「无工具注册」都要精确匹配。
  it('contributes two tagged sections and the write/edit stamp wraps', async () => {
    const f = await fixture()
    const extension: Extension = f.extension

    expect(extension.name).toBe(MEMORY_EXTENSION_NAME)
    expect(extension.sections?.map(section => section.key)).toEqual(['memory', 'memory-index'])
    expect(extension.wraps?.map(item => ('tool' in item ? item.tool : item.section))).toEqual(['write', 'edit'])
    expect(extension.tools).toBeUndefined()
  })
})

/**
 * 记忆保存协议 section 测试。
 *
 * 关键契约：
 * - memory section 渲染保存协议：含绝对记忆根路径、metadata 模板、节点类型枚举、
 *   MEMORY.md 先读后改与「不重复保存仓库已记录内容」纪律；
 * - 记忆关闭或未绑定 workspace 时整个 section 省略；
 * - 只读工具面（无 write/edit，含 Plan 模式）也省略——保存协议需要写工具，背景提取负责兜底。
 */
describe('memory instructions section', () => {
  // 渲染内容与 memoryInstructions(memoryRoot) 一致，且包含根路径、metadata、节点类型枚举与关键纪律文案。
  it('renders the save protocol with the absolute memory root', async () => {
    const f = await fixture()
    const rendered = await f.render('memory')

    expect(rendered).toBe(memoryInstructions(f.memoryRoot))
    expect(rendered).toContain(`\`${f.memoryRoot}/\``)
    expect(rendered).toContain('metadata:')
    expect(rendered).toContain('user | feedback | project | reference')
    expect(rendered).toContain('MEMORY.md')
    expect(rendered).toContain('修改 `MEMORY.md` 前先 read 它')
    expect(rendered).toContain('不要保存仓库本身已记录的内容')
  })

  // 记忆关闭（enabled=false）或 env 未绑定 workspace（env=undefined）时 section 均省略。
  it('omits the section when memory is disabled or no workspace is bound', async () => {
    const disabled = await fixture({ enabled: false })
    expect(await disabled.render('memory')).toBeUndefined()

    const f = await fixture()
    const item = f.extension.sections?.find(section => section.key === 'memory')
    const rendered = await item?.render({ ...f.input, env: undefined } as never, {} as never)
    expect(rendered).toBeUndefined()
  })

  // 只读工具面（read/list/search/glob/grep）省略 section；Plan 模式把 write/edit 从工具面过滤掉，同样省略（由背景提取兜底）。
  it('omits the section for a read-only tool surface, including plan mode', async () => {
    const readOnly = await fixture({ tools: ['read', 'list_files', 'search_files', 'glob', 'grep'] })
    expect(await readOnly.render('memory')).toBeUndefined()

    // Plan 模式会把 write/edit 从宣告的工具面中滤掉，因此保存协议不出现；
    // 「记住这个」仍由后台提取捕获。
    const plan = await fixture({ tools: ['read'], planActive: true })
    expect(await plan.render('memory')).toBeUndefined()
  })
})

/**
 * 记忆索引 section 测试。
 *
 * 关键契约：MEMORY.md 存在且非空时渲染其（去 frontmatter）内容；为空或缺失时省略；
 * 记忆关闭时即使文件存在也省略。
 */
describe('memory index section', () => {
  // 有内容的 MEMORY.md 渲染出正文（不含 frontmatter）；清空后省略；文件缺失的全新夹具也省略。
  it('renders a loaded index and omits missing or empty files', async () => {
    const f = await fixture()
    await mkdir(f.memoryRoot, { recursive: true })
    await writeFile(join(f.memoryRoot, 'MEMORY.md'), '---\nname: index\n---\n- [One](one.md) — first\n', 'utf8')

    const rendered = await f.render('memory-index')
    expect(rendered).toContain(`\`${join(f.memoryRoot, 'MEMORY.md')}\` 的内容`)
    expect(rendered).toContain('- [One](one.md) — first')
    expect(rendered).not.toContain('name: index')

    await writeFile(join(f.memoryRoot, 'MEMORY.md'), '', 'utf8')
    expect(await f.render('memory-index')).toBeUndefined()

    const missing = await fixture()
    expect(await missing.render('memory-index')).toBeUndefined()
  })

  // 记忆关闭时即使 MEMORY.md 有内容也不渲染索引。
  it('omits the index when memory is disabled', async () => {
    const f = await fixture({ enabled: false })
    await mkdir(f.memoryRoot, { recursive: true })
    await writeFile(join(f.memoryRoot, 'MEMORY.md'), '- [One](one.md) — first\n', 'utf8')
    expect(await f.render('memory-index')).toBeUndefined()
  })
})

/**
 * 记忆戳记包装（write/edit wrap）测试。
 *
 * 关键契约：
 * - write 到安全的记忆 .md 文件时，内容在工具执行前补上 node_type/originSessionId 戳记；
 * - 非记忆路径、受保护段（.git）、非 .md、记忆关闭时全部原样透传；
 * - edit 成功后对事实文件补戳；工具返回 isError 时跳过补戳。
 */
describe('memory stamp wraps', () => {
  /**
   * 构造一个最小 write 工具注册。
   * @param execute 接收 {path, content} 并返回结果的对象
   * @returns ToolRegistration
   */
  function writeTool(execute: (args: { path: string; content: string }) => Promise<{ isError?: boolean }>): ToolRegistration {
    return {
      name: 'write',
      description: 'write',
      parameters: { type: 'object', properties: {}, required: [] },
      execute: async (args: never) => execute(args as never),
    } as unknown as ToolRegistration
  }

  /**
   * 构造一个最小 edit 工具注册。
   * @param execute 接收 {path, edits} 并返回结果的对象
   * @returns ToolRegistration
   */
  function editTool(execute: (args: { path: string; edits: Array<{ oldText: string; newText: string }> }) => Promise<{ isError?: boolean }>): ToolRegistration {
    return {
      name: 'edit',
      description: 'edit',
      parameters: { type: 'object', properties: {}, required: [] },
      execute: async (args: never) => execute(args as never),
    } as unknown as ToolRegistration
  }

  /**
   * 构造执行上下文：cwd 指向夹具 workspace，会话 id 固定为 7（originSessionId 的来源）。
   * @param f 夹具对象
   * @returns 传给 wrapped.execute 的 api 参数
   */
  function api(f: Awaited<ReturnType<typeof fixture>>) {
    return { env: { cwd: f.workspace }, conversationId: 7 } as never
  }

  // write 到 memoryRoot/prefs.md：工具实际收到的 content 已带 node_type: memory 与 originSessionId: "7"。
  it('stamps a write to a safe memory Markdown file before the tool runs', async () => {
    const f = await fixture()
    let received: { path: string; content: string } | undefined
    const wrapped = f.wrap('write')(writeTool(async args => {
      received = args
      return {}
    }))
    await wrapped.execute({
      path: join(f.memoryRoot, 'prefs.md'),
      content: '---\nname: prefs\n---\nBody\n',
    } as never, api(f), {} as never)

    expect(received?.content).toContain('node_type: memory')
    expect(received?.content).toContain('originSessionId: "7"')
  })

  // 三类透传（root 外路径、.git 受保护段、.txt 非 Markdown）加记忆关闭，内容全部原样不戳。
  it('passes through non-memory paths, protected segments, and disabled memory', async () => {
    const enabled = await fixture()
    const cases = [
      join('/tmp', 'outside.md'),
      join(enabled.memoryRoot, '.git', 'x.md'),
      join(enabled.memoryRoot, 'prefs.txt'),
    ]
    for (const path of cases) {
      let received: { content: string } | undefined
      const wrapped = enabled.wrap('write')(writeTool(async args => {
        received = args
        return {}
      }))
      await wrapped.execute({ path, content: '---\nname: x\n---\nBody\n' } as never, api(enabled), {} as never)
      expect(received?.content, path).toBe('---\nname: x\n---\nBody\n')
    }

    const disabled = await fixture({ enabled: false })
    let received: { content: string } | undefined
    const wrapped = disabled.wrap('write')(writeTool(async args => {
      received = args
      return {}
    }))
    await wrapped.execute({ path: join(disabled.memoryRoot, 'prefs.md'), content: '---\nname: x\n---\nBody\n' } as never, api(disabled), {} as never)
    expect(received?.content).toBe('---\nname: x\n---\nBody\n')
  })

  // edit 成功执行后 prefs.md 落盘内容带 originSessionId: "7"；返回 isError 的调用不补戳（failed.md 无 origin）。
  it('stamps an edited fact file after a successful call and skips failed calls', async () => {
    const f = await fixture()
    await mkdir(f.memoryRoot, { recursive: true })
    const source = join(f.memoryRoot, 'prefs.md')
    await writeFile(source, '---\nname: prefs\ndescription: a fact\n---\nBody\n', 'utf8')

    const wrapped = f.wrap('edit')(editTool(async args => {
      await writeFile(args.path, '---\nname: prefs\ndescription: a fact\n---\nBody updated\n', 'utf8')
      return {}
    }))
    await wrapped.execute({ path: source, edits: [{ oldText: 'Body', newText: 'Body updated' }] } as never, api(f), {} as never)
    const stamped = await readFile(source, 'utf8')
    expect(stamped).toContain('originSessionId: "7"')

    const failing = join(f.memoryRoot, 'failed.md')
    await writeFile(failing, '---\nname: failed\n---\nBody\n', 'utf8')
    const failedWrap = f.wrap('edit')(editTool(async () => ({ isError: true })))
    await failedWrap.execute({ path: failing, edits: [] } as never, api(f), {} as never)
    expect(await readFile(failing, 'utf8')).not.toContain('originSessionId')
  })
})
