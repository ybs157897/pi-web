import { describe, expect, it } from 'vitest'
import { runEventHooks, runHook, type HookRunInput } from '../src/server/hooks/runner.ts'
import type { HookEntry } from '../src/server/hooks/schema.ts'

/**
 * hooks 执行引擎契约测试（真实子进程，node -e 脚本，三平台可跑）。
 *
 * 关键契约（对齐 ZCode 运行时）：
 * - exit 0 成功并解析 stdout JSON；非 JSON stdout 仅诊断；exit 2 阻断；其他非零可恢复失败；
 * - 合法 JSON 但已知字段类型错误 → 该 hook 失败；非法 JSON（{ 开头但解析失败）→ 诊断；
 * - 超时杀进程树记 timeout；父级 abort 记 cancelled；命令不存在记 failed 不抛；
 * - 组内串行、单条失败隔离；聚合 block 优先、updatedInput 后者覆盖、context 预算截断；
 * - enabled:false 真跳过；matcher 过滤与非法正则诊断。
 */

/** 构造 process 型 hook：用当前 node 解释器执行内联脚本（跨平台）。 */
function nodeHook(script: string, extra: Partial<HookEntry> = {}): HookEntry {
  return { type: 'process', command: process.execPath, args: ['-e', script], ...extra }
}

const input: HookRunInput = { hook_event_name: 'PreToolUse', session_id: 's1', cwd: process.cwd(), tool_name: 'Bash', tool_input: { command: 'ls' } }
const opts = { timeoutMs: 10_000, maxOutputBytes: 32_768 }

describe('hooks runner 单条执行契约', () => {
  // exit 0 + 合法 JSON：解析并归一化决策。
  it('parses JSON stdout on exit 0', async () => {
    const run = await runHook(nodeHook(`process.stdout.write(JSON.stringify({ additionalContext: '注意规范', hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow' } }))`), input, opts)
    expect(run.outcome).toBe('success')
    expect(run.exitCode).toBe(0)
    expect(run.additionalContext).toBe('注意规范')
    expect(run.block).toBe(false)
  })

  // 非 JSON stdout：成功但无决策效果。
  it('treats non-JSON stdout as diagnostic only', async () => {
    const run = await runHook(nodeHook(`console.log('普通日志输出')`), input, opts)
    expect(run.outcome).toBe('success')
    expect(run.output).toBeUndefined()
    expect(run.additionalContext).toBeUndefined()
  })

  // { 开头但非法 JSON：按诊断处理，不失败。
  it('treats malformed JSON as diagnostic, not failure', async () => {
    const run = await runHook(nodeHook(`process.stdout.write('{ broken')`), input, opts)
    expect(run.outcome).toBe('success')
    expect(run.output).toBeUndefined()
  })

  // 合法 JSON 但已知字段类型错误：该 hook 失败。
  it('fails on schema-invalid JSON output', async () => {
    const run = await runHook(nodeHook(`process.stdout.write(JSON.stringify({ continue: 'not-boolean' }))`), input, opts)
    expect(run.outcome).toBe('failed')
    expect(run.error).toContain('校验失败')
  })

  // exit 2：阻断语义，stderr 作为原因。
  it('blocks on exit code 2 with stderr as reason', async () => {
    const run = await runHook(nodeHook(`console.error('禁止删除'); process.exit(2)`), input, opts)
    expect(run.outcome).toBe('blocked')
    expect(run.block).toBe(true)
    expect(run.blockReason).toContain('禁止删除')
  })

  // 其他非零退出码：可恢复失败，不阻断。
  it('reports recoverable failure on other non-zero exit codes', async () => {
    const run = await runHook(nodeHook(`process.exit(3)`), input, opts)
    expect(run.outcome).toBe('failed')
    expect(run.block).toBe(false)
    expect(run.exitCode).toBe(3)
  })

  // stdin 单行 JSON 送达脚本。
  it('delivers stdin JSON to the hook process', async () => {
    const run = await runHook(nodeHook(`let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const j=JSON.parse(d);process.stdout.write(JSON.stringify({additionalContext:j.tool_name}))})`), input, opts)
    expect(run.outcome).toBe('success')
    expect(run.additionalContext).toBe('Bash')
  })

  // 超时：杀进程树，记 timeout。
  it('kills the process tree on timeout', async () => {
    const run = await runHook(nodeHook(`setTimeout(()=>{}, 30000)`), input, { ...opts, timeoutMs: 200 })
    expect(run.outcome).toBe('timeout')
    expect(run.error).toContain('超时')
    expect(run.durationMs).toBeLessThan(5000)
  })

  // 父级取消：记 cancelled。
  it('cancels via parent abort signal', async () => {
    const controller = new AbortController()
    setTimeout(() => controller.abort(), 100)
    const run = await runHook(nodeHook(`setTimeout(()=>{}, 30000)`), input, { ...opts, abortSignal: controller.signal })
    expect(run.outcome).toBe('cancelled')
  })

  // 已 abort 的信号：直接 cancelled，不启动进程。
  it('returns cancelled immediately for an already-aborted signal', async () => {
    const controller = new AbortController()
    controller.abort()
    const run = await runHook(nodeHook(`process.exit(0)`), input, { ...opts, abortSignal: controller.signal })
    expect(run.outcome).toBe('cancelled')
  })

  // 命令不存在：failed 收敛，不向外抛。
  it('converges spawn errors to failed without throwing', async () => {
    const run = await runHook({ type: 'process', command: 'pi-web-no-such-command-xyz', args: [] }, input, opts)
    expect(run.outcome).toBe('failed')
    expect(run.error).toContain('启动失败')
  })

  // stdout 超上限截断并标记。
  it('truncates stdout beyond maxOutputBytes', async () => {
    const run = await runHook(nodeHook(`process.stdout.write('x'.repeat(5000))`), input, { ...opts, maxOutputBytes: 100 })
    expect(run.truncated).toBe(true)
    expect(Buffer.byteLength(run.stdout, 'utf8')).toBeLessThanOrEqual(100)
  })

  // command 型经 shell 执行（posix bash / Windows powershell）。
  it('runs command-type hooks through the platform shell', async () => {
    const script = process.platform === 'win32' ? 'Write-Output ok' : 'echo ok'
    const run = await runHook({ type: 'command', command: script }, input, opts)
    expect(run.outcome).toBe('success')
    expect(run.stdout.trim()).toBe('ok')
  })
})

describe('hooks runner 组聚合契约', () => {
  const groups = (hooks: HookEntry[], matcher?: string) => [{ matcher, hooks, sourceTimeoutMs: 10_000, sourceMaxOutputBytes: 32_768 }]

  // 串行 + 错误隔离：第一条失败，第二条仍执行并生效。
  it('isolates failures and keeps executing subsequent hooks', async () => {
    const result = await runEventHooks(groups([
      nodeHook(`process.exit(1)`),
      nodeHook(`process.stdout.write(JSON.stringify({additionalContext:'第二条'}))`),
    ]), 'PostToolUse', 'Bash', input)
    expect(result.runs).toHaveLength(2)
    expect(result.runs[0].outcome).toBe('failed')
    expect(result.runs[1].outcome).toBe('success')
    expect(result.additionalContext).toBe('第二条')
  })

  // block 优先：任一阻断即聚合阻断；context 仍收集。
  it('aggregates block with deny priority and keeps context', async () => {
    const result = await runEventHooks(groups([
      nodeHook(`process.stdout.write(JSON.stringify({additionalContext:'放行方'}))`),
      nodeHook(`process.stdout.write(JSON.stringify({decision:'block',reason:'危险操作',additionalContext:'阻断方'}))`),
    ]), 'PreToolUse', 'Bash', input)
    expect(result.block).toBe(true)
    expect(result.blockReason).toBe('危险操作')
    expect(result.additionalContext).toBe('放行方\n阻断方')
  })

  // updatedInput 后者覆盖。
  it('lets the last valid updatedInput win', async () => {
    const result = await runEventHooks(groups([
      nodeHook(`process.stdout.write(JSON.stringify({hookSpecificOutput:{hookEventName:'PreToolUse',updatedInput:{command:'first'}}}))`),
      nodeHook(`process.stdout.write(JSON.stringify({hookSpecificOutput:{hookEventName:'PreToolUse',updatedInput:{command:'second'}}}))`),
    ]), 'PreToolUse', 'Bash', input)
    expect(result.updatedInput).toEqual({ command: 'second' })
  })

  // additionalContext 总预算截断（24k 字符）。
  it('truncates aggregated context to the budget', async () => {
    const result = await runEventHooks(groups([
      nodeHook(`process.stdout.write(JSON.stringify({additionalContext:'a'.repeat(20000)}))`),
      nodeHook(`process.stdout.write(JSON.stringify({additionalContext:'b'.repeat(20000)}))`),
    ]), 'PostToolUse', 'Bash', input)
    expect(result.additionalContext?.length).toBe(24_000)
  })

  // enabled:false 真跳过（不启动进程）。
  it('skips disabled hooks entirely', async () => {
    const result = await runEventHooks(groups([
      nodeHook(`process.exit(2)`, { enabled: false }),
      nodeHook(`process.stdout.write(JSON.stringify({additionalContext:'生效'}))`),
    ]), 'PreToolUse', 'Bash', input)
    expect(result.runs).toHaveLength(1)
    expect(result.block).toBe(false)
    expect(result.additionalContext).toBe('生效')
  })

  // matcher 过滤：不匹配的组不执行；非法正则记诊断。
  it('filters by matcher and reports invalid regex', async () => {
    const result = await runEventHooks([
      { matcher: 'Write|Edit', hooks: [nodeHook(`process.exit(2)`)], sourceTimeoutMs: 10_000, sourceMaxOutputBytes: 32_768 },
      { matcher: '[bad', hooks: [nodeHook(`process.exit(2)`)], sourceTimeoutMs: 10_000, sourceMaxOutputBytes: 32_768 },
      { matcher: 'Bash', hooks: [nodeHook(`process.stdout.write(JSON.stringify({additionalContext:'匹配'}))`)], sourceTimeoutMs: 10_000, sourceMaxOutputBytes: 32_768 },
    ], 'PreToolUse', 'Bash', input)
    expect(result.runs).toHaveLength(1)
    expect(result.block).toBe(false)
    expect(result.additionalContext).toBe('匹配')
    expect(result.diagnostics).toHaveLength(1)
  })

  // 条目级 timeoutMs 覆盖来源级。
  it('prefers entry-level timeout over source default', async () => {
    const result = await runEventHooks(groups([
      nodeHook(`setTimeout(()=>{},30000)`, { timeoutMs: 200 }),
    ]), 'Stop', undefined, input)
    expect(result.runs[0].outcome).toBe('timeout')
  })
})