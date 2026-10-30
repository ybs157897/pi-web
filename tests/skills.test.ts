import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { SkillStore } from '../src/server/skills.ts'

const temporaryRoots: string[] = []

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'pi-web-skills-')))
  temporaryRoots.push(root)
  const workspace = join(root, 'workspace')
  const builtin = join(root, 'builtin')
  await mkdir(workspace)
  await mkdir(builtin)
  return { root, workspace, builtin, store: new SkillStore({ builtinRoot: builtin }) }
}

function skill(name: string, description = 'A useful skill.', body = 'Follow the task instructions carefully.'): string {
  return `---\nname: ${name}\ndescription: >-\n  ${description}\n  with a second line\n---\n\n${body}\n`
}

async function putSkill(root: string, name: string, content: string): Promise<string> {
  const directory = join(root, name)
  await mkdir(directory, { recursive: true })
  await writeFile(join(directory, 'SKILL.md'), content)
  return directory
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('SkillStore', () => {
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

    // No frontmatter: named after the directory, empty description, still loadable.
    await expect(store.load(workspace, 'plain-notes')).resolves.toMatchObject({
      skill: { id: 'agents:plain-notes', name: 'plain-notes', description: '' },
      content: '# Plain notes\n\nNo frontmatter at all.\n',
    })
    // Mismatched frontmatter name: the directory name stays the lookup key.
    await expect(store.load(workspace, 'folder-name')).resolves.toMatchObject({ skill: { name: 'display-name' } })
    // Non-kebab directory and empty description load; validation reports the quality notes.
    const validation = await store.validate(workspace, 'empty-description')
    expect(validation.valid).toBe(true)
    expect(validation.warnings.join(' ')).toMatch(/description is empty/u)
  })

  it('shadows same-named skills by discovery order instead of failing', async () => {
    const { workspace, builtin, store } = await fixture()
    await putSkill(builtin, 'shared-name', skill('shared-name', 'Bundled version.'))
    await putSkill(join(workspace, '.pi-web', 'skills'), 'shared-name', skill('shared-name', 'Pi version.'))
    await putSkill(join(workspace, '.agents', 'skills'), 'shared-name', skill('shared-name', 'Agents version.'))

    // All copies stay visible in the catalog (sorted by name, then source), but the
    // bare name loads the first in discovery order: builtin > .pi-web > .agents.
    const catalog = await store.list(workspace)
    expect(catalog.skills.map(item => item.id)).toEqual(['agents:shared-name', 'builtin:shared-name', 'pi:shared-name'])
    await expect(store.load(workspace, 'shared-name')).resolves.toMatchObject({ skill: { source: 'builtin', description: 'Bundled version. with a second line' } })
    // A source-qualified id still reaches a shadowed copy directly.
    await expect(store.load(workspace, 'pi:shared-name')).resolves.toMatchObject({ skill: { source: 'pi', description: 'Pi version. with a second line' } })
    await expect(store.load(workspace, 'agents:shared-name')).resolves.toMatchObject({ skill: { source: 'agents', description: 'Agents version. with a second line' } })
    await expect(store.load(workspace, 'unknown:shared-name')).rejects.toMatchObject({ code: 'INVALID_INPUT' })
  })

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
    // Same name on two levels: the deeper level shadows the repository root.
    await expect(store.load(workspace, 'layered')).resolves.toMatchObject({ skill: { description: 'Deeper agents version. with a second line' } })
    await expect(store.load(workspace, 'from-repo-root')).resolves.toMatchObject({ skill: { source: 'pi' } })

    // Above the repository root is out of scope.
    await putSkill(join(root, '.pi-web', 'skills'), 'outside-repo', skill('outside-repo'))
    const bounded = await store.list(workspace)
    expect(bounded.skills.map(item => item.id)).toEqual(['pi:from-repo-root', 'agents:layered'])

    // Without a repository the walk stops at the workspace itself.
    const plain = join(root, 'plain')
    await mkdir(plain, { recursive: true })
    const plainStore = new SkillStore({ builtinRoot: join(root, 'builtin') })
    const plainCatalog = await plainStore.list(plain)
    expect(plainCatalog.skills.map(item => item.id)).toEqual([])
  })

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

  it('rejects symbolic links in skill roots, directories, and resources', async () => {
    const { root, workspace, store } = await fixture()
    const outside = join(root, 'outside')
    await mkdir(outside)
    await writeFile(join(outside, 'SKILL.md'), skill('escaped-skill'))
    await mkdir(join(workspace, '.agents', 'skills'), { recursive: true })
    await symlink(outside, join(workspace, '.agents', 'skills', 'escaped-skill'))
    const resourceDirectory = await putSkill(join(workspace, '.pi-web', 'skills'), 'linked-resource', skill('linked-resource'))
    await symlink(join(outside, 'SKILL.md'), join(resourceDirectory, 'external.md'))

    const catalog = await store.list(workspace)
    expect(catalog.skills.map(item => item.id)).toEqual(['pi:linked-resource'])
    expect(catalog.diagnostics).toHaveLength(1)
    await expect(store.load(workspace, 'agents:escaped-skill')).rejects.toMatchObject({ code: 'FORBIDDEN' })
    await expect(store.load(workspace, 'pi:linked-resource')).rejects.toMatchObject({ code: 'FORBIDDEN' })
    await expect(store.save(workspace, { name: 'escaped-skill', content: skill('escaped-skill') })).rejects.toMatchObject({ code: 'FORBIDDEN' })
  })

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
