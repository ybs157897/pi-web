import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@earendil-works/chord/context'
import type { ToolExecutionApi } from '@earendil-works/pi-durable'
import { NodeExecutionEnv } from '@earendil-works/pi-durable/env/node'
import { afterEach, describe, expect, it } from 'vitest'
import { CodingTools, createCodingTools } from '../src/server/shell-tools.ts'

const directories: string[] = []

afterEach(async () => {
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

const TEST_CONTEXT = {} as Context

async function workspace(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'pi-web-shell-tools-'))
  directories.push(directory)
  return directory
}

function apiFor(cwd: string): ToolExecutionApi {
  let text = ''
  return {
    env: new NodeExecutionEnv({ cwd }),
    callId: `shell-${Date.now()}`,
    output: (chunk: string) => { text += chunk },
    retainedOutput: () => ({ text, truncated: false }),
    diagnostic: () => undefined,
  } as unknown as ToolExecutionApi
}

function bashTool() {
  const tool = CodingTools.tools?.find(candidate => candidate.name === 'bash')
  if (!tool) throw new Error('missing bash tool')
  return tool
}

function pwshTool() {
  const tool = CodingTools.tools?.find(candidate => candidate.name === 'pwsh')
  if (!tool) throw new Error('missing pwsh tool')
  return tool
}

describe('shell tool selection', () => {
  it('adds pwsh before bash on Windows and keeps bash alone elsewhere', () => {
    const windows = createCodingTools('win32').tools ?? []
    const posix = createCodingTools('darwin').tools ?? []

    expect(windows.map(tool => tool.name)).toEqual(['read', 'write', 'edit', 'pwsh'])
    expect(posix.map(tool => tool.name)).toEqual(['read', 'write', 'edit', 'bash'])
    const pwsh = windows.find(tool => tool.name === 'pwsh')
    expect(pwsh?.description).toContain('workdir')
    expect(pwsh?.description).toContain('Set-Location')
    expect(pwsh?.description).toContain('Before any delete or move')
    expect(pwsh?.description).toContain('resolved absolute target path')
    const properties = (pwsh?.parameters as { properties?: Record<string, unknown> }).properties ?? {}
    expect(Object.keys(properties)).toEqual(expect.arrayContaining(['command', 'description', 'workdir', 'timeout']))
    expect(posix.find(tool => tool.name === 'bash')?.description).toContain('Before any delete or move')
  })
})

describe.runIf(process.platform !== 'win32')('workspace-aware bash', () => {
  it('runs in the session workspace by default and accepts a subdirectory workdir', async () => {
    const root = await workspace()
    await mkdir(join(root, 'sub'))
    await writeFile(join(root, 'root-marker.txt'), 'root')

    await bashTool().execute({ command: 'pwd > root-cwd.txt' }, apiFor(root), TEST_CONTEXT)
    await bashTool().execute({ command: 'pwd > child-cwd.txt', workdir: 'sub' }, apiFor(root), TEST_CONTEXT)

    const canonical = await realpath(root)
    expect((await readFile(join(root, 'root-cwd.txt'), 'utf8')).trim()).toBe(canonical)
    expect((await readFile(join(root, 'sub', 'child-cwd.txt'), 'utf8')).trim()).toBe(join(canonical, 'sub'))
  })

  it('rejects a workdir outside the workspace or one that does not exist', async () => {
    const root = await workspace()

    await expect(bashTool().execute({ command: 'pwd', workdir: '..' }, apiFor(root), TEST_CONTEXT))
      .rejects.toMatchObject({ code: 'FORBIDDEN' })
    await expect(bashTool().execute({ command: 'pwd', workdir: 'missing' }, apiFor(root), TEST_CONTEXT))
      .rejects.toMatchObject({ code: 'NOT_FOUND' })
  })
})

describe('workspace-aware pwsh', () => {
  it.runIf(process.platform === 'win32')('runs with a subdirectory workdir', async () => {
    const root = await workspace()
    await mkdir(join(root, 'sub'))

    await pwshTool().execute({
      command: "[IO.File]::WriteAllText('child-cwd.txt', (Get-Location).Path)",
      workdir: 'sub',
    }, apiFor(root), TEST_CONTEXT)

    const canonical = await realpath(root)
    expect((await readFile(join(root, 'sub', 'child-cwd.txt'), 'utf8')).trim()).toBe(join(canonical, 'sub'))
  })
})
