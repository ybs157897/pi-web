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
 * 功能：创建 `shell_session` 工具——在 `bash`/`pwsh` 调用让渡超时后继续命令的入口，
 * 即 codex `write_stdin` 面板在 pi-web 下的命名版本。
 * 输入校验：`sessionId` 必须对应仍存在的会话；无效（从未运行、已退出回收或服务重启）
 * 抛 NOT_FOUND RuntimeError，并提示改读原结果里的 `fullOutputPath`。
 * 边界：省略 `stdin` 即纯轮询不写入；增量输出受 outputLimits（字节/行数上限，保留尾部）约束。
 * @returns 可注册的 `shell_session` 工具定义。
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
    /**
     * 功能：续读/续写 shell 会话。
     * 内部逻辑：经 readShellSession 读取增量（可先写 stdin）；会话不存在抛 NOT_FOUND。
     * 增量经 api.output 流式给模型（调用可能已结算或中止，静默吞错）；structuredOutput
     * 只供 codemode 程序使用。进程已结束时带最终退出码、isError 与 session_reclaimed
     * 诊断——最终状态只送一次，因为读取即回收会话。
     */
    execute: async (args, api, context) => {
      const read = await readShellSession(args.sessionId, args.stdin, args.yieldTimeMs, context)
      if (read === undefined) {
        throw new RuntimeError(
          'NOT_FOUND',
          `Session ${args.sessionId} does not exist. It either never ran here, already exited and was reclaimed, or the server restarted; read the original result's fullOutputPath for the complete output.`,
        )
      }
      const { session, delta } = read
      // 模型只能看到 `api.output()` 保留的内容；structuredOutput 只触达 codemode
      // 程序。增量在那里流式输出，与 bash/pwsh 流式输出的方式保持一致。
      if (delta !== '') {
        try {
          api.output(delta)
        } catch {
          // 调用可能已经结算或中止。
        }
      }
      // 最终状态只送达一次：读取即回收会话。
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
