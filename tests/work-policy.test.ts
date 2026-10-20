import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createWorkPolicyExtension, WORK_POLICY_EXTENSION_NAME } from '../src/server/work-policy.ts'

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
    expect(prompt).toContain('本请求实际提供的计划提交能力')
    expect(prompt).not.toContain('todo_write')
  })
})
