import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@earendil-works/chord/context'
import type { ToolExecutionApi } from '@earendil-works/pi-durable'
import { NodeExecutionEnv } from '@earendil-works/pi-durable/env/node'
import { afterEach, describe, expect, it } from 'vitest'
import { killPosixTree } from '../src/server/tools/shell/posix.ts'
import { createShellSessionTool } from '../src/server/tools/shell/session.ts'
import { CodingTools, createCodingTools } from '../src/server/tools/shell/tools.ts'
import { activeShellSessionCount, disposeShellSessions, runShellCommand, YIELD_TIME_MS } from '../src/server/tools/shell/runner.ts'

/**
 * codex 风格 shell 会话契约测试：长命令在 yield 预算后「晋升」为可轮询会话，
 * 模型通过 shell_session 工具按游标增量读取输出。
 * 关键契约：晋升响应携带晋升前输出；轮询只返回游标之后的增量；
 * 会话退出后被回收（再轮询报 NOT_FOUND）；溢出文件（spill file）始终完整。
 */
const directories: string[] = []

afterEach(async () => {
  // 释放全部会话并清理临时 workspace，防止子进程跨用例泄漏。
  disposeShellSessions()
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

/**
 * 创建一次性临时 workspace 目录并登记待清理。
 * @returns 临时目录绝对路径
 */
async function workspace(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'pi-web-shell-session-'))
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
    callId: `session-${Date.now()}`,
    output: (chunk: string) => { text += chunk },
    retainedOutput: () => ({ text, truncated: false }),
    diagnostic: () => undefined,
  } as unknown as ToolExecutionApi
}

const TEST_CONTEXT = {} as Context

/**
 * 构造 shell 命令 spec。
 * @param cwd 命令工作目录
 * @param command 要执行的 bash 命令
 * @param yieldTimeMs yield 预算，默认 250ms（codex 对齐下限），保证晋升可确定复现
 * @returns 走 /bin/bash、超时 5 秒、POSIX 进程树 kill 的完整执行 spec
 */
function spec(cwd: string, command: string, yieldTimeMs: number | undefined = 250) {
  return {
    command,
    program: '/bin/bash',
    args: ['-c', command],
    cwd,
    env: process.env,
    legacyEncoding: null,
    timeoutSeconds: 5,
    yieldTimeMs,
    kill: killPosixTree,
    api: apiFor(cwd),
    context: TEST_CONTEXT,
  }
}

describe.runIf(process.platform !== 'win32')('shell sessions (codex-style yield)', () => {
  it('keeps the default yield budget exported for tool descriptions', () => {
    expect(YIELD_TIME_MS).toBe(10_000)
  })

  // 晋升契约：超过 yield 预算仍在跑的命令返回 status=running + sh_ 前缀会话 id +
  // exitCode=-1 + 溢出文件路径，并发出 session_started 诊断。
  it('promotes a still-running command to a pollable session', async () => {
    const cwd = await workspace()
    const result = await runShellCommand(spec(cwd, 'sleep 0.6; echo done-from-session'))
    const structured = result.structuredOutput as { status?: string; sessionId?: string; exitCode: number; fullOutputPath?: string }
    expect(structured.status).toBe('running')
    expect(structured.sessionId).toMatch(/^sh_/)
    expect(structured.exitCode).toBe(-1)
    expect(structured.fullOutputPath).toBeDefined()
    expect(activeShellSessionCount()).toBe(1)
    expect(result.diagnostics?.some(diagnostic => diagnostic.code === 'session_started')).toBe(true)
  })

  it('reads incremental output through the session cursor until exit', async () => {
    const cwd = await workspace()
    const promoted = await runShellCommand(spec(cwd, 'echo first-line; sleep 0.7; echo second-line; echo third-line'))
    const sessionId = (promoted.structuredOutput as { sessionId: string }).sessionId

    const tool = createShellSessionTool()
    // The model reads polls only through `api.output()` retention, never structuredOutput.
    let retained = ''
    const api = {
      ...apiFor(cwd),
      output: (chunk: string) => { retained += chunk },
    } as unknown as ToolExecutionApi

    // The promotion response already carried the pre-promotion output (first-line); polls
    // stream only what is printed after promotion.
    expect((promoted.structuredOutput as { output?: string }).output).toContain('first-line')
    // First poll with a short window: nothing new yet, the command is still sleeping.
    const first = await tool.execute({ sessionId, yieldTimeMs: 250 }, api, TEST_CONTEXT)
    expect((first.structuredOutput as { status: string }).status).toBe('running')
    expect((first.structuredOutput as { output: string }).output).not.toContain('first-line')
    expect(retained).not.toContain('first-line')

    // Second poll after the remaining lines: only the delta since the cursor comes back.
    await new Promise(resolve => setTimeout(resolve, 700))
    const second = await tool.execute({ sessionId }, api, TEST_CONTEXT)
    const secondStructured = second.structuredOutput as { output: string; status: string; exitCode?: number }
    expect(secondStructured.status).toBe('exited')
    expect(secondStructured.exitCode).toBe(0)
    expect(secondStructured.output).toContain('second-line')
    expect(secondStructured.output).not.toContain('first-line')
    expect(second.isError).toBe(false)
    // The same delta reached the model through api.output() retention.
    expect(retained).toContain('second-line')
    expect(retained).toContain('third-line')
    expect(retained).not.toContain('first-line')
    expect(second.diagnostics?.some(diagnostic => diagnostic.code === 'session_reclaimed' && diagnostic.message.includes('exit code: 0'))).toBe(true)
    expect(activeShellSessionCount()).toBe(0)
  })

  // 生命周期边界：会话正常退出即被回收，再次轮询同一 sessionId 必须抛出
  // 「does not exist」，而不是返回一个僵尸会话。
  it('reports the reclaimed session as NOT_FOUND after exit', async () => {
    const cwd = await workspace()
    const promoted = await runShellCommand(spec(cwd, 'sleep 0.3; echo bye'))
    const sessionId = (promoted.structuredOutput as { sessionId: string }).sessionId
    const tool = createShellSessionTool()
    await tool.execute({ sessionId }, apiFor(cwd), TEST_CONTEXT)
    await expect(tool.execute({ sessionId }, apiFor(cwd), TEST_CONTEXT)).rejects.toThrow(/does not exist/)
  })

  // 交互能力：轮询时透传 stdin（换行结尾），交互式命令能读到并回显。
  it('writes stdin through to the session process', async () => {
    const cwd = await workspace()
    const promoted = await runShellCommand(spec(cwd, 'read line; echo "got:$line"'))
    const sessionId = (promoted.structuredOutput as { sessionId: string }).sessionId
    const tool = createShellSessionTool()
    const polled = await tool.execute({ sessionId, stdin: 'hello-stdin\n' }, apiFor(cwd), TEST_CONTEXT)
    const structured = polled.structuredOutput as { output: string; status: string; exitCode?: number }
    expect(structured.status).toBe('exited')
    expect(structured.output).toContain('got:hello-stdin')
  })

  // 失败语义：非零退出码的终止轮询要 isError=true 并带 exit_code 诊断，
  // 让模型能感知命令失败。
  it('marks the terminal poll as an error for nonzero exits', async () => {
    const cwd = await workspace()
    const promoted = await runShellCommand(spec(cwd, 'sleep 0.4; exit 3'))
    const sessionId = (promoted.structuredOutput as { sessionId: string }).sessionId
    const tool = createShellSessionTool()
    const polled = await tool.execute({ sessionId }, apiFor(cwd), TEST_CONTEXT)
    expect((polled.structuredOutput as { status: string }).status).toBe('exited')
    expect((polled.structuredOutput as { exitCode?: number }).exitCode).toBe(3)
    expect(polled.isError).toBe(true)
    expect(polled.diagnostics?.some(diagnostic => diagnostic.code === 'exit_code')).toBe(true)
  })

  // 溢出文件契约：晋升前后全部输出都落盘，末尾追加退出码标记；
  // 内存缓冲可截断，落盘文件不允许缺行。
  it('keeps the spill file complete and marks the exit in it', async () => {
    const cwd = await workspace()
    const promoted = await runShellCommand(spec(cwd, 'echo spill-line; sleep 0.4; echo tail-line'))
    const structured = promoted.structuredOutput as { sessionId: string; fullOutputPath: string }
    const tool = createShellSessionTool()
    await tool.execute({ sessionId: structured.sessionId }, apiFor(cwd), TEST_CONTEXT)
    const log = await readFile(structured.fullOutputPath, 'utf8')
    expect(log).toContain('spill-line')
    expect(log).toContain('tail-line')
    expect(log).toContain('[exited with code 0]')
  })

  it('bounds the buffer and reports truncation', async () => {
    const cwd = await workspace()
    // 洪峰输出发生在晋升之后，因此这些字节计入会话缓冲预算：
    // 结构化输出要标记 truncated=true，落盘文件仍保留全量（>1MB）。
    const promoted = await runShellCommand(spec(cwd, 'sleep 0.4; head -c 1200000 /dev/zero | tr "\\0" "x"; sleep 0.2'))
    const structured = promoted.structuredOutput as { sessionId: string; fullOutputPath: string; truncated: boolean }
    const tool = createShellSessionTool()
    const polled = await tool.execute({ sessionId: structured.sessionId }, apiFor(cwd), TEST_CONTEXT)
    expect((polled.structuredOutput as { truncated: boolean }).truncated).toBe(true)
    const log = await readFile(structured.fullOutputPath, 'utf8')
    expect(log.length).toBeGreaterThan(1_000_000)
  })

  // 晋升后的会话继承 spec 的 timeoutSeconds（5 秒）：超时后轮询应看到
  // exited + exitCode=-1 + timeout 诊断，而不是命令继续挂到 30 秒。
  it('enforces the explicit timeout on a promoted session', async () => {
    const cwd = await workspace()
    const promoted = await runShellCommand(spec(cwd, 'sleep 30'))
    const sessionId = (promoted.structuredOutput as { sessionId: string }).sessionId
    // The session inherits the spec's timeoutSeconds (5s). Wait past it.
    await new Promise(resolve => setTimeout(resolve, 5_400))
    const tool = createShellSessionTool()
    const polled = await tool.execute({ sessionId }, apiFor(cwd), TEST_CONTEXT)
    expect((polled.structuredOutput as { status: string }).status).toBe('exited')
    expect((polled.structuredOutput as { exitCode?: number }).exitCode).toBe(-1)
    expect(polled.isError).toBe(true)
    expect(polled.diagnostics?.some(diagnostic => diagnostic.code === 'timeout')).toBe(true)
  }, 10_000)

  // 工具注册表契约：两个平台都要有 shell_session，命令工具按平台切换 bash/pwsh。
  it('registers the session tool on both platforms', () => {
    for (const platform of ['darwin', 'win32'] as const) {
      const tools = createCodingTools(platform).tools
      expect(tools).toBeDefined()
      const names = (tools ?? []).map(tool => tool.name)
      expect(names).toContain('shell_session')
      expect(names).toContain(platform === 'win32' ? 'pwsh' : 'bash')
    }
  })
})
