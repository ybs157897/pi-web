import type {
  DiffHunk, ReadBlockLine, SearchBlockProps, WebBlockProps,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { FileArtifact, InteractionStatus } from '../shared/types.ts'
import { asRecord, messageOutput, toolActivity, type ActivityCount, type ToolItem, type ToolActivity } from './render-model.ts'
import type { Translate } from './render-labels.ts'

/** Payload kind the runtime steers into the conversation when a pending question is answered. */
export const ANSWER_REPLY_KIND = 'answer_to_pending_question'

/** Payload kind the runtime steers into the conversation when the user dismisses a question set. */
export const DISMISSAL_REPLY_KIND = 'dismissed_pending_question'

/** Tools whose rows present the read-only question record instead of a generic tool summary. */
const QUESTION_TOOL_NAMES = new Set(['ask_user_question', 'request_user_input'])

/** Pi's code-mode tool: one call runs a model-written script against the conversation's tools. */
export const CODEMODE_TOOL_NAME = 'codemode'

/** Pi's code-mode tool calls are named `mcp__<server>__<tool>`; DSH titles them the same way. */
const MCP_TOOL_NAME = /^mcp__(.+?)__(.+)$/iu

/** DSH's MCP row title for an `mcp__server__tool` name; undefined for every other tool. */
function mcpRowTitle(name: string): string | undefined {
  const match = MCP_TOOL_NAME.exec(name)
  return match === null ? undefined : `MCP · ${match[1]} · ${match[2]}`
}

export interface ToolRenderModel {
  readonly name: string
  readonly title: string
  readonly summary: string
  readonly output: string
  readonly command?: string
  readonly cwd?: string
  readonly path?: string
  readonly language?: string
  readonly exitCode?: number | null
  readonly signal?: string
  readonly read?: { readonly lines: readonly ReadBlockLine[]; readonly totalLines: number } | undefined
  readonly diffs?: readonly DiffHunk[] | undefined
  readonly search?: SearchBlockProps | undefined
  readonly web?: WebBlockProps | undefined
  readonly artifacts: readonly FileArtifact[]
  readonly details?: unknown
  readonly args: Readonly<Record<string, unknown>>
  readonly running: boolean
  readonly failed: boolean
  readonly cancelled: boolean
  readonly errorText?: string
  readonly knownPresentation: boolean
}


/** Running group-title label for one category, in DSH's wording. */
export function activityRunning(kind: ToolActivity, t: Translate): string {
  switch (kind) {
    case 'read': return t('正在读取文件', 'Reading a file')
    case 'readImage': return t('正在读取图片', 'Reading an image')
    case 'search': return t('正在搜索代码', 'Searching the code')
    case 'write': return t('正在写入文件', 'Writing a file')
    case 'edit': return t('正在编辑文件', 'Editing a file')
    case 'commands': return t('正在运行命令', 'Running a command')
    case 'code': return t('正在运行代码', 'Running code')
    case 'webSearch': return t('正在搜索网页', 'Searching the web')
    case 'webFetch': return t('正在访问网页', 'Fetching a page')
    case 'subagents': return t('正在协调子智能体', 'Coordinating subagents')
    case 'plan': return t('正在更新计划', 'Updating the plan')
    case 'questions': return t('等待你的操作', 'Waiting for you')
    default: return t('正在调用工具', 'Calling a tool')
  }
}

/** Settled group-title label for one category, in DSH's wording. */
export function activityDone(kind: ToolActivity, t: Translate): string {
  switch (kind) {
    case 'read': return t('已读取文件', 'Read a file')
    case 'readImage': return t('已读取图片', 'Read an image')
    case 'search': return t('已搜索代码', 'Searched the code')
    case 'write': return t('已写入文件', 'Wrote a file')
    case 'edit': return t('修改了文件', 'Edited a file')
    case 'commands': return t('执行了命令', 'Ran a command')
    case 'code': return t('运行了代码', 'Ran code')
    case 'webSearch': return t('已搜索网页', 'Searched the web')
    case 'webFetch': return t('已访问网页', 'Fetched a page')
    case 'subagents': return t('已协调子智能体', 'Coordinated subagents')
    case 'plan': return t('更新了计划', 'Updated the plan')
    case 'questions': return t('向用户提出了问题', 'Asked the user')
    default: return t('已调用工具', 'Called a tool')
  }
}

/**
 * DSH's settled group title: the top three categories, joined with 并 or ，and
 * capped with 等 beyond three, sharing the 已 prefix where both halves have it.
 */
export function processTitleFromCounts(counts: readonly ActivityCount[], t: Translate): string {
  const labels = counts.slice(0, 3).map(({ kind }) => activityDone(kind, t))
  const first = labels[0]
  if (first === undefined) return t('已完成分析', 'Finished analyzing')
  const continuation = (label: string): string => label.charAt(0).toLowerCase() + label.slice(1)
  const second = labels[1]
  if (second === undefined) return first
  if (labels.length === 2) {
    const prefix = t('已', '')
    const shared = prefix !== '' && first.startsWith(prefix) && second.startsWith(prefix)
    return t(`${first}并${continuation(shared ? second.slice(prefix.length) : second)}`,
      `${first} and ${continuation(shared ? second.slice(prefix.length) : second)}`)
  }
  const title = [first, ...labels.slice(1).map(continuation)].join(t('，', ', '))
  return counts.length > 3 ? t(`${title}等`, `${title}, and more`) : title
}

/** Row title in DSH's `tool.title` vocabulary, which differs from the group categories. */
export function toolRowTitle(name: string, t: Translate): string {
  // MCP names are rendered as `MCP · server · tool`; the category icon stays the generic one.
  const mcp = mcpRowTitle(name)
  if (mcp !== undefined) return mcp
  const id = name.toLocaleLowerCase()
  if (id === CODEMODE_TOOL_NAME) return t('代码', 'Code')
  // A listing is not a text search; name the operation the tool actually performs.
  if (id === 'list_files') return t('搜索列表', 'List files')
  if (id === 'skill') return t('技能', 'Skill')
  if (id === 'task_stop') return t('停止任务', 'Stop task')
  switch (toolActivity(id)) {
    case 'read': case 'readImage': return t('读取', 'Read')
    case 'search': case 'webSearch': return t('搜索', 'Search')
    case 'webFetch': return t('网页抓取', 'Fetch')
    case 'write': return t('写入', 'Write')
    case 'edit': return t('编辑', 'Edit')
    case 'commands': return t('运行命令', 'Bash')
    case 'code': return t('代码', 'Code')
    case 'plan': return t('待办', 'Todos')
    default: return t('工具调用', 'Tool call')
  }
}

/** DSH's live detail priority for the group title, first field with text wins. */
const LIVE_DETAIL_KEYS = [
  'title', 'description', 'objective', 'task', 'task_name', 'name', 'question', 'questions', 'prompt', 'message',
  'command', 'cmd', 'code', 'queries', 'query', 'pattern', 'url', 'uri', 'file_path', 'path', 'target', 'action', 'status',
] as const

/** One-line live detail for a running group title, whitespace-normalized. */
export function toolLiveDetail(args: Readonly<Record<string, unknown>>): string {
  for (const key of LIVE_DETAIL_KEYS) {
    const value = args[key]
    const text = typeof value === 'string' ? value : Array.isArray(value) && value.every(item => typeof item === 'string') ? value.join(', ') : ''
    // A code-mode script is a program, not a one-line argument: its first line is the live detail.
    const single = key === 'code' ? firstLine(text) || text : text
    const normalized = single.replace(/\s+/gu, ' ').trim()
    if (normalized !== '') return normalized.length > 160 ? `${normalized.slice(0, 159).trimEnd()}…` : normalized
  }
  return ''
}

interface ToolDetails {
  command?: string
  cwd?: string
  path?: string
  language?: string
  lines?: ReadBlockLine[]
  totalLines?: number
  exitCode?: number | null
  signal?: string
  diffs?: DiffHunk[]
  search?: SearchBlockProps
  web?: WebBlockProps
}

const COMMAND_NAMES = new Set(['bash', 'shell', 'exec', 'terminal', 'run_command'])
const READ_NAMES = new Set(['read', 'read_file', 'readfile', 'cat', 'read_text_file'])
const WRITE_NAMES = new Set(['write', 'write_file', 'writefile', 'create_file'])
const EDIT_NAMES = new Set(['edit', 'edit_file', 'apply_patch', 'patch'])
const SEARCH_NAMES = new Set(['search', 'grep', 'ripgrep', 'glob', 'find_files', 'find'])
const WEB_SEARCH_NAMES = new Set(['web_search', 'search_web', 'browser_search'])
const WEB_FETCH_NAMES = new Set(['web_fetch', 'fetch_url', 'fetch'])

/** Convert a durable Pi tool call into the matching DSH result primitive. */
export function buildToolRenderModel(item: ToolItem, t: (chinese: string, english: string) => string, runRunning: boolean): ToolRenderModel {
  const message = item.result ?? item.message
  const name = item.call?.name ?? message.toolName ?? 'tool'
  const normalizedName = name.toLocaleLowerCase()
  const args = item.call?.arguments ?? {}
  const output = messageOutput(item.result)
  const detailsRecord = detailsRecordFor(item.result?.details, output)
  const details = parseDetails(detailsRecord, name, output)
  const artifactValues = item.result?.artifacts ?? []
  const artifacts = dedupeArtifacts(artifactValues)
  const primaryArtifact = artifactValues.find(artifact => artifact.kind === 'edit' || artifact.kind === 'write' || artifact.kind === 'nativeEdit')
  const fileArtifactDiff = primaryArtifact?.before !== undefined && primaryArtifact.after !== undefined
    ? [{ path: primaryArtifact.path, oldText: primaryArtifact.before, newText: primaryArtifact.after }]
    : undefined
  const diffValues = details.diffs ?? fileArtifactDiff ?? argsDiff(args)
  const path = details.path ?? stringField(args, ['path', 'filePath', 'file_path', 'file']) ?? primaryArtifact?.path
  const command = details.command ?? stringField(args, ['command', 'cmd', 'script'])
  const cwd = details.cwd ?? stringField(args, ['cwd', 'workingDirectory'])
  const language = details.language ?? stringField(args, ['language', 'lang']) ?? languageFromPath(path)
  const resultStatus = item.result?.status ?? item.message.status
  const running = item.result?.streaming === true || resultStatus === 'running'
    || item.result === undefined && (item.message.streaming === true || runRunning)
  const failed = item.result?.isError === true || resultStatus === 'error'
  const cancelled = resultStatus === 'cancelled'
  const description = stringField(args, ['description', 'title'])
  const summary = failed ? firstLine(output) || t('执行失败', 'Failed')
    : cancelled ? t('已停止', 'Stopped')
      : summaryFor(normalizedName, args, path, command, description, detailsRecord, output, t)
  const specialized = command !== undefined && COMMAND_NAMES.has(normalizedName)
    || READ_NAMES.has(normalizedName) && details.lines !== undefined
    || diffValues !== undefined && diffValues.length > 0
    || details.search !== undefined
    || details.web !== undefined
  const read = READ_NAMES.has(normalizedName) || artifacts.some(artifact => artifact.kind === 'read')
    ? buildRead(details, path, output, artifacts)
    : undefined
  return {
    name,
    title: toolRowTitle(name, t),
    summary,
    output,
    ...(command === undefined ? {} : { command }),
    ...(cwd === undefined ? {} : { cwd }),
    ...(path === undefined ? {} : { path }),
    ...(language === undefined ? {} : { language }),
    ...(details.exitCode === undefined ? {} : { exitCode: details.exitCode }),
    ...(details.signal === undefined ? {} : { signal: details.signal }),
    ...(read === undefined ? {} : { read }),
    ...(diffValues === undefined ? {} : { diffs: diffValues }),
    ...(details.search === undefined ? {} : { search: details.search }),
    ...(details.web === undefined ? {} : { web: details.web }),
    artifacts,
    ...(item.result?.details === undefined ? {} : { details: item.result.details }),
    args,
    running,
    failed,
    cancelled,
    ...(failed && output !== '' ? { errorText: firstLine(output) } : {}),
    knownPresentation: specialized || COMMAND_NAMES.has(normalizedName) || READ_NAMES.has(normalizedName)
      || WRITE_NAMES.has(normalizedName) || EDIT_NAMES.has(normalizedName) || SEARCH_NAMES.has(normalizedName)
      || WEB_SEARCH_NAMES.has(normalizedName) || WEB_FETCH_NAMES.has(normalizedName) || normalizedName === 'list_files',
  }
}

function detailsRecordFor(value: unknown, output: string): Record<string, unknown> | undefined {
  const direct = asRecord(value)
  if (direct !== undefined) return direct
  if (typeof value === 'string') {
    const parsed = parseJsonRecord(value)
    if (parsed !== undefined) return parsed
  }
  return parseJsonRecord(output)
}

function parseJsonRecord(value: string): Record<string, unknown> | undefined {
  if (value.length > 1_000_000) return undefined
  try { return asRecord(JSON.parse(value)) }
  catch (error) {
    if (!(error instanceof SyntaxError)) throw error
    return undefined
  }
}

function parseDetails(record: Record<string, unknown> | undefined, name: string, output: string): ToolDetails {
  if (record === undefined) {
    const search = parseSearchOutput(name, output)
    return search === undefined ? {} : { search }
  }
  const structuredOutput = asRecord(record.structuredOutput)
    ?? (typeof record.structuredOutput === 'string' ? parseJsonRecord(record.structuredOutput) : undefined)
  const values = structuredOutput === undefined ? record : { ...record, ...structuredOutput }
  const lines = parseReadLines(values.lines)
  const diffs = parseDiffs(values.diffs)
  const search = parseSearch(values) ?? parseSearchOutput(name, output)
  const web = parseWeb(values, name)
  const command = stringField(values, ['command', 'cmd'])
  const cwd = stringField(values, ['cwd', 'workingDirectory'])
  const path = stringField(values, ['path', 'filePath', 'file_path'])
  const language = stringField(values, ['lang', 'language'])
  return {
    ...(command === undefined ? {} : { command }),
    ...(cwd === undefined ? {} : { cwd }),
    ...(path === undefined ? {} : { path }),
    ...(language === undefined ? {} : { language }),
    ...(lines === undefined ? {} : { lines }),
    ...(typeof values.totalLines === 'number' && Number.isFinite(values.totalLines) ? { totalLines: values.totalLines } : {}),
    ...(typeof values.exitCode === 'number' || values.exitCode === null ? { exitCode: values.exitCode } : {}),
    ...(typeof values.signal === 'string' ? { signal: values.signal } : {}),
    ...(diffs === undefined ? {} : { diffs }),
    ...(search === undefined ? {} : { search }),
    ...(web === undefined ? {} : { web }),
  }
}

function parseReadLines(value: unknown): ReadBlockLine[] | undefined {
  if (!Array.isArray(value)) return undefined
  const result: ReadBlockLine[] = []
  for (const entry of value) {
    const line = asRecord(entry)
    if (line === undefined || typeof line.text !== 'string') continue
    result.push({ number: finiteNumber(line.number) ?? result.length + 1, text: line.text })
  }
  return result
}

function parseDiffs(value: unknown): DiffHunk[] | undefined {
  if (!Array.isArray(value)) return undefined
  const result: DiffHunk[] = []
  for (const entry of value) {
    const diff = asRecord(entry)
    if (diff === undefined || typeof diff.path !== 'string' || typeof diff.newText !== 'string'
      || !(typeof diff.oldText === 'string' || diff.oldText === null)) continue
    result.push({ path: diff.path, oldText: diff.oldText, newText: diff.newText })
  }
  return result.length === 0 ? undefined : result
}

function parseSearch(record: Record<string, unknown>): SearchBlockProps | undefined {
  const paths = stringArray(record.paths ?? record.files)
  if (paths !== undefined) return { kind: 'paths', paths, total: finiteNumber(record.total) ?? paths.length, truncated: record.truncated === true, labels: placeholderSearchLabels }
  const matchValues = Array.isArray(record.matches) ? record.matches : Array.isArray(record.results) ? record.results : undefined
  if (matchValues === undefined) return undefined
  const groups = new Map<string, Array<{ lineNumber: number; line: string }>>()
  for (const value of matchValues) {
    const match = asRecord(value)
    if (match === undefined || typeof match.path !== 'string') continue
    const line = typeof match.line === 'string' ? match.line : typeof match.text === 'string' ? match.text : undefined
    if (line === undefined) continue
    const bucket = groups.get(match.path) ?? []
    bucket.push({ lineNumber: finiteNumber(match.lineNumber ?? match.line) ?? bucket.length + 1, line })
    groups.set(match.path, bucket)
  }
  if (groups.size === 0) return undefined
  const files = [...groups].map(([path, matches]) => ({ path, matches }))
  const total = finiteNumber(record.total) ?? files.reduce((sum, file) => sum + file.matches.length, 0)
  return { kind: 'matches', files, total, truncated: record.truncated === true, labels: placeholderSearchLabels }
}

function parseSearchOutput(name: string, output: string): SearchBlockProps | undefined {
  const normalized = name.toLocaleLowerCase()
  const rows = output.split(/\r?\n/u).map(line => line.trimEnd()).filter(line => line !== '')
  if (rows.length === 0) return undefined
  if (/^(glob|find|find_files)$/u.test(normalized) && rows.every(line => !line.startsWith('{'))) {
    return { kind: 'paths', paths: rows, total: rows.length, truncated: false, labels: placeholderSearchLabels }
  }
  if (!/^(grep|ripgrep|search)$/u.test(normalized)) return undefined
  const groups = new Map<string, Array<{ lineNumber: number; line: string }>>()
  for (const row of rows) {
    const match = /^(.*?):(\d+):(.*)$/u.exec(row)
    if (match === null) continue
    const path = match[1]
    const lineNumber = Number(match[2])
    const line = match[3]
    if (path === undefined || line === undefined || !Number.isFinite(lineNumber)) continue
    const bucket = groups.get(path) ?? []
    bucket.push({ lineNumber, line })
    groups.set(path, bucket)
  }
  if (groups.size === 0) return undefined
  const files = [...groups].map(([path, matches]) => ({ path, matches }))
  const total = files.reduce((sum, file) => sum + file.matches.length, 0)
  return { kind: 'matches', files, total, truncated: false, labels: placeholderSearchLabels }
}

const placeholderSearchLabels = {
  pathsSummary: () => '', matchesSummary: () => '', copy: '', copied: '', noResults: '',
  collapseAria: '', expandAria: () => '', collapse: '', expand: () => '',
} satisfies SearchBlockProps['labels']

function parseWeb(record: Record<string, unknown>, name: string): WebBlockProps | undefined {
  const normalized = name.toLocaleLowerCase()
  const sources = Array.isArray(record.sources) ? record.sources.flatMap(value => {
    const source = asRecord(value)
    if (source === undefined || typeof source.url !== 'string') return []
    const snippet = typeof source.snippet === 'string' ? source.snippet
      : typeof source.description === 'string' ? source.description : undefined
    return [{
      url: source.url,
      ...(typeof source.title === 'string' ? { title: source.title } : {}),
      ...(snippet === undefined ? {} : { snippet }),
      ...(typeof source.publishedAt === 'string' ? { publishedAt: source.publishedAt } : {}),
    }]
  }) : []
  if (WEB_SEARCH_NAMES.has(normalized) && (sources.length > 0 || typeof record.answer === 'string')) {
    return { kind: 'search', sources, truncated: record.truncated === true,
      ...(typeof record.answer === 'string' ? { answer: record.answer } : {}), labels: placeholderWebLabels }
  }
  if (WEB_FETCH_NAMES.has(normalized) && typeof record.url === 'string' && finiteNumber(record.statusCode) !== undefined) {
    return { kind: 'fetch', url: record.url, statusCode: finiteNumber(record.statusCode) ?? 0,
      truncated: record.truncated === true, labels: placeholderWebLabels }
  }
  return undefined
}

const placeholderWebLabels = {
  noResults: '', sourcesTruncated: '', http: 'HTTP', contentTruncated: '',
  markdown: { code: { copyLabel: '', copiedLabel: '' }, footnotes: '' },
} satisfies WebBlockProps['labels']

function buildRead(details: ToolDetails, path: string | undefined, output: string, artifacts: readonly FileArtifact[]) {
  const artifact = artifacts.find(item => item.kind === 'read' && item.after !== undefined)
  const artifactLines = artifact?.after?.split(/\r?\n/u)
  const lines = details.lines ?? (artifactLines !== undefined
    ? artifactLines.map((text, index) => ({ number: (artifact?.lineStart ?? 1) + index, text }))
    : output === '' ? undefined : output.split(/\r?\n/u).map((text, index) => ({ number: index + 1, text })))
  if (lines === undefined) return undefined
  return { lines, totalLines: details.totalLines ?? artifactLines?.length ?? lines.length }
}

function argsDiff(args: Readonly<Record<string, unknown>>): DiffHunk[] | undefined {
  const path = stringField(args, ['path', 'filePath', 'file_path', 'file'])
  const oldText = stringField(args, ['oldText', 'old_text', 'before'])
  const newText = stringField(args, ['newText', 'new_text', 'after'])
  return path !== undefined && newText !== undefined ? [{ path, oldText: oldText ?? null, newText }] : undefined
}

function summaryFor(
  normalizedName: string,
  args: Readonly<Record<string, unknown>>,
  path: string | undefined,
  command: string | undefined,
  description: string | undefined,
  record: Record<string, unknown> | undefined,
  output: string,
  t: (chinese: string, english: string) => string,
): string {
  if (command !== undefined) return firstLine(description ?? command)
  // A code-mode call's whole argument is the script; its first line is the live detail.
  if (normalizedName === CODEMODE_TOOL_NAME) {
    const script = typeof args.code === 'string' ? firstLine(args.code) : ''
    if (script !== '') return script
  }
  const query = stringField(args, ['query', 'pattern', 'searchQuery'])
    ?? (record === undefined ? undefined : stringField(record, ['query', 'pattern']))
  // A search row names what was searched for, not where it searched.
  const searchQuery = query === undefined ? '' : firstLine(query)
  if (SEARCH_NAMES.has(normalizedName) && searchQuery !== '') {
    return t(`查找 ${searchQuery}`, `Find ${searchQuery}`)
  }
  if (normalizedName === 'list_files') {
    // Listings are shown as the real request, so the row needs no decoding.
    return JSON.stringify({ name: 'list_files', arguments: args }, null, 1).replace(/\n\s*/gu, ' ')
  }
  if (path !== undefined) return path
  if (query !== undefined) return firstLine(query)
  if (output !== '') return firstLine(output)
  return emptyLabel(normalizedName, t)
}

function emptyLabel(name: string, t: (chinese: string, english: string) => string): string {
  if (COMMAND_NAMES.has(name)) return t('查看命令输出', 'View command output')
  if (READ_NAMES.has(name)) return t('查看文件内容', 'View file content')
  if (WRITE_NAMES.has(name)) return t('查看写入结果', 'View write result')
  if (EDIT_NAMES.has(name)) return t('查看文件差异', 'View file changes')
  if (WEB_SEARCH_NAMES.has(name) || SEARCH_NAMES.has(name)) return t('查看搜索结果', 'View search results')
  if (WEB_FETCH_NAMES.has(name)) return t('查看网页内容', 'View page content')
  return t('查看结果', 'View result')
}

function dedupeArtifacts(artifacts: readonly FileArtifact[]): FileArtifact[] {
  const seen = new Set<string>()
  return artifacts.filter(artifact => {
    const key = JSON.stringify({ kind: artifact.kind, path: artifact.path, before: artifact.before ?? null,
      after: artifact.after ?? null, diff: artifact.diff ?? null })
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function stringField(record: Readonly<Record<string, unknown>>, keys: readonly string[]): string | undefined {
  for (const key of keys) if (typeof record[key] === 'string') return record[key]
  return undefined
}

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const items = value.filter((entry): entry is string => typeof entry === 'string')
  return items.length === value.length ? items : undefined
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function firstLine(value: string): string {
  return value.split(/\r?\n/u)[0]?.trim() ?? ''
}

function languageFromPath(path: string | undefined): string | undefined {
  if (path === undefined) return undefined
  const extension = path.split('.').at(-1)?.toLocaleLowerCase()
  if (extension === undefined || extension === path.toLocaleLowerCase()) return undefined
  const aliases: Record<string, string> = {
    cjs: 'javascript', cts: 'typescript', htm: 'html', mdx: 'markdown', mjs: 'javascript', mts: 'typescript',
    py: 'python', rb: 'ruby', rs: 'rust', sh: 'bash', tsx: 'tsx', jsx: 'jsx', yml: 'yaml',
  }
  return aliases[extension] ?? extension
}

/* ---------- Late question answers: the reply bubble and the ask_user_question row ---------- */

/** One question as echoed back inside a late answer payload. */
export interface LateAnswerQuestion {
  readonly id: string
  readonly question: string
  readonly header?: string
  readonly detail?: string
  readonly options?: readonly LateAnswerOption[]
  readonly multiSelect?: boolean
}

/** One choice as echoed back inside a late answer payload. */
export interface LateAnswerOption {
  readonly label: string
  readonly description?: string
}

/** One recorded answer of a late answer payload. */
export interface LateAnswerEntry {
  readonly id: string
  readonly selected: readonly string[]
  readonly custom?: string
}

/** One question paired with the values its answer holds, in display order. */
export interface LateAnswerRow {
  readonly question: LateAnswerQuestion
  readonly answers: readonly string[]
}

/**
 * A `answer_to_pending_question` payload: the question set echoed back with the
 * recorded answers. The runtime steers it as a plain user message, so the
 * transcript recognizes it by parsing the message text at the conversation boundary.
 */
export interface LateAnswer {
  readonly callId: string
  readonly questions: readonly LateAnswerQuestion[]
  readonly answers: readonly LateAnswerEntry[]
  /** Model-facing payload text, rendered and copied when the payload holds no readable question. */
  readonly text: string
}

/** Read one late answer payload out of a user message's text; null when the text is not one. */
export function lateAnswerOf(text: string): LateAnswer | null {
  // Cheap guard before parsing, so ordinary prompts never reach JSON.parse.
  if (!text.includes(ANSWER_REPLY_KIND)) return null
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error
    return null
  }
  const record = asRecord(value)
  if (record === undefined || record.kind !== ANSWER_REPLY_KIND) return null
  return {
    callId: typeof record.callId === 'string' ? record.callId : '',
    questions: lateAnswerQuestions(record.questions),
    answers: lateAnswerEntries(record.answers),
    text,
  }
}

/** Echoed questions, dropping the entries a strict reader cannot render. */
function lateAnswerQuestions(value: unknown): LateAnswerQuestion[] {
  if (!Array.isArray(value)) return []
  const questions: LateAnswerQuestion[] = []
  for (const item of value) {
    const question = asRecord(item)
    if (question === undefined || typeof question.id !== 'string' || typeof question.question !== 'string') continue
    const options = lateAnswerOptions(question.options)
    questions.push({
      id: question.id,
      question: question.question,
      ...(typeof question.header === 'string' ? { header: question.header } : {}),
      ...(typeof question.detail === 'string' ? { detail: question.detail } : {}),
      ...(options === undefined ? {} : { options }),
      ...(typeof question.multiSelect === 'boolean' ? { multiSelect: question.multiSelect } : {}),
    })
  }
  return questions
}

/** Echoed options, dropping the entries without a label. */
function lateAnswerOptions(value: unknown): LateAnswerOption[] | undefined {
  if (!Array.isArray(value)) return undefined
  const options: LateAnswerOption[] = []
  for (const item of value) {
    const option = asRecord(item)
    if (option === undefined || typeof option.label !== 'string') continue
    options.push({ label: option.label, ...(typeof option.description === 'string' ? { description: option.description } : {}) })
  }
  return options
}

/** Recorded answers, dropping the entries a strict reader cannot render. */
function lateAnswerEntries(value: unknown): LateAnswerEntry[] {
  if (!Array.isArray(value)) return []
  const answers: LateAnswerEntry[] = []
  for (const item of value) {
    const answer = asRecord(item)
    if (answer === undefined || typeof answer.id !== 'string' || !Array.isArray(answer.selected)) continue
    answers.push({
      id: answer.id,
      selected: answer.selected.filter((entry): entry is string => typeof entry === 'string'),
      ...(typeof answer.custom === 'string' ? { custom: answer.custom } : {}),
    })
  }
  return answers
}

/** Answer values of one question in display order: the chosen labels, then a non-blank custom answer. */
export function lateAnswerValues(data: LateAnswer, id: string): string[] {
  const answer = data.answers.find(item => item.id === id)
  const custom = answer?.custom?.trim() ?? ''
  return [...(answer?.selected ?? []), ...(custom === '' ? [] : [custom])]
}

/** Pair every echoed question with the values of its answer; a skipped question holds none. */
export function lateAnswerRows(data: LateAnswer): LateAnswerRow[] {
  return data.questions.map(question => ({ question, answers: lateAnswerValues(data, question.id) }))
}

/**
 * Collapsed one-line summary: each question's values joined by 、, a skipped
 * question reads 已跳过, and a batch with no answer at all reads just 已跳过.
 * Empty when the payload echoed no readable question.
 */
export function lateAnswerSummary(data: LateAnswer, t: Translate): string {
  if (data.questions.length === 0) return ''
  const rows = lateAnswerRows(data)
  const separator = t('、', ', ')
  if (rows.every(row => row.answers.length === 0)) return t('已跳过', 'Skipped')
  return rows.map(row => row.answers.length === 0 ? t('已跳过', 'Skipped') : row.answers.join(separator)).join(separator)
}

/**
 * Clipboard text of one late reply: every question with the answer the user
 * gave, in the layout the open bubble shows, without the options nobody chose.
 * @returns One block per question, or the model-facing text when the payload was unreadable.
 */
export function lateAnswerClipboardText(data: LateAnswer, t: Translate): string {
  if (data.questions.length === 0) return data.text
  return lateAnswerRows(data).map(({ question, answers }) => {
    const heading = question.header !== undefined && question.header !== question.question
      ? `${question.header} — ${question.question}`
      : question.question
    const answer = answers.length === 0
      ? t('已跳过', 'Skipped')
      : `${t('回答：', 'Answer: ')}${answers.join(t('、', ', '))}`
    return `${heading}\n${answer}`
  }).join('\n\n')
}

/** One question of a call's read-only record with the values the user chose. */
export interface AskQuestionRecordItem {
  readonly id: string
  readonly question: string
  readonly answers: readonly string[]
}

/** What the `ask_user_question` row expands into: the asked questions, answered or still waiting. */
export interface AskQuestionRecord {
  /** True while the record holds no answers yet, so the list shows the questions alone. */
  readonly waiting: boolean
  readonly items: readonly AskQuestionRecordItem[]
  /** DSH's record verdict line: present for continued, closed, and cancelled sets. */
  readonly verdict?: string
}

/** Everything the `ask_user_question` row shows: its title, collapsed summary, and record. */
export interface AskQuestionRowModel {
  /** Row title in DSH's wording. */
  readonly title: string
  /** Collapsed summary: the answered progress and status, or the failure wording. */
  readonly summary: string
  /** Read-only question record; null when pairing the recorded answers would be ambiguous. */
  readonly record: AskQuestionRecord | null
}

/**
 * Build the `ask_user_question` row from the call's arguments and result plus what the
 * projected interaction says about it. The projection is the state machine DSH reads
 * too: `pending` still waits for an answer, `continued` keeps the row answerable after
 * the agent moved on, `expired` closed it, `cancelled` is the user's own dismissal, and
 * `answered` settles it. The late reply is the newer truth, so it wins over both.
 * @returns The row model, or null when this is not a question call.
 */
export function askQuestionRowModel(input: {
  readonly name: string
  readonly args: Readonly<Record<string, unknown>>
  readonly details: unknown
  readonly failed: boolean
  readonly reply?: LateAnswer | undefined
  /** The projected interaction status of this call, when the transcript was given the list. */
  readonly status?: InteractionStatus | undefined
}, t: Translate): AskQuestionRowModel | null {
  if (!QUESTION_TOOL_NAMES.has(input.name.toLocaleLowerCase())) return null
  const details = asRecord(input.details)
  const questions = askedQuestions(input.args.questions) ?? askedQuestions(details?.questions)
  const answers = input.reply !== undefined ? input.reply.answers : recordedAnswers(details?.answers)
  const title = t('提问', 'Ask question')
  if (input.failed) return { title, summary: t('提问失败', 'Question failed'), record: null }
  const answered = input.reply !== undefined || details?.status === 'answered' || answers !== null || input.status === 'answered'
  const waitingRecord = (verdict?: string): AskQuestionRecord | null => questions === null
    ? null
    : { waiting: true, items: questions.map(question => ({ ...question, answers: [] })), ...(verdict === undefined ? {} : { verdict }) }
  if (!answered) {
    const progress = questions === null ? '' : `0 / ${String(questions.length)} · `
    // DSH's row states: still waiting, or continued but still answerable; expired and
    // cancelled rows carry a verdict instead of the progress prefix.
    if (input.status === 'continued') {
      return { title, summary: t('已继续工作，仍可回答', 'continued; answer still available'), record: waitingRecord(t('等待中的问题仍可在输入框中回答', 'These pending questions remain answerable from the composer.')) }
    }
    if (input.status === 'expired') {
      return { title, summary: t('已结束', 'closed'), record: waitingRecord(t('该问题已结束，结果见下方对话', 'This question is closed; its outcome is in the conversation below.')) }
    }
    if (input.status === 'cancelled') {
      return { title, summary: t('已取消', 'cancelled'), record: waitingRecord(t('本轮已取消，未提交回答', 'This question set was cancelled before answers were submitted.')) }
    }
    return {
      title,
      summary: `${progress}${t('等待回答', 'waiting')}`,
      record: waitingRecord(),
    }
  }
  // Strict pairing needs stable ids and valid visible fields; the legacy
  // best-effort count still reports what the batch answered when it is unsafe.
  const paired = questions === null || answers === null ? null : pairAskedAnswers(questions, answers)
  const summary = answers === null
    ? t('已回答', 'Answered')
    : `${String(answeredCount(answers))} / ${String(answers.length)} · ${t('已回答', 'Answered')}`
  return { title, summary, record: paired === null ? null : { waiting: false, items: paired } }
}

/** Question ids and texts from one arguments or details field; null when the set is ambiguous. */
function askedQuestions(value: unknown): { readonly id: string; readonly question: string }[] | null {
  if (!Array.isArray(value) || value.length === 0) return null
  const questions: { id: string; question: string }[] = []
  const ids = new Set<string>()
  for (const item of value) {
    const question = asRecord(item)
    if (question === undefined || typeof question.id !== 'string' || typeof question.question !== 'string' || ids.has(question.id)) return null
    ids.add(question.id)
    questions.push({ id: question.id, question: question.question })
  }
  return questions
}

/** Answer batch from a tool result; null when it is absent or malformed. */
function recordedAnswers(value: unknown): LateAnswerEntry[] | null {
  if (!Array.isArray(value)) return null
  const answers: LateAnswerEntry[] = []
  for (const item of value) {
    const answer = asRecord(item)
    if (answer === undefined || typeof answer.id !== 'string' || !Array.isArray(answer.selected)
      || !answer.selected.every(entry => typeof entry === 'string')
      || (answer.custom !== undefined && typeof answer.custom !== 'string')) return null
    answers.push({
      id: answer.id,
      selected: answer.selected,
      ...(answer.custom === undefined ? {} : { custom: answer.custom }),
    })
  }
  return answers
}

/** Pair questions with their answers by id; null when either set makes the pairing ambiguous. */
function pairAskedAnswers(
  questions: readonly { readonly id: string; readonly question: string }[],
  answers: readonly LateAnswerEntry[],
): AskQuestionRecordItem[] | null {
  if (questions.length !== answers.length) return null
  const byId = new Map<string, LateAnswerEntry>()
  for (const answer of answers) {
    if (byId.has(answer.id)) return null
    byId.set(answer.id, answer)
  }
  const paired: AskQuestionRecordItem[] = []
  for (const question of questions) {
    const answer = byId.get(question.id)
    if (answer === undefined) return null
    const custom = answer.custom?.trim() ?? ''
    paired.push({ id: question.id, question: question.question, answers: [...answer.selected, ...(custom === '' ? [] : [custom])] })
  }
  return paired
}

/** Answers a batch actually holds, counted the way DSH counts them on the row. */
function answeredCount(answers: readonly LateAnswerEntry[]): number {
  return answers.filter(answer => answer.selected.length > 0 || (answer.custom ?? '').trim() !== '').length
}

/**
 * A `dismissed_pending_question` payload: the runtime's record that the user gave up a
 * pending question set. DSH has no user message for this (its waterfall rejects with
 * `ASK_CANCELLED`), so the transcript recognizes the steered payload and shows a compact
 * bubble instead of the raw JSON; the tool row carries the cancelled record.
 */
export interface QuestionDismissal {
  readonly callId: string
  /** The model-facing payload text, kept for the session-log reader. */
  readonly text: string
}

/** Read one dismissal payload out of a user message's text; null when the text is not one. */
export function dismissedQuestionOf(text: string): QuestionDismissal | null {
  // Cheap guard before parsing, so ordinary prompts never reach JSON.parse.
  if (!text.includes(DISMISSAL_REPLY_KIND)) return null
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error
    return null
  }
  const record = asRecord(value)
  if (record === undefined || record.kind !== DISMISSAL_REPLY_KIND) return null
  return { callId: typeof record.callId === 'string' ? record.callId : '', text }
}

/** Everything the `subagent` call row shows: DSH's `started subagent <id>` receipt. */
export interface SubagentRowModel {
  /** Row title in DSH's wording. */
  readonly title: string
  /** Collapsed summary: the delegation started and its label plus child conversation id. */
  readonly summary: string
  /** The child conversation the row can open; absent when the tool never recorded one. */
  readonly childId?: string
  /** The delegation label the child recorded; the strip names its chip with it. */
  readonly label?: string
  /** The delegated task text, shown in place of the raw JSON arguments. */
  readonly task?: string
}

/**
 * Build the `subagent` row from the call's arguments and its details. DSH renders the
 * activation as `started subagent <id>` plus a receipt card carrying the delegated task;
 * Pi's foreground tool returns the child's answer, so the row keeps that answer as its
 * body while the summary names the started delegation, its label, and the child id.
 * @returns The row model, or null when this is not a subagent call.
 */
export function subagentRowModel(input: {
  readonly name: string
  readonly args: Readonly<Record<string, unknown>>
  readonly details: unknown
  readonly failed: boolean
}, t: Translate): SubagentRowModel | null {
  if (input.name.toLocaleLowerCase() !== 'subagent') return null
  // A live tool message nests the extension's payload under `result` (`projection.ts:liveToolMessages`);
  // a settled result carries it directly.
  const record = asRecord(input.details)
  const details = asRecord(record?.result) ?? record
  const childId = typeof details?.conversationId === 'string' && details.conversationId !== '' ? details.conversationId : undefined
  const label = typeof details?.label === 'string' && details.label.trim() !== '' ? details.label.trim() : undefined
  const task = typeof input.args.task === 'string' && input.args.task.trim() !== '' ? input.args.task : undefined
  const title = t('子智能体', 'Subagent')
  const summary = [t('已开始子智能体', 'Started subagent'), label, childId].filter(part => part !== undefined).join(t(' · ', ' · '))
  return {
    title,
    summary,
    ...(childId === undefined ? {} : { childId }),
    ...(label === undefined ? {} : { label }),
    ...(task === undefined ? {} : { task }),
  }
}

/* ---------- Code mode: the `codemode` row and the tool calls its script made ---------- */

/** One tool call a script made, matching Pi's `CodemodeNestedCall` result details. */
export type CodemodeCallStatus = 'running' | 'ok' | 'error' | 'cancelled'

export interface CodemodeCallView {
  /** The VM's call number, as a stable list key. */
  readonly id: string
  readonly name: string
  /** Compact JSON of the call arguments, kept as the row's hover text. */
  readonly args: string
  readonly status: CodemodeCallStatus
  readonly durationMs?: number
  /** The failure text, shown under the call row. */
  readonly error?: string
}

/** Everything the `codemode` row shows: the script, its nested calls, and the result text. */
export interface CodemodeRowModel {
  /** Row title in DSH's wording. */
  readonly title: string
  /** Collapsed live detail: the script's first line, falling back to the result's first line. */
  readonly summary: string
  /** The script the call ran; empty for a result recorded without its call. */
  readonly script: string
  /** The tool result text (the script's console output and returned value). */
  readonly output: string
  /** The tool calls the script made, in the order it made them. */
  readonly calls: readonly CodemodeCallView[]
  /** Complete output file, when the result text was cut to its token budget. */
  readonly fullOutputPath?: string
}

const CODEMODE_CALL_STATUSES = new Set<string>(['running', 'ok', 'error', 'cancelled'])

/**
 * Build the `codemode` row from the call's script argument and the result's details.
 * A result without `details.calls` (a still-running call, or an older record) is not
 * specialized: the row falls back to the ordinary tool card.
 * @returns The row model, or null when this is not a code-mode call or has no call list.
 */
export function codemodeRowModel(input: {
  readonly name: string
  readonly args: Readonly<Record<string, unknown>>
  readonly details: unknown
  readonly output: string
}, t: Translate): CodemodeRowModel | null {
  if (input.name.toLocaleLowerCase() !== CODEMODE_TOOL_NAME) return null
  // The durable details can arrive as a record or as a JSON string.
  const details = detailsRecordFor(input.details, '')
  if (details === undefined || !Array.isArray(details.calls)) return null
  const script = typeof input.args.code === 'string' ? input.args.code : ''
  const fullOutputPath = typeof details.fullOutputPath === 'string' && details.fullOutputPath.trim() !== ''
    ? details.fullOutputPath
    : undefined
  return {
    title: t('代码', 'Code'),
    summary: firstLine(script) || firstLine(input.output),
    script,
    output: input.output,
    calls: parseCodemodeCalls(details.calls),
    ...(fullOutputPath === undefined ? {} : { fullOutputPath }),
  }
}

/** The nested call list, dropping the entries a strict reader cannot show. */
function parseCodemodeCalls(value: readonly unknown[]): CodemodeCallView[] {
  const calls: CodemodeCallView[] = []
  for (const entry of value) {
    const call = asRecord(entry)
    if (call === undefined || typeof call.name !== 'string' || call.name === '') continue
    if (typeof call.status !== 'string' || !CODEMODE_CALL_STATUSES.has(call.status)) continue
    const id = typeof call.id === 'string' ? call.id
      : typeof call.id === 'number' && Number.isFinite(call.id) ? String(call.id)
        : String(calls.length)
    const durationMs = finiteNumber(call.durationMs)
    calls.push({
      id,
      name: call.name,
      args: codemodeCallArgs(call.args),
      status: call.status as CodemodeCallStatus,
      ...(durationMs === undefined ? {} : { durationMs }),
      ...(typeof call.error === 'string' && call.error !== '' ? { error: call.error } : {}),
    })
  }
  return calls
}

/** Compact argument text; arrays and records are serialized, unreadable values read as empty. */
function codemodeCallArgs(value: unknown): string {
  if (typeof value === 'string') return value
  if (value === undefined) return ''
  try {
    return JSON.stringify(value) ?? ''
  } catch (error) {
    if (!(error instanceof TypeError)) throw error
    return ''
  }
}

