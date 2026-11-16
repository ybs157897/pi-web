import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@earendil-works/chord/context'
import type { ToolExecutionApi } from '@earendil-works/pi-durable'
import { NodeExecutionEnv } from '@earendil-works/pi-durable/env/node'
import { afterEach, describe, expect, it } from 'vitest'
import { CodingTools, DEFAULT_COMMAND_TIMEOUT_SECONDS, commandTimeout, createCodingTools } from '../src/server/tools/shell/tools.ts'

/**
 * shell 命令工具（bash / pwsh）契约测试：平台相关的工具选型、
 * 默认超时与描述文案、workspace 感知的 workdir 解析与安全边界。
 */
const directories: string[] = []

afterEach(async () => {
  // 清理本文件创建的临时 workspace 目录。
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

const TEST_CONTEXT = {} as Context

/**
 * 创建一次性临时 workspace 目录并登记待清理。
 * @returns 临时目录绝对路径
 */
async function workspace(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'pi-web-shell-tools-'))
  directories.push(directory)
  return directory
}

/**
 * 构造测试用 ToolExecutionApi。
 * @param cwd 工具执行的工作目录
 * @returns output 分片按序累积进 retained 缓冲的桩实现
 */
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

/**
 * 取 POSIX 平台工具集中的 bash 工具。
 * @returns 名为 bash 的工具定义，缺失则抛错
 */
function bashTool() {
  const tool = CodingTools.tools?.find(candidate => candidate.name === 'bash')
  if (!tool) throw new Error('missing bash tool')
  return tool
}

/**
 * 取 Windows 平台工具集中的 pwsh 工具。
 * @returns 名为 pwsh 的工具定义，缺失则抛错
 */
function pwshTool() {
  const tool = CodingTools.tools?.find(candidate => candidate.name === 'pwsh')
  if (!tool) throw new Error('missing pwsh tool')
  return tool
}

describe('shell tool selection', () => {
  it('adds pwsh before bash on Windows and keeps bash alone elsewhere, plus the shared session tool', () => {
    const windows = createCodingTools('win32').tools ?? []
    const posix = createCodingTools('darwin').tools ?? []

    expect(windows.map(tool => tool.name)).toEqual(['read', 'write', 'edit', 'pwsh', 'shell_session'])
    expect(posix.map(tool => tool.name)).toEqual(['read', 'write', 'edit', 'bash', 'shell_session'])
    const pwsh = windows.find(tool => tool.name === 'pwsh')
    expect(pwsh?.description).toContain('workdir')
    expect(pwsh?.description).toContain('Set-Location')
    expect(pwsh?.description).toContain('删除或移动前')
    expect(pwsh?.description).toContain('解析后的绝对目标路径')
    const properties = (pwsh?.parameters as { properties?: Record<string, unknown> }).properties ?? {}
    expect(Object.keys(properties)).toEqual(expect.arrayContaining(['command', 'description', 'workdir', 'timeout', 'yieldTimeMs']))
    expect(posix.find(tool => tool.name === 'bash')?.description).toContain('删除或移动前')
    expect(posix.find(tool => tool.name === 'bash')?.description).toContain('shell_session')
    expect(posix.find(tool => tool.name === 'bash')?.description).not.toContain('转入后台并将输出保存到文件')
  })

  // 超时与防呆契约：所有命令工具默认 300 秒超时、timeout 参数描述写明默认值、
  // yieldTimeMs 描述写明 10000；描述都要警示不要前台跑开发服务器。
  it('bounds every command with a default timeout and warns against foreground servers', () => {
    expect(DEFAULT_COMMAND_TIMEOUT_SECONDS).toBe(300)
    expect(commandTimeout(undefined)).toBe(300)
    expect(commandTimeout(30)).toBe(30)
    for (const tool of [...createCodingTools('darwin').tools ?? [], ...createCodingTools('win32').tools ?? []]) {
      if (tool.name !== 'bash' && tool.name !== 'pwsh') continue
      expect(tool.description).toContain('不要在前台运行开发服务器、监听模式或交互式程序')
      const timeout = (tool.parameters as { properties?: Record<string, { description?: string }> }).properties?.timeout
      expect(timeout?.description).toContain('默认 300')
      const yieldTimeMs = (tool.parameters as { properties?: Record<string, { description?: string }> }).properties?.yieldTimeMs
      expect(yieldTimeMs?.description).toContain('10000')
    }
  })
})

describe.runIf(process.platform !== 'win32')('workspace-aware bash', () => {
  // workdir 解析契约：省略 workdir 时以会话 workspace 为根；
  // 相对 workdir 解析为 workspace 下的子目录（用 realpath 消除 macOS 临时目录符号链接干扰）。
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

  // 边界：timeout=1 秒的命令要在超时处终止，调用在 4 秒内返回且结果不含命令尾部输出。
  it('stops a command at its timeout instead of waiting for it', async () => {
    const root = await workspace()
    const started = Date.now()
    const outcome = await bashTool().execute({ command: 'sleep 5; echo finished', timeout: 1 }, apiFor(root), TEST_CONTEXT)
      .then(result => result, (error: unknown) => error)
    expect(Date.now() - started).toBeLessThan(4_000)
    expect(JSON.stringify(outcome ?? null)).not.toContain('finished')
  }, 10_000)

  // 安全边界：逃逸 workspace 的 workdir（..）报 FORBIDDEN，不存在的路径报 NOT_FOUND。
  it('rejects a workdir outside the workspace or one that does not exist', async () => {
    const root = await workspace()

    await expect(bashTool().execute({ command: 'pwd', workdir: '..' }, apiFor(root), TEST_CONTEXT))
      .rejects.toMatchObject({ code: 'FORBIDDEN' })
    await expect(bashTool().execute({ command: 'pwd', workdir: 'missing' }, apiFor(root), TEST_CONTEXT))
      .rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  // 语义约定：grep 无匹配（exit 1）是正常结果而非失败，须带 no_matches 诊断。
  it('treats grep exit 1 as no matches rather than an error', async () => {
    const root = await workspace()

    const result = await bashTool().execute({ command: 'printf "a\\n" | grep zzz' }, apiFor(root), TEST_CONTEXT)

    expect(result.isError).not.toBe(true)
    expect(result.diagnostics?.some(diagnostic => diagnostic.code === 'no_matches')).toBe(true)
  })

  // 对照：真实的非零退出（exit 3）仍然 isError=true，与「无匹配」区分开。
  it('keeps a real command failure an error', async () => {
    const root = await workspace()

    const result = await bashTool().execute({ command: 'exit 3' }, apiFor(root), TEST_CONTEXT)

    expect(result.isError).toBe(true)
  })
})

describe('workspace-aware pwsh', () => {
  // 仅 Windows 执行：pwsh 的相对 workdir 同样解析为 workspace 子目录。
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
