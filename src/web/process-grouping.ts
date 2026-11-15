import type { ProcessPart, ToolItem } from './render-model.ts'

/** ZCode 式由 UI 合成的过程分组；连续同类行 ≥ 2 行才成组。 */
export type ProcessToolGroupKind = 'explore' | 'execute'

/** 只读子行在 `查阅` 汇总里归属的桶。 */
export type ExploreBucket = 'fetch' | 'search' | 'list' | 'file'

const READ_ONLY_TOOL_NAMES = new Set([
  'read', 'read_image', 'read_file', 'readfile', 'cat', 'read_text_file',
  'grep', 'ripgrep', 'search', 'search_files', 'find', 'find_files', 'glob', 'list_files',
  'web_search', 'search_web', 'browser_search', 'web_fetch', 'fetch_url', 'fetch',
])
const SHELL_TOOL_NAMES = new Set(['bash', 'shell', 'exec', 'exec_command', 'terminal', 'run_command', 'pwsh'])

/** ZCode 的只读 shell 白名单；带写入或重定向的命令归入 `终端`。 */
const SHELL_READ_RE = /\b(rg|grep|find|ls|cat|head|tail|wc|stat|pwd|which|readlink|tree|sed\s+-n|get-childitem|gci|dir|get-content|gc|type|select-string|sls|get-location|test-path|resolve-path)\b|^git\s+(status|log|show|diff)\b/i
const SHELL_WRITE_RE = /\b(sed\s+-i|perl\s+-pi|tee|mv|cp|rm|mkdir|rmdir|touch|truncate|chmod|chown|remove-item|del|erase|set-content|add-content|clear-content|out-file|new-item|move-item|copy-item|rename-item|set-item)\b|^git\s+(add|commit|rm|mv|checkout|switch|restore|reset|clean|revert|cherry-pick|merge|rebase)\b/i
const SHELL_REDIRECT_WRITE_RE = /(^|[^\d<])>>?\s*\S|&>\s*\S/i

/**
 * 功能：判定一条工具行是否入组以及入哪个组。
 * @param item 工具行
 * @returns `'explore'`（进 `查阅` 组）、`'execute'`（进 `终端` 组）；不属于任何组返回 undefined
 * 内部逻辑：内置只读工具名直接入 explore；shell 行解析出命令后，命中写入正则或写重定向即 execute，否则命中只读白名单为 explore，读不出命令的 shell 行保守归 execute。
 */
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

/**
 * 功能：`查阅` 组内一行的汇总桶（fetch/search/list/file），供分组头显示计数。
 * @param item 只读工具行
 * @returns 四桶之一；shell 行按命令内容正则二次分桶，其余按文件读取算 file
 */
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

/**
 * 功能：把连续同类工具行折叠成 `查阅` / `终端` 分组；单行不成组，保持原样平铺。
 * @param parts 过程部件序列（工具行与其他内容混排）
 * @returns 折叠后的新序列：非工具部件原样保留，成组处替换为 kind='toolGroup' 的聚合部件
 * 内部逻辑：从左到右扫描，遇到可入组行就向后吞并同类行（kind 必须一致）；不足 2 行不成组（对齐 ZCode：第二条连续行出现才合成父节点）；分组 key 由组类型与首行 key 生成。
 */
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
    // ZCode 只在出现第二条连续行后才合成父节点。
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

/**
 * 功能：提取一条 shell 工具行实际运行的命令串，去掉 shell 包装与引号。
 * @param item 工具行
 * @returns 去重后的命令段列表（按 `&&` `||` `;` 切分）
 * 内部逻辑：依次尝试 arguments 的 command/cmd/script/parsed_cmd 字段；数组形式优先取 `-lc` 的下一个元素；对象形式取 `cmd`；`zsh|bash|sh -lc` 与 `powershell -Command` 包装先剥壳再剥引号。
 */
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
