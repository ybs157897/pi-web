import { lstat, realpath } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { Type } from '@earendil-works/pi-ai'
import { defineExtension, defineTool, type Extension, type ToolRegistration } from '@earendil-works/pi-durable'
import { createBashTool, createEditTool, createPowerShellTool, createReadTool, createWriteTool } from '@earendil-works/pi-durable/tools'
import { RuntimeError } from './runtime-errors.ts'

const baseBash = createBashTool()
const basePwsh = createPowerShellTool()

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

/** PowerShell single-quoted string: only the quote itself is doubled. */
function powershellQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`
}

/** Resolve one call's working directory, keeping it inside the bound workspace. */
async function resolveWorkdir(cwd: string, value: unknown): Promise<string> {
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

/**
 * Pi's bash tool plus `workdir` and `description`. The base tool always runs in the
 * conversation workspace, so a call that targets a subdirectory becomes one shell
 * `cd` prefix instead of forcing the model to open every command with `cd`.
 */
const bashTool = defineTool({
  ...baseBash,
  description: 'Execute a bash command and return its stdout/stderr. Each call runs in a fresh shell; pass `workdir` instead of using `cd`. Provide `description` before `command` in the arguments. Long output is truncated to its tail and the full output is saved to a temp file. Check the exit code before moving on.',
  parameters: Type.Object({
    command: Type.String({ description: 'Bash command to execute' }),
    description: Type.Optional(Type.String({ description: 'Clear, concise description of what this command does in active voice, 5-10 words.' })),
    workdir: Type.Optional(Type.String({ description: 'Working directory for this command. Defaults to the session workspace; a relative path resolves against it.' })),
    timeout: Type.Optional(Type.Number({ description: 'Timeout in seconds (optional, no default timeout)' })),
  }),
  execute: async (args, api, context) => {
    const cwd = api.env?.cwd
    if (typeof cwd !== 'string' || cwd.trim() === '') {
      throw new RuntimeError('UNSUPPORTED', 'This conversation has no workspace directory.')
    }
    const root = await realpath(cwd).catch(() => resolve(cwd))
    const workdir = await resolveWorkdir(root, args.workdir)
    const command = workdir === root ? args.command : `cd -- ${shellQuote(workdir)} && ${args.command}`
    return baseBash.execute({ command, ...(args.timeout === undefined ? {} : { timeout: args.timeout }) }, api, context)
  },
})

/** Pi's PowerShell tool plus the same `workdir`/`description` contract as the bash wrapper. */
const pwshTool = defineTool({
  ...basePwsh,
  name: 'pwsh',
  description: 'Execute a PowerShell command (`pwsh`, falling back to Windows PowerShell) and return its stdout/stderr. Each call runs in a fresh process; pass `workdir` instead of using `Set-Location`. Provide `description` before `command` in the arguments. Long output is truncated to its tail and the full output is saved to a temp file. Check the exit code before moving on.',
  parameters: Type.Object({
    command: Type.String({ description: 'PowerShell command to execute' }),
    description: Type.Optional(Type.String({ description: 'Clear, concise description of what this command does in active voice, 5-10 words.' })),
    workdir: Type.Optional(Type.String({ description: 'Working directory for this command. Defaults to the session workspace; a relative path resolves against it.' })),
    timeout: Type.Optional(Type.Number({ description: 'Timeout in seconds (optional, no default timeout)' })),
  }),
  execute: async (args, api, context) => {
    const cwd = api.env?.cwd
    if (typeof cwd !== 'string' || cwd.trim() === '') {
      throw new RuntimeError('UNSUPPORTED', 'This conversation has no workspace directory.')
    }
    const root = await realpath(cwd).catch(() => resolve(cwd))
    const workdir = await resolveWorkdir(root, args.workdir)
    const command = workdir === root ? args.command : `Set-Location -LiteralPath ${powershellQuote(workdir)}\n${args.command}`
    return basePwsh.execute({ command, ...(args.timeout === undefined ? {} : { timeout: args.timeout }) }, api, context)
  },
})

/**
 * The same tool surface as Pi's `coding-tools`, matching DSH's platform split:
 * Windows gets native `pwsh` only; other platforms get `bash` only.
 */
export function createCodingTools(platform: NodeJS.Platform = process.platform): Extension {
  const tools: ToolRegistration[] = [createReadTool(), createWriteTool(), createEditTool()]
  tools.push(platform === 'win32' ? pwshTool : bashTool)
  return defineExtension({ name: 'coding-tools', tools })
}

export const CodingTools = createCodingTools()
