import { lstat, realpath } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { RuntimeError } from '../../runtime-errors.ts'

/** Bounds a call that sets no timeout, so a server or watcher started in the foreground cannot hold it forever. */
export const DEFAULT_COMMAND_TIMEOUT_SECONDS = 300

export function commandTimeout(seconds: number | undefined): number {
  return seconds ?? DEFAULT_COMMAND_TIMEOUT_SECONDS
}

/** POSIX single-quoted string: only the quote itself is escaped. */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

/** PowerShell single-quoted string: only the quote itself is doubled. */
export function powershellQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`
}

/** Resolve one call's working directory, keeping it inside the bound workspace. */
export async function resolveWorkdir(cwd: string, value: unknown): Promise<string> {
  if (value === undefined) return cwd
  if (typeof value !== 'string' || value.trim() === '' || value.includes('\u0000')) {
    throw new RuntimeError('INVALID_INPUT', 'workdir must be a non-empty path inside the workspace.')
  }
  let root: string
  let target: string
  try {
    root = await realpath(cwd)
    target = await realpath(isAbsolute(value) ? value : resolve(root, value))
  } catch {
    throw new RuntimeError('NOT_FOUND', 'workdir does not exist or is unavailable.')
  }
  const rel = relative(root, target)
  if (rel !== '' && (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel))) {
    throw new RuntimeError('FORBIDDEN', 'workdir must stay inside the workspace.')
  }
  const info = await lstat(target)
  if (!info.isDirectory()) throw new RuntimeError('INVALID_INPUT', 'workdir must be a workspace directory.')
  return target
}

/** Commands whose `1` exit status means "no matches", not a failure. */
const NO_MATCH_COMMANDS = new Set(['grep', 'egrep', 'fgrep', 'rg', 'findstr'])

function commandSegments(command: string): string[] {
  return command
    .split(/\|\||&&|[|;\n\r]/)
    .map(segment => segment.trim())
    .filter(segment => segment !== '')
}

function commandName(segment: string): string | undefined {
  const tokens = segment.match(/"[^"]*"|'[^']*'|\S+/g) ?? []
  let index = 0
  // PowerShell's call operator is not the command itself.
  while (tokens[index] === '&') index += 1
  const raw = tokens[index]
  if (raw === undefined) return undefined
  const unquoted = raw.replace(/^["']|["']$/g, '')
  const name = unquoted.split(/[\\/]/).pop()?.toLowerCase().replace(/\.exe$/, '')
  return name === '' ? undefined : name
}

function segmentIsNoMatch(segment: string): boolean {
  const name = commandName(segment)
  if (name === undefined) return false
  if (NO_MATCH_COMMANDS.has(name)) return true
  if (name === 'git') {
    const tokens = segment.match(/"[^"]*"|'[^']*'|\S+/g) ?? []
    const subcommand = tokens
      .slice(1)
      .map(token => token.replace(/^["']|["']$/g, '').toLowerCase())
      .find(token => !token.startsWith('-'))
    return subcommand === 'grep'
  }
  return false
}

/** Whether the command's failure came from a no-match search rather than a real error. */
export function isNoMatchCommand(command: string): boolean {
  return commandSegments(command).some(segmentIsNoMatch)
}

interface ShellResultShape {
  isError?: boolean
  structuredOutput?: unknown
  output?: readonly { type: string; text?: string }[]
  diagnostics?: readonly { code?: string }[]
}

/**
 * Turn a `grep`/`rg`/`findstr` exit 1 into a successful "no matches" result. The shell
 * tools keep their exit-code diagnostics for every other failure.
 */
export function withNoMatchSuccess<T extends ShellResultShape>(result: T, command: string): T {
  if (result.isError !== true) return result
  const structured = result.structuredOutput
  if (typeof structured !== 'object' || structured === null) return result
  if ((structured as { exitCode?: unknown }).exitCode !== 1) return result
  if (!isNoMatchCommand(command)) return result

  return {
    ...result,
    isError: false,
    diagnostics: [
      ...(result.diagnostics ?? []).filter(diagnostic => diagnostic.code !== 'exit_code'),
      { severity: 'info' as const, code: 'no_matches', message: 'No matches found.' },
    ],
  } as T
}
