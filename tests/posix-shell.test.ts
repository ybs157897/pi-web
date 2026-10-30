import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@earendil-works/chord/context'
import type { ToolExecutionApi } from '@earendil-works/pi-durable'
import { NodeExecutionEnv } from '@earendil-works/pi-durable/env/node'
import { afterEach, describe, expect, it } from 'vitest'
import { executePosixBash, isBlockedShellSearch, killPosixTree, resolvePosixEnv } from '../src/server/posix-shell.ts'
import { createExecutionEnv, localShellSpawn } from '../src/server/execution-env.ts'
import { disposeBackgroundShells, runShellCommand } from '../src/server/shell-runner.ts'

const directories: string[] = []
const originalEnv = {
  LANG: process.env.LANG,
  LC_CTYPE: process.env.LC_CTYPE,
  LC_ALL: process.env.LC_ALL,
}

const TEST_CONTEXT = {} as Context

afterEach(async () => {
  disposeBackgroundShells()
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
})

async function workspace(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'pi-web-posix-shell-'))
  directories.push(directory)
  return directory
}

function apiFor(cwd: string): ToolExecutionApi {
  let text = ''
  return {
    env: new NodeExecutionEnv({ cwd }),
    callId: `posix-${Date.now()}`,
    output: (chunk: string) => { text += chunk },
    retainedOutput: () => ({ text, truncated: false }),
    diagnostic: () => undefined,
  } as unknown as ToolExecutionApi
}

function shellSpec(cwd: string, command: string) {
  return {
    command,
    program: '/bin/bash',
    args: ['-c', command],
    cwd,
    env: process.env,
    legacyEncoding: null,
    timeoutSeconds: 5,
    kill: killPosixTree,
    api: apiFor(cwd),
    context: TEST_CONTEXT,
  }
}

describe.runIf(process.platform !== 'win32')('POSIX recursive search guard', () => {
  it('blocks recursive grep/rg forms', () => {
    for (const command of [
      'grep -r foo .',
      'grep -R foo .',
      'grep -rn foo .',
      'grep --recursive foo .',
      'rg foo',
      'rgrep foo .',
      'find . -exec grep foo {} \\;',
      'find . | xargs grep foo',
    ]) {
      expect(isBlockedShellSearch(command)).toBe(true)
    }
  })

  it('allows non-recursive grep and quoted mentions', () => {
    for (const command of [
      'grep foo file.txt',
      'cat file | grep foo',
      "echo 'grep -r foo'",
      'git grep foo',
    ]) {
      expect(isBlockedShellSearch(command)).toBe(false)
    }
  })

  it('rejects a recursive search through the bash tool', async () => {
    const root = await workspace()
    await expect(executePosixBash({ command: 'grep -r foo .' }, apiFor(root), TEST_CONTEXT))
      .rejects.toMatchObject({ code: 'FORBIDDEN' })
  })
})

describe.runIf(process.platform !== 'win32')('POSIX locale environment', () => {
  it('replaces an unusable C/POSIX locale with a UTF-8 one', () => {
    process.env.LANG = 'C'
    delete process.env.LC_CTYPE
    delete process.env.LC_ALL

    const { env, legacyEncoding } = resolvePosixEnv()

    expect(env.LANG).not.toBe('C')
    expect(env.LC_CTYPE).toBe(env.LANG)
    expect(legacyEncoding).toBeNull()
  })

  it('keeps a non-UTF-8 codeset as the decoder fallback', () => {
    process.env.LC_ALL = 'zh_CN.GB18030'

    const { legacyEncoding } = resolvePosixEnv()

    expect(legacyEncoding?.toLowerCase()).toBe('gb18030')
  })
})

describe.runIf(process.platform !== 'win32')('POSIX shell runner', () => {
  it('returns foreground output', async () => {
    const root = await workspace()
    const result = await runShellCommand(shellSpec(root, 'printf hi'))

    expect(result.isError).not.toBe(true)
    expect((result.structuredOutput as { output?: string }).output).toContain('hi')
  })

  it('treats grep exit 1 as no matches', async () => {
    const root = await workspace()
    const result = await runShellCommand(shellSpec(root, 'grep zzz /dev/null'))

    expect(result.isError).not.toBe(true)
    expect(result.diagnostics?.some(diagnostic => diagnostic.code === 'no_matches')).toBe(true)
  })

  it('moves a long command to the background and keeps writing its output file', async () => {
    const root = await workspace()
    const result = await runShellCommand({
      ...shellSpec(root, 'sleep 1; echo done'),
      backgroundAfterMs: 100,
    })

    const structured = result.structuredOutput as { background?: boolean; fullOutputPath?: string }
    expect(structured.background).toBe(true)
    expect(structured.fullOutputPath).toBeTruthy()

    await new Promise(resolveWait => setTimeout(resolveWait, 1_400))
    const output = await readFile(structured.fullOutputPath!, 'utf8')
    expect(output).toContain('done')
  })

  it('decodes non-UTF-8 output with the locale codeset', async () => {
    const root = await workspace()
    const result = await runShellCommand({
      ...shellSpec(root, "printf '\\xd6\\xd0\\xce\\xc4'"),
      legacyEncoding: 'gb18030',
    })

    expect((result.structuredOutput as { output?: string }).output).toContain('中文')
  })

  it.runIf(process.platform === 'darwin')('keeps the workspaceWrite sandbox for a detached spawn', async () => {
    const root = await workspace()
    const env = await createExecutionEnv(root, 'workspaceWrite')
    const spawnSpec = localShellSpawn(env, 'pwd', '/bin/bash')
    expect(spawnSpec.file).toBe('/usr/bin/sandbox-exec')

    const result = await runShellCommand({
      ...shellSpec(root, 'pwd'),
      program: spawnSpec.file,
      args: spawnSpec.args,
    })

    expect((result.structuredOutput as { output?: string }).output).toContain(root)
  })
})
