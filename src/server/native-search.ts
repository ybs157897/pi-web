import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { makeExcerpt, type SearchMatch } from './search-format.ts'

/** A search that finished, or why it could not run. */
export type NativeSearchOutcome =
  | { kind: 'ok'; matches: SearchMatch[]; scannedFiles: number; truncated: boolean }
  | { kind: 'unavailable'; reason: string }
  | { kind: 'failed'; reason: string }

const DEFAULT_RG_TIMEOUT_MS = 30_000
const MAX_RG_STDOUT_BYTES = 8 * 1_024 * 1_024
const MAX_RG_STDERR_BYTES = 64 * 1_024
const MAX_COLUMNS = 500
/** Keep the walker's per-file ceiling so one generated bundle cannot dominate a search. */
const MAX_FILE_BYTES = '512K'
const OMITTED_DIRECTORIES = ['.git', '.svn', '.hg', '.bzr', '.jj', '.sl', 'node_modules', '.data'] as const
const PRIVATE_GLOBS = [
  '!**/{credentials,secrets,tokens,private-key}*.{json,yaml,yml,toml,txt}',
  '!**/id_rsa',
  '!**/id_ed25519',
  '!**/*.{pem,key,p12,pfx,keystore}',
] as const
const PRIVATE_FILE_EXTENSIONS = new Set(['.pem', '.key', '.p12', '.pfx', '.keystore'])
const PRIVATE_FILE_NAME = /^(?:(?:credentials?|secrets?|tokens?|private[-_]?key)\.(?:json|ya?ml|toml|txt)|id_rsa|id_ed25519)$/i

let resolvedRipgrep: string | undefined | null = null
let forcedRipgrep: string | undefined
let hasForcedRipgrep = false

/** Resolve a native ripgrep once: explicit override, bundled binary, then PATH. */
export async function resolveRipgrep(): Promise<string | undefined> {
  if (hasForcedRipgrep) return forcedRipgrep
  if (resolvedRipgrep !== null) return resolvedRipgrep

  const explicit = process.env.PI_WEB_RG_PATH?.trim()
  if (explicit && existsSync(explicit)) {
    resolvedRipgrep = explicit
    return explicit
  }

  try {
    // A non-literal specifier keeps TypeScript from requiring the optional package's types.
    const specifier = '@vscode/ripgrep'
    const loaded = await import(specifier) as { rgPath?: string; default?: { rgPath?: string } }
    const bundled = loaded.rgPath ?? loaded.default?.rgPath
    if (bundled && existsSync(bundled)) {
      resolvedRipgrep = bundled
      return bundled
    }
  } catch {
    // The optional package is absent; PATH is still worth a try.
  }

  resolvedRipgrep = 'rg'
  return resolvedRipgrep
}

export function resetRipgrepResolverForTests(): void {
  resolvedRipgrep = null
  forcedRipgrep = undefined
  hasForcedRipgrep = false
}

/** Force the search executable (or `undefined` for unavailable) in tests. */
export function setRipgrepForTests(command: string | undefined): void {
  forcedRipgrep = command
  hasForcedRipgrep = true
  resolvedRipgrep = null
}

function isPrivatePath(path: string): boolean {
  const name = path.split('/').pop() ?? ''
  const lower = name.toLowerCase()
  const extension = lower.slice(lower.lastIndexOf('.'))
  return PRIVATE_FILE_NAME.test(name) || PRIVATE_FILE_EXTENSIONS.has(extension)
}

function toWorkspacePath(root: string, path: string): string | undefined {
  const absolute = isAbsolute(path) ? path : resolve(root, path)
  const local = relative(root, absolute)
  if (local === '' || local === '..' || local.startsWith(`..${sep}`) || isAbsolute(local)) return undefined
  const normalized = local.split(sep).join('/')
  return isPrivatePath(normalized) ? undefined : normalized
}

function buildArgs(input: {
  pattern: string
  searchPath: string
  include?: string
  caseSensitive: boolean
}): string[] {
  const args = [
    '--no-config',
    '--color', 'never',
    '--no-heading',
    '--with-filename',
    '--line-number',
    '--max-columns', String(MAX_COLUMNS),
    '--max-filesize', MAX_FILE_BYTES,
    '--json',
    '--stats',
  ]

  for (const directory of OMITTED_DIRECTORIES) {
    args.push('--glob', `!${directory}`, '--glob', `!**/${directory}/**`)
  }
  for (const glob of PRIVATE_GLOBS) args.push('--glob', glob)

  if (!input.caseSensitive) args.push('--ignore-case')
  if (input.include) args.push('--glob', input.include)
  args.push('--', input.pattern, input.searchPath)
  return args
}

function killChild(child: ChildProcess | undefined): void {
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

interface RipgrepEvent {
  type?: string
  data?: {
    path?: { text?: string }
    line_number?: number
    lines?: { text?: string }
    submatches?: Array<{ start?: number }>
    stats?: { searches?: number }
  }
}

function parseStdout(
  stdout: string,
  root: string,
  maxResults: number,
): { matches: SearchMatch[]; scannedFiles: number; truncated: boolean } {
  const matches: SearchMatch[] = []
  let scannedFiles = 0
  let truncated = false

  for (const line of stdout.split('\n')) {
    if (line.trim() === '') continue
    let event: RipgrepEvent
    try {
      event = JSON.parse(line) as RipgrepEvent
    } catch {
      continue
    }

    if (event.type === 'summary') {
      const searches = event.data?.stats?.searches
      if (typeof searches === 'number') scannedFiles = searches
      continue
    }
    if (event.type !== 'match') continue

    const path = event.data?.path?.text
    const lineNumber = event.data?.line_number
    const lineText = event.data?.lines?.text
    if (typeof path !== 'string' || typeof lineNumber !== 'number' || typeof lineText !== 'string') continue
    const workspacePath = toWorkspacePath(root, path)
    if (workspacePath === undefined) continue

    const text = lineText.replace(/\r?\n$/, '')
    const byteStart = event.data?.submatches?.[0]?.start
    const matchIndex = typeof byteStart === 'number'
      ? Buffer.from(text, 'utf8').subarray(0, byteStart).toString('utf8').length
      : 0
    if (matches.length >= maxResults) {
      // Keep reading so the summary still reports how many files were searched.
      truncated = true
      continue
    }
    matches.push({ path: workspacePath, line: lineNumber, excerpt: makeExcerpt(text, matchIndex) })
  }

  if (scannedFiles === 0) scannedFiles = new Set(matches.map(match => match.path)).size
  return { matches, scannedFiles, truncated }
}

/**
 * Run the workspace regex search on native ripgrep. The caller keeps its JavaScript walker as
 * the fallback for a missing binary, an unsupported Rust regex, or any runtime failure.
 */
export async function searchWithRipgrep(input: {
  root: string
  searchPath: string
  pattern: string
  include?: string
  caseSensitive: boolean
  maxResults: number
  signal?: AbortSignal
}): Promise<NativeSearchOutcome> {
  const command = await resolveRipgrep()
  if (command === undefined) return { kind: 'unavailable', reason: 'no ripgrep binary was found' }
  if (input.signal?.aborted) return { kind: 'failed', reason: 'aborted' }

  const args = buildArgs(input)

  return await new Promise<NativeSearchOutcome>((settle) => {
    let settled = false
    let truncated = false
    let stdout = ''
    let stderr = ''
    let child: ChildProcess | undefined
    let timer: NodeJS.Timeout | undefined

    const finish = (outcome: NativeSearchOutcome) => {
      if (settled) return
      settled = true
      if (timer !== undefined) clearTimeout(timer)
      input.signal?.removeEventListener('abort', onAbort)
      settle(outcome)
    }

    const onAbort = () => {
      killChild(child)
      finish({ kind: 'failed', reason: 'aborted' })
    }

    let spawned: ChildProcess
    try {
      spawned = spawn(command, args, {
        cwd: input.root,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      })
    } catch (error) {
      finish({ kind: 'failed', reason: error instanceof Error ? error.message : String(error) })
      return
    }
    child = spawned

    timer = setTimeout(() => {
      killChild(spawned)
      finish({ kind: 'failed', reason: `ripgrep did not finish within ${DEFAULT_RG_TIMEOUT_MS / 1_000}s` })
    }, DEFAULT_RG_TIMEOUT_MS)
    input.signal?.addEventListener('abort', onAbort, { once: true })

    spawned.stdout?.on('data', (chunk: Buffer) => {
      if (settled) return
      if (stdout.length + chunk.length > MAX_RG_STDOUT_BYTES) {
        truncated = true
        killChild(spawned)
        finish({ kind: 'ok', ...parseStdout(stdout, input.root, input.maxResults), truncated: true })
        return
      }
      stdout += chunk.toString('utf8')
    })

    spawned.stderr?.on('data', (chunk: Buffer) => {
      if (stderr.length < MAX_RG_STDERR_BYTES) stderr += chunk.toString('utf8')
    })

    spawned.on('error', (error) => {
      const code = (error as NodeJS.ErrnoException).code
      finish(code === 'ENOENT'
        ? { kind: 'unavailable', reason: `ripgrep is not installed at ${command}` }
        : { kind: 'failed', reason: error.message })
    })

    spawned.on('close', (code) => {
      if (settled) return
      if (code === 0 || code === 1) {
        const parsed = parseStdout(stdout, input.root, input.maxResults)
        finish({ kind: 'ok', ...parsed, truncated: parsed.truncated || truncated })
        return
      }
      finish({
        kind: 'failed',
        reason: `ripgrep exited with code ${String(code)}${stderr.trim() === '' ? '' : `: ${stderr.trim().slice(0, 500)}`}`,
      })
    })
  })
}
