import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { realpath } from 'node:fs/promises'
import { resolve } from 'node:path'
import iconv from 'iconv-lite'
import { Type } from '@earendil-works/pi-ai'
import { defineTool, type ToolRegistration } from '@earendil-works/pi-durable'
import { createPowerShellTool } from '@earendil-works/pi-durable/tools'
import { RuntimeError } from '../../runtime-errors.ts'
import {
  commandTimeout,
  DEFAULT_COMMAND_TIMEOUT_SECONDS,
  powershellQuote,
  resolveWorkdir,
} from './common.ts'
import {
  MAX_OUTPUT_BYTES,
  MAX_OUTPUT_LINES,
  MAX_YIELD_TIME_MS,
  MIN_YIELD_TIME_MS,
  runShellCommand,
  SHELL_OUTPUT_SCHEMA,
  YIELD_TIME_MS,
} from './runner.ts'

/** 覆盖旧编码探测结果的环境变量名（值须为 iconv-lite 支持的编码名）。 */
const LEGACY_ENCODING_ENV = 'PI_WEB_WINDOWS_OUTPUT_ENCODING'

/** Pi 内置 PowerShell 工具的原始定义，非本地环境时委托执行用。 */
const basePwsh = createPowerShellTool()

/** pwsh/powershell 可执行路径缓存（null 表示探测过且回落到 PATH 名称）。 */
let cachedPowerShell: string | null | undefined
/** Windows 输出旧编码缓存（null 表示无遗留编码）。 */
let cachedLegacyEncoding: string | null | undefined

/**
 * 功能：清空 pwsh 路径与旧编码的模块级缓存，供测试隔离环境差异。
 */
export function resetWindowsShellCachesForTests(): void {
  cachedPowerShell = undefined
  cachedLegacyEncoding = undefined
}

/**
 * 功能：拦截"递归枚举管道进 Select-String"这一本工具要规避的慢路径：它会遍历生成目录
 * 并为每个命中物化一个 MatchInfo；grep 工具走的是原生 ripgrep。
 * 内部逻辑：先匹配递归 Get-ChildItem/gci/ls/dir -Recurse/-r，再要求 Select-String/sls
 * 出现在管道符 `|` 之后。
 * @param command 完整命令文本。
 * @returns 命中拦截规则时 true。
 */
export function isBlockedRecursiveSearch(command: string): boolean {
  if (!/\b(?:Get-ChildItem|gci|ls|dir)\b[^\n;]*?\s-(?:Recurse|r)\b/i.test(command)) return false
  const select = /\b(?:Select-String|sls)\b/i.exec(command)
  if (select === null) return false
  const pipe = command.indexOf('|')
  return pipe !== -1 && select.index > pipe
}

/**
 * 功能：把用户命令包进一段 PowerShell 包装脚本再执行。
 * 内部逻辑：错误偏好 Continue（不让非终止错误中断管道）；把控制台/管道输出编码设为
 * UTF-8 并尝试 chcp 65001；`$LASTEXITCODE` 初始化为 0，命令结束后若为非 0 则以它作为
 * 进程退出码，让退出码语义可被 runner 捕获。
 * @param command 用户要执行的 PowerShell 命令。
 * @returns 完整包装脚本文本。
 */
export function buildPowerShellScript(command: string): string {
  return [
    "$ErrorActionPreference='Continue'",
    'try { [Console]::OutputEncoding=[System.Text.Encoding]::UTF8; $OutputEncoding=[System.Text.Encoding]::UTF8 } catch {}',
    'try { & chcp.com 65001 *> $null } catch {}',
    '$global:LASTEXITCODE = 0',
    command,
    '$__pi_code = $LASTEXITCODE',
    'if ($null -ne $__pi_code -and $__pi_code -ne 0) { exit $__pi_code }',
  ].join('\n')
}

/**
 * 功能：解析 PowerShell 可执行路径（带模块级缓存）。
 * 内部逻辑：优先 `PI_WEB_PWSH_PATH` 环境变量；否则用 `where.exe pwsh.exe` 探测（2 秒
 * 超时，非 Windows 或 where.exe 缺失时静默跳过）；最后回落 System32 下的 Windows
 * PowerShell（存在时用绝对路径，否则直接 `powershell.exe` 交给 PATH）。
 * @returns PowerShell 可执行路径。
 */
export function resolvePowerShell(): string {
  if (cachedPowerShell !== null && cachedPowerShell !== undefined) return cachedPowerShell
  const configured = process.env.PI_WEB_PWSH_PATH?.trim()
  if (configured) {
    cachedPowerShell = configured
    return configured
  }
  try {
    const found = spawnSync('where.exe', ['pwsh.exe'], { encoding: 'utf8', windowsHide: true, timeout: 2_000 })
    const first = found.stdout?.split(/\r?\n/).map(line => line.trim()).find(line => line !== '')
    if (found.status === 0 && first !== undefined) {
      cachedPowerShell = first
      return first
    }
  } catch {
    // Not on Windows, or where.exe is unavailable.
  }
  const system = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'
  cachedPowerShell = process.platform === 'win32' && existsSync(system) ? system : 'powershell.exe'
  return cachedPowerShell
}

/**
 * 功能：探测 Windows 控制台输出的旧编码（带模块级缓存）。
 * 内部逻辑：优先读 PI_WEB_WINDOWS_OUTPUT_ENCODING 覆盖（须为 iconv 支持的编码）；否则
 * 用 `chcp` 取代码页——非 65001 且 iconv 支持对应 `cpNNN` 时采用；代码页探测失败或为
 * UTF-8 时按 locale 启发式回落（中文 gb18030、日文 cp932、韩文 cp949、俄文 cp866，
 * 其余 cp437）；结果须被 iconv 支持，否则返回 null。
 * @returns 旧编码名（iconv-lite 可用）或 null 表示无回退。
 */
export function resolveLegacyEncoding(): string | null {
  if (cachedLegacyEncoding !== undefined) return cachedLegacyEncoding
  const override = process.env[LEGACY_ENCODING_ENV]?.trim()
  if (override) {
    cachedLegacyEncoding = iconv.encodingExists(override) ? override : null
    return cachedLegacyEncoding
  }

  let codePage: string | undefined
  try {
    const result = spawnSync(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', 'chcp'], {
      encoding: 'utf8',
      timeout: 1_000,
      windowsHide: true,
    })
    codePage = result.stdout?.match(/(\d{3,5})/)?.[1]
  } catch {
    // 失败则继续走 locale 启发式判断。
  }
  if (codePage !== undefined && codePage !== '65001') {
    const candidate = `cp${codePage}`
    if (iconv.encodingExists(candidate)) {
      cachedLegacyEncoding = candidate
      return candidate
    }
  }

  const locale = [
    process.env.LC_ALL,
    process.env.LC_CTYPE,
    process.env.LANG,
    Intl.DateTimeFormat().resolvedOptions().locale,
  ].filter(value => value !== undefined && value !== '').join(' ').toLowerCase()
  const fallback = /(zh|chinese|cn|hans|hant)/.test(locale) ? 'gb18030'
    : /(ja|japanese|jp)/.test(locale) ? 'cp932'
      : /(ko|korean|kr)/.test(locale) ? 'cp949'
        : /(ru|russian)/.test(locale) ? 'cp866'
          : 'cp437'
  cachedLegacyEncoding = iconv.encodingExists(fallback) ? fallback : null
  return cachedLegacyEncoding
}

/**
 * 功能：终止 PowerShell 命令的整个进程树。
 * 内部逻辑：Windows 上用 `taskkill /F /T` 强制杀整棵树（启动失败静默忽略，进程可能
 * 已退出）；非 Windows（测试环境）直接对子进程发 SIGKILL。
 * @param child 由 runner 启动的子进程，可能为 undefined。
 */
function killProcessTree(child: ChildProcess | undefined): void {
  const pid = child?.pid
  if (pid === undefined) return
  if (process.platform === 'win32') {
    try {
      const killer = spawn('taskkill', ['/F', '/T', '/PID', String(pid)], { stdio: 'ignore', windowsHide: true })
      killer.on('error', () => undefined)
    } catch {
      // 进程可能已经退出。
    }
    return
  }
  try {
    child?.kill('SIGKILL')
  } catch {
    // 进程可能已经退出。
  }
}

/**
 * 功能：创建 Windows 专用 `pwsh` 工具，优先 pwsh、回退 Windows PowerShell。
 * 输入校验：拦截"递归 Get-ChildItem | Select-String"（FORBIDDEN）；会话无工作区抛
 * UNSUPPORTED；timeout 必须为正数（INVALID_INPUT）。
 * 边界：workdir 经 resolveWorkdir 限制在工作区内；长输出受 outputLimits（字节/行数上限，
 * 保留尾部）约束；让渡超时后转 shell_session。非本地环境委托 Pi 平台 PowerShell 工具
 * （必要时拼 Set-Location 前缀）；本地环境用 buildPowerShellScript 包装脚本执行。
 * @returns 可注册的 `pwsh` 工具定义。
 */
export function createWindowsPowerShellTool(): ToolRegistration {
  return defineTool({
    name: 'pwsh',
    description: `执行 PowerShell 命令（优先 \`pwsh\`，回退到 Windows PowerShell），返回 stdout/stderr。每次调用都启动新进程；传入 \`workdir\`，不要用 \`Set-Location\`。参数中先提供 \`description\`，再提供 \`command\`。删除或移动前，确认解析后的绝对目标路径符合预期；不要操作未经核实的计算路径，并保护路径变量，避免未设置的值扩大操作范围。不要在前台运行开发服务器、监听模式或交互式程序；它们会占住调用直到超时。优先使用单次执行方式和非交互参数（例如 \`vitest run\`、\`tsc --noEmit\`、\`git commit -m\`）。内容检索用 grep 工具（原生 ripgrep），查找文件用 glob；不要用 \`Select-String\`、\`findstr /s\` 或递归 \`Get-ChildItem\` 搜索整个工作区。递归 \`Get-ChildItem ... | Select-String\` 会被拦截。命令默认等待 ${String(YIELD_TIME_MS / 1_000)} 秒（\`yieldTimeMs\` 可调整）；仍未结束时返回 \`sessionId\` 与已有输出，命令继续运行，用 \`shell_session\` 读取增量输出或写入 stdin。\`timeout\` 是总时限，到点终止进程。长输出仅保留末尾，完整输出保存到临时文件。`,
    parameters: Type.Object({
      command: Type.String({ description: '要执行的 PowerShell 命令。' }),
      description: Type.Optional(Type.String({ description: '用主动表达简洁说明命令的作用，约 5–10 个词。' })),
      workdir: Type.Optional(Type.String({ description: '命令的工作目录，默认使用会话工作区；相对路径以工作区为基准解析。' })),
      timeout: Type.Optional(Type.Number({ description: `超时秒数（默认 ${DEFAULT_COMMAND_TIMEOUT_SECONDS}），命令的总时限，到点终止进程。长时间构建或测试套件可传更大的值。` })),
      yieldTimeMs: Type.Optional(Type.Number({ description: `前台等待毫秒数（默认 ${String(YIELD_TIME_MS)}，范围 ${String(MIN_YIELD_TIME_MS)}–${String(MAX_YIELD_TIME_MS)}）。到点仍未结束会返回 \`sessionId\` 并转入会话轮询。` })),
    }),
    structuredOutputSchema: SHELL_OUTPUT_SCHEMA,
    outputLimits: { maxBytes: MAX_OUTPUT_BYTES, maxLines: MAX_OUTPUT_LINES, retain: 'tail' },
    /**
     * 功能：执行 PowerShell 命令。
     * 输入校验：先拦截递归 Select-String 管道，再校验工作区存在与 timeout 为正。
     * 内部逻辑：workdir 限制在工作区内；非本地环境委托平台工具；本地环境以
     * `-NoProfile -NonInteractive -ExecutionPolicy Bypass -Command` 运行包装脚本，
     * 交给 runShellCommand（含旧编码回退、让渡超时、进程树终止）。
     */
    execute: async (args, api, context) => {
      if (isBlockedRecursiveSearch(args.command)) {
        throw new RuntimeError(
          'FORBIDDEN',
          '已拦截：递归 Get-ChildItem 经管道传给 Select-String 速度慢，还可能静默扫描生成目录。请改用 grep 工具（原生 ripgrep），例如 grep({ pattern: "canTransferSite", path: "module", include: "*.java" })。',
        )
      }

      const cwd = api.env?.cwd
      if (typeof cwd !== 'string' || cwd.trim() === '') {
        throw new RuntimeError('UNSUPPORTED', 'This conversation has no workspace directory.')
      }
      const timeoutSeconds = commandTimeout(args.timeout)
      if (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0) {
        throw new RuntimeError('INVALID_INPUT', 'timeout must be a positive number of seconds.')
      }

      const root = await realpath(cwd).catch(() => resolve(cwd))
      const workdir = await resolveWorkdir(root, args.workdir)

      // 远程或其他非本地环境沿用平台工具自身的执行模型。
      if (api.env === undefined || api.env.id !== 'node:local') {
        const command = workdir === root
          ? args.command
          : `Set-Location -LiteralPath ${powershellQuote(workdir)}\n${args.command}`
        return await basePwsh.execute({ command, timeout: timeoutSeconds }, api, context)
      }

      return await runShellCommand({
        command: args.command,
        program: resolvePowerShell(),
        args: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', buildPowerShellScript(args.command)],
        cwd: workdir,
        env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
        legacyEncoding: resolveLegacyEncoding(),
        timeoutSeconds,
        yieldTimeMs: args.yieldTimeMs,
        kill: killProcessTree,
        api,
        context,
      })
    },
  })
}
