import { spawn, type ChildProcess } from 'node:child_process'
import { performance } from 'node:perf_hooks'
import { killPosixTree } from '../tools/shell/posix.ts'
import { LegacyAwareDecoder } from '../tools/shared/text-decode.ts'
import {
  ADDITIONAL_CONTEXT_BUDGET,
  DEFAULT_MAX_OUTPUT_BYTES,
  DEFAULT_TIMEOUT_MS,
  hookOutputSchema,
  matchHookMatcher,
  normalizeHookOutput,
  type HookEntry,
  type HookEvent,
  type HookOutput,
} from './schema.ts'

/**
 * 功能：hooks 子进程执行引擎——契约对齐 ZCode 运行时（源码核实版）：
 * stdin 单行 JSON；stdout 以 `{` 开头才解析校验，非 JSON 仅诊断；exit 0 成功 / 2 阻断 /
 * 其他非零可恢复失败；超时与父级取消都杀进程树；组内串行、逐条错误隔离。
 * 内部逻辑：process 型 argv 直传不经 shell（三平台一致）；command 型 posix 走 bash -c、
 * Windows 走系统自带 powershell.exe（不依赖 pwsh 安装）。输出解码复用 LegacyAwareDecoder。
 */

/** 一次 hook 运行的终态。 */
export type HookOutcome = 'success' | 'blocked' | 'failed' | 'timeout' | 'cancelled'

/** runner 的 stdin 载荷：基础字段 + 事件专属字段（extension 侧构造）。 */
export interface HookRunInput {
  hook_event_name: HookEvent
  session_id: string
  cwd: string
  [key: string]: unknown
}

/** 单条 hook 的执行选项。 */
export interface HookRunOptions {
  timeoutMs: number
  maxOutputBytes: number
  abortSignal?: AbortSignal
  /** 追加注入的环境变量（PI_WEB_SESSION_ID 等由调用方给）。 */
  env?: Record<string, string>
}

/** 单条 hook 的运行结果（含可观测字段）。 */
export interface HookRunResult {
  outcome: HookOutcome
  exitCode: number
  durationMs: number
  stdout: string
  stderr: string
  truncated: boolean
  output?: HookOutput
  block: boolean
  blockReason?: string
  additionalContext?: string
  updatedInput?: Record<string, unknown>
  error?: string
}

/** 一个事件全部匹配 hook 的聚合决策。 */
export interface EventRunResult {
  block: boolean
  blockReason?: string
  /** 按执行顺序拼接、总预算截断后的附加上下文。 */
  additionalContext?: string
  /** 多个 updatedInput 时最后一个有效完整替代生效（ZCode 同款）。 */
  updatedInput?: Record<string, unknown>
  runs: HookRunResult[]
  /** matcher 非法等配置诊断。 */
  diagnostics: string[]
}

/**
 * 功能：终止 hook 子进程整个进程树。
 * 内部逻辑：posix 复用 shell 工具的 killPosixTree（detached 进程组 SIGKILL）；
 * Windows 用 taskkill /F /T（windows.ts 同款），非 win32 测试环境回落单进程 kill。
 */
function killHookTree(child: ChildProcess): void {
  if (process.platform === 'win32') {
    const pid = child.pid
    if (pid === undefined) return
    try {
      const killer = spawn('taskkill', ['/F', '/T', '/PID', String(pid)], { stdio: 'ignore', windowsHide: true })
      killer.on('error', () => undefined)
    } catch {
      // 进程可能已经退出。
    }
    return
  }
  killPosixTree(child)
}

/**
 * 功能：选择启动方式——process 型 argv 直传；command 型按平台包 shell。
 * @returns program 与 args；Windows command 型用系统自带 Windows PowerShell（最稳，不依赖 pwsh）。
 */
function resolveSpawn(entry: HookEntry): { program: string; args: string[] } {
  if (entry.type === 'process') return { program: entry.command, args: entry.args ?? [] }
  if (process.platform === 'win32') {
    return { program: 'powershell.exe', args: ['-NoProfile', '-NonInteractive', '-Command', entry.command] }
  }
  return { program: 'bash', args: ['-c', entry.command] }
}

/** 收集流文本：超过上限截断并标记（stdout 保留头部——JSON 决策在头部）。 */
function createCollector(maxBytes: number): { push: (text: string) => void; text: () => string; truncated: () => boolean } {
  let buffer = ''
  let bytes = 0
  let over = false
  return {
    push: (text: string) => {
      if (over) return
      const size = Buffer.byteLength(text, 'utf8')
      if (bytes + size > maxBytes) {
        const room = maxBytes - bytes
        if (room > 0) buffer += Buffer.from(text, 'utf8').subarray(0, room).toString('utf8')
        over = true
        return
      }
      buffer += text
      bytes += size
    },
    text: () => buffer,
    truncated: () => over,
  }
}

/**
 * 功能：执行单条 hook 子进程并解析决策。
 * @param entry hook 定义（enabled:false 由调用方跳过）。
 * @param input stdin JSON 载荷。
 * @param options 超时/输出上限/取消信号。
 * @returns 运行结果；任何异常都收敛为 failed/timeout/cancelled，绝不向外抛（错误隔离）。
 */
export async function runHook(entry: HookEntry, input: HookRunInput, options: HookRunOptions): Promise<HookRunResult> {
  const started = performance.now()
  const base: Omit<HookRunResult, 'outcome' | 'exitCode' | 'durationMs'> = {
    stdout: '', stderr: '', truncated: false, block: false,
  }
  const finish = (outcome: HookOutcome, exitCode: number, extra: Partial<HookRunResult> = {}): HookRunResult => ({
    ...base, outcome, exitCode, durationMs: Math.round(performance.now() - started), ...extra,
  })

  if (options.abortSignal?.aborted) return finish('cancelled', -1)

  const { program, args } = resolveSpawn(entry)
  let child: ChildProcess
  try {
    child = spawn(program, args, {
      cwd: input.cwd,
      env: { ...process.env, ...options.env },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: process.platform === 'win32',
      detached: process.platform !== 'win32',
    })
  } catch (error) {
    return finish('failed', -1, { error: `hook 启动失败：${error instanceof Error ? error.message : String(error)}` })
  }

  const stdoutCollector = createCollector(options.maxOutputBytes)
  const stderrCollector = createCollector(options.maxOutputBytes)
  const stdoutDecoder = new LegacyAwareDecoder(null)
  const stderrDecoder = new LegacyAwareDecoder(null)
  child.stdout?.on('data', (chunk: Buffer) => stdoutCollector.push(stdoutDecoder.write(chunk)))
  child.stderr?.on('data', (chunk: Buffer) => stderrCollector.push(stderrDecoder.write(chunk)))

  // stdin：单行 JSON + 换行（Claude 兼容契约）。写入失败（进程早退）不致命。
  child.stdin?.on('error', () => undefined)
  child.stdin?.end(`${JSON.stringify(input)}\n`)

  return await new Promise<HookRunResult>((resolve) => {
    let settled = false
    let outcomeOverride: HookOutcome | undefined
    const timer = setTimeout(() => {
      outcomeOverride = 'timeout'
      killHookTree(child)
    }, options.timeoutMs)
    const onAbort = (): void => {
      outcomeOverride = 'cancelled'
      killHookTree(child)
    }
    options.abortSignal?.addEventListener('abort', onAbort, { once: true })

    const settle = (result: HookRunResult): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      options.abortSignal?.removeEventListener('abort', onAbort)
      resolve(result)
    }

    child.on('error', (error) => {
      // ENOENT 等启动期错误经 error 事件到达（spawn 不同步抛）；语义归为启动失败。
      const errno = (error as NodeJS.ErrnoException).code
      settle(finish(outcomeOverride ?? 'failed', -1, {
        error: errno === 'ENOENT' || errno === 'EACCES'
          ? `hook 启动失败：${error.message}`
          : `hook 执行失败：${error.message}`,
        stderr: stderrCollector.text() + stderrDecoder.end(),
      }))
    })

    child.on('close', (code) => {
      const exitCode = code ?? -1
      const stdout = stdoutCollector.text() + stdoutDecoder.end()
      const stderr = stderrCollector.text() + stderrDecoder.end()
      const truncated = stdoutCollector.truncated() || stderrCollector.truncated()
      base.stdout = stdout
      base.stderr = stderr
      base.truncated = truncated

      if (outcomeOverride !== undefined) {
        settle(finish(outcomeOverride, exitCode, { error: outcomeOverride === 'timeout' ? `hook 超时（${String(options.timeoutMs)}ms）` : 'hook 被取消' }))
        return
      }
      if (exitCode !== 0 && exitCode !== 2) {
        settle(finish('failed', exitCode, { error: `hook 退出码 ${String(exitCode)}：${stderr.slice(0, 500) || stdout.slice(0, 500)}` }))
        return
      }

      // exit 0/2：解析 stdout JSON（以 { 开头才尝试；非 JSON 仅诊断，不注入）。
      let output: HookOutput | undefined
      const trimmed = stdout.trimStart()
      if (trimmed.startsWith('{')) {
        let parsedJson: unknown
        try {
          parsedJson = JSON.parse(trimmed)
        } catch {
          parsedJson = undefined // 非法 JSON 按诊断处理（ZCode：非 JSON stdout 成功但无效果）。
        }
        if (parsedJson !== undefined) {
          const parsed = hookOutputSchema.safeParse(parsedJson)
          if (!parsed.success) {
            settle(finish('failed', exitCode, { error: 'hook 输出 JSON 校验失败' }))
            return
          }
          output = parsed.data
        }
      }
      const normalized = output !== undefined ? normalizeHookOutput(output, input.hook_event_name) : undefined
      // exit 2 的阻断语义：PreToolUse 类→阻断调用；Stop→续跑请求。统一标记 block。
      const block = exitCode === 2 || normalized?.block === true
      settle(finish(block ? 'blocked' : 'success', exitCode, {
        output,
        block,
        blockReason: normalized?.blockReason ?? (exitCode === 2 ? stderr.slice(0, 500) || 'hook 以退出码 2 请求阻断' : undefined),
        additionalContext: normalized?.additionalContext,
        updatedInput: normalized?.updatedInput,
      }))
    })
  })
}

/**
 * 功能：执行一个事件下全部匹配的 hook 并聚合决策。
 * @param groups 来源的 matcher 组（可多来源拼接，用户级在前）。
 * @param event 事件名。
 * @param matchValue matcher 匹配值（工具名 / source）；无查询值的事件传 undefined。
 * @param input stdin 载荷。
 * @param defaults 来源级生效默认值（条目级 timeoutMs 优先）。
 * @param options 取消信号与 env。
 * @returns 聚合决策与逐条运行记录。
 * 内部逻辑：matcher 过滤（非法正则记诊断不执行）→ enabled:false 真跳过 → 串行执行、
 * 单条失败隔离 → 聚合：任一 block 即 block（deny 优先），updatedInput 后者覆盖，
 * additionalContext 按序拼接并受 24k 字符总预算截断。
 */
export async function runEventHooks(
  groups: Array<{ matcher?: string; hooks: HookEntry[]; sourceTimeoutMs?: number; sourceMaxOutputBytes?: number }>,
  event: HookEvent,
  matchValue: string | undefined,
  input: HookRunInput,
  options: { abortSignal?: AbortSignal; env?: Record<string, string> } = {},
): Promise<EventRunResult> {
  const result: EventRunResult = { block: false, runs: [], diagnostics: [] }
  const contextParts: string[] = []
  let contextLength = 0
  for (const group of groups) {
    const { matched, invalid } = matchHookMatcher(group.matcher, matchValue)
    if (invalid) {
      result.diagnostics.push(`非法 matcher 正则（已跳过）：${group.matcher ?? ''}`)
      continue
    }
    if (!matched) continue
    for (const entry of group.hooks) {
      if (entry.enabled === false) continue
      const run = await runHook(entry, input, {
        timeoutMs: entry.timeoutMs ?? group.sourceTimeoutMs ?? DEFAULT_TIMEOUT_MS,
        maxOutputBytes: group.sourceMaxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES,
        abortSignal: options.abortSignal,
        env: options.env,
      })
      result.runs.push(run)
      if (run.block) {
        result.block = true
        result.blockReason ??= run.blockReason
      }
      if (run.updatedInput !== undefined) result.updatedInput = run.updatedInput
      if (run.additionalContext !== undefined && contextLength < ADDITIONAL_CONTEXT_BUDGET) {
        const room = ADDITIONAL_CONTEXT_BUDGET - contextLength
        const part = run.additionalContext.length > room ? run.additionalContext.slice(0, room) : run.additionalContext
        contextParts.push(part)
        contextLength += part.length
      }
    }
  }
  // 拼接分隔符也占预算：join 后精确截断到总上限。
  if (contextParts.length > 0) result.additionalContext = contextParts.join('\n').slice(0, ADDITIONAL_CONTEXT_BUDGET)
  return result
}