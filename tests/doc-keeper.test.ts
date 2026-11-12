// doc-keeper service 与 extension 单测：脚本化 OpenAI provider + 真实 runtime fixture。
// check 模式断言零模型调用；refresh 模式用脚本驱动五工具闭环；extension 边界用 fake api 直测。
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Extension, ToolExecutionApi, ToolRegistration } from '@earendil-works/pi-durable'
import type { Context } from '@earendil-works/chord/context'
import type { DocKeeperTaskShape } from '../src/server/knowledge/extension.ts'
import {
  DOC_PATH, OLD_STAMP, cleanupKeeperFixtures, gitWorkspace, keeperFixture, registerKeeperCleanup, textTurn, toolTurn,
  type ProviderScript,
} from './keeper-fixtures.ts'

const { createDocKeeperExtension, DOC_KEEPER_TOOL_NAMES, DocKeeperTask } = await import('../src/server/knowledge/extension.ts')
const { CONVERSATION_KIND } = await import('../src/server/runtime/helpers.ts')
const { knowledgeHash } = await import('../src/server/knowledge/core.ts')

afterEach(cleanupKeeperFixtures)

const input = { globs: ['src/**'], knowledgePath: DOC_PATH } as const

describe('doc-keeper service：check 模式（无模型）', () => {
  it('stale 文档返回体检与变更摘要，且不调用模型、不建会话', async () => {
    const { runtime } = await keeperFixture({ turn: () => { throw new Error('check 模式不应调用模型') } })
    const result = await runtime.runDocKeeperMaintenance({ ...input, mode: 'check' })
    expect(result.mode).toBe('check')
    expect(result.health).toBe('stale')
    expect(result.updated).toBe(false)
    expect(result.commitCount).toBe(1)
    expect(result.changedFiles).toEqual(['src/a.ts'])
    expect(result.knowledgePath).toBe(DOC_PATH)
    expect(await runtime.list()).toEqual([])
  })

  it('fresh 文档返回 fresh 与零变更', async () => {
    const { runtime } = await keeperFixture({ turn: () => { throw new Error('check 模式不应调用模型') } }, { stamp: '2027-01-01T00:00:00.000Z' })
    const result = await runtime.runDocKeeperMaintenance({ ...input, mode: 'check' })
    expect(result.health).toBe('fresh')
    expect(result.commitCount).toBe(0)
    expect(result.updated).toBe(false)
  })

  it('文档缺失返回 unknown', async () => {
    const { runtime, workspace } = await keeperFixture({ turn: () => { throw new Error('check 模式不应调用模型') } })
    await rm(join(workspace, DOC_PATH))
    const result = await runtime.runDocKeeperMaintenance({ ...input, mode: 'check' })
    expect(result.health).toBe('unknown')
  })
})

describe('doc-keeper service：输入校验', () => {
  it('拒绝空 globs、越界 glob 与非法 knowledgePath', async () => {
    const { runtime } = await keeperFixture({ turn: () => { throw new Error('不应调用模型') } })
    await expect(runtime.runDocKeeperMaintenance({ globs: [], knowledgePath: DOC_PATH, mode: 'check' }))
      .rejects.toMatchObject({ code: 'INVALID_INPUT' })
    await expect(runtime.runDocKeeperMaintenance({ globs: ['../escape/**'], knowledgePath: DOC_PATH, mode: 'check' }))
      .rejects.toMatchObject({ code: 'INVALID_INPUT' })
    await expect(runtime.runDocKeeperMaintenance({ globs: ['/abs/**'], knowledgePath: DOC_PATH, mode: 'check' }))
      .rejects.toMatchObject({ code: 'INVALID_INPUT' })
    await expect(runtime.runDocKeeperMaintenance({ ...input, knowledgePath: '/abs.md', mode: 'check' }))
      .rejects.toMatchObject({ code: 'INVALID_INPUT' })
    await expect(runtime.runDocKeeperMaintenance({ ...input, knowledgePath: '../escape.md', mode: 'check' }))
      .rejects.toMatchObject({ code: 'INVALID_INPUT' })
  })
})

describe('doc-keeper service：refresh 模式（脚本模型驱动五工具）', () => {
  const newBody = [
    '## 职责', '', '- 负责 server 模块（关注路径：`src/**`）。', '',
    '## 关键文件', '', '- `src/a.ts`：入口，导出 a=2。', '',
    '## 已知坑', '', '- 暂无。', '',
    '## changelog', '', '- 2026-11-12 增量刷新：a 从 1 变 2；1 条提交。', '',
  ].join('\n')

  function refreshScript(): ProviderScript {
    return {
      turn: (_userText, toolCount) => {
        switch (toolCount) {
          case 0: return toolTurn('detect_changes', {})
          case 1: return toolTurn('read_knowledge', {})
          case 2: return toolTurn('git_diff', {})
          case 3: return toolTurn('read_code', { paths: ['src/a.ts'] })
          case 4: return toolTurn('write_knowledge', { body: newBody })
          default: return textTurn('刷新完成：关键文件描述已更新（a=2），1 条提交，无需人工复核。')
        }
      },
    }
  }

  it('有变更时增量写回：updated=true、frontmatter 保留、stamp 更新、报告捕获', async () => {
    const { runtime, workspace } = await keeperFixture(refreshScript())
    const before = await readFile(join(workspace, DOC_PATH), 'utf8')
    const result = await runtime.runDocKeeperMaintenance({ ...input, mode: 'refresh', model: { provider: 'repro', modelId: 'repro-model' } })
    expect(result.mode).toBe('refresh')
    expect(result.updated).toBe(true)
    expect(result.health).toBe('fresh')
    expect(result.hash).toBeTruthy()
    expect(result.report).toContain('刷新完成')
    expect(result.error).toBeUndefined()

    const after = await readFile(join(workspace, DOC_PATH), 'utf8')
    expect(after).not.toBe(before)
    expect(result.hash).toBe(knowledgeHash(after))
    expect(after).toContain('botId: atlas')
    expect(after).toContain('module: server')
    expect(after).toContain('globs: ["src/**"]')
    expect(after).not.toContain(OLD_STAMP)
    expect(after.endsWith(newBody)).toBe(true)
    // 维护会话对普通列表隐藏。
    expect(await runtime.list()).toEqual([])
  })

  it('无变更时模型报告 fresh，不写回', async () => {
    const script: ProviderScript = {
      turn: (_userText, toolCount) => {
        if (toolCount === 0) return toolTurn('detect_changes', {})
        if (toolCount === 1) return toolTurn('read_knowledge', {})
        return textTurn('fresh：关注路径无新提交，未改写文档。')
      },
    }
    const { runtime, workspace } = await keeperFixture(script, { stamp: '2027-01-01T00:00:00.000Z' })
    const before = await readFile(join(workspace, DOC_PATH), 'utf8')
    const result = await runtime.runDocKeeperMaintenance({ ...input, mode: 'refresh' })
    expect(result.updated).toBe(false)
    expect(result.health).toBe('fresh')
    expect(result.report).toContain('fresh')
    expect(await readFile(join(workspace, DOC_PATH), 'utf8')).toBe(before)
  })
})

describe('doc-keeper extension：执行边界（fake api）', () => {
  const extension = createDocKeeperExtension()
  const ctx = undefined as unknown as Context

  function tool(name: string): ToolRegistration {
    const found = (extension.tools ?? []).find(item => item.name === name)
    if (found === undefined) throw new Error(`tool missing: ${name}`)
    return found
  }

  function fakeApi(repo: string, kind: string | undefined, task?: DocKeeperTaskShape): ToolExecutionApi {
    return {
      conversationId: 'conv-test',
      env: { cwd: repo },
      snapshot: async (doc: unknown) => {
        if (doc === CONVERSATION_KIND) return kind === undefined ? undefined : { kind }
        if (doc === DocKeeperTask) return task
        return undefined
      },
    } as unknown as ToolExecutionApi
  }

  function taskFor(repo: string): DocKeeperTaskShape {
    return { repo, knowledgePath: DOC_PATH, globs: ['src/**'], mode: 'refresh', botId: 'atlas', module: 'server' }
  }

  async function repoFixture(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), 'pi-keeper-ext-'))
    registerKeeperCleanup(async () => { await rm(root, { recursive: true, force: true }) })
    return await gitWorkspace(root)
  }

  it('五个工具齐备', () => {
    expect((extension.tools ?? []).map(item => item.name).sort()).toEqual([...DOC_KEEPER_TOOL_NAMES].sort())
  })

  it('非 docKeeper 会话调用工具一律 FORBIDDEN', async () => {
    const repo = await repoFixture()
    for (const name of DOC_KEEPER_TOOL_NAMES) {
      const args = name === 'read_code' ? { paths: ['src/a.ts'] } : name === 'write_knowledge' ? { body: 'x' } : {}
      await expect(tool(name).execute(args as never, fakeApi(repo, 'chat'), ctx))
        .rejects.toMatchObject({ code: 'FORBIDDEN' })
    }
  })

  it('docKeeper 会话缺任务目标同样 FORBIDDEN', async () => {
    const repo = await repoFixture()
    await expect(tool('detect_changes').execute({} as never, fakeApi(repo, 'docKeeper'), ctx))
      .rejects.toMatchObject({ code: 'FORBIDDEN' })
  })

  it('盖章任务后 detect_changes/read_knowledge/read_code 正常工作', async () => {
    const repo = await repoFixture()
    const api = fakeApi(repo, 'docKeeper', taskFor(repo))
    const changes = await tool('detect_changes').execute({} as never, api, ctx)
    expect(changes.details).toMatchObject({ count: 1, gitAvailable: true })
    const inspection = await tool('read_knowledge').execute({} as never, api, ctx)
    expect(inspection.details).toMatchObject({ health: 'stale' })
    const code = await tool('read_code').execute({ paths: ['src/a.ts'] } as never, api, ctx)
    expect(JSON.stringify(code.details)).toContain('export const a = 2')
  })

  it('write_knowledge 拒绝超正文上限', async () => {
    const repo = await repoFixture()
    const api = fakeApi(repo, 'docKeeper', taskFor(repo))
    await expect(tool('write_knowledge').execute({ body: 'x'.repeat(8001) } as never, api, ctx))
      .rejects.toMatchObject({ code: 'INVALID_INPUT' })
  })

  it('write/edit wrap 把 docKeeper 会话钉死在目标文档', async () => {
    const repo = await repoFixture()
    const base: ToolRegistration = {
      name: 'write',
      description: 'base write',
      execute: async () => ({ output: [{ type: 'text' as const, text: 'written' }] }),
    } as unknown as ToolRegistration
    type ToolWrap = Extract<NonNullable<Extension['wraps']>[number], { tool: string }>
    const wrapped = (extension.wraps ?? []).find((item): item is ToolWrap => 'tool' in item && item.tool === 'write')?.wrap(base)
    if (wrapped === undefined) throw new Error('write wrap missing')

    const keeperApi = fakeApi(repo, 'docKeeper', taskFor(repo))
    await expect(wrapped.execute({ path: 'src/a.ts' } as never, keeperApi, ctx))
      .rejects.toMatchObject({ code: 'ACCESS_DENIED' })
    await expect(wrapped.execute({ path: '../outside.md' } as never, keeperApi, ctx))
      .rejects.toMatchObject({ code: 'ACCESS_DENIED' })
    const allowed = await wrapped.execute({ path: DOC_PATH } as never, keeperApi, ctx)
    expect(allowed.output).toEqual([{ type: 'text', text: 'written' }])
    const absolute = await wrapped.execute({ path: join(repo, DOC_PATH) } as never, keeperApi, ctx)
    expect(absolute.output).toEqual([{ type: 'text', text: 'written' }])

    // 普通会话不受 wrap 影响。
    const chatApi = fakeApi(repo, 'chat')
    const passthrough = await wrapped.execute({ path: 'src/a.ts' } as never, chatApi, ctx)
    expect(passthrough.output).toEqual([{ type: 'text', text: 'written' }])
  })

  it('doc-keeper-policy section 只对盖章任务的维护会话渲染', async () => {
    const repo = await repoFixture()
    const policy = (extension.sections ?? []).find(item => item.key === 'doc-keeper-policy')
    if (policy === undefined) throw new Error('policy section missing')
    const renderInput = (kind: string | undefined, task?: DocKeeperTaskShape) => ({
      conversationId: 'conv-test',
      read: {
        snapshot: async (doc: unknown) => {
          if (doc === CONVERSATION_KIND) return kind === undefined ? undefined : { kind }
          if (doc === DocKeeperTask) return task
          return undefined
        },
      },
    }) as never
    expect(await policy.render(renderInput('chat'), ctx)).toBeUndefined()
    expect(await policy.render(renderInput('docKeeper'), ctx)).toBeUndefined()
    const text = await policy.render(renderInput('docKeeper', taskFor(repo)), ctx)
    expect(text).toContain(repo)
    expect(text).toContain(DOC_PATH)
    expect(text).toContain('mode：refresh')
    expect(text).toContain('write_knowledge')
  })
})
