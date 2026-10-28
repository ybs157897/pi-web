import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createWorkPolicyExtension, WORK_POLICY_EXTENSION_NAME } from '../src/server/work-policy.ts'

const SHELL_TOOL = process.platform === 'win32' ? 'pwsh' : 'bash'

function promptInput(options: {
  tools?: string[]
  callable?: string[]
  planActive?: boolean
  cwd?: string
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
      snapshot: async () => ({ active: options.planActive ?? false, updatedAt: 1 }),
    },
  }
}

async function renderPolicy(options: Parameters<typeof promptInput>[0] = {}): Promise<string> {
  const extension = createWorkPolicyExtension()
  const sections = extension.sections ?? []
  if (sections.length === 0) throw new Error('Runtime policy extension has no sections')
  const rendered = await Promise.all(sections.map(policy => policy.render(promptInput(options) as never, {} as never)))
  return rendered.filter((value): value is string => typeof value === 'string').join('\n\n')
}

describe('default runtime work policy', () => {
  it('has a stable extension identity and contributes no tools', () => {
    const extension = createWorkPolicyExtension()

    expect(extension.name).toBe(WORK_POLICY_EXTENSION_NAME)
    expect(extension.sections?.map(section => section.key)).toEqual(['runtime-core', 'project-instructions', 'work-policy'])
    expect(extension.tools).toBeUndefined()
  })

  it('teaches plugin creation through the bundled skill and keeps installation manual', async () => {
    const prompt = await renderPolicy()

    expect(prompt).toContain('builtin:plugin-creator')
    expect(prompt).toContain('plugins/<slug>/')
    expect(prompt).toContain('设置 → 插件市场 → 创建插件')
    expect(prompt).toContain('不得声称已安装')
    expect(prompt).toContain('Plugin 是打包 skills/MCP/UI 的可安装目录')
    expect(prompt).toContain('安装/更新/卸载不要用 npm/git')
    expect(prompt).toContain('只会被标为不支持')
    expect(prompt).toContain('代码定位与检索')
    expect(prompt).toContain('git log --oneline --grep')
    expect(prompt).toContain('不要用“工具调用过程复盘”代替缺陷分析')
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

  it('uses the Host-provided working directory as the current project scope', async () => {
    const prompt = await renderPolicy({ cwd: '/workspace/pi-web' })

    expect(prompt).toContain('当前工作区（默认当前项目）由 Host 提供')
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

    expect(prompt).toContain('找路径用 `glob`')
    expect(prompt).toContain('不要用 shell `find`')
    expect(prompt).toContain('搜内容用 `grep`')
    expect(prompt).toContain('不要用 shell `grep`')
    expect(prompt).toContain('读文件用 `read`')
    expect(prompt).toContain('`workdir`')
    expect(prompt).toContain(SHELL_TOOL === 'pwsh' ? 'Windows 命令优先用 `pwsh`' : 'shell 只用于构建')
    expect(prompt).not.toContain('找路径用 `list_files`')
  })

  it('falls back to list_files and search_files when the DSH-named tools are unavailable', async () => {
    const prompt = await renderPolicy({ tools: ['list_files', 'search_files', 'read'] })

    expect(prompt).toContain('找路径用 `list_files`')
    expect(prompt).toContain('搜内容用 `search_files`')
    expect(prompt).not.toContain('找路径用 `glob`')
    expect(prompt).not.toContain('搜内容用 `grep`')
  })

  it('tells the model to plan before implementing when plan mode is off', async () => {
    const prompt = await renderPolicy({ tools: ['todo_write'] })

    expect(prompt).toContain('即使计划模式未开启')
    expect(prompt).toContain('先做只读研究并在回复中给出可执行计划')
    expect(prompt).toContain('不要擅自实施')
    expect(prompt).toContain('调研→形成计划→等待确认')
  })

  it('keeps proactive-asking rules in the stable core', async () => {
    const prompt = await renderPolicy()

    expect(prompt).toContain('用户引用本会话之外的对话、文档或决定')
    expect(prompt).toContain('先问是哪个会话或哪份文档')
    expect(prompt).toContain('不要扫描项目里的 agent 状态目录')
  })

  it('classifies user utterances before deciding whether to act', async () => {
    const prompt = await renderPolicy({ tools: ['todo_write'] })

    expect(prompt).toContain('用户话语解读')
    expect(prompt).toContain('看看/分析一下')
    expect(prompt).toContain('改/修复/实现')
    expect(prompt).toContain('今天/昨天/前两天')
    expect(prompt).toContain('用户粘贴的日志')
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

      expect(prompt).toContain('project-instructions')
      expect(prompt).toContain('Root project rules')
      expect(prompt).toContain('Keep this request scoped.')
      expect(prompt).toContain('"status":"loaded"')
      expect(prompt).not.toContain('todo_write')
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  })

  it('uses short textual progress when no todo tool is available', async () => {
    const prompt = await renderPolicy()

    expect(prompt).toContain('Pi agent 内置的编程助手')
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
