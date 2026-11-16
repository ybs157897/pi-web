import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@earendil-works/chord/context'
import { NOOP_TELEMETRY_CONTEXT } from '@earendil-works/pi-telemetry'
import type { ToolExecutionApi, Tx } from '@earendil-works/pi-durable'
import { CODEMODE_TOOL_NAME } from '@earendil-works/pi-durable/codemode'
import type { ConversationId } from '@earendil-works/pi-durable'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { LoadedSkills, SKILL_READ_TOOLS, createSkillTools } from '../src/server/tools/skill.ts'
import { SkillStore } from '../src/server/skills/store.ts'

/**
 * 技能工具扩展契约测试：skill_list/load/save/validate 的数据边界（无路径泄漏、
 * 有界引用）、写权限 fail-closed、提示词路由（按请求工具集裁剪、字符预算降级、
 * 新增技能通告）。
 */
const directories: string[] = []

afterEach(async () => {
  // 清理本文件创建的临时 workspace 目录。
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

/** 测试用 Context：空遥测、无中止信号。 */
const TEST_CONTEXT: Context = {
  telemetry: NOOP_TELEMETRY_CONTEXT,
  abortSignal: undefined,
  value: () => undefined,
  toString: () => 'pi-web-skill-tools-test',
}

/** 合法的技能正文样本（frontmatter + 工作流说明），供保存/校验用例复用。 */
const SKILL_BODY = [
  '---',
  'name: smoke-check',
  'description: Run a bounded smoke check for one workspace change.',
  '---',
  '',
  '## Workflow',
  '',
  'Read the changed files, run the targeted check, and report the result.',
].join('\n')

/**
 * 创建一次性临时 workspace 目录并登记待清理。
 * @returns 临时目录绝对路径
 */
async function workspace(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'pi-web-skill-tools-'))
  directories.push(directory)
  return directory
}

/**
 * 构造工具执行 API 桩。
 * @param state 会话文档状态（skill_load 向其写入 references）
 * @returns env.cwd 为 path、commit 直写 doc 的桩实现
 */
function createApi(path: string, state: { references: Array<Record<string, unknown>> }) {
  const tx = {
    doc: async () => state,
  } as unknown as Tx
  const api = {
    env: { cwd: path },
    conversationId: 41 as ConversationId,
    commit: async <T>(change: (transaction: Tx) => T | Promise<T>): Promise<T> => change(tx),
  }
  return api as unknown as ToolExecutionApi
}

/**
 * 从扩展中按名取已注册的工具定义，缺失则抛错。
 */
function registered(extension: ReturnType<typeof createSkillTools>, name: string) {
  const tool = extension.tools?.find(candidate => candidate.name === name)
  if (!tool) throw new Error(`missing tool ${name}`)
  return tool
}

/**
 * 执行扩展工具的便捷封装。
 * @param args 工具参数
 * @param context 执行上下文，默认 TEST_CONTEXT
 */
async function callTool(
  extension: ReturnType<typeof createSkillTools>,
  name: string,
  args: Record<string, unknown>,
  api: ToolExecutionApi,
  context = TEST_CONTEXT,
) {
  return registered(extension, name).execute(args as never, api, context)
}

/**
 * 构造提示词 section 的渲染输入。
 * @param tools 本次请求直接可用的工具名
 * @param callable 已解析的可调用工具名（codemode 场景用）
 * @param references 会话文档中的技能引用快照
 * @param shown 上次渲染并已展示给模型的 section 文本
 */
function promptInput(
  path: string,
  tools: string[],
  callable: string[],
  references?: unknown,
  shown: Record<string, string> = {},
) {
  const state = references === undefined ? undefined : { references }
  return {
    conversationId: 41 as ConversationId,
    env: { cwd: path },
    agent: {
      tools: tools.map(name => ({ name })),
      callable: callable.map(name => ({ name })),
    },
    shown,
    read: { snapshot: async () => state },
  }
}

/**
 * 渲染技能扩展的策略 section。
 * @returns 渲染后的提示词文本；扩展无 section 时抛错
 */
async function renderSection(
  extension: ReturnType<typeof createSkillTools>,
  input: ReturnType<typeof promptInput>,
): Promise<string | undefined> {
  const promptSection = extension.sections?.[0]
  if (!promptSection) throw new Error('Skills extension has no policy section')
  return promptSection.render(input as never, TEST_CONTEXT)
}

describe('Skills extension tools', () => {
  // 目录元数据有界：不泄漏磁盘路径；Pi 输出保持原生数组形状；只读工具清单固定。
  it('lists bounded metadata and exposes actual array-shaped Pi output', async () => {
    const path = await workspace()
    const store = new SkillStore()
    const extension = createSkillTools({ store, canWrite: async () => true })
    const result = await callTool(extension, 'skill_list', {}, createApi(path, { references: [] }))
    const catalog = result.structuredOutput as { skills: Array<{ id: string; path?: string }>; diagnostics: string[] }

    expect(result.output).toHaveLength(1)
    expect(catalog.skills.some(skill => skill.id === 'builtin:skill-creator')).toBe(true)
    expect(catalog.skills.every(skill => skill.path === undefined)).toBe(true)
    expect(SKILL_READ_TOOLS).toEqual(['skill_list', 'skill_load', 'skill_validate'])
  })

  // 加载契约：正文只在显式请求时读取；会话引用记录有界（不含正文），
  // 提示词 section 只提示「资源在哪」而非复述内容；跨 workspace 的引用不出现。
  it('loads a body only on request and records a bounded conversation reference without the body', async () => {
    const path = await workspace()
    const skillDirectory = join(path, '.agents', 'skills', 'support-demo')
    const guidePath = join(skillDirectory, 'references', 'guide.md')
    await mkdir(join(skillDirectory, 'references'), { recursive: true })
    await writeFile(join(skillDirectory, 'SKILL.md'), [
      '---',
      'name: support-demo',
      'description: Demonstrate resource location for a workspace Skill.',
      '---',
      '',
      'Read [the guide](references/guide.md) before acting.',
    ].join('\n'))
    await writeFile(guidePath, '# Support guide\n\nKeep the result concise.')
    const state = { references: [] as Array<Record<string, unknown>> }
    const store = new SkillStore()
    const extension = createSkillTools({ store, canWrite: async () => true })
    const result = await callTool(extension, 'skill_load', {
      skill: 'agents:support-demo',
      resource: 'references/guide.md',
    }, createApi(path, state))
    const loaded = result.structuredOutput as {
      content: string
      skill: { version: string }
      baseDirectory: string
      resource: string
      files: string[]
      filesTruncated: boolean
    }
    const canonicalSkillDirectory = await realpath(skillDirectory)

    expect(loaded.resource).toBe('references/guide.md')
    expect(loaded.baseDirectory).toBe(canonicalSkillDirectory)
    expect(loaded.files).toContain('references/guide.md')
    expect(loaded.filesTruncated).toBe(false)
    expect(await readFile(join(loaded.baseDirectory, loaded.resource), 'utf8')).toBe(loaded.content)
    expect(state.references).toHaveLength(1)
    expect(state.references[0]).toMatchObject({
      id: 'agents:support-demo',
      version: loaded.skill.version,
      baseDirectory: canonicalSkillDirectory,
      resource: 'references/guide.md',
      workspace: await realpath(path),
    })
    expect(state.references[0]).not.toHaveProperty('content')

    const prompt = await renderSection(extension, promptInput(path, ['skill_load'], ['skill_load'], state.references))
    expect(prompt).toContain('agents:support-demo')
    expect(prompt).toContain(canonicalSkillDirectory)
    expect(prompt).toContain('压缩、重启')
    expect(prompt).not.toContain('# Support guide')

    const otherWorkspace = await workspace()
    const otherPrompt = await renderSection(extension, promptInput(otherWorkspace, ['skill_load'], ['skill_load'], state.references))
    expect(otherPrompt).not.toContain('agents:support-demo')
    expect(otherPrompt).not.toContain(canonicalSkillDirectory)
    expect(otherPrompt).not.toContain('Loaded Skill references in this conversation')
  })

  // 保存契约：canWrite 允许时只写 workspace 技能目录（.agents/skills/<name>/SKILL.md），
  // 不在其他位置落地；保存后 validate 通过。
  it('writes only the workspace Skills directory when the runtime permission callback allows it', async () => {
    const path = await workspace()
    const extension = createSkillTools({ store: new SkillStore(), canWrite: async () => true })
    const result = await callTool(extension, 'skill_save', { name: 'smoke-check', content: SKILL_BODY }, createApi(path, { references: [] }))
    const saved = result.structuredOutput as { location: string; created: boolean; validation: { valid: boolean } }

    expect(saved).toMatchObject({ location: '.agents/skills/smoke-check/SKILL.md', created: true, validation: { valid: true } })
    expect(await readFile(join(path, saved.location), 'utf8')).toBe(SKILL_BODY)
    await expect(stat(join(path, '.agents', 'smoke-check'))).rejects.toMatchObject({ code: 'ENOENT' })

    const validation = await callTool(extension, 'skill_validate', { skill: 'agents:smoke-check' }, createApi(path, { references: [] }))
    expect(validation.structuredOutput).toEqual({ valid: true, errors: [], warnings: [] })
  })

  // fail-closed：权限拒绝与权限检查抛错两种情况下保存都失败，
  // 且不产生任何文件（连 .agents 目录都不创建）。
  it('fails closed when write permission is false or cannot be checked', async () => {
    const path = await workspace()
    const store = new SkillStore()
    const canWrite = vi.fn(async () => false)
    const denied = createSkillTools({ store, canWrite })
    await expect(callTool(denied, 'skill_save', { name: 'smoke-check', content: SKILL_BODY }, createApi(path, { references: [] })))
      .rejects.toThrow('workspace writing is disabled')
    expect(canWrite).toHaveBeenCalledOnce()
    await expect(stat(join(path, '.agents'))).rejects.toMatchObject({ code: 'ENOENT' })

    const uncertain = createSkillTools({ store, canWrite: async () => { throw new Error('metadata unavailable') } })
    await expect(callTool(uncertain, 'skill_save', { name: 'smoke-check', content: SKILL_BODY }, createApi(path, { references: [] })))
      .rejects.toThrow('permission could not be confirmed')
    await expect(stat(join(path, '.agents'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  // 中止语义：调用前已 abort 的请求直接抛出取消错误，连权限检查都不触发。
  it('does not start a save after the call has already been aborted', async () => {
    const path = await workspace()
    const canWrite = vi.fn(async () => true)
    const extension = createSkillTools({ store: new SkillStore(), canWrite })
    const abort = new AbortController()
    abort.abort(new Error('cancelled'))
    const context = { ...TEST_CONTEXT, abortSignal: abort.signal }

    await expect(callTool(extension, 'skill_save', { name: 'smoke-check', content: SKILL_BODY }, createApi(path, { references: [] }), context))
      .rejects.toThrow('cancelled')
    expect(canWrite).not.toHaveBeenCalled()
    await expect(stat(join(path, '.agents'))).rejects.toMatchObject({ code: 'ENOENT' })
  })
})

describe('Skills prompt routing', () => {
  // 直接模型请求路由：只宣传本次选中的工具，保存/校验相关的规则文案不出现。
  it('advertises only tools selected for this direct model request', async () => {
    const path = await workspace()
    const extension = createSkillTools({ store: new SkillStore(), canWrite: async () => true })
    const prompt = await renderSection(extension, promptInput(path, ['skill_list'], ['skill_list', 'skill_load', 'skill_save', 'skill_validate']))

    expect(prompt).toContain('直接工具：`skill_list`。')
    expect(prompt).not.toContain('`skill_save`')
    expect(prompt).not.toContain('加载相关技能')
    expect(prompt).not.toContain('保存或更新技能后，调用 skill_validate')
  })

  // codemode-only 请求：从可调用集合解析出技能工具全集并写入指引，
  // 提示创建者技能优先加载。
  it('supports codemode-only requests from the resolved callable tool set', async () => {
    const path = await workspace()
    const extension = createSkillTools({ store: new SkillStore(), canWrite: async () => true })
    const prompt = await renderSection(extension, promptInput(
      path,
      [CODEMODE_TOOL_NAME],
      ['skill_list', 'skill_load', 'skill_save', 'skill_validate'],
    ))

    expect(prompt).toContain('通过 `codemode`')
    expect(prompt).toContain('`skill_list`, `skill_load`, `skill_save`, `skill_validate`')
    expect(prompt).toContain('存在 `builtin:skill-creator`，先加载它')
    expect(prompt).toContain('任务明确符合技能描述时，先用 skill_load 加载')
  })

  // 空预设边界：当前预设无任何技能工具时整个 section 不渲染。
  it('omits the section when the current preset exposes no Skill tool', async () => {
    const path = await workspace()
    const extension = createSkillTools({ store: new SkillStore(), canWrite: async () => true })
    expect(await renderSection(extension, promptInput(path, [], []))).toBeUndefined()
  })

  // 目录渲染形状：紧凑的 ZCode 风格行（id: 描述 (file: 路径)），不输出 JSON。
  it('renders a compact ZCode-shaped catalog with callable ids and file paths', async () => {
    const path = await workspace()
    const extension = createSkillTools({ store: new SkillStore(), canWrite: async () => true })
    const prompt = await renderSection(extension, promptInput(path, ['skill_list'], ['skill_list']))

    expect(prompt).toMatch(/- builtin:skill-creator: 按用户要求创建、适配.* \(file: .*skills\/skill-creator\/SKILL\.md\)/u)
    expect(prompt).not.toContain('{"id":')
  })

  it('drops catalog descriptions once the character budget is exhausted', async () => {
    const path = await workspace()
    // 120 个 workspace 技能，description 与 when_to_use 都取 250 字符显示上限：
    // 完整渲染爆掉 2 万字符预算，连降级的「id+路径」行都长到需要按省略数截尾。
    const description = 'd'.repeat(1_000)
    const whenToUse = 'w'.repeat(1_000)
    for (let index = 0; index < 120; index += 1) {
      const name = `bulk-${String(index).padStart(3, '0')}-${'a'.repeat(40)}`
      const directory = join(path, '.agents', 'skills', name)
      await mkdir(directory, { recursive: true })
      await writeFile(
        join(directory, 'SKILL.md'),
        `---\nname: ${name}\ndescription: ${description}\nwhen_to_use: ${whenToUse}\n---\n\nFollow the task.\n`,
      )
    }
    const extension = createSkillTools({ store: new SkillStore(), canWrite: async () => true })
    const prompt = await renderSection(extension, promptInput(path, ['skill_list'], ['skill_list']))

    // 超预算后每行降级为 id+路径，并显式报出省略数量。
    expect(prompt).not.toContain('d'.repeat(200))
    expect(prompt).not.toContain('w'.repeat(200))
    expect(prompt).toMatch(/- agents:bulk-000-a+ \(file: .*bulk-000-a+\/SKILL\.md\)/u)
    expect(prompt).toContain('此有界目录省略了另外')
    expect(prompt?.length ?? 0).toBeLessThan(25_000)
  })

  // 新增通告：section 已渲染给模型后落盘的新技能，下一次渲染追加「自上次请求后新增」
  // 通告；该通告文本成为 shown 后再次消失（只通告一次）。
  it('announces Skills added after the section the model already received', async () => {
    const path = await workspace()
    const extension = createSkillTools({ store: new SkillStore(), canWrite: async () => true })
    const first = await renderSection(extension, promptInput(path, ['skill_list'], ['skill_list']))
    expect(first).not.toContain('自上次请求后，此工作区新增了技能')

    const directory = join(path, '.agents', 'skills', 'fresh-drop')
    await mkdir(directory, { recursive: true })
    await writeFile(join(directory, 'SKILL.md'), '---\nname: fresh-drop\ndescription: Dropped in mid-session.\n---\n\nFollow it.\n')

    const second = await renderSection(extension, promptInput(path, ['skill_list'], ['skill_list'], undefined, { 'skills-policy': first! }))
    expect(second).toContain('自上次请求后，此工作区新增了技能')
    expect(second).toContain('agents:fresh-drop')

    // 通告文本成为已展示 section 后，下一次不再重复通告。
    const third = await renderSection(extension, promptInput(path, ['skill_list'], ['skill_list'], undefined, { 'skills-policy': second! }))
    expect(third).not.toContain('自上次请求后，此工作区新增了技能')
  })
})
