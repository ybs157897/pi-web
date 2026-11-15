import { Type } from '@earendil-works/pi-ai'
import { defineExtension, defineTool, type Extension, type ToolRegistration } from '@earendil-works/pi-durable'
import { createBashTool, createEditTool, createReadTool, createWriteTool } from '@earendil-works/pi-durable/tools'
import { executePosixBash } from './posix.ts'
import { DEFAULT_COMMAND_TIMEOUT_SECONDS } from './common.ts'
import { MAX_YIELD_TIME_MS, MIN_YIELD_TIME_MS, SHELL_OUTPUT_SCHEMA, YIELD_TIME_MS } from './runner.ts'
import { createShellSessionTool } from './session.ts'
import { createWindowsPowerShellTool } from './windows.ts'

export { commandTimeout, DEFAULT_COMMAND_TIMEOUT_SECONDS } from './common.ts'

const baseBash = createBashTool()

const FOREGROUND_RULE = '不要在前台运行开发服务器、监听模式或交互式程序；它们会占住调用直到超时。优先使用单次执行方式和非交互参数（例如 `vitest run`、`tsc --noEmit`、`git commit -m`）。'
const TIMEOUT_PARAMETER = Type.Optional(Type.Number({ description: `超时秒数（默认 ${DEFAULT_COMMAND_TIMEOUT_SECONDS}），命令的总时限，到点终止进程。长时间构建或测试套件可传更大的值。` }))
const YIELD_PARAMETER = Type.Optional(Type.Number({ description: `前台等待毫秒数（默认 ${String(YIELD_TIME_MS)}，范围 ${String(MIN_YIELD_TIME_MS)}–${String(MAX_YIELD_TIME_MS)}）。到点仍未结束会返回 \`sessionId\` 并转入会话轮询。` }))
const YIELD_RULE = `命令默认等待 ${String(YIELD_TIME_MS / 1_000)} 秒（\`yieldTimeMs\` 可调整）；仍未结束时返回 \`sessionId\` 与已有输出，命令继续运行，用 \`shell_session\` 读取增量输出或写入 stdin。\`timeout\` 是总时限，到点终止进程。`

/**
 * Pi's bash tool plus `workdir` and `description`. The local executor keeps the same output
 * contract while adding the workspace write sandbox, codex-style yielding with pollable
 * sessions, and search-friendly exit semantics.
 */
const bashTool = defineTool({
  ...baseBash,
  description: `执行 bash 命令，返回 stdout/stderr。优先使用专用工具：内容检索用 grep，查找文件用 glob，已知路径读取用 read，定点编辑用 edit。不要用 \`grep -r\`、\`rg\`、\`find\` 或递归 \`ls\` 搜索整个工作区。每次调用都启动新的 shell；传入 \`workdir\`，不要用 \`cd\`。参数中先提供 \`description\`，再提供 \`command\`。删除或移动前，确认解析后的绝对目标路径符合预期；不要操作未经核实的计算路径，并保护路径变量，避免未设置的值扩大操作范围。${FOREGROUND_RULE} ${YIELD_RULE} 长输出仅保留末尾，完整输出保存到临时文件。继续前先检查退出码。`,
  parameters: Type.Object({
    command: Type.String({ description: '要执行的 Bash 命令。' }),
    description: Type.Optional(Type.String({ description: '用主动表达简洁说明命令的作用，约 5–10 个词。' })),
    workdir: Type.Optional(Type.String({ description: '命令的工作目录，默认使用会话工作区；相对路径以工作区为基准解析。' })),
    timeout: TIMEOUT_PARAMETER,
    yieldTimeMs: YIELD_PARAMETER,
  }),
  structuredOutputSchema: SHELL_OUTPUT_SCHEMA,
  execute: executePosixBash,
})

const pwshTool = createWindowsPowerShellTool()
const shellSessionTool = createShellSessionTool()

/**
 * The same tool surface as Pi's `coding-tools`, matching DSH's platform split:
 * Windows gets native `pwsh` only; other platforms get `bash` only. `shell_session`
 * continues commands either shell promoted after its yield budget.
 */
export function createCodingTools(platform: NodeJS.Platform = process.platform): Extension {
  const tools: ToolRegistration[] = [createReadTool(), createWriteTool(), createEditTool()]
  tools.push(platform === 'win32' ? pwshTool : bashTool)
  tools.push(shellSessionTool)
  return defineExtension({ name: 'coding-tools', tools })
}

export const CodingTools = createCodingTools()
