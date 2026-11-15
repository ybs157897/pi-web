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

export const MAX_OUTPUT_BYTES = 50 * 1_024
export const MAX_OUTPUT_LINES = 2_000
/** Foreground budget before a command is promoted to a pollable session (codex `yield_time_ms`). */
export const YIELD_TIME_MS = 10_000
export const MIN_YIELD_TIME_MS = 250
export const MAX_YIELD_TIME_MS = 30_000
/** Per-session output-buffer cap; the spill file keeps the full output beyond it. */
export const MAX_SESSION_BUFFER_BYTES = 1_024 * 1_024
/** Live command sessions; a real resource, so the container bounds it. */
export const MAX_SHELL_SESSIONS = 20

export const SHELL_OUTPUT_SCHEMA = Type.Object({
  output: Type.String(),
  truncated: Type.Boolean(),
  fullOutputPath: Type.Optional(Type.String()),
  exitCode: Type.Number(),
  status: Type.Optional(Type.Union([Type.Literal('running')])),
  sessionId: Type.Optional(Type.String()),
})

export const SESSION_OUTPUT_SCHEMA = Type.Object({
  output: Type.String(),
  status: Type.Union([Type.Literal('running'), Type.Literal('exited')]),
  exitCode: Type.Optional(Type.Number()),
  sessionId: Type.String(),
  truncated: Type.Boolean(),
  fullOutputPath: Type.Optional(Type.String()),
})

/** One command that outlived its caller and is kept pollable across tool calls. */
export interface ShellSession {
  id: string
  child: ChildProcess | undefined
  kill: (child?: ChildProcess) => void
  command: string
  timeoutSeconds: number
  timeoutTimer: NodeJS.Timeout | undefined
  outputPath: string
  outputStream: WriteStream | undefined
  /** Decoded output accumulated while the session is live; the spill file keeps everything. */
  buffer: string
  bufferTruncated: boolean
  outputBytes: number
  /** Consumed-character cursor of the last `shell_session` read. */
  cursor: number
  exited: boolean
  exitCode: number | null
  timedOut: boolean
  listeners: Set<() => void>
}

const shellSessions = new Map<string, ShellSession>()

/** Stop every live command session. Called when the server closes. */
export function disposeShellSessions(): void {
  for (const session of shellSessions.values()) {
    if (session.timeoutTimer !== undefined) clearTimeout(session.timeoutTimer)
    session.outputStream?.end()
    if (!session.exited) session.kill(session.child)
  }
  shellSessions.clear()
}

export function activeShellSessionCount(): number {
  return shellSessions.size
}

function notifySession(session: ShellSession): void {
  for (const listener of session.listeners) listener()
  session.listeners.clear()
}

export interface ShellRunSpec {
  command: string
  program: string
  args: readonly string[]
  cwd: string
  env: NodeJS.ProcessEnv
  legacyEncoding: string | null
  timeoutSeconds: number
  /** Embedding/tests may shorten the foreground budget; tools keep the 10s default. */
  yieldTimeMs?: number
  kill: (child: ChildProcess | undefined) => void
  api: ToolExecutionApi
  context: Context
}

function outputFilePath(): string {
  const directory = resolve(tmpdir(), 'pi-web-shell')
  mkdirSync(directory, { recursive: true })
  return resolve(directory, `${Date.now()}-${randomUUID()}.log`)
}

/**
 * Run one shell command with streaming output, a retained tail, a full-output log, and codex-style
 * yielding: after `yieldTimeMs` a still-running command is promoted to a pollable session that
 * survives this call, and later turns read it through `shell_session`. Platform adapters supply the
 * executable, environment, legacy encoding, and process-tree killer.
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
    const ensureOutput = (): string => {
      if (outputPath !== undefined) return outputPath
      outputPath = outputFilePath()
      outputStream = createWriteStream(outputPath, { flags: 'a', mode: 0o600 })
      outputStream.on('error', () => undefined)
      return outputPath
    }

    const writeOutput = (text: string): void => {
      if (text === '') return
      if (!settled) {
        try {
          api.output(text)
        } catch {
          // The call may already be settled or aborted.
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

    const onAbort = (): void => {
      kill(child)
      if (settled) return
      settled = true
      clearTimers()
      context.abortSignal?.removeEventListener('abort', onAbort)
      closeOutput()
      rejectPromise(new Error('Command aborted'))
    }

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
     * Promote the still-running command into a session: it outlives this call, keeps streaming
     * into the spill file, and later turns poll it through `shell_session`.
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
      // A promoted command outlives this run; only the explicit timeout still bounds it.
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
        // The buffer only carries post-promotion output, but the byte budget counts the whole
        // command so a chatty first phase still spills instead of growing the buffer forever.
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
        // The call may already be settled.
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
        // stdin is a pipe so a promoted session can receive text through `shell_session`;
        // nothing is written by the runner itself, and non-interactive commands unaffected.
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

    if (timeoutMs > yieldTimeMs) {
      yieldTimer = setTimeout(promoteSession, yieldTimeMs)
    }
    context.abortSignal?.addEventListener('abort', onAbort, { once: true })

    spawned.stdout?.on('data', (chunk: Buffer) => {
      writeOutput(stdoutDecoder.write(chunk))
    })
    spawned.stderr?.on('data', (chunk: Buffer) => {
      writeOutput(stderrDecoder.write(chunk))
    })

    spawned.on('error', (error) => {
      resolvedSpawnError(error)
    })

    spawned.on('close', (code) => {
      const exitCode = code ?? -1
      if (settled && session !== undefined) {
        outputStream?.write(`\n[exited with code ${String(exitCode)}]\n`)
        settleSession(exitCode, false)
        return
      }
      if (settled) return

      // Flush a clipped multi-byte character before the retained output is read.
      const tailStdout = stdoutDecoder.end()
      const tailStderr = stderrDecoder.end()
      if (tailStdout !== '') {
        try {
          api.output(tailStdout)
        } catch {
          // The call may already be settled.
        }
      }
      if (tailStderr !== '') {
        try {
          api.output(tailStderr)
        } catch {
          // The call may already be settled.
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

/** Clamp a model-provided yield budget into the supported range; undefined keeps the default. */
export function clampYieldTime(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return YIELD_TIME_MS
  return Math.min(Math.max(Math.round(value), MIN_YIELD_TIME_MS), MAX_YIELD_TIME_MS)
}

/**
 * Wait until the session reports new output, exits, or the budget expires. Returns the incremental
 * text since the last read plus the terminal state; abort resolves with whatever is available
 * instead of killing the session, which outlives this call.
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
      // The process may have exited between the poll and the write.
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

/** Final state of a session as diagnostics, shared by the `shell_session` tool result. */
export function sessionDiagnostics(session: ShellSession): ToolExecutionResult['diagnostics'] {
  if (session.timedOut) {
    return [{ severity: 'error', code: 'timeout', message: `Command timed out after ${String(session.timeoutSeconds)} seconds` }]
  }
  if (session.exitCode !== null && session.exitCode !== 0) {
    return [{ severity: 'error', code: 'exit_code', message: `Command exited with code ${String(session.exitCode)}` }]
  }
  return undefined
}
