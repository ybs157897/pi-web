import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { SkillStore } from '../src/server/skills/store.ts'

/**
 * SkillStore 契约测试：技能发现（builtin/global/user-agents/workspace 多层根）、
 * 松散技能容错（无 frontmatter/名称不一致/非 kebab 目录）、同名遮蔽与发现顺序、
 * 保存的幂等与版本冲突、符号链接读取与严格写入、资源与名称的安全边界。
 */
const temporaryRoots: string[] = []

/**
 * 构造标准 fixture：临时根下的 workspace + builtin 目录，store 指向该 builtin。
 * @returns 各目录路径与 SkillStore；root 已登记待清理
 */
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'pi-web-skills-')))
  temporaryRoots.push(root)
  const workspace = join(root, 'workspace')
  const builtin = join(root, 'builtin')
  await mkdir(workspace)
  await mkdir(builtin)
  return { root, workspace, builtin, store: new SkillStore({ builtinRoot: builtin }) }
}

/**
 * 构造技能 SKILL.md 正文。
 * @param description 多行 YAML 描述（模拟折叠标量），验证解析
 * @returns 带 frontmatter 的完整正文
 */
function skill(name: string, description = 'A useful skill.', body = 'Follow the task instructions carefully.'): string {
  return `---\nname: ${name}\ndescription: >-\n  ${description}\n  with a second line\n---\n\n${body}\n`
}

/**
 * 在指定技能根下落盘一个技能目录。
 * @returns 技能目录路径
 */
async function putSkill(root: string, name: string, content: string): Promise<string> {
  const directory = join(root, name)
  await mkdir(directory, { recursive: true })
  await writeFile(join(directory, 'SKILL.md'), content)
  return directory
}

/** 逐用例清理全部临时根目录。 */
afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('SkillStore', () => {
  // 基础链路：合法技能列出（builtin 前缀在前）、多行 YAML 描述折叠、
  // 资源文件加载与本地相对链接校验。
  it('lists valid skills, parses multiline YAML, loads resources, and validates local links', async () => {
    const { workspace, builtin, store } = await fixture()
    const builtInSkill = skill('release-check', 'Review a release.', 'Read [the checklist](references/checklist.md).')
    const builtInDirectory = await putSkill(builtin, 'release-check', builtInSkill)
    await mkdir(join(builtInDirectory, 'references'))
    await writeFile(join(builtInDirectory, 'references', 'checklist.md'), 'Check tests and changelog.\n')
    await putSkill(join(workspace, '.agents', 'skills'), 'release-check-local', skill('release-check-local', 'Local workflow.'))

    const catalog = await store.list(workspace)
    expect(catalog.diagnostics).toEqual([])
    expect(catalog.skills.map(item => item.id)).toEqual(['builtin:release-check', 'agents:release-check-local'])
    expect(catalog.skills[0]).toMatchObject({
      name: 'release-check',
      description: 'Review a release. with a second line',
      source: 'builtin',
      writable: false,
    })

    const loaded = await store.load(workspace, 'builtin:release-check', 'references/checklist.md')
    expect(loaded.resource).toBe('references/checklist.md')
    expect(loaded.content).toBe('Check tests and changelog.\n')
    expect(loaded.files).toEqual(['SKILL.md', 'references/checklist.md'])
    expect(await store.validate(workspace, 'release-check')).toEqual({ valid: true, errors: [], warnings: [] })
  })

  // 校验门槛：frontmatter 缺 name 或 description、描述超长的技能不进目录，
  // 但仍以显式 ID 校验出错误明细。
  it('drops skills whose frontmatter lacks name or description and validates them by explicit ID', async () => {
    const { workspace, store } = await fixture()
    await putSkill(join(workspace, '.agents', 'skills'), 'valid-skill', skill('valid-skill'))
    await putSkill(join(workspace, '.agents', 'skills'), 'no-name', '---\ndescription: Has no name.\n---\nbody\n')
    await putSkill(join(workspace, '.agents', 'skills'), 'no-description', '---\nname: no-description\n---\nbody\n')
    await putSkill(join(workspace, '.agents', 'skills'), 'long-description', `---\nname: long-description\ndescription: ${'x'.repeat(1_025)}\n---\nbody\n`)

    const catalog = await store.list(workspace)
    expect(catalog.skills.map(item => item.id)).toEqual(['agents:valid-skill'])
    expect(catalog.diagnostics.map(item => item.path)).toEqual(expect.arrayContaining([
      expect.stringContaining('/no-name/SKILL.md'),
      expect.stringContaining('/no-description/SKILL.md'),
      expect.stringContaining('/long-description/SKILL.md'),
    ]))
    expect(await store.validate(workspace, 'agents:no-description')).toMatchObject({ valid: false })
  })

  // 松散技能容错：无 frontmatter（以目录名命名）、frontmatter 名与目录不一致
  // （目录名是查找键）、非 kebab 目录、空描述都能加载；重复 YAML 键降为警告。
  it('loads loose skills: no frontmatter, mismatched name, non-kebab directory, empty description', async () => {
    const { workspace, store } = await fixture()
    await putSkill(join(workspace, '.agents', 'skills'), 'plain-notes', '# Plain notes\n\nNo frontmatter at all.\n')
    await putSkill(join(workspace, '.agents', 'skills'), 'folder-name', '---\nname: display-name\ndescription: Frontmatter name differs.\n---\nbody\n')
    await putSkill(join(workspace, '.agents', 'skills'), 'My Notes', '---\nname: My Notes\ndescription: Non-kebab names load too.\n---\nbody\n')
    await putSkill(join(workspace, '.agents', 'skills'), 'empty-description', '---\nname: empty-description\ndescription: ""\n---\nbody\n')
    // Duplicate YAML keys are skipped as warnings, not dropped.
    await putSkill(join(workspace, '.agents', 'skills'), 'dup-keys', '---\nname: first\nname: dup-keys\ndescription: Duplicate keys.\n---\nbody\n')

    const catalog = await store.list(workspace)
    expect(catalog.diagnostics).toEqual([])
    expect(catalog.skills.map(item => item.id)).toEqual([
      'agents:folder-name', 'agents:dup-keys', 'agents:empty-description', 'agents:My Notes', 'agents:plain-notes',
    ])

    // 无 frontmatter：以目录名命名、描述为空，仍可加载。
    await expect(store.load(workspace, 'plain-notes')).resolves.toMatchObject({
      skill: { id: 'agents:plain-notes', name: 'plain-notes', description: '' },
      content: '# Plain notes\n\nNo frontmatter at all.\n',
    })
    // frontmatter 名不一致时，目录名仍是查找键。
    await expect(store.load(workspace, 'folder-name')).resolves.toMatchObject({ skill: { name: 'display-name' } })
    // 非 kebab 目录与空描述都能加载；校验以警告形式报告质量问题。
    const validation = await store.validate(workspace, 'empty-description')
    expect(validation.valid).toBe(true)
    expect(validation.warnings.join(' ')).toMatch(/description is empty/u)
  })

  // 遮蔽规则：同名技能按发现顺序（builtin > .pi-web > .agents）解析裸名加载，
  // 全部副本仍在目录可见；源限定 id 可直达被遮蔽副本，未知源报 INVALID_INPUT。
  it('shadows same-named skills by discovery order instead of failing', async () => {
    const { workspace, builtin, store } = await fixture()
    await putSkill(builtin, 'shared-name', skill('shared-name', 'Bundled version.'))
    await putSkill(join(workspace, '.pi-web', 'skills'), 'shared-name', skill('shared-name', 'Pi version.'))
    await putSkill(join(workspace, '.agents', 'skills'), 'shared-name', skill('shared-name', 'Agents version.'))

    // 全部副本留在目录中（按名称再按来源排序），但裸名加载按发现顺序取
    // builtin > .pi-web > .agents 的第一个。
    const catalog = await store.list(workspace)
    expect(catalog.skills.map(item => item.id)).toEqual(['agents:shared-name', 'builtin:shared-name', 'pi:shared-name'])
    await expect(store.load(workspace, 'shared-name')).resolves.toMatchObject({ skill: { source: 'builtin', description: 'Bundled version. with a second line' } })
    // 源限定 id 仍可直接命中被遮蔽的副本。
    await expect(store.load(workspace, 'pi:shared-name')).resolves.toMatchObject({ skill: { source: 'pi', description: 'Pi version. with a second line' } })
    await expect(store.load(workspace, 'agents:shared-name')).resolves.toMatchObject({ skill: { source: 'agents', description: 'Agents version. with a second line' } })
    await expect(store.load(workspace, 'unknown:shared-name')).rejects.toMatchObject({ code: 'INVALID_INPUT' })
  })

  // 层级遍历：workspace 向上走到仓库根（.git 为界）发现技能；同名时更深层级遮蔽仓库根；
  // 仓库根之上不扫；无仓库时只扫 workspace 自身。
  it('walks workspace levels up to the repository root with deeper levels winning', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'pi-web-skills-')))
    temporaryRoots.push(root)
    const repo = join(root, 'repo')
    const workspace = join(repo, 'packages', 'app')
    await mkdir(join(repo, '.git'), { recursive: true })
    await mkdir(workspace, { recursive: true })
    await putSkill(join(repo, '.pi-web', 'skills'), 'from-repo-root', skill('from-repo-root', 'Repo root version.'))
    await putSkill(join(repo, '.agents', 'skills'), 'layered', skill('layered', 'Repo agents version.'))
    await putSkill(join(workspace, '.agents', 'skills'), 'layered', skill('layered', 'Deeper agents version.'))
    const store = new SkillStore({ builtinRoot: join(root, 'builtin') })

    const catalog = await store.list(workspace)
    expect(catalog.skills.map(item => item.id)).toEqual(['pi:from-repo-root', 'agents:layered'])
    // 两个层级同名：更深层级遮蔽仓库根。
    await expect(store.load(workspace, 'layered')).resolves.toMatchObject({ skill: { description: 'Deeper agents version. with a second line' } })
    await expect(store.load(workspace, 'from-repo-root')).resolves.toMatchObject({ skill: { source: 'pi' } })

    // 仓库根之上不在扫描范围内。
    await putSkill(join(root, '.pi-web', 'skills'), 'outside-repo', skill('outside-repo'))
    const bounded = await store.list(workspace)
    expect(bounded.skills.map(item => item.id)).toEqual(['pi:from-repo-root', 'agents:layered'])

    // 无仓库时遍历止步于 workspace 本身。
    const plain = join(root, 'plain')
    await mkdir(plain, { recursive: true })
    const plainStore = new SkillStore({ builtinRoot: join(root, 'builtin') })
    const plainCatalog = await plainStore.list(plain)
    expect(plainCatalog.skills.map(item => item.id)).toEqual([])
  })

  // 全局技能根：只读、source=global、frontmatter 的 when_to_use 折叠后透出；
  // workspace 技能没有该字段时省略。
  it('discovers user-level global skills as read-only and surfaces when_to_use', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'pi-web-skills-')))
    temporaryRoots.push(root)
    const workspace = join(root, 'workspace')
    const globalRoot = join(root, 'global-skills')
    await mkdir(workspace)
    await mkdir(globalRoot)
    const whenToUseSkill = '---\nname: triage-helper\ndescription: Triage production incidents.\nwhen_to_use: >-\n  Use when the user asks to diagnose\n  a live incident.\n---\n\nSteps here.\n'
    await putSkill(globalRoot, 'triage-helper', whenToUseSkill)
    const store = new SkillStore({ builtinRoot: join(root, 'builtin'), globalRoot })

    const catalog = await store.list(workspace)
    expect(catalog.diagnostics).toEqual([])
    expect(catalog.skills.map(item => item.id)).toEqual(['global:triage-helper'])
    expect(catalog.skills[0]).toMatchObject({
      source: 'global',
      writable: false,
      whenToUse: 'Use when the user asks to diagnose a live incident.',
    })
    await expect(store.load(workspace, 'global:triage-helper')).resolves.toMatchObject({ skill: { source: 'global' } })

    // Workspace skills without when_to_use simply omit the field.
    await putSkill(join(workspace, '.agents', 'skills'), 'plain-skill', skill('plain-skill'))
    const withWorkspace = await store.list(workspace)
    expect(withWorkspace.skills.map(item => item.id)).toEqual(['agents:plain-skill', 'global:triage-helper'])
    expect(withWorkspace.skills.find(item => item.id === 'agents:plain-skill')?.whenToUse).toBeUndefined()
  })

  // 共享用户根 ~/.agents/skills：只读、扫描先于 workspace 层级（对齐 ZCode/opencode），
  // 裸名命中用户副本、被遮蔽的 workspace 副本用源限定 id 仍可达；
  // 缺失的用户根是正常全新安装状态，不产生诊断。
  it('discovers the shared user-level ~/.agents/skills root as read-only, ahead of workspace levels', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'pi-web-skills-')))
    temporaryRoots.push(root)
    const workspace = join(root, 'workspace')
    const userAgents = join(root, 'agents-skills')
    await mkdir(workspace)
    await putSkill(userAgents, 'user-helper', skill('user-helper', 'User version.'))
    await putSkill(userAgents, 'layered', skill('layered', 'User layered version.'))
    // 无 SKILL.md 的点目录或普通文件夹不算技能，也不进诊断。
    await mkdir(join(userAgents, '.beam'), { recursive: true })
    await putSkill(join(workspace, '.agents', 'skills'), 'layered', skill('layered', 'Workspace layered version.'))
    const store = new SkillStore({ builtinRoot: join(root, 'builtin'), userAgentsRoot: userAgents })

    // 两份副本都按各自来源留在目录中，workspace 副本不会被隐藏。
    const catalog = await store.list(workspace)
    expect(catalog.diagnostics).toEqual([])
    expect(catalog.skills.map(item => item.id)).toEqual(['agents:layered', 'user-agents:layered', 'user-agents:user-helper'])
    expect(catalog.skills.find(item => item.id === 'user-agents:user-helper')).toMatchObject({ source: 'user-agents', writable: false })

    // 用户根先于 workspace 层级扫描，对齐 ZCode/opencode：裸名命中用户副本……
    await expect(store.load(workspace, 'layered')).resolves.toMatchObject({ skill: { source: 'user-agents', description: 'User layered version. with a second line' } })
    // ……被遮蔽的 workspace 副本通过源限定 id 仍可达。
    await expect(store.load(workspace, 'agents:layered')).resolves.toMatchObject({ skill: { description: 'Workspace layered version. with a second line' } })
    await expect(store.load(workspace, 'user-helper')).resolves.toMatchObject({ skill: { source: 'user-agents' } })

    // 缺失的用户根是正常的全新安装状态：无诊断、不失败。
    const bare = new SkillStore({ builtinRoot: join(root, 'builtin'), userAgentsRoot: join(root, 'missing') })
    await expect(bare.list(workspace)).resolves.toMatchObject({ diagnostics: [] })
  })

  // 保存与并发：首次创建、内容未变时幂等（unchanged）、无 expectedVersion 的更新报
  // CONFLICT；同版本号并发保存恰好一个成功；版本号是内容的 sha256，新 store 重读一致。
  it('saves idempotently, requires the current hash for updates, serializes writers, and reloads in a new store', async () => {
    const { workspace, builtin } = await fixture()
    const store = new SkillStore({ builtinRoot: builtin })
    const created = await store.save(workspace, { name: 'incident-triage', content: skill('incident-triage', 'Triage an incident.') })
    expect(created).toMatchObject({ created: true, unchanged: false, validation: { valid: true } })

    const unchanged = await store.save(workspace, { name: 'incident-triage', content: skill('incident-triage', 'Triage an incident.') })
    expect(unchanged).toMatchObject({ created: false, unchanged: true, skill: { version: created.skill.version } })

    await expect(store.save(workspace, { name: 'incident-triage', content: skill('incident-triage', 'Changed description.') }))
      .rejects.toMatchObject({ code: 'CONFLICT' })

    const firstUpdate = skill('incident-triage', 'First concurrent update.')
    const secondUpdate = skill('incident-triage', 'Second concurrent update.')
    const outcomes = await Promise.allSettled([
      store.save(workspace, { name: 'incident-triage', content: firstUpdate, expectedVersion: created.skill.version }),
      store.save(workspace, { name: 'incident-triage', content: secondUpdate, expectedVersion: created.skill.version }),
    ])
    expect(outcomes.filter(outcome => outcome.status === 'fulfilled')).toHaveLength(1)
    expect(outcomes.filter(outcome => outcome.status === 'rejected')).toHaveLength(1)
    const latest = new SkillStore({ builtinRoot: builtin })
    const loaded = await latest.load(workspace, 'agents:incident-triage')
    expect([firstUpdate, secondUpdate]).toContain(loaded.content)
    expect(loaded.skill.version).toBe((outcomes.find(outcome => outcome.status === 'fulfilled') as PromiseFulfilledResult<Awaited<ReturnType<typeof store.save>>>).value.skill.version)
    expect(loaded.skill.version).toBe(createHash('sha256').update(loaded.content).digest('hex'))
  })

  // 写入边界：与 builtin / .pi-web 技能同名时保存到 workspace 副本，
  // 绝不覆盖既有来源的文件。
  it('never writes over bundled or Pi skills with the same name', async () => {
    const { workspace, builtin, store } = await fixture()
    const builtinContent = skill('same-name', 'Bundled copy.')
    const piContent = skill('same-name', 'Pi copy.')
    const builtinDirectory = await putSkill(builtin, 'same-name', builtinContent)
    const piDirectory = await putSkill(join(workspace, '.pi-web', 'skills'), 'same-name', piContent)

    await store.save(workspace, { name: 'same-name', content: skill('same-name', 'Workspace copy.') })
    expect(await readFile(join(builtinDirectory, 'SKILL.md'), 'utf8')).toBe(builtinContent)
    expect(await readFile(join(piDirectory, 'SKILL.md'), 'utf8')).toBe(piContent)
    await expect(store.load(workspace, 'agents:same-name')).resolves.toMatchObject({ skill: { writable: true } })
  })

  // 符号链接语义：技能目录、SKILL.md 文件、资源三级链接都跟随读取
  // （对齐 ZCode/pi/opencode，支持 dotfiles 仓库链入）；写入从不跟随链接。
  it('follows symlinks in skill directories, SKILL.md files, and resources; writes stay strict', async () => {
    const { root, workspace, store } = await fixture()
    const outside = join(root, 'outside')
    await mkdir(outside)
    await writeFile(join(outside, 'SKILL.md'), skill('escaped-skill'))
    await mkdir(join(workspace, '.agents', 'skills'), { recursive: true })
    await symlink(outside, join(workspace, '.agents', 'skills', 'escaped-skill'))
    const fileDirectory = join(workspace, '.pi-web', 'skills', 'linked-file')
    await mkdir(fileDirectory, { recursive: true })
    await symlink(join(outside, 'SKILL.md'), join(fileDirectory, 'SKILL.md'))
    const resourceDirectory = await putSkill(join(workspace, '.pi-web', 'skills'), 'linked-resource', skill('linked-resource'))
    await symlink(join(outside, 'SKILL.md'), join(resourceDirectory, 'external.md'))

    // 目录与文件链接都跟随读取（dotfiles 仓库链入技能根时等同真实目录）。
    const catalog = await store.list(workspace)
    expect(catalog.skills.map(item => item.id)).toEqual(['agents:escaped-skill', 'pi:linked-file', 'pi:linked-resource'])
    expect(catalog.diagnostics).toEqual([])
    await expect(store.load(workspace, 'agents:escaped-skill')).resolves.toMatchObject({
      skill: { description: 'A useful skill. with a second line' },
      content: expect.stringContaining('escaped-skill'),
    })
    await expect(store.load(workspace, 'pi:linked-file')).resolves.toMatchObject({
      skill: { description: 'A useful skill. with a second line' },
    })
    // 符号链接资源同样列出且可经同一路径读取。
    const resource = await store.load(workspace, 'pi:linked-resource')
    expect(resource.files).toEqual(['SKILL.md', 'external.md'])
    await expect(store.load(workspace, 'pi:linked-resource', 'external.md')).resolves.toMatchObject({
      resource: 'external.md',
      content: expect.stringContaining('escaped-skill'),
    })
    // 写入从不跟随链接：skill_save 拒绝已存在的符号链接目标。
    await expect(store.save(workspace, { name: 'escaped-skill', content: skill('escaped-skill') })).rejects.toMatchObject({ code: 'FORBIDDEN' })
  })

  // 安全边界：正文超 UTF-8 字节预算拒绝、Markdown 内的越界相对链接拒绝保存、
  // 资源读取拒绝路径穿越、Windows 保留名（CON）拒绝。
  it('bounds UTF-8 bytes, rejects malicious Markdown references, and rejects resource traversal', async () => {
    const { workspace, store } = await fixture()
    const oversized = skill('oversized', 'Too large.', '界'.repeat(200_000))
    await expect(store.save(workspace, { name: 'oversized', content: oversized })).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    await expect(store.save(workspace, {
      name: 'unsafe-link',
      content: skill('unsafe-link', 'Unsafe reference.', 'Read [outside](../../outside.md).'),
    })).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    await store.save(workspace, { name: 'safe-resource', content: skill('safe-resource') })
    await expect(store.load(workspace, 'agents:safe-resource', '../outside.md')).rejects.toMatchObject({ code: 'FORBIDDEN' })
    await expect(store.save(workspace, { name: 'CON', content: skill('CON') })).rejects.toMatchObject({ code: 'INVALID_INPUT' })
  })
})
