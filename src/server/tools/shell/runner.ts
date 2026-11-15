import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { createWriteStream, mkdirSync, type WriteStream } from 'node:fs'
import { unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { Type } from '@earendil-works/pi-ai'
import type { ToolExecutionApi, ToolExecutionResult } from '@earendil-works/pi-durable'
import type { Context } from '@earendil-works/chord/context'
import { withNoMatchSuccess } from './common.ts'
import { LegacyAwareDecoder } from '../shared/text-decode.ts'

/** 单次 shell 工具输出的最大字节数（保留尾部）。 */
export const MAX_OUTPUT_BYTES = 50 * 1_024
/** 单次 shell 工具输出的最大行数。 */
export const MAX_OUTPUT_LINES = 2_000
/** 前台等待预算：超过后命令让渡为可轮询会话（对应 codex 的 `yield_time_ms`）。 */
export const YIELD_TIME_MS = 10_000
/** 模型可传的最小让渡毫秒数。 */
export const MIN_YIELD_TIME_MS = 250
/** 模型可传的最大让渡毫秒数。 */
export const MAX_YIELD_TIME_MS = 30_000
/** 单会话内存输出缓冲上限；超限部分由落盘 spill 文件保存完整输出。 */
export const MAX_SESSION_BUFFER_BYTES = 1_024 * 1_024
/** 同时存活的 shell 会话上限；会话是真实资源（进程 + 文件句柄），必须限流。 */
export const MAX_SHELL_SESSIONS = 20

/** bash/pwsh 工具的 structuredOutput schema：增量/累计输出、截断标记、退出码及让渡后的会话信息。 */
export const SHELL_OUTPUT_SCHEMA = Type.Object({
  output: Type.String(),
  truncated: Type.Boolean(),
  fullOutputPath: Type.Optional(Type.String()),
  exitCode: Type.Number(),
  status: Type.Optional(Type.Union([Type.Literal('running')])),
  sessionId: Type.Optional(Type.String()),
})

/** shell_session 工具的 structuredOutput schema：增量输出、运行/退出状态、退出码与会话信息。 */
export const SESSION_OUTPUT_SCHEMA = Type.Object({
  output: Type.String(),
  status: Type.Union([Type.Literal('running'), Type.Literal('exited')]),
  exitCode: Type.Optional(Type.Number()),
  sessionId: Type.String(),
  truncated: Type.Boolean(),
  fullOutputPath: Type.Optional(Type.String()),
})

/** 一条比调用方活得久、可跨工具调用轮询的命令会话。 */
export interface ShellSession {
  id: string
  child: ChildProcess | undefined
  kill: (child?: ChildProcess) => void
  command: string
  timeoutSeconds: number
  timeoutTimer: NodeJS.Timeout | undefined
  outputPath: string
  outputStream: WriteStream | undefined
  /** 会话存活期间累计的已解码输出；完整内容始终由 spill 文件保存。 */
  buffer: string
  bufferTruncated: boolean
  outputBytes: number
  /** 上一次 `shell_session` 读取已消费到的字符游标。 */
  cursor: number
  exited: boolean
  exitCode: number | null
  timedOut: boolean
  listeners: Set<() => void>
}

/** 模块级会话表：sessionId → 会话。服务进程生命周期内共享。 */
const shellSessions = new Map<string, ShellSession>()

/**
 * 功能：停止所有存活的命令会话（服务关闭时调用）。
 * 内部逻辑：逐个清掉超时定时器、关闭输出流；未退出的会话杀掉进程树，最后清空会话表。
 */
export function disposeShellSessions(): void {
  for (const session of shellSessions.values()) {
    if (session.timeoutTimer !== undefined) clearTimeout(session.timeoutTimer)
    session.outputStream?.end()
    if (!session.exited) session.kill(session.child)
  }
  shellSessions.clear()
}

/**
 * 功能：返回当前存活 shell 会话的数量（供监控/诊断用）。
 * @returns 会话表大小。
 */
export function activeShellSessionCount(): number {
  return shellSessions.size
}

/**
 * 功能：唤醒并清空会话的所有等待者（新输出或退出时通知轮询方）。
 * @param session 目标会话。
 */
function notifySession(session: ShellSession): void {
  for (const listener of session.listeners) listener()
  session.listeners.clear()
}

/** runShellCommand 的运行参数包：平台适配器提供可执行文件、环境、旧编码与进程树终止器。 */
export interface ShellRunSpec {
  command: string
  program: string
  args: readonly string[]
  cwd: string
  env: NodeJS.ProcessEnv
  legacyEncoding: string | null
  timeoutSeconds: number
  /** 嵌入方/测试可缩短前台等待预算；工具保持默认 10 秒。 */
  yieldTimeMs?: number
  kill: (child: ChildProcess | undefined) => void
  api: ToolExecutionApi
  context: Context
}

/**
 * 功能：生成 shell 完整输出的落盘文件路径。
 * 内部逻辑：在系统临时目录下建 `pi-web-shell` 目录，文件名含时间戳与 UUID，避免并发冲突。
 * @returns 日志文件绝对路径。
 */
function outputFilePath(): string {
  const directory = resolve(tmpdir(), 'pi-web-shell')
  mkdirSync(directory, { recursive: true })
  return resolve(directory, `${Date.now()}-${randomUUID()}.log`)
}

/**
 * 功能：执行一条 shell 命令：流式输出、保留尾部、完整输出落盘日志，以及 codex 风格的
 * 让渡——`yieldTimeMs` 后仍在运行的命令被提升为可轮询会话，跨调用存活，由后续回合经
 * `shell_session` 读取。平台适配器提供可执行文件、环境、旧编码与进程树终止器。
 * 边界：超时定时器到点杀进程并报 timeout；abort 时杀进程并 reject；会话数达
 * MAX_SHELL_SESSIONS 上限时杀进程并报 session_limit；输出超过 MAX_OUTPUT_BYTES 时提示
 * 完整输出路径。
 * @param spec 命令与运行参数（ShellRunSpec）。
 * @returns 标准 shell 工具结果；让渡时 status=running 并带 sessionId。
 */
export async function runShellCommand(spec: ShellRunSpec): Promise<ToolExecutionResult> {
  const { api, context, command, kill } = spec
  const yieldTimeMs = clampYieldTime(spec.yieldTimeMs)
  const timeoutMs = Math.round(spec.timeoutSeconds * 1_000)
  const stdoutDecoder = new LegacyAwareDecoder(spec.legacyEncoding)
  const stderrDecoder = new LegacyAwareDecoder(spec.legacyEncoding)
  let outputPath: string | undefined
  let outputStream: WriteStream | undefined
  let outputBytes = 0
  let child: ChildProcess | undefined
  let settled = false
  let session: ShellSession | undefined
  let timeoutTimer: NodeJS.Timeout | undefined
  let yieldTimer: NodeJS.Timeout | undefined

  return await new Promise<ToolExecutionResult>((resolvePromise, rejectPromise) => {
    /** 惰性创建完整输出日志文件（追加写、权限 0600），保证路径只建一次。 */
    const ensureOutput = (): string => {
      if (outputPath !== undefined) return outputPath
      outputPath = outputFilePath()
      outputStream = createWriteStream(outputPath, { flags: 'a', mode: 0o600 })
      outputStream.on('error', () => undefined)
      return outputPath
    }

    /**
     * 输出的统一出口：未结算时流给 api.output（调用可能已结算/中止，静默吞错）；
     * 会话存活时累计进缓冲（超过 MAX_SESSION_BUFFER_BYTES 即停止缓冲，落盘兜底）；
     * 始终追加写入完整输出文件。
     */
    const writeOutput = (text: string): void => {
      if (text === '') return
      if (!settled) {
        try {
          api.output(text)
        } catch {
          // 调用可能已经结算或中止。
        }
      }
      if (session !== undefined && !session.exited) {
        session.outputBytes += Buffer.byteLength(text)
        if (!session.bufferTruncated) {
          if (session.outputBytes > MAX_SESSION_BUFFER_BYTES) {
            session.bufferTruncated = true
          } else {
            session.buffer += text
          }
        }
      }
      ensureOutput()
      if (outputStream !== undefined && !outputStream.writableEnded) outputStream.write(text)
    }

    const clearTimers = (): void => {
      if (timeoutTimer !== undefined) clearTimeout(timeoutTimer)
      if (yieldTimer !== undefined) clearTimeout(yieldTimer)
    }

    const closeOutput = (): void => {
      if (outputStream !== undefined && !outputStream.writableEnded) outputStream.end()
    }

    /** abort 处理：杀掉进程树；未结算时清理定时器/监听并 reject。 */
    const onAbort = (): void => {
      kill(child)
      if (settled) return
      settled = true
      clearTimers()
      context.abortSignal?.removeEventListener('abort', onAbort)
      closeOutput()
      rejectPromise(new Error('Command aborted'))
    }

    /**
     * 前台收尾：结算 promise；输出被裁剪（保留尾部截断或超字节上限）时提示完整输出路径；
     * 未产生裁剪且日志未满时删除临时日志文件，避免垃圾残留。
     */
    const finishForeground = (result: ToolExecutionResult): void => {
      if (settled) return
      settled = true
      clearTimers()
      context.abortSignal?.removeEventListener('abort', onAbort)
      const retained = api.retainedOutput()
      const clipped = retained.truncated || outputBytes > MAX_OUTPUT_BYTES
      if (clipped && outputPath !== undefined) {
        api.diagnostic({ severity: 'info', code: 'full_output', message: `Full output: ${outputPath}` })
      }
      if (outputStream === undefined) {
        if (!clipped && outputPath !== undefined) void unlink(outputPath).catch(() => undefined)
      } else if (!outputStream.writableEnded) {
        outputStream.end(() => {
          if (!clipped && outputPath !== undefined) {
            void unlink(outputPath).catch(() => undefined)
          }
        })
      }
      resolvePromise(result)
    }

    /**
     * 让渡收尾：把仍在运行的命令提升为会话——它跨本次调用存活，继续把输出流入
     * spill 文件，后续回合经 `shell_session` 轮询。会话数达上限时改为杀进程并报错。
     */
    const promoteSession = (): void => {
      if (settled) return
      if (shellSessions.size >= MAX_SHELL_SESSIONS) {
        kill(child)
        finishForeground({
          structuredOutput: {
            output: api.retainedOutput().text,
            truncated: api.retainedOutput().truncated,
            exitCode: -1,
          },
          isError: true,
          diagnostics: [
            {
              severity: 'error',
              code: 'session_limit',
              message: `Too many live shell sessions (limit ${String(MAX_SHELL_SESSIONS)}); finish or abandon existing sessions first.`,
            },
          ],
        })
        return
      }
      const path = ensureOutput()
      settled = true
      // 被提升的命令比本次运行活得久；此后只有显式 timeout 还在约束它。
      context.abortSignal?.removeEventListener('abort', onAbort)
      session = {
        id: `sh_${randomUUID().slice(0, 8)}`,
        child: spawned,
        kill,
        command,
        timeoutSeconds: spec.timeoutSeconds,
        timeoutTimer,
        outputPath: path,
        outputStream,
        buffer: '',
        bufferTruncated: false,
        // 缓冲只承载提升之后的输出，但字节预算统计整条命令，让多话的前半程也触发
        // 落盘，而不是让缓冲无限增长。
        outputBytes,
        cursor: 0,
        exited: false,
        exitCode: null,
        timedOut: false,
        listeners: new Set(),
      }
      shellSessions.set(session.id, session)
      const note = `\n[Command still running after ${String(yieldTimeMs / 1_000)}s; promoted to session ${session.id}. Poll it with shell_session to read incremental output or write stdin.]\n`
      try {
        api.output(note)
      } catch {
        // 调用可能已经结算。
      }
      resolvePromise({
        structuredOutput: {
          output: api.retainedOutput().text,
          truncated: api.retainedOutput().truncated,
          fullOutputPath: path,
          exitCode: -1,
          status: 'running',
          sessionId: session.id,
        },
        diagnostics: [
          { severity: 'info', code: 'session_started', message: `Command promoted to session ${session.id}. Output: ${path}` },
        ],
      })
    }

    /** spawn 失败收尾：未结算时清理并 reject，报出底层错误信息。 */
    const resolvedSpawnError = (error: unknown): void => {
      if (settled) return
      settled = true
      clearTimers()
      context.abortSignal?.removeEventListener('abort', onAbort)
      closeOutput()
      rejectPromise(new Error(`Command failed to start: ${error instanceof Error ? error.message : String(error)}`))
    }

    try {
      child = spawn(spec.program, [...spec.args], {
        cwd: spec.cwd,
        env: spec.env,
        // stdin 用管道，让提升后的会话能经 `shell_session` 接收文本；runner 自身不写
        // stdin，非交互命令不受影响。
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: process.platform === 'win32',
        detached: process.platform !== 'win32',
      })
    } catch (error) {
      resolvedSpawnError(error)
      return
    }

    const spawned = child
    if (spawned === undefined) {
      resolvedSpawnError(new Error('Shell did not start'))
      return
    }

    /** 会话终态结算：标记退出码/超时，清定时器、关输出流并唤醒所有轮询等待者。 */
    const settleSession = (exitCode: number, timedOut: boolean): void => {
      const target = session
      if (target === undefined || target.exited) return
      target.exited = true
      target.exitCode = exitCode
      target.timedOut = timedOut
      if (target.timeoutTimer !== undefined) {
        clearTimeout(target.timeoutTimer)
        target.timeoutTimer = undefined
      }
      target.outputStream?.end()
      notifySession(target)
    }

    /** 总时限定时器：到点杀进程。已让渡的会话记 timedOut 终态；前台则报 timeout 错误。 */
    timeoutTimer = setTimeout(() => {
      kill(spawned)
      if (session !== undefined) {
        outputStream?.write(`\n[timed out after ${String(spec.timeoutSeconds)}s]\n`)
        settleSession(-1, true)
        return
      }
      const retained = api.retainedOutput()
      finishForeground({
        structuredOutput: {
          output: retained.text,
          truncated: retained.truncated,
          exitCode: -1,
        },
        isError: true,
        diagnostics: [
          { severity: 'error', code: 'timeout', message: `Command timed out after ${String(spec.timeoutSeconds)} seconds` },
        ],
      })
    }, timeoutMs)

    // 前台预算小于总时限时安排让渡定时器；abort 事件一次性挂接。
    if (timeoutMs > yieldTimeMs) {
      yieldTimer = setTimeout(promoteSession, yieldTimeMs)
    }
    context.abortSignal?.addEventListener('abort', onAbort, { once: true })

    // stdout/stderr 各用一个旧编码感知解码器，解出的文本走统一的输出出口。
    spawned.stdout?.on('data', (chunk: Buffer) => {
      writeOutput(stdoutDecoder.write(chunk))
    })
    spawned.stderr?.on('data', (chunk: Buffer) => {
      writeOutput(stderrDecoder.write(chunk))
    })

    spawned.on('error', (error) => {
      resolvedSpawnError(error)
    })

    /** 进程退出收尾：已让渡的会话写退出码尾注并结算终态；前台则冲刷残留解码、按退出码成/败结算。 */
    spawned.on('close', (code) => {
      const exitCode = code ?? -1
      if (settled && session !== undefined) {
        outputStream?.write(`\n[exited with code ${String(exitCode)}]\n`)
        settleSession(exitCode, false)
        return
      }
      if (settled) return

      // 在读取保留输出之前，冲刷可能被裁断的多字节字符残余。
      const tailStdout = stdoutDecoder.end()
      const tailStderr = stderrDecoder.end()
      if (tailStdout !== '') {
        try {
          api.output(tailStdout)
        } catch {
          // 调用可能已经结算。
        }
      }
      if (tailStderr !== '') {
        try {
          api.output(tailStderr)
        } catch {
          // 调用可能已经结算。
        }
      }

      const retained = api.retainedOutput()
      if (exitCode === 0) {
        finishForeground({
          structuredOutput: {
            output: retained.text,
            truncated: retained.truncated,
            exitCode,
          },
        })
        return
      }

      const failure: ToolExecutionResult = {
        structuredOutput: {
          output: retained.text,
          truncated: retained.truncated,
          exitCode,
        },
        isError: true,
        diagnostics: [{ severity: 'error', code: 'exit_code', message: `Command exited with code ${String(exitCode)}` }],
      }
      finishForeground(withNoMatchSuccess(failure, command))
    })
  })
}

/**
 * 功能：把模型传入的让渡毫秒数夹取到支持的范围内。
 * 内部逻辑：undefined/非有限值用默认 YIELD_TIME_MS；否则四舍五入后夹在
 * MIN_YIELD_TIME_MS 与 MAX_YIELD_TIME_MS 之间。
 * @param value 模型传入的让渡毫秒数。
 * @returns 规范化后的让渡毫秒数。
 */
export function clampYieldTime(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return YIELD_TIME_MS
  return Math.min(Math.max(Math.round(value), MIN_YIELD_TIME_MS), MAX_YIELD_TIME_MS)
}

/**
 * 功能：轮询一个 shell 会话：等到有新输出、进程退出或预算到期为止。
 * 内部逻辑：可选先写 stdin（进程可能恰好在轮询与写入之间退出，写失败静默忽略）；
 * 未退出的会话等预算到期或被 notify/abort 唤醒；abort 只是提前返回可用数据，不杀会话
 * （会话跨调用存活）。返回自上次游标以来的增量文本并把游标推进到末尾；已退出的会话
 * 在无等待者时从会话表回收。
 * @param sessionId 会话 id；不存在时返回 undefined。
 * @param stdin 要写入进程 stdin 的文本；省略或空串则只轮询。
 * @param yieldTimeMs 本轮等待预算（经 clampYieldTime 规范化）。
 * @param context 执行上下文（提供 abortSignal）。
 * @returns 会话对象与增量文本；会话不存在时 undefined。
 */
export async function readShellSession(
  sessionId: string,
  stdin: string | undefined,
  yieldTimeMs: number | undefined,
  context: Context,
): Promise<{ session: ShellSession; delta: string } | undefined> {
  const session = shellSessions.get(sessionId)
  if (session === undefined) return undefined

  if (stdin !== undefined && stdin !== '' && !session.exited) {
    try {
      session.child?.stdin?.write(stdin)
    } catch {
      // 进程可能在轮询与写入之间退出。
    }
  }

  const budget = clampYieldTime(yieldTimeMs)
  if (!session.exited) {
    await new Promise<void>(resolveWait => {
      const done = () => {
        clearTimeout(timer)
        context.abortSignal?.removeEventListener('abort', onAbort)
        resolveWait()
      }
      const listener = () => done()
      const timer = setTimeout(done, budget)
      session.listeners.add(listener)
      const onAbort = () => done()
      context.abortSignal?.addEventListener('abort', onAbort, { once: true })
    })
  }

  const from = Math.min(session.cursor, session.buffer.length)
  const delta = session.buffer.slice(from)
  session.cursor = session.buffer.length
  if (session.exited && session.listeners.size === 0) shellSessions.delete(sessionId)
  return { session, delta }
}

/**
 * 功能：把会话终态转成诊断条目，供 `shell_session` 工具结果复用。
 * 内部逻辑：超时返回 error 级 timeout 诊断；非 0 退出返回 error 级 exit_code 诊断；
 * 其余（正常退出）返回 undefined。
 * @param session 目标会话。
 * @returns 诊断数组或 undefined。
 */
export function sessionDiagnostics(session: ShellSession): ToolExecutionResult['diagnostics'] {
  if (session.timedOut) {
    return [{ severity: 'error', code: 'timeout', message: `Command timed out after ${String(session.timeoutSeconds)} seconds` }]
  }
  if (session.exitCode !== null && session.exitCode !== 0) {
    return [{ severity: 'error', code: 'exit_code', message: `Command exited with code ${String(session.exitCode)}` }]
  }
  return undefined
}
