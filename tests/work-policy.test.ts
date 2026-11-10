import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createWorkPolicyExtension, WORK_POLICY_EXTENSION_NAME } from '../src/server/conversation/work-policy.ts'
import { Subagents, type SubagentProfile } from '../src/server/tools/subagent.ts'

const SHELL_TOOL = process.platform === 'win32' ? 'pwsh' : 'bash'

/** A data directory with no personalization file: the section must contribute nothing. */
let dataDir = ''
beforeAll(async () => { dataDir = await realpath(await mkdtemp(join(tmpdir(), 'pi-web-work-policy-data-'))) })
afterAll(async () => { if (dataDir) await rm(dataDir, { recursive: true, force: true }) })

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

async function renderPolicy(options: Parameters<typeof promptInput>[0] = {}): Promise<string> {
  const extension = createWorkPolicyExtension({ dataDir })
  const sections = extension.sections ?? []
  if (sections.length === 0) throw new Error('Runtime policy extension has no sections')
  const rendered = await Promise.all(sections.map(policy => policy.render(promptInput(options) as never, {} as never)))
  return rendered.filter((value): value is string => typeof value === 'string').join('\n\n')
}

async function renderSection(key: string, options: Parameters<typeof promptInput>[0] = {}): Promise<string | undefined> {
  const extension = createWorkPolicyExtension({ dataDir })
  const policy = extension.sections?.find(candidate => candidate.key === key)
  if (!policy) throw new Error(`Missing ${key} section`)
  return await (policy.render as unknown as (input: unknown, context: unknown) => Promise<string | undefined>)(promptInput(options) as never, {} as never)
}

describe('default runtime work policy', () => {
  it('has a stable extension identity and contributes no tools', () => {
    const extension = createWorkPolicyExtension({ dataDir })

    expect(extension.name).toBe(WORK_POLICY_EXTENSION_NAME)
    expect(extension.sections?.map(section => section.key)).toEqual(['runtime-core', 'personal-instructions', 'project-instructions', 'work-policy'])
    expect(extension.tools).toBeUndefined()
  })

  it('routes plugin creation to the bundled skill without restating its process', async () => {
    const prompt = await renderPolicy()

    expect(prompt).toContain('builtin:plugin-creator')
    expect(prompt).toContain('builtin:skill-creator')
    expect(prompt).toContain('不要凭记忆编造 manifest')
    expect(prompt).toContain('代码定位与检索')
    expect(prompt).toContain('git log --oneline --grep')
  })

  it('guides concrete multi-step todo tracking only when the direct tool is available', async () => {
    const prompt = await renderPolicy({ tools: ['todo_write'] })

    expect(prompt).toContain('直接待办工具 `todo_write`')
    expect(prompt).toContain('具体步骤和必要验证')
    expect(prompt).toContain('设为 `in_progress`')
    expect(prompt).toContain('只有真实并行时才标多个')
    expect(prompt).not.toContain('通过 `codemode` 调用')
  })

  it('routes todo tracking through codemode when that is the only model-facing path', async () => {
    const prompt = await renderPolicy({
      tools: ['codemode'],
      callable: ['todo_write'],
    })

    expect(prompt).toContain('通过 `codemode` 调用 `todo_write`')
    expect(prompt).toContain('await tools.todo_write')
    expect(prompt).not.toContain('直接待办工具')
  })

  it('uses the system-provided working directory as the current project scope', async () => {
    const prompt = await renderPolicy({ cwd: '/workspace/pi-web' })

    expect(prompt).toContain('当前工作区（默认当前项目）由系统提供')
    expect(prompt).toContain('/workspace/pi-web')
  })

  it('reports session facts and the actual write/shell capability', async () => {
    const prompt = await renderPolicy({ cwd: '/workspace/pi-web', tools: ['read', 'write', SHELL_TOOL] })

    expect(prompt).toContain('平台：')
    expect(prompt).toContain('当前日期：')
    expect(prompt).toContain('本请求模型：未提供')
    expect(prompt).toContain('可写工作区')
    expect(prompt).toContain(`可执行 shell（${SHELL_TOOL}）`)
  })

  it('routes file discovery and reading to the tools actually offered', async () => {
    const prompt = await renderPolicy({ tools: ['glob', 'grep', 'read', 'write', 'edit', SHELL_TOOL] })

    expect(prompt).toContain('读文件用 `read`')
    expect(prompt).toContain('优先用 `edit` 做定点替换')
    expect(prompt).toContain('覆盖已有文件前先 `read`')
    expect(prompt).toContain('只用于构建、测试、git、进程')
    expect(prompt).not.toContain('找路径用 `list_files`')
    expect(prompt).not.toContain('搜内容用 `search_files`')
  })

  it('falls back to list_files and search_files when the DSH-named tools are unavailable', async () => {
    const prompt = await renderPolicy({ tools: ['list_files', 'search_files', 'read'] })

    expect(prompt).toContain('找路径用 `list_files`')
    expect(prompt).toContain('搜内容用 `search_files`')
    expect(prompt).not.toContain('找路径用 `glob`')
    expect(prompt).not.toContain('搜内容用 `grep`')
  })

  it('answers plan-only requests without claiming an unavailable entry tool', async () => {
    const prompt = await renderPolicy({ tools: ['todo_write'] })

    expect(prompt).toContain('只读调研后给出计划，不实施')
    expect(prompt).toContain('本请求不能自行进入计划模式')
    expect(prompt).toContain('完成只读调研后直接给出方案')
  })

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

  it('returns inherited planning work to the delegator instead of asking the user', async () => {
    const prompt = await renderSection('work-policy', { planActive: true, subagentProfile: 'general-purpose' })
    expect(prompt).toContain('将结论交给委派方')
    expect(prompt).not.toContain('提交计划')
    const inactive = await renderSection('work-policy', { subagentProfile: 'Explore' })
    expect(inactive).not.toContain('/plan')
  })

  it('keeps proactive-asking rules in the stable core', async () => {
    const prompt = await renderPolicy()

    expect(prompt).toContain('本会话看不到的对话、文档或决定')
    expect(prompt).toContain('先问是哪个会话或哪份文档')
    expect(prompt).toContain('不要扫描项目里的 agent 状态目录')
  })

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

  it('injects the user-level personalization file before project instructions', async () => {
    const cwd = await realpath(await mkdtemp(join(tmpdir(), 'pi-web-work-policy-')))
    try {
      await writeFile(join(cwd, 'AGENTS.md'), '# Project\n- Use pnpm.\n', 'utf8')
      await writeFile(join(dataDir, 'AGENTS.md'), '# Personal\n- Prefer short answers.\n', 'utf8')
      const section = await renderSection('personal-instructions')
      expect(section).toContain('<personal_instructions>')
      expect(section).toContain('Prefer short answers.')
      expect(section).toContain('Project instructions and explicit task instructions win on conflict')
      expect(section).toContain('</personal_instructions>')

      const prompt = await renderPolicy({ cwd })
      // runtime-core quotes the project tag in prose, so locate the project section by its status line.
      expect(prompt.indexOf('<personal_instructions>')).toBeLessThan(prompt.indexOf(`Workspace ${join(cwd, 'AGENTS.md')} applies`))
    } finally {
      await rm(join(dataDir, 'AGENTS.md'), { force: true })
      await rm(cwd, { recursive: true, force: true })
    }
  })

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

  it('uses short textual progress when no todo tool is available', async () => {
    const prompt = await renderPolicy()

    expect(prompt).toContain('pi-web 内置的编程助手')
    expect(prompt).toContain('已完成、当前和下一步')
    expect(prompt).not.toContain('todo_write')
  })

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
