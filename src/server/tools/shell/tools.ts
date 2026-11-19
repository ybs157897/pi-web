import { Type } from '@earendil-works/pi-ai'
import { defineExtension, defineTool, type Extension, type ToolRegistration } from '@earendil-works/pi-durable'
import { createBashTool, createEditTool, createReadTool, createWriteTool } from '@earendil-works/pi-durable/tools'
import { workbenchFileEnv } from '../../conversation/execution-env.ts'
import { executePosixBash } from './posix.ts'
import { DEFAULT_COMMAND_TIMEOUT_SECONDS } from './common.ts'
import { MAX_YIELD_TIME_MS, MIN_YIELD_TIME_MS, SHELL_OUTPUT_SCHEMA, YIELD_TIME_MS } from './runner.ts'
import { createShellSessionTool } from './session.ts'
import { createWindowsPowerShellTool } from './windows.ts'

export { commandTimeout, DEFAULT_COMMAND_TIMEOUT_SECONDS } from './common.ts'

/** Pi 内置 bash 工具的原始定义，仅作为 bashTool 展开覆盖的基底。 */
const baseBash = createBashTool()

/** 禁止前台长驻进程的行为规则文本，拼进 bash/pwsh 工具描述。 */
const FOREGROUND_RULE = '不要在前台运行开发服务器、监听模式或交互式程序；它们会占住调用直到超时。优先使用单次执行方式和非交互参数（例如 `vitest run`、`tsc --noEmit`、`git commit -m`）。'
/** `timeout` 参数 schema：可选正整数秒数，命令总时限，到点终止进程。 */
const TIMEOUT_PARAMETER = Type.Optional(Type.Number({ description: `超时秒数（默认 ${DEFAULT_COMMAND_TIMEOUT_SECONDS}），命令的总时限，到点终止进程。长时间构建或测试套件可传更大的值。` }))
/** `yieldTimeMs` 参数 schema：可选前台等待毫秒数，超过后转入会话轮询。 */
const YIELD_PARAMETER = Type.Optional(Type.Number({ description: `前台等待毫秒数（默认 ${String(YIELD_TIME_MS)}，范围 ${String(MIN_YIELD_TIME_MS)}–${String(MAX_YIELD_TIME_MS)}）。到点仍未结束会返回 \`sessionId\` 并转入会话轮询。` }))
/** 让渡（yield）机制的行为规则文本：到点未结束返回 sessionId，命令转入 shell_session 续接。 */
const YIELD_RULE = `命令默认等待 ${String(YIELD_TIME_MS / 1_000)} 秒（\`yieldTimeMs\` 可调整）；仍未结束时返回 \`sessionId\` 与已有输出，命令继续运行，用 \`shell_session\` 读取增量输出或写入 stdin。\`timeout\` 是总时限，到点终止进程。`

/**
 * 功能：bash 命令执行工具，基于 Pi 内置 bash 工具扩展出 `workdir`、`description` 参数。
 * 内部逻辑：输出契约与 Pi 保持一致，新增工作区写沙箱、codex 风格的让让（yield）机制
 * （超时未结束返回 sessionId 转入可轮询会话）以及对检索友好的退出码语义。
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

/** 记录 Pi 实际读写的绝对路径，包括 read 找到的 Unicode 文件名变体。 */
function withWorkbenchFileRoot(tool: ToolRegistration): ToolRegistration {
  return {
    ...tool,
    async execute(args, api, context) {
      const env = workbenchFileEnv(api.env)
      if (env === undefined) return tool.execute(args, api, context)

      let resolvedPath: string | undefined
      const openBinaryReader = env.openBinaryReader.bind(env)
      env.openBinaryReader = (path, options, ctx) => {
        resolvedPath = path
        return openBinaryReader(path, options, ctx)
      }
      const writeFile = env.writeFile.bind(env)
      env.writeFile = (path, content, ctx) => {
        resolvedPath = path
        return writeFile(path, content, ctx)
      }
      const result = await tool.execute(args, { ...api, env }, context)
      if (resolvedPath === undefined || result.isError) return result
      const details = result.details
      return {
        ...result,
        details: { ...(details && typeof details === 'object' && !Array.isArray(details) ? details : {}), resolvedPath },
      }
    },
  }
}

/**
 * 功能：装配 coding-tools 工具扩展，工具面与 Pi 内置 `coding-tools` 一致，并按 DSH 的平台
 * 划分：Windows 只装原生 `pwsh`，其他平台只装 `bash`。
 * 内部逻辑：先装 read/write/edit 三个文件工具，再按平台装 shell 工具，最后统一加上
 * `shell_session`——它是任一 shell 工具让渡超时后继续命令的入口。本扩展不贡献 section。
 * @param platform 目标平台标识，默认取当前进程平台；仅 `win32` 会切换到 pwsh。
 * @returns 名为 `coding-tools` 的扩展，包含 read、write、edit、shell、shell_session 五个工具。
 */
export function createCodingTools(platform: NodeJS.Platform = process.platform): Extension {
  const tools = [createReadTool(), createWriteTool(), createEditTool()].map(withWorkbenchFileRoot)
  tools.push(platform === 'win32' ? pwshTool : bashTool)
  tools.push(shellSessionTool)
  return defineExtension({ name: 'coding-tools', tools })
}

/** 默认按当前进程平台预装配好的 coding-tools 扩展实例。 */
export const CodingTools = createCodingTools()
