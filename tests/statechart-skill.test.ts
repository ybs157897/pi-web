import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { SkillStore } from '../src/server/skills/store.ts'

/**
 * 固定（pin）内置技能包的形状：statechart 技能必须始终可发现、frontmatter 干净、
 * 且能连同方法参考文档一起加载——它是产品表面（提示词目录 + 分析工作流）的一部分，
 * 不是测试布景。
 */
const temporaryRoots: string[] = []

/**
 * 构造只含内置技能包的 SkillStore。
 * @returns 默认 builtinRoot 相对于 store 模块（即仓库 skills/ 目录）解析、
 *          且不挂全局根的 SkillStore，因此目录内容恰为随仓库分发的内置技能。
 */
function bundledStore() {
  return new SkillStore()
}

/** 逐用例清理临时 workspace 目录，避免 tmpdir 中残留垃圾。 */
afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('builtin statechart skill', () => {
  it('is discoverable in the bundled catalog with clean frontmatter', async () => {
    const workspace = await realpath(await mkdtemp(join(tmpdir(), 'pi-web-statechart-')))
    temporaryRoots.push(workspace)
    const store = bundledStore()
    const catalog = await store.list(workspace)
    const statechart = catalog.skills.find(item => item.id === 'builtin:statechart')
    expect(statechart).toMatchObject({
      name: 'statechart',
      source: 'builtin',
      writable: false,
    })
    expect(statechart?.description).toContain('状态 × 事件')
    // 触发词两侧的语义都必须完整越过模型目录的 250 字符上限。
    expect(statechart!.description.length).toBeLessThanOrEqual(250)
    expect(statechart?.description).toContain('普通业务流程查询、无状态逻辑和格式调整不适用')
    expect(await store.validate(workspace, 'statechart')).toEqual({ valid: true, errors: [], warnings: [] })
  })

  // 验证加载后的技能正文与方法参考资源：正文必须保留工作流关键要素
  // （穷举提问、ask_user_question、references/method.md 引用），
  // 且不包含已被修订掉的旧表述「问题未决就结束回合」。
  it('loads with its method reference and carries the workflow essentials', async () => {
    const workspace = await realpath(await mkdtemp(join(tmpdir(), 'pi-web-statechart-')))
    temporaryRoots.push(workspace)
    const store = bundledStore()
    const loaded = await store.load(workspace, 'builtin:statechart')
    expect(loaded.skill.name).toBe('statechart')
    expect(loaded.content).toContain('Enumerate exhaustively')
    expect(loaded.content).toContain('ask_user_question')
    expect(loaded.content).toContain('references/method.md')
    expect(loaded.content).toContain('proceed directly to implementation')
    expect(loaded.content).toContain('Pause only the work that depends')
    expect(loaded.content).not.toContain('End the turn while the questions are pending')

    const method = await store.load(workspace, 'builtin:statechart', 'references/method.md')
    expect(method.resource).toBe('references/method.md')
    expect(method.content).toContain('Enumeration procedure')
    expect(method.content).toContain('review-question protocol')
    expect(method.files).toEqual(['ORIGIN.md', 'SKILL.md', 'references/method.md'])
  })
})
