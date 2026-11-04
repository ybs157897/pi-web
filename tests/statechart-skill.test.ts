import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { SkillStore } from '../src/server/skills/store.ts'

/**
 * Pins the shipped builtin bundle: the statechart Skill must stay discoverable,
 * frontmatter-clean, and loadable with its method reference — it is part of the
 * product surface (prompt catalog + analysis workflow), not test scenery.
 */
const temporaryRoots: string[] = []

function bundledStore() {
  // The default builtinRoot resolves relative to the store module, i.e. the repo's
  // skills/ directory; no global root, so the catalog is exactly the bundle.
  return new SkillStore()
}

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
    expect(statechart?.description).toContain('state × event')
    // Both sides of the trigger must survive the model catalog's 250-character cap.
    expect(statechart!.description.length).toBeLessThanOrEqual(250)
    expect(statechart?.description).toContain('Skip ordinary business-flow lookup')
    expect(await store.validate(workspace, 'statechart')).toEqual({ valid: true, errors: [], warnings: [] })
  })

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
