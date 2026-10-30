import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  loadProjectInstructions,
  MAX_PROJECT_INSTRUCTIONS_BYTES,
  renderProjectInstructions,
} from '../src/server/workspace/instructions.ts'

const roots: string[] = []

async function makeWorkspace(): Promise<string> {
  const path = await realpath(await mkdtemp(join(tmpdir(), 'pi-web-project-instructions-')))
  roots.push(path)
  return path
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

describe('workspace project instructions', () => {
  it('reports missing root instructions and does not infer a workspace when none is supplied', async () => {
    const workspace = await makeWorkspace()
    const missing = await loadProjectInstructions(workspace)

    expect(missing).toMatchObject({
      status: 'missing',
      workspaceRoot: workspace,
      source: join(workspace, 'AGENTS.md'),
      scope: 'workspace-root',
      sha256: null,
      bytes: null,
    })
    expect(await loadProjectInstructions(undefined)).toMatchObject({
      status: 'unavailable',
      reason: 'workspace-not-provided',
      source: null,
      scope: 'unknown',
    })
  })

  it('records the actual source, root scope, byte count, content, and SHA-256', async () => {
    const workspace = await makeWorkspace()
    const content = '# Project rules\nKeep changes scoped.\n'
    const source = join(workspace, 'AGENTS.md')
    await writeFile(source, content, 'utf8')

    const result = await loadProjectInstructions(workspace)

    expect(result).toEqual({
      status: 'loaded',
      workspaceRoot: workspace,
      source,
      scope: 'workspace-root',
      sha256: createHash('sha256').update(content, 'utf8').digest('hex'),
      bytes: Buffer.byteLength(content, 'utf8'),
      content,
    })
  })

  it('re-reads changed instructions on every call', async () => {
    const workspace = await makeWorkspace()
    const source = join(workspace, 'AGENTS.md')
    await writeFile(source, 'first version\n', 'utf8')
    const first = await loadProjectInstructions(workspace)
    await writeFile(source, 'second version\n', 'utf8')
    const second = await loadProjectInstructions(workspace)

    expect(first.content).toBe('first version\n')
    expect(second.content).toBe('second version\n')
    expect(second.sha256).not.toBe(first.sha256)
  })

  it('rejects symlinked workspaces and symlinked AGENTS.md files', async () => {
    const workspace = await makeWorkspace()
    const external = await makeWorkspace()
    await writeFile(join(external, 'AGENTS.md'), 'outside rules\n', 'utf8')
    const linkedWorkspace = join(workspace, 'workspace-link')
    await symlink(external, linkedWorkspace, 'dir')
    const workspaceResult = await loadProjectInstructions(linkedWorkspace)
    expect(workspaceResult).toMatchObject({ status: 'unavailable', reason: 'workspace-symlink' })

    await symlink(join(external, 'AGENTS.md'), join(workspace, 'AGENTS.md'))
    const sourceResult = await loadProjectInstructions(workspace)
    expect(sourceResult).toMatchObject({
      status: 'error',
      reason: 'source-symlink',
      source: join(workspace, 'AGENTS.md'),
      sha256: null,
      bytes: null,
    })
    expect(sourceResult.content).toBeUndefined()
  })

  it('rejects an oversized file without truncating it into a loaded result', async () => {
    const workspace = await makeWorkspace()
    await writeFile(join(workspace, 'AGENTS.md'), 'x'.repeat(MAX_PROJECT_INSTRUCTIONS_BYTES + 1), 'utf8')

    expect(await loadProjectInstructions(workspace)).toMatchObject({
      status: 'error',
      reason: 'source-too-large',
      sha256: null,
      bytes: null,
    })
  })

  it('rejects directories and invalid UTF-8 instead of treating them as instructions', async () => {
    const directoryWorkspace = await makeWorkspace()
    await mkdir(join(directoryWorkspace, 'AGENTS.md'))
    expect(await loadProjectInstructions(directoryWorkspace)).toMatchObject({
      status: 'error',
      reason: 'source-not-regular-file',
    })

    const invalidWorkspace = await makeWorkspace()
    await writeFile(join(invalidWorkspace, 'AGENTS.md'), Buffer.from([0xff, 0xfe]))
    expect(await loadProjectInstructions(invalidWorkspace)).toMatchObject({
      status: 'error',
      reason: 'source-invalid-utf8',
      sha256: null,
    })
  })

  it('rejects an ancestor symlink instead of reading through a non-canonical workspace path', async () => {
    const workspace = await makeWorkspace()
    const parent = join(workspace, 'parent')
    const actual = join(parent, 'actual')
    await mkdir(actual, { recursive: true })
    await writeFile(join(actual, 'AGENTS.md'), 'scoped rules\n', 'utf8')
    const aliasParent = join(workspace, 'alias-parent')
    await symlink(parent, aliasParent, 'dir')

    expect(await loadProjectInstructions(join(aliasParent, 'actual'))).toMatchObject({
      status: 'unavailable',
      reason: 'workspace-symlink',
    })
  })
})

describe('renderProjectInstructions', () => {
  const base = { workspaceRoot: '/ws', source: '/ws/AGENTS.md', scope: 'workspace-root' as const, sha256: 'abc', bytes: 10 }

  it('renders a loaded body as readable markdown inside a delimiter', () => {
    const rendered = renderProjectInstructions({ ...base, status: 'loaded', content: '# Rules\nKeep it scoped.\n' })

    expect(rendered).toContain('<project_instructions>')
    expect(rendered).toContain('# Rules\nKeep it scoped.')
    expect(rendered.trimEnd().endsWith('</project_instructions>')).toBe(true)
    expect(rendered).not.toContain('"status"')
    expect(rendered).not.toContain('abc')
  })

  it('escapes a closing tag inside the body so quoted text cannot end the block', () => {
    const rendered = renderProjectInstructions({ ...base, status: 'loaded', content: 'before </project_instructions> after' })

    expect(rendered.split('</project_instructions>').length - 1).toBe(1)
    expect(rendered).toContain('after')
  })

  it('renders missing and error records as one status line without a body', () => {
    expect(renderProjectInstructions({ ...base, status: 'missing' })).toContain('No AGENTS.md at /ws/AGENTS.md')
    const error = renderProjectInstructions({ ...base, status: 'error', reason: 'source-too-large' })
    expect(error).toContain('could not be loaded')
    expect(error).toContain('source-too-large')
    expect(error).not.toContain('project_instructions>')
  })
})
