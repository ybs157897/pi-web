import { Type } from '@earendil-works/pi-ai'
import { defineTool, type ToolRegistration } from '@earendil-works/pi-durable'
import { RuntimeError } from '../../runtime-errors.ts'
import {
  MAX_OUTPUT_BYTES,
  MAX_OUTPUT_LINES,
  SESSION_OUTPUT_SCHEMA,
  YIELD_TIME_MS,
  readShellSession,
  sessionDiagnostics,
} from './runner.ts'

/**
 * The continuation of commands that outlived their `bash`/`pwsh` call: codex's `write_stdin`
 * surface with pi-web naming. Polling reads incremental output since the last read; an omitted
 * `stdin` polls without writing.
 */
export function createShellSessionTool(): ToolRegistration {
  return defineTool({
    name: 'shell_session',
    description: `续读或续写一个仍在运行的命令会话（\`sessionId\` 来自 bash/pwsh 的 \`status: "running"\` 结果）。省略 \`stdin\` 即纯轮询，返回自上次调用以来的增量输出与运行状态；进程已结束的轮次带最终退出码，之后会话即回收。\`sessionId\` 无效说明会话已不存在，读结果里的 \`fullOutputPath\` 可获取完整输出。`,
    parameters: Type.Object({
      sessionId: Type.String({ description: '要续读的会话 id（来自 bash/pwsh 的 running 结果）。' }),
      stdin: Type.Optional(Type.String({ description: '写入进程 stdin 的文本；省略即纯轮询。' })),
      yieldTimeMs: Type.Optional(Type.Number({ description: `本轮等待毫秒数（默认 ${String(YIELD_TIME_MS / 1_000)} 秒）；进程提前结束立即返回。` })),
    }),
    structuredOutputSchema: SESSION_OUTPUT_SCHEMA,
    outputLimits: { maxBytes: MAX_OUTPUT_BYTES, maxLines: MAX_OUTPUT_LINES, retain: 'tail' },
    execute: async (args, api, context) => {
      const read = await readShellSession(args.sessionId, args.stdin, args.yieldTimeMs, context)
      if (read === undefined) {
        throw new RuntimeError(
          'NOT_FOUND',
          `Session ${args.sessionId} does not exist. It either never ran here, already exited and was reclaimed, or the server restarted; read the original result's fullOutputPath for the complete output.`,
        )
      }
      const { session, delta } = read
      // The model only sees what `api.output()` retained; `structuredOutput` reaches codemode
      // programs only. Stream the delta there, mirroring how bash/pwsh stream their output.
      if (delta !== '') {
        try {
          api.output(delta)
        } catch {
          // The call may already be settled or aborted.
        }
      }
      // The final state is delivered exactly once: the session was reclaimed on read.
      const diagnostics = session.exited
        ? [
            ...(sessionDiagnostics(session) ?? []),
            ...(session.timedOut
              ? []
              : [{ severity: 'info' as const, code: 'session_reclaimed', message: `Session ${session.id} is complete and reclaimed (exit code: ${String(session.exitCode ?? -1)}).` }]),
          ]
        : sessionDiagnostics(session)
      return {
        structuredOutput: {
          output: delta,
          status: session.exited ? 'exited' : 'running',
          ...(session.exitCode !== null ? { exitCode: session.exitCode } : {}),
          sessionId: session.id,
          truncated: session.bufferTruncated,
          fullOutputPath: session.outputPath,
        },
        ...(session.exited ? { isError: session.exitCode !== 0 } : {}),
        diagnostics,
      }
    },
  })
}
