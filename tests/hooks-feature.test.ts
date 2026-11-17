import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { HooksStore } from '../src/server/hooks/store.ts'
import { createHooksFeature } from '../src/server/runtime/hooks.ts'

/**
 * hooks feature 服务契约测试。
 *
 * 关键契约：
 * - list 双来源投影 + trust 状态（not_required/trusted/pending/blocked）；
 * - index 与 manage_hooks 同口径（事件内组顺序→组内顺序展开）；
 * - save 不自动 admit：项目级编辑后新 digest 回落 pending（安全边界）；
 * - removeEntry 空组清理 + revoke；setEnabled 不改信任状态；
 * - 损坏配置拒绝写；无工作区项目级操作抛错。
 */

const tempDirs: string[] = []
async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'pi-web-hooks-feature-'))
  tempDirs.push(dir)
  return dir
}
afterAll(async () => {
  await Promise.all(tempDirs.map(dir => rm(dir, { recursive: true, force: true })))
})

async function setup() {
  const dir = await tempDir()
  const store = new HooksStore(join(dir, 'home'), dir)
  const workspace = join(dir, 'repo')
  const feature = createHooksFeature({ store, workspacePath: id => (id === 'ws1' ? workspace : undefined) })
  return { store, workspace, feature }
}

const processEntry = { type: 'process' as const, command: 'node', args: ['check.mjs'] }

describe('hooks feature list 与 trust 投影', () => {
  // 用户级 trust 恒 not_required；项目级未批准为 pending，批准后 trusted，撤销回落。
  it('projects trust states per source', async () => {
    const { store, workspace, feature } = await setup()
    await store.saveUser({ events: { Stop: [{ hooks: [processEntry] }] } })
    await store.saveProject(workspace, { events: { PreToolUse: [{ matcher: 'Bash', hooks: [processEntry] }] } })
    const before = await feature.list('ws1')
    expect(before.user.entries[0].trust).toBe('not_required')
    expect(before.project?.entries[0].trust).toBe('pending')
    expect(before.project?.entries[0].event).toBe('PreToolUse')
    await feature.trust({ workspaceId: 'ws1', digest: before.project!.entries[0].digest })
    const after = await feature.list('ws1')
    expect(after.project?.entries[0].trust).toBe('trusted')
    await feature.revoke({ workspaceId: 'ws1', digest: after.project!.entries[0].digest })
    expect((await feature.list('ws1')).project?.entries[0].trust).toBe('pending')
  })

  // trust store 损坏 → blocked（fail-closed 展示）。
  it('shows blocked when the trust store is corrupt', async () => {
    const { store, workspace, feature } = await setup()
    await store.saveProject(workspace, { events: { Stop: [{ hooks: [processEntry] }] } })
    await writeFile(store.trustPath(), '{ broken', 'utf8')
    const view = await feature.list('ws1')
    expect(view.project?.entries[0].trust).toBe('blocked')
  })

  // index 跨组连续计数；无工作区只返回 user。
  it('numbers entries across groups and omits project without workspace', async () => {
    const { store, feature } = await setup()
    await store.saveUser({ events: { PostToolUse: [
      { matcher: 'Write', hooks: [processEntry, processEntry] },
      { matcher: 'Edit', hooks: [processEntry] },
    ] } })
    const view = await feature.list()
    expect(view.project).toBeUndefined()
    expect(view.user.entries.map(entry => entry.index)).toEqual([0, 1, 2])
    expect(view.user.entries[2].matcher).toBe('Edit')
  })

  // 来源级默认值投影；损坏来源带 error 且 entries 为空。
  it('projects source defaults and corrupt-source diagnostics', async () => {
    const { store, feature } = await setup()
    await store.saveUser({ timeoutMs: 5000, enabled: false })
    const view = await feature.list()
    expect(view.user.timeoutMs).toBe(5000)
    expect(view.user.enabled).toBe(false)
    await writeFile(store.userConfigPath(), '{ broken', 'utf8')
    const corrupt = await feature.list()
    expect(corrupt.user.error).toContain('JSON')
    expect(corrupt.user.entries).toHaveLength(0)
  })
})

describe('hooks feature 写操作', () => {
  // save 项目级不自动 admit：编辑执行参数后 digest 变化回落 pending。
  it('save does not auto-admit project edits', async () => {
    const { store, workspace, feature } = await setup()
    await store.saveProject(workspace, { events: { Stop: [{ hooks: [processEntry] }] } })
    const initial = await feature.list('ws1')
    await feature.trust({ workspaceId: 'ws1', digest: initial.project!.entries[0].digest })
    // 编辑 command（执行参数变化）→ 新 digest 未批准 → pending。
    await feature.save({ scope: 'project', workspaceId: 'ws1', config: { events: { Stop: [{ hooks: [{ ...processEntry, command: 'node2' }] }] } } })
    const edited = await feature.list('ws1')
    expect(edited.project?.entries[0].trust).toBe('pending')
  })

  // 无工作区项目级抛错；不存在的工作区抛错。
  it('rejects missing or unknown workspace for project operations', async () => {
    const { feature } = await setup()
    await expect(feature.save({ scope: 'project', config: { events: { Stop: [{ hooks: [processEntry] }] } } })).rejects.toThrow('工作区')
    await expect(feature.save({ scope: 'project', workspaceId: 'nope', config: {} })).rejects.toThrow('不存在')
  })

  // removeEntry 删除条目并清理空组；项目级同时 revoke；越界抛错。
  it('removes entries, cleans empty groups and revokes project trust', async () => {
    const { store, workspace, feature } = await setup()
    await store.saveProject(workspace, { events: { Stop: [{ hooks: [processEntry] }] } })
    const view = await feature.list('ws1')
    const digest = view.project!.entries[0].digest
    await feature.trust({ workspaceId: 'ws1', digest })
    await feature.removeEntry({ scope: 'project', workspaceId: 'ws1', event: 'Stop', index: 0 })
    const after = await feature.list('ws1')
    expect(after.project?.entries).toHaveLength(0)
    expect((await store.trustedDigests('ws1'))?.has(digest)).toBe(false)
    await expect(feature.removeEntry({ scope: 'project', workspaceId: 'ws1', event: 'Stop', index: 0 })).rejects.toThrow('不存在')
  })

  // setEnabled 改 enabled 不动信任状态（enabled 不参与 digest）。
  it('toggles enabled without changing trust', async () => {
    const { store, workspace, feature } = await setup()
    await store.saveProject(workspace, { events: { Stop: [{ hooks: [processEntry] }] } })
    const view = await feature.list('ws1')
    await feature.trust({ workspaceId: 'ws1', digest: view.project!.entries[0].digest })
    await feature.setEnabled({ scope: 'project', workspaceId: 'ws1', event: 'Stop', index: 0, enabled: false })
    const after = await feature.list('ws1')
    expect(after.project?.entries[0].entry.enabled).toBe(false)
    expect(after.project?.entries[0].trust).toBe('trusted')
  })

  // 损坏配置拒绝写操作（保护用户可修复的文件）。
  it('refuses writes to a corrupt source', async () => {
    const { store, feature } = await setup()
    await store.saveUser({})
    await writeFile(store.userConfigPath(), '{ broken', 'utf8')
    await expect(feature.setEnabled({ scope: 'user', event: 'Stop', index: 0, enabled: false })).rejects.toThrow('JSON')
  })
})