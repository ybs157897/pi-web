import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { CHINESE_REASONING_INSTRUCTION, createWorkPolicyExtension, WORK_POLICY_EXTENSION_NAME } from '../src/server/conversation/work-policy.ts'
import { Subagents, type SubagentProfile } from '../src/server/tools/subagent.ts'

const SHELL_TOOL = process.platform === 'win32' ? 'pwsh' : 'bash'

/**
 * 工作策略提示词扩展（work-policy）契约测试：extension 身份与 section 清单、
 * 工具路由（todo/文件发现/计划入口按可用工具切换直接或 codemode 表述）、
 * 会话事实与能力声明、project/personal 指令注入（Explore 档案剔除）、
 * 计划模式下的策略抑制、中文推理开关。
 */

/** 无个性化文件的数据目录：personal-instructions section 应不产出内容。 */
let dataDir = ''
/** 下方 fixture 闭包读取的中文推理开关状态。 */
let chineseReasoning = false
beforeAll(async () => { dataDir = await realpath(await mkdtemp(join(tmpdir(), 'pi-web-work-policy-data-'))) })
afterAll(async () => { if (dataDir) await rm(dataDir, { recursive: true, force: true }) })

/**
 * 构造策略 section 的渲染输入。
 * @param tools 本请求可见的工具名
 * @param callable 可调用集合（codemode 场景）
 * @param planActive 计划模式是否激活
 * @param cwd 工作目录（决定项目指令查找）
 * @param subagentProfile 子智能体档案（Explore 时剔除项目/个人指令）
 */
function promptInput(options: {
  tools?: string[]
  callable?: string[]
  planActive?: boolean
  cwd?: string
  subagentProfile?: SubagentProfile
} = {}) {
  return {
    conversationId: 1,
    env: options.cwd ? { cwd: options.cwd } : undefined,
    shown: {},
    agent: {
      tools: (options.tools ?? []).map(name => ({ name })),
      callable: (options.callable ?? []).map(name => ({ name })),
    },
    read: {
      snapshot: async (document: unknown) => {
        if (document === Subagents) {
          return options.subagentProfile === undefined
            ? undefined
            : { record: { label: 'delegated task', createdAt: 1, profile: options.subagentProfile } }
        }
        return { active: options.planActive ?? false, updatedAt: 1 }
      },
    },
  }
}

/**
 * 渲染扩展的全部 section 并拼接结果。
 * @returns 各 section 输出以空行连接的完整提示词
 */
async function renderPolicy(options: Parameters<typeof promptInput>[0] = {}): Promise<string> {
  const extension = createWorkPolicyExtension({ dataDir, chineseReasoning: () => chineseReasoning })
  const sections = extension.sections ?? []
  if (sections.length === 0) throw new Error('Runtime policy extension has no sections')
  const rendered = await Promise.all(sections.map(policy => policy.render(promptInput(options) as never, {} as never)))
  return rendered.filter((value): value is string => typeof value === 'string').join('\n\n')
}

/**
 * 按 key 渲染单个 section。
 * @returns section 文本；该 section 不产出时为 undefined
 */
async function renderSection(key: string, options: Parameters<typeof promptInput>[0] = {}): Promise<string | undefined> {
  const extension = createWorkPolicyExtension({ dataDir, chineseReasoning: () => chineseReasoning })
  const policy = extension.sections?.find(candidate => candidate.key === key)
  if (!policy) throw new Error(`Missing ${key} section`)
  return await (policy.render as unknown as (input: unknown, context: unknown) => Promise<string | undefined>)(promptInput(options) as never, {} as never)
}

describe('default runtime work policy', () => {
  // 身份契约：extension 名稳定、section 顺序固定（runtime-core 在前）、不贡献工具。
  it('has a stable extension identity and contributes no tools', () => {
    const extension = createWorkPolicyExtension({ dataDir, chineseReasoning: () => chineseReasoning })

    expect(extension.name).toBe(WORK_POLICY_EXTENSION_NAME)
    expect(extension.sections?.map(section => section.key)).toEqual(['runtime-core', 'personal-instructions', 'project-instructions', 'work-policy'])
    expect(extension.tools).toBeUndefined()
  })

  // 插件/技能创建指向内置技能 id，不复述流程；代码定位给出具体检索手段。
  it('routes plugin creation to the bundled skill without restating its process', async () => {
    const prompt = await renderPolicy()

    expect(prompt).toContain('builtin:plugin-creator')
    expect(prompt).toContain('builtin:skill-creator')
    expect(prompt).toContain('不要凭记忆编造 manifest')
    expect(prompt).toContain('代码定位与检索')
    expect(prompt).toContain('git log --oneline --grep')
  })

  // Todo 指引只在直接工具可见时出现，且要求具体步骤、状态标记与并行诚实标注。
  it('guides concrete multi-step todo tracking only when the direct tool is available', async () => {
    const prompt = await renderPolicy({ tools: ['todo_write'] })

    expect(prompt).toContain('直接待办工具 `todo_write`')
    expect(prompt).toContain('具体步骤和必要验证')
    expect(prompt).toContain('设为 `in_progress`')
    expect(prompt).toContain('只有真实并行时才标多个')
    expect(prompt).not.toContain('通过 `codemode` 调用')
  })

  // 对照：codemode-only 时改写为 `await tools.todo_write` 形式，直接工具表述消失。
  it('routes todo tracking through codemode when that is the only model-facing path', async () => {
    const prompt = await renderPolicy({
      tools: ['codemode'],
      callable: ['todo_write'],
    })

    expect(prompt).toContain('通过 `codemode` 调用 `todo_write`')
    expect(prompt).toContain('await tools.todo_write')
    expect(prompt).not.toContain('直接待办工具')
  })

  // 项目作用域：当前项目以系统提供的工作目录为准并写进提示词。
  it('uses the system-provided working directory as the current project scope', async () => {
    const prompt = await renderPolicy({ cwd: '/workspace/pi-web' })

    expect(prompt).toContain('当前工作区（默认当前项目）由系统提供')
    expect(prompt).toContain('/workspace/pi-web')
  })

  // 会话事实：平台、日期、模型（缺省「未提供」）与真实能力（可写工作区、shell 工具名）。
  it('reports session facts and the actual write/shell capability', async () => {
    const prompt = await renderPolicy({ cwd: '/workspace/pi-web', tools: ['read', 'write', SHELL_TOOL] })

    expect(prompt).toContain('平台：')
    expect(prompt).toContain('当前日期：')
    expect(prompt).toContain('本请求模型：未提供')
    expect(prompt).toContain('可写工作区')
    expect(prompt).toContain(`可执行 shell（${SHELL_TOOL}）`)
  })

  // 文件工具路由：按实际可用的工具名表述读写/检索；
  // DSH 命名工具不可用时对应指引不得出现。
  it('routes file discovery and reading to the tools actually offered', async () => {
    const prompt = await renderPolicy({ tools: ['glob', 'grep', 'read', 'write', 'edit', SHELL_TOOL] })

    expect(prompt).toContain('读文件用 `read`')
    expect(prompt).toContain('优先用 `edit` 做定点替换')
    expect(prompt).toContain('覆盖已有文件前先 `read`')
    expect(prompt).toContain('只用于构建、测试、git、进程')
    expect(prompt).not.toContain('找路径用 `list_files`')
    expect(prompt).not.toContain('搜内容用 `search_files`')
  })

  // 对照回退：只有 DSH 命名工具（list_files/search_files）时改用它们，glob/grep 指引消失。
  it('falls back to list_files and search_files when the DSH-named tools are unavailable', async () => {
    const prompt = await renderPolicy({ tools: ['list_files', 'search_files', 'read'] })

    expect(prompt).toContain('找路径用 `list_files`')
    expect(prompt).toContain('搜内容用 `search_files`')
    expect(prompt).not.toContain('找路径用 `glob`')
    expect(prompt).not.toContain('搜内容用 `grep`')
  })

  // 计划请求边界：无计划入口工具时不虚称可入计划模式，指引只读调研后直接给方案。
  it('answers plan-only requests without claiming an unavailable entry tool', async () => {
    const prompt = await renderPolicy({ tools: ['todo_write'] })

    expect(prompt).toContain('只读调研后给出计划，不实施')
    expect(prompt).toContain('本请求不能自行进入计划模式')
    expect(prompt).toContain('完成只读调研后直接给出方案')
  })

  // 计划入口路由：入口与提交工具都可用才给进入指引（直接或 codemode 形式）；
  // 只有入口没有提交工具时明确「不要自行进入计划模式」。
  it('routes plan entry only when both entry and submission are callable', async () => {
    const direct = await renderSection('work-policy', { tools: ['enter_plan_mode', 'exit_plan_mode'] })
    expect(direct).not.toContain('/plan')
    const nested = await renderSection('work-policy', { tools: ['codemode'], callable: ['enter_plan_mode', 'exit_plan_mode'] })
    expect(nested).toContain('await tools.enter_plan_mode({})')
    expect(nested).toContain('明确详细指令时不需要计划模式')
    const noExit = await renderSection('work-policy', { tools: ['enter_plan_mode'] })
    expect(noExit).toContain('没有可调用的计划提交工具')
    expect(noExit).toContain('不要自行进入计划模式')
  })

  // 继承计划的成员：结论交还委派方而非询问用户，不提「提交计划」；
  // 非计划上下文（Explore、计划未激活）不出现计划入口指引。
  it('returns inherited planning work to the delegator instead of asking the user', async () => {
    const prompt = await renderSection('work-policy', { planActive: true, subagentProfile: 'general-purpose' })
    expect(prompt).toContain('将结论交给委派方')
    expect(prompt).not.toContain('提交计划')
    const inactive = await renderSection('work-policy', { subagentProfile: 'Explore' })
    expect(inactive).not.toContain('/plan')
  })

  // 主动澄清规则属于稳定核：看不到的上下文要先问来源，不扫描 agent 状态目录。
  it('keeps proactive-asking rules in the stable core', async () => {
    const prompt = await renderPolicy()

    expect(prompt).toContain('本会话看不到的对话、文档或决定')
    expect(prompt).toContain('先问是哪个会话或哪份文档')
    expect(prompt).toContain('不要扫描项目里的 agent 状态目录')
  })

  // 用户话语分类表：观察/行动/时间指代/粘贴内容/认可/暂缓各类话术都要先解读再行动。
  it('classifies user utterances before deciding whether to act', async () => {
    const prompt = await renderPolicy({ tools: ['todo_write'] })

    expect(prompt).toContain('用户话语解读')
    expect(prompt).toContain('看看/分析一下')
    expect(prompt).toContain('改/修复/实现')
    expect(prompt).toContain('今天/昨天/前两天')
    expect(prompt).toContain('用户粘贴的内容')
    expect(prompt).toContain('可以/行/好的/没问题')
    expect(prompt).toContain('先别改/只看看')
    expect(prompt).toContain('列出候选并问')
  })

  // 项目指令：workspace 根的 AGENTS.md 以 project_instructions 标签注入，
  // 与可用工具无关（无工具时也注入）。
  it('includes the root instruction section even when the request has no tools', async () => {
    const cwd = await realpath(await mkdtemp(join(tmpdir(), 'pi-web-work-policy-')))
    const body = '# Root project rules\nKeep this request scoped.\n'
    try {
      await writeFile(join(cwd, 'AGENTS.md'), body, 'utf8')
      const prompt = await renderPolicy({ cwd })

      expect(prompt).toContain('<project_instructions>')
      expect(prompt).toContain('Root project rules')
      expect(prompt).toContain('Keep this request scoped.')
      expect(prompt).toContain('</project_instructions>')
      expect(prompt).not.toContain('todo_write')
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  })

  // Explore 档案剔除项目指令；general-purpose 档案保留。
  it('omits project instructions for an Explore subagent while other profiles keep them', async () => {
    const cwd = await realpath(await mkdtemp(join(tmpdir(), 'pi-web-work-policy-')))
    const body = '# Root project rules\nKeep this request scoped.\n'
    try {
      await writeFile(join(cwd, 'AGENTS.md'), body, 'utf8')
      const explore = await renderSection('project-instructions', { cwd, subagentProfile: 'Explore' })
      expect(explore).toBeUndefined()

      const general = await renderSection('project-instructions', { cwd, subagentProfile: 'general-purpose' })
      expect(general).toContain('<project_instructions>')
      expect(general).toContain('Root project rules')
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  })

  // 注入次序：用户级个性化文件先于项目指令；附冲突优先级说明。
  // runtime-core 在散文中引用项目标签，因此按状态行定位项目 section。
  it('injects the user-level personalization file before project instructions', async () => {
    const cwd = await realpath(await mkdtemp(join(tmpdir(), 'pi-web-work-policy-')))
    try {
      await writeFile(join(cwd, 'AGENTS.md'), '# Project\n- Use pnpm.\n', 'utf8')
      await writeFile(join(dataDir, 'AGENTS.md'), '# Personal\n- Prefer short answers.\n', 'utf8')
      const section = await renderSection('personal-instructions')
      expect(section).toContain('<personal_instructions>')
      expect(section).toContain('Prefer short answers.')
      expect(section).toContain('发生冲突时，项目指令和明确的任务指令优先')
      expect(section).toContain('</personal_instructions>')

      const prompt = await renderPolicy({ cwd })
      // runtime-core 在散文中引用项目标签，因此按状态行定位项目 section。
      expect(prompt.indexOf('<personal_instructions>')).toBeLessThan(prompt.indexOf(`工作区 ${join(cwd, 'AGENTS.md')} 适用于`))
    } finally {
      await rm(join(dataDir, 'AGENTS.md'), { force: true })
      await rm(cwd, { recursive: true, force: true })
    }
  })

  // 边界：空个性化文件保持沉默；Explore 档案剔除个性化，general-purpose 保留。
  it('omits personalization for Explore subagents and leaves an empty file silent', async () => {
    try {
      await writeFile(join(dataDir, 'AGENTS.md'), '', 'utf8')
      expect(await renderSection('personal-instructions')).toBeUndefined()

      await writeFile(join(dataDir, 'AGENTS.md'), '# Personal\n- Prefer short answers.\n', 'utf8')
      expect(await renderSection('personal-instructions', { subagentProfile: 'Explore' })).toBeUndefined()
      expect(await renderSection('personal-instructions', { subagentProfile: 'general-purpose' })).toContain('<personal_instructions>')
    } finally {
      await rm(join(dataDir, 'AGENTS.md'), { force: true })
    }
  })

  // 无 todo 工具时的回退：要求短文本式进度汇报（已完成/当前/下一步），不提 todo_write。
  it('uses short textual progress when no todo tool is available', async () => {
    const prompt = await renderPolicy()

    expect(prompt).toContain('pi-web 内置的编程助手')
    expect(prompt).toContain('已完成、当前和下一步')
    expect(prompt).not.toContain('todo_write')
  })

  // 计划模式抑制：激活时让位于计划策略（只读研究/提交计划），
  // 并抑制执行型 todo 指引与自动续跑目标。
  it('defers to plan policy and suppresses execution todo guidance while plan mode is active', async () => {
    const prompt = await renderPolicy({
      tools: ['todo_write'],
      planActive: true,
    })

    expect(prompt).toContain('计划模式已开启')
    expect(prompt).toContain('只读研究')
    expect(prompt).toContain('不启动自动续跑工作目标')
    expect(prompt).toContain('只读研究并提交计划')
    expect(prompt).not.toContain('todo_write')
  })
})

describe('chinese reasoning setting', () => {
  // 开关关闭时 personal-instructions 不产出中文推理指令。
  it('stays silent while the toggle is off', async () => {
    chineseReasoning = false
    try {
      expect(await renderSection('personal-instructions')).toBeUndefined()
    } finally {
      chineseReasoning = false
    }
  })

  // 开关开启：指令经 personal-instructions 框架渲染并注明全局适用。
  it('renders the instruction through the personal-instructions framing while on', async () => {
    chineseReasoning = true
    try {
      const section = await renderSection('personal-instructions')
      if (section === undefined) throw new Error('personal-instructions should render while the toggle is on')
      expect(section).toContain('<personal_instructions>')
      expect(section).toContain(CHINESE_REASONING_INSTRUCTION)
      expect(section).toContain('用户设置适用于所有工作区')
    } finally {
      chineseReasoning = false
    }
  })

  // 两者并存：个性化文件正文在前、推理指令附加在后（两个标签块，先后有序）。
  it('appends the instruction after the personalization file body when both apply', async () => {
    chineseReasoning = true
    try {
      await writeFile(join(dataDir, 'AGENTS.md'), '# Personal\n- Prefer short answers.\n', 'utf8')
      const section = await renderSection('personal-instructions')
      if (section === undefined) throw new Error('personal-instructions should render both parts when on')
      expect(section).toContain('<personal_instructions>')
      expect(section).toContain('<personal_instructions>')
      expect(section.indexOf('<personal_instructions>')).toBeLessThan(section.lastIndexOf('<personal_instructions>'))
      expect(await renderSection('personal-instructions', { subagentProfile: 'Explore' })).toBeUndefined()
    } finally {
      chineseReasoning = false
      await rm(join(dataDir, 'AGENTS.md'), { force: true })
    }
  })
})
