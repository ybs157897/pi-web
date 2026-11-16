/**
 * POSIX shell 工具链测试（非 Windows 平台运行）。
 *
 * 覆盖三类契约：
 * - 递归搜索防线：grep -r/-R/--recursive、裸 rg、rgrep、find+xargs grep 等递归形式被拦截，
 *   非递归 grep 与引号内的提及放行；bash 工具层面递归搜索直接 FORBIDDEN；
 * - locale 环境：C/POSIX locale 不可用时替换为 UTF-8 变体；非 UTF-8 codeset（如 GB18030）
 *   保留为输出解码回退；
 * - shell runner：前台输出回收、grep 退出码 1 视为"无匹配"而非错误、长命令升级为可轮询会话
 *   （sessionId + 输出文件持续写入 + 退出码行）、按 locale codeset 解码非 UTF-8 输出、
 *   macOS 上 workspaceWrite 沙箱在 detached spawn 时保持生效。
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@earendil-works/chord/context'
import type { ToolExecutionApi } from '@earendil-works/pi-durable'
import { NodeExecutionEnv } from '@earendil-works/pi-durable/env/node'
import { afterEach, describe, expect, it } from 'vitest'
import { executePosixBash, isBlockedShellSearch, killPosixTree, resolvePosixEnv } from '../src/server/tools/shell/posix.ts'
import { createExecutionEnv, localShellSpawn } from '../src/server/conversation/execution-env.ts'
import { disposeShellSessions, runShellCommand } from '../src/server/tools/shell/runner.ts'

/** 用例创建的临时工作目录，afterEach 统一删除。 */
const directories: string[] = []
/** 用例开始前的 locale 环境变量快照，afterEach 恢复（避免污染其他测试）。 */
const originalEnv = {
  LANG: process.env.LANG,
  LC_CTYPE: process.env.LC_CTYPE,
  LC_ALL: process.env.LC_ALL,
}

/** 空的 chord Context 占位（shell 执行不消费它）。 */
const TEST_CONTEXT = {} as Context

/** 清理：释放 shell 会话、删除临时目录、恢复 locale 环境变量。 */
afterEach(async () => {
  disposeShellSessions()
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
})

/**
 * 创建临时工作目录并注册清理。
 * @returns 目录绝对路径
 */
async function workspace(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'pi-web-posix-shell-'))
  directories.push(directory)
  return directory
}

/**
 * 构造指向给定 cwd 的 ToolExecutionApi：Node 执行环境 + 累积输出的 retainedOutput。
 * @param cwd 工作目录
 * @returns 可传给 executePosixBash 的 api 对象
 */
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

/**
 * 构造 /bin/bash -c 执行规格（5 秒超时、进程组终止、继承当前环境）。
 * @param cwd 工作目录
 * @param command 待执行命令
 * @returns runShellCommand 的 shellSpec
 */
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

/** 递归搜索拦截（isBlockedShellSearch / executePosixBash 防线）。 */
describe.runIf(process.platform !== 'win32')('POSIX recursive search guard', () => {
  // 验证递归形式全拦截：-r/-R/-rn/--recursive、裸 rg、rgrep、find -exec grep、find|xargs grep。
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

  // 验证放行清单：指定文件的 grep、管道中的 grep、引号字符串里的"grep -r"（只是提及）、git grep。
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

  // 验证工具层防线：bash 工具执行递归 grep 直接拒绝（FORBIDDEN），不只是分析层拦截。
  it('rejects a recursive search through the bash tool', async () => {
    const root = await workspace()
    await expect(executePosixBash({ command: 'grep -r foo .' }, apiFor(root), TEST_CONTEXT))
      .rejects.toMatchObject({ code: 'FORBIDDEN' })
  })
})

/** locale 环境解析（resolvePosixEnv）测试。 */
describe.runIf(process.platform !== 'win32')('POSIX locale environment', () => {
  // 验证 C/POSIX locale 替换：LANG=C 时解析出非 C 的 UTF-8 locale，LC_CTYPE 与 LANG 一致，
  // 不启用 legacy 解码（legacyEncoding 为 null）。
  it('replaces an unusable C/POSIX locale with a UTF-8 one', () => {
    process.env.LANG = 'C'
    delete process.env.LC_CTYPE
    delete process.env.LC_ALL

    const { env, legacyEncoding } = resolvePosixEnv()

    expect(env.LANG).not.toBe('C')
    expect(env.LC_CTYPE).toBe(env.LANG)
    expect(legacyEncoding).toBeNull()
  })

  // 验证非 UTF-8 codeset 保留：LC_ALL=zh_CN.GB18030 时 legacyEncoding 为 gb18030（解码回退用）。
  it('keeps a non-UTF-8 codeset as the decoder fallback', () => {
    process.env.LC_ALL = 'zh_CN.GB18030'

    const { legacyEncoding } = resolvePosixEnv()

    expect(legacyEncoding?.toLowerCase()).toBe('gb18030')
  })
})

/** shell runner（runShellCommand）的前台/会话/解码行为测试。 */
describe.runIf(process.platform !== 'win32')('POSIX shell runner', () => {
  // 验证前台路径：短命令同步完成、无错误、输出被回收。
  it('returns foreground output', async () => {
    const root = await workspace()
    const result = await runShellCommand(shellSpec(root, 'printf hi'))

    expect(result.isError).not.toBe(true)
    expect((result.structuredOutput as { output?: string }).output).toContain('hi')
  })

  // 验证退出码语义：grep 无匹配的退出码 1 不算错误，附带 no_matches 诊断。
  it('treats grep exit 1 as no matches', async () => {
    const root = await workspace()
    const result = await runShellCommand(shellSpec(root, 'grep zzz /dev/null'))

    expect(result.isError).not.toBe(true)
    expect(result.diagnostics?.some(diagnostic => diagnostic.code === 'no_matches')).toBe(true)
  })

  // 验证会话升级：超过 yieldTimeMs（100ms）的长命令转为轮询会话——立即返回 running 状态、
  // sh_ 前缀 sessionId 与输出文件路径；等待完成后输出文件含命令结果与"[exited with code 0]"行。
  it('promotes a long command to a pollable session and keeps writing its output file', async () => {
    const root = await workspace()
    const result = await runShellCommand({
      ...shellSpec(root, 'sleep 1; echo done'),
      yieldTimeMs: 100,
    })

    const structured = result.structuredOutput as { status?: string; sessionId?: string; fullOutputPath?: string }
    expect(structured.status).toBe('running')
    expect(structured.sessionId).toMatch(/^sh_/)
    expect(structured.fullOutputPath).toBeTruthy()

    await new Promise(resolveWait => setTimeout(resolveWait, 1_400))
    const output = await readFile(structured.fullOutputPath!, 'utf8')
    expect(output).toContain('done')
    expect(output).toContain('[exited with code 0]')
  })

  // 验证编码回退：GB18030 字节序列（"中文"的 GBK 编码）按 legacyEncoding 正确解码。
  it('decodes non-UTF-8 output with the locale codeset', async () => {
    const root = await workspace()
    const result = await runShellCommand({
      ...shellSpec(root, "printf '\\xd6\\xd0\\xce\\xc4'"),
      legacyEncoding: 'gb18030',
    })

    expect((result.structuredOutput as { output?: string }).output).toContain('中文')
  })

  // macOS 专属：验证 detached spawn（localShellSpawn）仍走 /usr/bin/sandbox-exec，
  // workspaceWrite 沙箱内的 pwd 输出包含工作区路径（沙箱未阻断执行）。
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
