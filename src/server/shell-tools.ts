import { Type } from '@earendil-works/pi-ai'
import { defineExtension, defineTool, type Extension, type ToolRegistration } from '@earendil-works/pi-durable'
import { createBashTool, createEditTool, createReadTool, createWriteTool } from '@earendil-works/pi-durable/tools'
import { executePosixBash } from './posix-shell.ts'
import { DEFAULT_COMMAND_TIMEOUT_SECONDS } from './shell-common.ts'
import { BACKGROUND_AFTER_MS, SHELL_OUTPUT_SCHEMA } from './shell-runner.ts'
import { createWindowsPowerShellTool } from './windows-shell.ts'

export { commandTimeout, DEFAULT_COMMAND_TIMEOUT_SECONDS } from './shell-common.ts'

const baseBash = createBashTool()

const FOREGROUND_RULE = 'Do not run dev servers, watch modes or interactive programs in the foreground; they hold the call until the timeout. Prefer one-shot forms and non-interactive flags (for example `vitest run`, `tsc --noEmit`, `git commit -m`).'
const TIMEOUT_PARAMETER = Type.Optional(Type.Number({ description: `Timeout in seconds (default ${DEFAULT_COMMAND_TIMEOUT_SECONDS}). Pass a larger value for long builds or test suites.` }))

/**
 * Pi's bash tool plus `workdir` and `description`. The local executor keeps the same output
 * contract while adding the workspace write sandbox, automatic backgrounding, and search-friendly
 * exit semantics.
 */
const bashTool = defineTool({
  ...baseBash,
  description: `Execute a bash command and return its stdout/stderr. Prefer the dedicated tools over shell equivalents: content search → the grep tool; file discovery → glob; a known file path → read; in-place edits → edit. Do not use \`grep -r\`, \`rg\`, \`find\`, or recursive \`ls\` for workspace-wide search. Each call runs in a fresh shell; pass \`workdir\` instead of using \`cd\`. Provide \`description\` before \`command\` in the arguments. Before any delete or move, verify the resolved absolute target path is the intended one; never run it against a computed path you have not checked, and guard path variables so an unset value cannot widen the target. ${FOREGROUND_RULE} Commands still running after ${BACKGROUND_AFTER_MS / 1_000}s are moved to the background and their output is saved to a file; use read on that path to check progress. Long output is truncated to its tail and the full output is saved to a temp file. Check the exit code before moving on.`,
  parameters: Type.Object({
    command: Type.String({ description: 'Bash command to execute' }),
    description: Type.Optional(Type.String({ description: 'Clear, concise description of what this command does in active voice, 5-10 words.' })),
    workdir: Type.Optional(Type.String({ description: 'Working directory for this command. Defaults to the session workspace; a relative path resolves against it.' })),
    timeout: TIMEOUT_PARAMETER,
  }),
  structuredOutputSchema: SHELL_OUTPUT_SCHEMA,
  execute: executePosixBash,
})

const pwshTool = createWindowsPowerShellTool()

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
