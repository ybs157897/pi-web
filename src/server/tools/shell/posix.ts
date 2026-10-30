import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { realpath } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { Context } from '@earendil-works/chord/context'
import type { ToolExecutionApi, ToolExecutionResult } from '@earendil-works/pi-durable'
import { createBashTool } from '@earendil-works/pi-durable/tools'
import iconv from 'iconv-lite'
import { localShellSpawn } from '../../conversation/execution-env.ts'
import { RuntimeError } from '../../runtime-errors.ts'
import { commandTimeout, resolveWorkdir, shellQuote, withNoMatchSuccess } from './common.ts'
import { runShellCommand } from './runner.ts'

const baseBash = createBashTool()

const WRAPPERS = new Set(['sudo', 'doas', 'command', 'env', 'time', 'nice', 'nohup', 'stdbuf', 'exec', 'xargs'])
const RECURSIVE_FLAG = /^(?:-[A-Za-z]*[rR][A-Za-z]*|--recursive|--dereference-recursive)$/

function stripQuoted(command: string): string {
  return command.replace(/'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"/g, ' ')
}

function commandSegments(command: string): string[] {
  return stripQuoted(command)
    .split(/\|\||&&|[|;\n\r]/)
    .map(segment => segment.trim())
    .filter(segment => segment !== '')
}

function commandName(token: string): string | undefined {
  const name = token.split(/[\\/]/).pop()?.toLowerCase()
  return name === undefined || name === '' ? undefined : name
}

/**
 * Recursive `grep`/`rg` in the shell bypasses the grep tool's workspace boundary, output
 * limits, and secret-file filters. `find -exec grep` and `find | xargs grep` are the same
 * bulk-search path. A quoted mention (for example in `echo`) is not a command.
 */
export function isBlockedShellSearch(command: string): boolean {
  for (const segment of commandSegments(command)) {
    const tokens = segment.split(/\s+/).filter(token => token !== '')
    let index = 0
    let viaXargs = false
    while (index < tokens.length) {
      const wrapper = commandName(tokens[index]!)
      if (wrapper === undefined || !WRAPPERS.has(wrapper)) break
      if (wrapper === 'xargs') viaXargs = true
      index += 1
      while (index < tokens.length && tokens[index]!.startsWith('-')) index += 1
    }

    const name = index < tokens.length ? commandName(tokens[index]!) : undefined
    if (name === undefined) continue
    const isSearch = name === 'grep' || name === 'egrep' || name === 'fgrep' || name === 'rg' || name === 'rgrep'
    if (viaXargs && isSearch) return true
    if (name === 'rg' || name === 'rgrep') return true
    if (name === 'grep' || name === 'egrep' || name === 'fgrep') {
      const args = tokens.slice(index + 1)
      if (args.some(arg => RECURSIVE_FLAG.test(arg))) return true
      if (args.some((arg, position) => arg === '-d' && args[position + 1] === 'recurse')) return true
    }
    if (name === 'find') {
      const execIndex = tokens.findIndex(token => token === '-exec' || token === '-execdir')
      if (execIndex >= 0) {
        const inner = tokens.slice(execIndex + 1).map(commandName)
        if (inner.some(token => token === 'grep' || token === 'egrep' || token === 'fgrep' || token === 'rg')) return true
      }
    }
  }
  return false
}

/** The shell the platform bash tool uses: bash when present, otherwise the user shell. */
export function resolvePosixShell(): string {
  if (existsSync('/bin/bash')) return '/bin/bash'
  const configured = process.env.SHELL?.trim()
  if (configured && existsSync(configured)) return configured
  return '/bin/sh'
}

/**
 * POSIX output is usually UTF-8, but a macOS GUI/remote host can inherit C/POSIX (which makes
 * `ls`/`wc` replace non-ASCII with `??`) and a user locale can name another codeset. Set a UTF-8
 * locale when the inherited one is unusable, and keep the codeset as the decoder fallback.
 */
export function resolvePosixEnv(): { env: NodeJS.ProcessEnv; legacyEncoding: string | null } {
  const env: NodeJS.ProcessEnv = { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' }
  const fallback = process.platform === 'darwin' ? 'en_US.UTF-8' : 'C.UTF-8'
  const unusable = (value: string | undefined): boolean =>
    value === undefined || value.trim() === '' || /^(?:C|POSIX)$/i.test(value.trim())

  if (unusable(env.LANG)) env.LANG = fallback
  if (unusable(env.LC_CTYPE)) env.LC_CTYPE = fallback
  if (env.LC_ALL !== undefined && unusable(env.LC_ALL)) env.LC_ALL = fallback

  const locale = env.LC_ALL ?? env.LC_CTYPE ?? env.LANG ?? ''
  const codeset = /\.([^@]+)$/.exec(locale)?.[1]?.trim()
  const legacyEncoding = codeset !== undefined && !/utf-?8/i.test(codeset) && iconv.encodingExists(codeset)
    ? codeset
    : null
  return { env, legacyEncoding }
}

export function killPosixTree(child: ChildProcess | undefined): void {
  const pid = child?.pid
  if (pid === undefined) return
  try {
    // The runner starts detached, so the child is a process-group leader.
    process.kill(-pid, 'SIGKILL')
  } catch {
    try {
      child?.kill('SIGKILL')
    } catch {
      // The process may already be gone.
    }
  }
}

/**
 * Execute the POSIX bash tool. Foreground calls keep the workspace write sandbox; the same
 * sandboxed invocation is used when a long command is moved to the background.
 */
export async function executePosixBash(
  args: { command: string; workdir?: string; timeout?: number },
  api: ToolExecutionApi,
  context: Context,
): Promise<ToolExecutionResult> {
  if (isBlockedShellSearch(args.command)) {
    throw new RuntimeError(
      'FORBIDDEN',
      'Blocked: recursive grep/rg in the shell bypasses the grep tool workspace policy, output limits, and secret-file filtering. Use the grep tool instead, for example grep({ pattern, path, include }).',
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

  if (api.env === undefined || api.env.id !== 'node:local') {
    const command = workdir === root ? args.command : `cd -- ${shellQuote(workdir)} && ${args.command}`
    const result = await baseBash.execute({ command, timeout: timeoutSeconds }, api, context)
    return withNoMatchSuccess(result, args.command)
  }

  const { env, legacyEncoding } = resolvePosixEnv()
  const spawnSpec = localShellSpawn(api.env, args.command, resolvePosixShell())
  return await runShellCommand({
    command: args.command,
    program: spawnSpec.file,
    args: spawnSpec.args,
    cwd: workdir,
    env,
    legacyEncoding,
    timeoutSeconds,
    kill: killPosixTree,
    api,
    context,
  })
}
