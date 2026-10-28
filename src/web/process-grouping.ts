import type { ProcessPart, ToolItem } from './render-model.ts'

/** ZCode's UI-synthesized process groups; a group only forms for two or more rows. */
export type ProcessToolGroupKind = 'explore' | 'execute'

/** The bucket a read-only child contributes to a `查阅` summary. */
export type ExploreBucket = 'fetch' | 'search' | 'list' | 'file'

const READ_ONLY_TOOL_NAMES = new Set([
  'read', 'read_image', 'read_file', 'readfile', 'cat', 'read_text_file',
  'grep', 'ripgrep', 'search', 'search_files', 'find', 'find_files', 'glob', 'list_files',
  'web_search', 'search_web', 'browser_search', 'web_fetch', 'fetch_url', 'fetch',
])
const SHELL_TOOL_NAMES = new Set(['bash', 'shell', 'exec', 'exec_command', 'terminal', 'run_command', 'pwsh'])

/** ZCode's read-only shell allowlist; writes and redirects keep a command in 终端. */
const SHELL_READ_RE = /\b(rg|grep|find|ls|cat|head|tail|wc|stat|pwd|which|readlink|tree|sed\s+-n|get-childitem|gci|dir|get-content|gc|type|select-string|sls|get-location|test-path|resolve-path)\b|^git\s+(status|log|show|diff)\b/i
const SHELL_WRITE_RE = /\b(sed\s+-i|perl\s+-pi|tee|mv|cp|rm|mkdir|rmdir|touch|truncate|chmod|chown|remove-item|del|erase|set-content|add-content|clear-content|out-file|new-item|move-item|copy-item|rename-item|set-item)\b|^git\s+(add|commit|rm|mv|checkout|switch|restore|reset|clean|revert|cherry-pick|merge|rebase)\b/i
const SHELL_REDIRECT_WRITE_RE = /(^|[^\d<])>>?\s*\S|&>\s*\S/i

/** A tool row that joins the surrounding `查阅` group, or null when it breaks the group. */
export function toolGroupKind(item: ToolItem): ProcessToolGroupKind | undefined {
  const name = toolName(item)
  if (READ_ONLY_TOOL_NAMES.has(name)) return 'explore'
  if (!SHELL_TOOL_NAMES.has(name)) return undefined
  const commands = shellCommands(item)
  if (commands.length === 0) return undefined
  if (commands.some(command => SHELL_WRITE_RE.test(command) || SHELL_REDIRECT_WRITE_RE.test(command))) return 'execute'
  if (commands.some(command => SHELL_READ_RE.test(command))) return 'explore'
  return 'execute'
}

/** The summary bucket for one row inside a `查阅` group. */
export function exploreBucket(item: ToolItem): ExploreBucket {
  const name = toolName(item)
  if (name === 'web_fetch' || name === 'fetch_url' || name === 'fetch') return 'fetch'
  if (name === 'web_search' || name === 'search_web' || name === 'browser_search') return 'search'
  if (name === 'grep' || name === 'ripgrep' || name === 'search' || name === 'search_files') return 'search'
  if (name === 'glob' || name === 'list_files' || name === 'find' || name === 'find_files') return 'list'
  if (!SHELL_TOOL_NAMES.has(name)) return 'file'
  const command = shellCommands(item).join(' ; ')
  if (/(^|\s)(rg|grep|ripgrep|git\s+grep)(\s|$)/i.test(command)) return 'search'
  if (/(^|\s)(ls|find|tree|dir)(\s|$)/i.test(command)) return 'list'
  return 'file'
}

/** Fold consecutive read-only rows into `查阅` and the rest into `终端`; singles stay flat. */
export function groupProcessParts(parts: readonly ProcessPart[]): ProcessPart[] {
  const grouped: ProcessPart[] = []
  let index = 0
  while (index < parts.length) {
    const part = parts[index]
    if (part?.kind !== 'tool') {
      if (part !== undefined) grouped.push(part)
      index += 1
      continue
    }
    const group = toolGroupKind(part.item)
    if (group === undefined) {
      grouped.push(part)
      index += 1
      continue
    }
    const items: ToolItem[] = [part.item]
    let next = index + 1
    while (next < parts.length) {
      const candidate = parts[next]
      if (candidate?.kind !== 'tool' || toolGroupKind(candidate.item) !== group) break
      items.push(candidate.item)
      next += 1
    }
    // ZCode only synthesizes a parent after the second consecutive row.
    if (items.length < 2) {
      grouped.push(part)
      index += 1
      continue
    }
    grouped.push({ kind: 'toolGroup', key: `group:${group}:${items[0]?.key ?? index}`, group, items, order: part.order })
    index = next
  }
  return grouped
}

function toolName(item: ToolItem): string {
  return (item.call?.name ?? item.result?.toolName ?? '').toLocaleLowerCase()
}

/** The command strings a shell row actually runs, with the shell wrapper and quoting removed. */
export function shellCommands(item: ToolItem): string[] {
  const args = item.call?.arguments
  const candidates: string[] = []
  const collect = (value: unknown): void => {
    if (typeof value === 'string') {
      if (value.trim() !== '') candidates.push(value.trim())
      return
    }
    if (!Array.isArray(value)) return
    if (value.every(entry => typeof entry === 'string')) {
      const parts = value as string[]
      const shellIndex = parts.findIndex(part => part === '-lc')
      if (shellIndex >= 0 && typeof parts[shellIndex + 1] === 'string') {
        candidates.push(parts[shellIndex + 1]!.trim())
        return
      }
      const joined = parts.join(' ').trim()
      if (joined !== '') candidates.push(joined)
      return
    }
    for (const entry of value) {
      if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) continue
      const command = (entry as Record<string, unknown>).cmd
      if (typeof command === 'string' && command.trim() !== '') candidates.push(command.trim())
    }
  }
  collect(args?.command)
  collect(args?.cmd)
  collect(args?.script)
  collect(args?.parsed_cmd)
  return [...new Set(candidates.flatMap(command => splitCommand(unwrapShell(command))))]
    .map(command => command.trim())
    .filter(command => command !== '')
}

function unwrapShell(command: string): string {
  const trimmed = command.trim()
  const shellMatch = /^(?:\/bin\/)?(?:zsh|bash|sh)\s+-lc\s+([\s\S]+)$/i.exec(trimmed)
    ?? /^(?:powershell(?:\.exe)?|pwsh(?:\.exe)?)\b[\s\S]*?\s-(?:command|c)\s+([\s\S]+)$/i.exec(trimmed)
  const value = (shellMatch?.[1] ?? trimmed).trim()
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1).trim()
  }
  return value
}

function splitCommand(command: string): string[] {
  return command.split(/&&|\|\||;/gu).map(segment => segment.trim()).filter(segment => segment !== '')
}
