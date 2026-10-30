import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { realpath } from 'node:fs/promises'
import { resolve } from 'node:path'
import iconv from 'iconv-lite'
import { Type } from '@earendil-works/pi-ai'
import { defineTool, type ToolRegistration } from '@earendil-works/pi-durable'
import { createPowerShellTool } from '@earendil-works/pi-durable/tools'
import { RuntimeError } from './runtime-errors.ts'
import {
  commandTimeout,
  DEFAULT_COMMAND_TIMEOUT_SECONDS,
  powershellQuote,
  resolveWorkdir,
} from './shell-common.ts'
import {
  BACKGROUND_AFTER_MS,
  MAX_OUTPUT_BYTES,
  MAX_OUTPUT_LINES,
  runShellCommand,
  SHELL_OUTPUT_SCHEMA,
} from './shell-runner.ts'

const LEGACY_ENCODING_ENV = 'PI_WEB_WINDOWS_OUTPUT_ENCODING'

const basePwsh = createPowerShellTool()

let cachedPowerShell: string | null | undefined
let cachedLegacyEncoding: string | null | undefined

export function resetWindowsShellCachesForTests(): void {
  cachedPowerShell = undefined
  cachedLegacyEncoding = undefined
}

/**
 * A recursive enumeration piped into Select-String is the slow path this tool exists to avoid:
 * it walks generated trees and materializes a MatchInfo per hit. The grep tool runs ripgrep.
 */
export function isBlockedRecursiveSearch(command: string): boolean {
  if (!/\b(?:Get-ChildItem|gci|ls|dir)\b[^\n;]*?\s-(?:Recurse|r)\b/i.test(command)) return false
  const select = /\b(?:Select-String|sls)\b/i.exec(command)
  if (select === null) return false
  const pipe = command.indexOf('|')
  return pipe !== -1 && select.index > pipe
}

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
    // Fall through to the locale heuristic.
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

function killProcessTree(child: ChildProcess | undefined): void {
  const pid = child?.pid
  if (pid === undefined) return
  if (process.platform === 'win32') {
    try {
      const killer = spawn('taskkill', ['/F', '/T', '/PID', String(pid)], { stdio: 'ignore', windowsHide: true })
      killer.on('error', () => undefined)
    } catch {
      // The process may already be gone.
    }
    return
  }
  try {
    child?.kill('SIGKILL')
  } catch {
    // The process may already be gone.
  }
}

export function createWindowsPowerShellTool(): ToolRegistration {
  return defineTool({
    name: 'pwsh',
    description: `Execute a PowerShell command (\`pwsh\`, falling back to Windows PowerShell) and return its stdout/stderr. Each call runs in a fresh process; pass \`workdir\` instead of using \`Set-Location\`. Provide \`description\` before \`command\` in the arguments. Before any delete or move, verify the resolved absolute target path is the intended one; never run it against a computed path you have not checked, and guard path variables so an unset value cannot widen the target. Do not run dev servers, watch modes or interactive programs in the foreground; they hold the call until the timeout. Prefer one-shot forms and non-interactive flags (for example \`vitest run\`, \`tsc --noEmit\`, \`git commit -m\`). Use the grep tool (native ripgrep) for content search and glob for file discovery; do not use \`Select-String\`, \`findstr /s\`, or recursive \`Get-ChildItem\` for workspace-wide search. Recursive \`Get-ChildItem ... | Select-String\` is blocked. Commands still running after ${BACKGROUND_AFTER_MS / 1_000}s are moved to the background and their output is saved to a file; use read on that path to check progress. Long output is truncated to its tail and the full output is saved to a temp file.`,
    parameters: Type.Object({
      command: Type.String({ description: 'PowerShell command to execute' }),
      description: Type.Optional(Type.String({ description: 'Clear, concise description of what this command does in active voice, 5-10 words.' })),
      workdir: Type.Optional(Type.String({ description: 'Working directory for this command. Defaults to the session workspace; a relative path resolves against it.' })),
      timeout: Type.Optional(Type.Number({ description: `Timeout in seconds (default ${DEFAULT_COMMAND_TIMEOUT_SECONDS}). Pass a larger value for long builds or test suites.` })),
    }),
    structuredOutputSchema: SHELL_OUTPUT_SCHEMA,
    outputLimits: { maxBytes: MAX_OUTPUT_BYTES, maxLines: MAX_OUTPUT_LINES, retain: 'tail' },
    execute: async (args, api, context) => {
      if (isBlockedRecursiveSearch(args.command)) {
        throw new RuntimeError(
          'FORBIDDEN',
          'Blocked: recursive Get-ChildItem piped into Select-String is slow and can silently scan generated trees. Use the grep tool (native ripgrep) instead, for example grep({ pattern: "canTransferSite", path: "module", include: "*.java" }).',
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

      // A remote or otherwise non-local environment keeps the platform tool's execution model.
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
        kill: killProcessTree,
        api,
        context,
      })
    },
  })
}
