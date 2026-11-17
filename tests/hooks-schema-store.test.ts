import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import {
  configDefaults,
  DEFAULT_MAX_OUTPUT_BYTES,
  DEFAULT_TIMEOUT_MS,
  hooksFileSchema,
  matchHookMatcher,
  normalizeHookOutput,
} from '../src/server/hooks/schema.ts'
import { eventGroups, hookDigest, HooksStore } from '../src/server/hooks/store.ts'

/**
 * hooks 基础层（schema + store）契约测试。
 *
 * 关键契约：
 * - matcher 语义对齐 ZCode：缺省/空/`*` 全匹配，纯名称列表精确匹配，其余正则，非法正则永不匹配；
 * - digest 覆盖全部执行参数（改 timeout 也失效），enabled 不参与（启停是管理操作）；
 * - trust store 损坏 fail-closed：项目级全拒，批准/撤销也拒绝；
 * - 配置热读：mtime 变化后重新加载；单来源损坏不牵连另一来源；
 * - 脚本落盘：禁路径分隔符、禁越界、禁符号链接。
 */

const tempDirs: string[] = []
async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'pi-web-hooks-test-'))
  tempDirs.push(dir)
  return dir
}
afterAll(async () => {
  await Promise.all(tempDirs.map(dir => rm(dir, { recursive: true, force: true })))
})

describe('hooks matcher 契约', () => {
  // 缺省、空串、* 都匹配全部。
  it('matches everything when matcher is omitted, empty or *', () => {
    for (const matcher of [undefined, '', '*']) {
      expect(matchHookMatcher(matcher, 'Write').matched).toBe(true)
    }
  })

  // 纯字母数字下划线与 | 按精确名称列表匹配，大小写敏感。
  it('matches exact name lists case-sensitively', () => {
    expect(matchHookMatcher('Write|Edit', 'Write').matched).toBe(true)
    expect(matchHookMatcher('Write|Edit', 'Edit').matched).toBe(true)
    expect(matchHookMatcher('Write|Edit', 'write').matched).toBe(false)
    expect(matchHookMatcher('Write|Edit', 'Bash').matched).toBe(false)
  })

  // 其余字符串按正则；非法正则永不匹配并标记 invalid。
  it('treats other strings as regex and never matches invalid regex', () => {
    expect(matchHookMatcher('^mcp__.*', 'mcp__server__tool').matched).toBe(true)
    expect(matchHookMatcher('^mcp__.*', 'write').matched).toBe(false)
    const invalid = matchHookMatcher('[unclosed', 'Write')
    expect(invalid.matched).toBe(false)
    expect(invalid.invalid).toBe(true)
  })

  // 无查询值的事件（Stop/UserPromptSubmit）即使带 matcher 也执行。
  it('ignores matcher when the event has no match value', () => {
    expect(matchHookMatcher('Write', undefined).matched).toBe(true)
  })
})

describe('hooks 输出归一化', () => {
  // snake_case 别名与事件专属 additionalContext 按序合并。
  it('merges additionalContext aliases and event-specific context', () => {
    const normalized = normalizeHookOutput({
      additionalContext: 'a',
      additional_context: 'b',
      hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: 'c' },
    }, 'PostToolUse')
    expect(normalized.additionalContext).toBe('a\nb\nc')
    expect(normalized.block).toBe(false)
  })

  // 事件专属输出只在 hookEventName 匹配时消费。
  it('ignores hookSpecificOutput for a different event', () => {
    const normalized = normalizeHookOutput({
      hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny' },
    }, 'PostToolUse')
    expect(normalized.block).toBe(false)
  })

  // deny / continue:false / decision:block 都归一为 block。
  it('normalizes deny, continue:false and decision:block to block', () => {
    expect(normalizeHookOutput({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: '危险' } }, 'PreToolUse').block).toBe(true)
    expect(normalizeHookOutput({ continue: false }, 'UserPromptSubmit').block).toBe(true)
    expect(normalizeHookOutput({ decision: 'block' }, 'Stop').block).toBe(true)
    expect(normalizeHookOutput({ decision: 'approve' }, 'PreToolUse').block).toBe(false)
  })

  // 配置 schema 保留未知字段（往返不丢失），拒绝非法类型。
  it('preserves unknown config fields and rejects invalid types', () => {
    const parsed = hooksFileSchema.safeParse({ hooks: { enabled: true, futureField: 1, events: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'process', command: 'node', args: ['x.mjs'], extra: true }] }] } } })
    expect(parsed.success).toBe(true)
    if (parsed.success) {
      expect((parsed.data.hooks as Record<string, unknown>).futureField).toBe(1)
    }
    expect(hooksFileSchema.safeParse({ hooks: { timeoutMs: -5 } }).success).toBe(false)
    expect(hooksFileSchema.safeParse({ hooks: { events: { NoSuchEvent: [] } } }).success).toBe(false)
  })

  // 默认值：来源级覆盖全局默认。
  it('resolves defaults from source config', () => {
    expect(configDefaults(undefined)).toEqual({ timeoutMs: DEFAULT_TIMEOUT_MS, maxOutputBytes: DEFAULT_MAX_OUTPUT_BYTES })
    expect(configDefaults({ timeoutMs: 5000 })).toEqual({ timeoutMs: 5000, maxOutputBytes: DEFAULT_MAX_OUTPUT_BYTES })
  })
})

describe('hooks digest 与信任', () => {
  const entry = { type: 'process' as const, command: 'node', args: ['x.mjs'] }
  const defaults = { timeoutMs: DEFAULT_TIMEOUT_MS, maxOutputBytes: DEFAULT_MAX_OUTPUT_BYTES }

  // 改任何执行参数都使 digest 失效；enabled 不参与。
  it('digest covers every execution parameter but not enabled', () => {
    const base = hookDigest('PreToolUse', 'Bash', entry, defaults)
    expect(hookDigest('PreToolUse', 'Bash', { ...entry, command: 'node2' }, defaults)).not.toBe(base)
    expect(hookDigest('PreToolUse', 'Bash', { ...entry, args: ['y.mjs'] }, defaults)).not.toBe(base)
    expect(hookDigest('PreToolUse', 'Bash', { ...entry, timeoutMs: 999 }, defaults)).not.toBe(base)
    expect(hookDigest('PreToolUse', 'Bash', { ...entry, includeNested: true }, defaults)).not.toBe(base)
    expect(hookDigest('PreToolUse', 'Edit', entry, defaults)).not.toBe(base)
    expect(hookDigest('PostToolUse', 'Bash', entry, defaults)).not.toBe(base)
    expect(hookDigest('PreToolUse', 'Bash', entry, { ...defaults, maxOutputBytes: 1024 })).not.toBe(base)
    expect(hookDigest('PreToolUse', 'Bash', { ...entry, enabled: false }, defaults)).toBe(base)
  })

  // admit 后 digest 进信任集；revoke 移除；另一 workspace 不共享信任。
  it('admits and revokes digests per workspace', async () => {
    const dir = await tempDir()
    const store = new HooksStore(join(dir, 'home'), dir)
    const digest = hookDigest('PreToolUse', undefined, entry, defaults)
    expect(await store.trustedDigests('ws1')).toEqual(new Set())
    await store.admit('ws1', digest)
    expect((await store.trustedDigests('ws1'))?.has(digest)).toBe(true)
    expect((await store.trustedDigests('ws2'))?.has(digest)).toBe(false)
    expect(await store.revoke('ws1', digest)).toBe(true)
    expect((await store.trustedDigests('ws1'))?.has(digest)).toBe(false)
    expect(await store.revoke('ws1', digest)).toBe(false)
  })

  // trust store 损坏 → fail-closed：trustedDigests 返回 undefined，admit/revoke 拒绝。
  it('fails closed when the trust store is corrupt', async () => {
    const dir = await tempDir()
    const store = new HooksStore(join(dir, 'home'), dir)
    await writeFile(store.trustPath(), '{ broken json', 'utf8')
    expect(await store.trustedDigests('ws1')).toBeUndefined()
    await expect(store.admit('ws1', 'a'.repeat(64))).rejects.toThrow('损坏')
    await expect(store.revoke('ws1', 'a'.repeat(64))).rejects.toThrow('损坏')
  })

  // schema 不合法的 trust 文件同样 fail-closed（strict 拒绝未知字段）。
  it('fails closed on schema-invalid trust file', async () => {
    const dir = await tempDir()
    const store = new HooksStore(join(dir, 'home'), dir)
    await writeFile(store.trustPath(), JSON.stringify({ version: 2, records: [] }), 'utf8')
    expect(await store.trustedDigests('ws1')).toBeUndefined()
  })
})

describe('hooks 配置热读与脚本落盘', () => {
  // 缺失→空配置；损坏→error 诊断；mtime 变化后重新加载。
  it('hot-reloads config on mtime change and isolates corrupt sources', async () => {
    const dir = await tempDir()
    const store = new HooksStore(join(dir, 'home'), dir)
    expect((await store.loadUser()).config).toBeUndefined()
    await store.saveUser({ enabled: true, events: { Stop: [{ hooks: [{ type: 'process', command: 'node' }] }] } })
    const first = await store.loadUser()
    expect(first.config?.enabled).toBe(true)
    // 直接改文件（模拟 agent/用户外部编辑）：mtime 变化后热读拿到新内容。
    await writeFile(store.userConfigPath(), JSON.stringify({ hooks: { enabled: false } }), 'utf8')
    const second = await store.loadUser()
    expect(second.config?.enabled).toBe(false)
    // 损坏文件：error 诊断，config 为 undefined。
    await writeFile(store.userConfigPath(), '{ broken', 'utf8')
    const third = await store.loadUser()
    expect(third.config).toBeUndefined()
    expect(third.error).toContain('JSON')
  })

  // 项目级配置路径在仓库 .pi-web 下；eventGroups 尊重来源 enabled。
  it('loads project config from the repo and respects source enabled flag', async () => {
    const dir = await tempDir()
    const store = new HooksStore(join(dir, 'home'), dir)
    const workspace = join(dir, 'repo')
    await store.saveProject(workspace, { events: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'process', command: 'node' }] }] } })
    expect(store.projectConfigPath(workspace)).toBe(join(workspace, '.pi-web', 'hooks.json'))
    const loaded = await store.loadProject(workspace)
    expect(eventGroups(loaded.config, 'PreToolUse')).toHaveLength(1)
    expect(eventGroups({ ...loaded.config, enabled: false }, 'PreToolUse')).toHaveLength(0)
    expect(eventGroups(undefined, 'PreToolUse')).toHaveLength(0)
  })

  // 脚本名白名单：禁路径分隔符与 ..；正常写入可读回。
  it('writes scripts with safe names only', async () => {
    const dir = await tempDir()
    const store = new HooksStore(join(dir, 'home'), dir)
    const scriptsDir = store.userScriptsDir()
    const path = await store.writeScript(scriptsDir, 'update-docs.mjs', 'console.log(1)\n')
    expect(await readFile(path, 'utf8')).toBe('console.log(1)\n')
    await expect(store.writeScript(scriptsDir, '../escape.mjs', 'x')).rejects.toThrow('非法脚本名')
    await expect(store.writeScript(scriptsDir, 'a/b.mjs', 'x')).rejects.toThrow('非法脚本名')
    await expect(store.writeScript(scriptsDir, '.hidden', 'x')).rejects.toThrow('非法脚本名')
  })

  // 目标是符号链接时拒绝写入（防借链接写出根外）。
  it('refuses to write through a symlink', async () => {
    const dir = await tempDir()
    const store = new HooksStore(join(dir, 'home'), dir)
    const scriptsDir = store.userScriptsDir()
    const outside = join(dir, 'outside.mjs')
    await writeFile(outside, 'original', 'utf8')
    const { mkdir } = await import('node:fs/promises')
    await mkdir(scriptsDir, { recursive: true })
    await symlink(outside, join(scriptsDir, 'link.mjs'))
    await expect(store.writeScript(scriptsDir, 'link.mjs', 'evil')).rejects.toThrow('符号链接')
    expect(await readFile(outside, 'utf8')).toBe('original')
  })
})