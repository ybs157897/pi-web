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
export const BACKGROUND_AFTER_MS = 15_000

export const SHELL_OUTPUT_SCHEMA = Type.Object({
  output: Type.String(),
  truncated: Type.Boolean(),
  fullOutputPath: Type.Optional(Type.String()),
  exitCode: Type.Number(),
  background: Type.Optional(Type.Boolean()),
})

const backgroundChildren = new Map<ChildProcess, (child: ChildProcess | undefined) => void>()

/** Stop every command that was moved to the background. Called when the server closes. */
export function disposeBackgroundShells(): void {
  for (const [child, kill] of backgroundChildren) kill(child)
  backgroundChildren.clear()
}

export interface ShellRunSpec {
  command: string
  program: string
  args: readonly string[]
  cwd: string
  env: NodeJS.ProcessEnv
  legacyEncoding: string | null
  timeoutSeconds: number
  /** Embedding/tests may shorten the foreground budget; tools keep the 15s default. */
  backgroundAfterMs?: number
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
 * Run one shell command with streaming output, a retained tail, a full-output log, automatic
 * backgrounding, and search-friendly exit semantics. Platform adapters supply the executable,
 * environment, legacy encoding, and process-tree killer.
 */
export async function runShellCommand(spec: ShellRunSpec): Promise<ToolExecutionResult> {
  const { api, context, command, kill } = spec
  const backgroundAfterMs = spec.backgroundAfterMs ?? BACKGROUND_AFTER_MS
  const timeoutMs = Math.round(spec.timeoutSeconds * 1_000)
  const stdoutDecoder = new LegacyAwareDecoder(spec.legacyEncoding)
  const stderrDecoder = new LegacyAwareDecoder(spec.legacyEncoding)
  let outputPath: string | undefined
  let outputStream: WriteStream | undefined
  let outputBytes = 0
  let child: ChildProcess | undefined
  let settled = false
  let backgrounded = false
  let timeoutTimer: NodeJS.Timeout | undefined
  let backgroundTimer: NodeJS.Timeout | undefined

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
      ensureOutput()
      outputBytes += Buffer.byteLength(text)
      if (outputStream !== undefined && !outputStream.writableEnded) outputStream.write(text)
    }

    const clearTimers = (): void => {
      if (timeoutTimer !== undefined) clearTimeout(timeoutTimer)
      if (backgroundTimer !== undefined) clearTimeout(backgroundTimer)
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

    const finishBackground = (): void => {
      if (settled) return
      const path = ensureOutput()
      settled = true
      backgrounded = true
      if (backgroundTimer !== undefined) clearTimeout(backgroundTimer)
      // A moved command outlives this run; only the explicit timeout still bounds it.
      context.abortSignal?.removeEventListener('abort', onAbort)
      if (child !== undefined) backgroundChildren.set(child, kill)
      const note = `\n[Command still running after ${backgroundAfterMs / 1_000}s; moved to background. Output: ${path}. Use read on that file to check progress.]\n`
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
          background: true,
        },
        diagnostics: [
          { severity: 'info', code: 'backgrounded', message: `Command moved to background. Output: ${path}` },
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
        stdio: ['ignore', 'pipe', 'pipe'],
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

    timeoutTimer = setTimeout(() => {
      kill(spawned)
      if (backgrounded) {
        outputStream?.write(`\n[timed out after ${String(spec.timeoutSeconds)}s]\n`)
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

    if (timeoutMs > backgroundAfterMs) {
      backgroundTimer = setTimeout(finishBackground, backgroundAfterMs)
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
      if (settled && backgrounded) {
        if (timeoutTimer !== undefined) clearTimeout(timeoutTimer)
        outputStream?.write(`\n[exited with code ${String(exitCode)}]\n`)
        outputStream?.end()
        backgroundChildren.delete(spawned)
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
