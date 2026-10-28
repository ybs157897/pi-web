import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@earendil-works/chord/context'
import type { ToolExecutionApi, Tx } from '@earendil-works/pi-durable'
import { CODEMODE_TOOL_NAME } from '@earendil-works/pi-durable/codemode'
import type { ConversationId } from '@earendil-works/pi-durable'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { LoadedSkills, SKILL_READ_TOOLS, createSkillTools } from '../src/server/skill-tools.ts'
import { SkillStore } from '../src/server/skills.ts'

const directories: string[] = []

afterEach(async () => {
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

const TEST_CONTEXT: Context = {
  abortSignal: undefined,
  value: () => undefined,
  toString: () => 'pi-web-skill-tools-test',
}

const SKILL_BODY = [
  '---',
  'name: smoke-check',
  'description: Run a bounded smoke check for one workspace change.',
  '---',
  '',
  '## Workflow',
  '',
  'Read the changed files, run the targeted check, and report the result.',
].join('\n')

async function workspace(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'pi-web-skill-tools-'))
  directories.push(directory)
  return directory
}

function createApi(path: string, state: { references: Array<Record<string, unknown>> }) {
  const tx = {
    doc: async () => state,
  } as unknown as Tx
  const api = {
    env: { cwd: path },
    conversationId: 41 as ConversationId,
    commit: async <T>(change: (transaction: Tx) => T | Promise<T>): Promise<T> => change(tx),
  }
  return api as unknown as ToolExecutionApi
}

function registered(extension: ReturnType<typeof createSkillTools>, name: string) {
  const tool = extension.tools?.find(candidate => candidate.name === name)
  if (!tool) throw new Error(`missing tool ${name}`)
  return tool
}

async function callTool(
  extension: ReturnType<typeof createSkillTools>,
  name: string,
  args: Record<string, unknown>,
  api: ToolExecutionApi,
  context = TEST_CONTEXT,
) {
  return registered(extension, name).execute(args as never, api, context)
}

function promptInput(path: string, tools: string[], callable: string[], references?: unknown) {
  const state = references === undefined ? undefined : { references }
  return {
    conversationId: 41 as ConversationId,
    env: { cwd: path },
    agent: {
      tools: tools.map(name => ({ name })),
      callable: callable.map(name => ({ name })),
    },
    read: { snapshot: async () => state },
  }
}

async function renderSection(
  extension: ReturnType<typeof createSkillTools>,
  input: ReturnType<typeof promptInput>,
): Promise<string | undefined> {
  const promptSection = extension.sections?.[0]
  if (!promptSection) throw new Error('Skills extension has no policy section')
  return promptSection.render(input as never, TEST_CONTEXT)
}

describe('Skills extension tools', () => {
  it('lists bounded metadata and exposes actual array-shaped Pi output', async () => {
    const path = await workspace()
    const store = new SkillStore()
    const extension = createSkillTools({ store, canWrite: async () => true })
    const result = await callTool(extension, 'skill_list', {}, createApi(path, { references: [] }))
    const catalog = result.structuredOutput as { skills: Array<{ id: string; path?: string }>; diagnostics: string[] }

    expect(result.output).toHaveLength(1)
    expect(catalog.skills.some(skill => skill.id === 'builtin:skill-creator')).toBe(true)
    expect(catalog.skills.every(skill => skill.path === undefined)).toBe(true)
    expect(SKILL_READ_TOOLS).toEqual(['skill_list', 'skill_load', 'skill_validate'])
  })

  it('loads a body only on request and records a bounded conversation reference without the body', async () => {
    const path = await workspace()
    const skillDirectory = join(path, '.agents', 'skills', 'support-demo')
    const guidePath = join(skillDirectory, 'references', 'guide.md')
    await mkdir(join(skillDirectory, 'references'), { recursive: true })
    await writeFile(join(skillDirectory, 'SKILL.md'), [
      '---',
      'name: support-demo',
      'description: Demonstrate resource location for a workspace Skill.',
      '---',
      '',
      'Read [the guide](references/guide.md) before acting.',
    ].join('\n'))
    await writeFile(guidePath, '# Support guide\n\nKeep the result concise.')
    const state = { references: [] as Array<Record<string, unknown>> }
    const store = new SkillStore()
    const extension = createSkillTools({ store, canWrite: async () => true })
    const result = await callTool(extension, 'skill_load', {
      skill: 'agents:support-demo',
      resource: 'references/guide.md',
    }, createApi(path, state))
    const loaded = result.structuredOutput as {
      content: string
      skill: { version: string }
      baseDirectory: string
      resource: string
      files: string[]
      filesTruncated: boolean
    }
    const canonicalSkillDirectory = await realpath(skillDirectory)

    expect(loaded.resource).toBe('references/guide.md')
    expect(loaded.baseDirectory).toBe(canonicalSkillDirectory)
    expect(loaded.files).toContain('references/guide.md')
    expect(loaded.filesTruncated).toBe(false)
    expect(await readFile(join(loaded.baseDirectory, loaded.resource), 'utf8')).toBe(loaded.content)
    expect(state.references).toHaveLength(1)
    expect(state.references[0]).toMatchObject({
      id: 'agents:support-demo',
      version: loaded.skill.version,
      baseDirectory: canonicalSkillDirectory,
      resource: 'references/guide.md',
      workspace: await realpath(path),
    })
    expect(state.references[0]).not.toHaveProperty('content')

    const prompt = await renderSection(extension, promptInput(path, ['skill_load'], ['skill_load'], state.references))
    expect(prompt).toContain('agents:support-demo')
    expect(prompt).toContain(canonicalSkillDirectory)
    expect(prompt).toContain('After compaction')
    expect(prompt).not.toContain('# Support guide')

    const otherWorkspace = await workspace()
    const otherPrompt = await renderSection(extension, promptInput(otherWorkspace, ['skill_load'], ['skill_load'], state.references))
    expect(otherPrompt).not.toContain('agents:support-demo')
    expect(otherPrompt).not.toContain(canonicalSkillDirectory)
    expect(otherPrompt).not.toContain('Loaded Skill references in this conversation')
  })

  it('writes only the workspace Skills directory when the runtime permission callback allows it', async () => {
    const path = await workspace()
    const extension = createSkillTools({ store: new SkillStore(), canWrite: async () => true })
    const result = await callTool(extension, 'skill_save', { name: 'smoke-check', content: SKILL_BODY }, createApi(path, { references: [] }))
    const saved = result.structuredOutput as { location: string; created: boolean; validation: { valid: boolean } }

    expect(saved).toMatchObject({ location: '.agents/skills/smoke-check/SKILL.md', created: true, validation: { valid: true } })
    expect(await readFile(join(path, saved.location), 'utf8')).toBe(SKILL_BODY)
    await expect(stat(join(path, '.agents', 'smoke-check'))).rejects.toMatchObject({ code: 'ENOENT' })

    const validation = await callTool(extension, 'skill_validate', { skill: 'agents:smoke-check' }, createApi(path, { references: [] }))
    expect(validation.structuredOutput).toEqual({ valid: true, errors: [], warnings: [] })
  })

  it('fails closed when write permission is false or cannot be checked', async () => {
    const path = await workspace()
    const store = new SkillStore()
    const canWrite = vi.fn(async () => false)
    const denied = createSkillTools({ store, canWrite })
    await expect(callTool(denied, 'skill_save', { name: 'smoke-check', content: SKILL_BODY }, createApi(path, { references: [] })))
      .rejects.toThrow('workspace writing is disabled')
    expect(canWrite).toHaveBeenCalledOnce()
    await expect(stat(join(path, '.agents'))).rejects.toMatchObject({ code: 'ENOENT' })

    const uncertain = createSkillTools({ store, canWrite: async () => { throw new Error('metadata unavailable') } })
    await expect(callTool(uncertain, 'skill_save', { name: 'smoke-check', content: SKILL_BODY }, createApi(path, { references: [] })))
      .rejects.toThrow('permission could not be confirmed')
    await expect(stat(join(path, '.agents'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('does not start a save after the call has already been aborted', async () => {
    const path = await workspace()
    const canWrite = vi.fn(async () => true)
    const extension = createSkillTools({ store: new SkillStore(), canWrite })
    const abort = new AbortController()
    abort.abort(new Error('cancelled'))
    const context = { ...TEST_CONTEXT, abortSignal: abort.signal }

    await expect(callTool(extension, 'skill_save', { name: 'smoke-check', content: SKILL_BODY }, createApi(path, { references: [] }), context))
      .rejects.toThrow('cancelled')
    expect(canWrite).not.toHaveBeenCalled()
    await expect(stat(join(path, '.agents'))).rejects.toMatchObject({ code: 'ENOENT' })
  })
})

describe('Skills prompt routing', () => {
  it('advertises only tools selected for this direct model request', async () => {
    const path = await workspace()
    const extension = createSkillTools({ store: new SkillStore(), canWrite: async () => true })
    const prompt = await renderSection(extension, promptInput(path, ['skill_list'], ['skill_list', 'skill_load', 'skill_save', 'skill_validate']))

    expect(prompt).toContain('Direct tools: `skill_list`.')
    expect(prompt).not.toContain('`skill_save`')
    expect(prompt).not.toContain('load a relevant Skill')
    expect(prompt).not.toContain('skill_validate after')
  })

  it('supports codemode-only requests from the resolved callable tool set', async () => {
    const path = await workspace()
    const extension = createSkillTools({ store: new SkillStore(), canWrite: async () => true })
    const prompt = await renderSection(extension, promptInput(
      path,
      [CODEMODE_TOOL_NAME],
      ['skill_list', 'skill_load', 'skill_save', 'skill_validate'],
    ))

    expect(prompt).toContain('Through `codemode`')
    expect(prompt).toContain('`skill_list`, `skill_load`, `skill_save`, `skill_validate`')
    expect(prompt).toContain('load `builtin:skill-creator`')
    expect(prompt).toContain('clearly matches a Skill description, load it with skill_load before acting')
  })

  it('omits the section when the current preset exposes no Skill tool', async () => {
    const path = await workspace()
    const extension = createSkillTools({ store: new SkillStore(), canWrite: async () => true })
    expect(await renderSection(extension, promptInput(path, [], []))).toBeUndefined()
  })
})
