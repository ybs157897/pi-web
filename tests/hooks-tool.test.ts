import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import type { ToolExecutionApi } from '@earendil-works/pi-durable'
import { createManageHooksTool } from '../src/server/hooks/tool.ts'
import { hookDigest, HooksStore } from '../src/server/hooks/store.ts'
import { configDefaults } from '../src/server/hooks/schema.ts'

/**
 * manage_hooks 工具契约测试（直调 tool.execute + stub api）。
 *
 * 关键契约：
 * - create 一站式：script 落盘 + 配置追加 + 项目级自动信任；
 * - list 双来源 trust 状态；update 重新 admit（旧 digest revoke）；delete revoke；
 * - set_enabled 不动信任；canWrite 拒绝写操作；无工作区项目级拒绝；index 越界报错。
 */

const tempDirs: string[] = []
async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'pi-web-hooks-tool-'))
  tempDirs.push(dir)
  return dir
}
afterAll(async () => {
  await Promise.all(tempDirs.map(dir => rm(dir, { recursive: true, force: true })))
})

async function setup(canWrite = true) {
  const dir = await tempDir()
  const store = new HooksStore(join(dir, 'home'), dir)
  const workspacePath = join(dir, 'repo')
  await mkdir(workspacePath, { recursive: true })
  const extension = createManageHooksTool({
    store,
    canWrite: async () => canWrite,
    resolveWorkspace: async () => ({ id: 'ws1', path: workspacePath }),
  })
  const tool = extension.tools?.[0]
  if (tool === undefined) throw new Error('缺少 manage_hooks 工具')
  const api = { conversationId: 1 } as unknown as ToolExecutionApi
  const execute = (args: Record<string, unknown>) => tool.execute(args as never, api, BACKGROUND_CONTEXT) as Promise<{ output: Array<{ text: string }>; details: Record<string, unknown> }>
  return { dir, store, workspacePath, execute }
}

const hookDef = { type: 'process' as const, command: 'node', args: ['hook-scripts/check.mjs'] }

describe('manage_hooks create 与 list', () => {
  // create 一站式：脚本落盘、配置追加、项目级自动信任、返回 index。
  it('creates a project hook with script and auto-trust', async () => {
    const { store, workspacePath, execute } = await setup()
    const result = await execute({ action: 'create', scope: 'project', event: 'Stop', hook: hookDef, script: { name: 'check.mjs', content: 'console.log(1)\n' } })
    expect(await readFile(join(workspacePath, '.pi-web', 'hook-scripts', 'check.mjs'), 'utf8')).toBe('console.log(1)\n')
    const config = (await store.loadProject(workspacePath)).config
    expect(config?.events?.Stop?.[0].hooks).toHaveLength(1)
    const digest = hookDigest('Stop', undefined, hookDef, configDefaults(config))
    expect((await store.trustedDigests('ws1'))?.has(digest)).toBe(true)
    expect(result.details.index).toBe(0)
    expect(result.output[0].text).toContain('立即生效')
  })

  // 用户级 create 不写信任集。
  it('creates user hooks without trust records', async () => {
    const { store, execute } = await setup()
    await execute({ action: 'create', scope: 'user', event: 'PreToolUse', matcher: 'Bash', hook: hookDef })
    expect((await store.trustedDigests('ws1'))?.size ?? 0).toBe(0)
    expect((await store.loadUser()).config?.events?.PreToolUse?.[0].matcher).toBe('Bash')
  })

  // list 返回双来源与 trust 状态。
  it('lists both sources with trust states', async () => {
    const { execute } = await setup()
    await execute({ action: 'create', scope: 'user', event: 'Stop', hook: hookDef })
    await execute({ action: 'create', scope: 'project', event: 'Stop', hook: hookDef })
    const result = await execute({ action: 'list', scope: 'user' })
    const sources = result.details.sources as Array<{ source: string; entries: Array<{ trust: string }> }>
    expect(sources.find(item => item.source === 'user')?.entries[0].trust).toBe('not_required')
    expect(sources.find(item => item.source === 'project')?.entries[0].trust).toBe('trusted')
  })

  // 同 matcher 组并入，index 连续。
  it('appends into the same matcher group with sequential index', async () => {
    const { execute } = await setup()
    await execute({ action: 'create', scope: 'user', event: 'PostToolUse', matcher: 'Write', hook: hookDef })
    const second = await execute({ action: 'create', scope: 'user', event: 'PostToolUse', matcher: 'Write', hook: { ...hookDef, command: 'node2' } })
    expect(second.details.index).toBe(1)
  })
})

describe('manage_hooks update/delete/set_enabled', () => {
  // update 替换条目并重新信任（旧 digest 移除）。
  it('update re-admits the new digest and revokes the old', async () => {
    const { store, execute } = await setup()
    await execute({ action: 'create', scope: 'project', event: 'Stop', hook: hookDef })
    const oldDigest = hookDigest('Stop', undefined, hookDef, configDefaults({}))
    const updated = { ...hookDef, timeoutMs: 30000 }
    await execute({ action: 'update', scope: 'project', event: 'Stop', index: 0, hook: updated })
    const trusted = await store.trustedDigests('ws1')
    expect(trusted?.has(oldDigest)).toBe(false)
    expect(trusted?.has(hookDigest('Stop', undefined, updated, configDefaults({})))).toBe(true)
  })

  // delete 移除条目并撤销信任。
  it('delete removes the entry and revokes trust', async () => {
    const { store, workspacePath, execute } = await setup()
    await execute({ action: 'create', scope: 'project', event: 'Stop', hook: hookDef })
    await execute({ action: 'delete', scope: 'project', event: 'Stop', index: 0 })
    expect((await store.loadProject(workspacePath)).config?.events?.Stop).toBeUndefined()
    expect((await store.trustedDigests('ws1'))?.size).toBe(0)
    const list = await execute({ action: 'list', scope: 'project' })
    const project = (list.details.sources as Array<{ source: string; entries: unknown[] }>).find(item => item.source === 'project')
    expect(project?.entries).toHaveLength(0)
  })

  // set_enabled 改 enabled 不动信任。
  it('set_enabled toggles without touching trust', async () => {
    const { store, workspacePath, execute } = await setup()
    await execute({ action: 'create', scope: 'project', event: 'Stop', hook: hookDef })
    await execute({ action: 'set_enabled', scope: 'project', event: 'Stop', index: 0, enabled: false })
    const config = (await store.loadProject(workspacePath)).config
    expect(config?.events?.Stop?.[0].hooks[0].enabled).toBe(false)
    expect((await store.trustedDigests('ws1'))?.size).toBe(1)
  })

  // index 越界报错。
  it('rejects out-of-range index', async () => {
    const { execute } = await setup()
    await expect(execute({ action: 'delete', scope: 'user', event: 'Stop', index: 5 })).rejects.toThrow('越界')
    await expect(execute({ action: 'update', scope: 'user', event: 'Stop', hook: hookDef })).rejects.toThrow('index')
  })
})

describe('manage_hooks 授权与边界', () => {
  // canWrite=false 拒绝写操作，list 放行。
  it('denies writes when canWrite is false but allows list', async () => {
    const { execute } = await setup(false)
    await expect(execute({ action: 'create', scope: 'user', event: 'Stop', hook: hookDef })).rejects.toThrow('不允许')
    await expect(execute({ action: 'list', scope: 'user' })).resolves.toBeDefined()
  })

  // 无工作区拒绝项目级操作。
  it('rejects project operations without a workspace', async () => {
    const dir = await tempDir()
    const store = new HooksStore(join(dir, 'home'), dir)
    const extension = createManageHooksTool({ store, canWrite: async () => true, resolveWorkspace: async () => undefined })
    const api = { conversationId: 1 } as unknown as ToolExecutionApi
    const tool = extension.tools![0]
    await expect(tool.execute({ action: 'create', scope: 'project', event: 'Stop', hook: hookDef } as never, api, BACKGROUND_CONTEXT)).rejects.toThrow('没有工作区')
  })

  // 非法 hook 定义与非法脚本名拒绝。
  it('rejects invalid hook definitions and script names', async () => {
    const { execute } = await setup()
    await expect(execute({ action: 'create', scope: 'user', event: 'Stop', hook: { type: 'process', command: '' } })).rejects.toThrow('不合法')
    await expect(execute({ action: 'create', scope: 'user', event: 'NoSuchEvent', hook: hookDef })).rejects.toThrow('event')
    await expect(execute({ action: 'create', scope: 'user', event: 'Stop', hook: hookDef, script: { name: '../evil.mjs', content: 'x' } })).rejects.toThrow('非法脚本名')
  })
})