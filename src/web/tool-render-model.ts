import type {
  DiffHunk, ReadBlockLine, SearchBlockProps, WebBlockProps,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { FileArtifact } from '../shared/types.ts'
import { asRecord, messageOutput, type ToolItem } from './render-model.ts'

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

/** Localize the activity heading shown while a tool is running. */
export function toolActivityTitle(name: string, t: (chinese: string, english: string) => string): string {
  return semanticTitle(name.toLocaleLowerCase(), t).running
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
  const semantic = semanticTitle(normalizedName, t)
  const summary = failed ? firstLine(output) || t('执行失败', 'Failed')
    : cancelled ? t('已停止', 'Stopped')
      : running ? semantic.running
        : summaryFor(normalizedName, args, path, command, detailsRecord, output, t)
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
    title: semantic.title,
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
      || WEB_SEARCH_NAMES.has(normalizedName) || WEB_FETCH_NAMES.has(normalizedName),
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
  record: Record<string, unknown> | undefined,
  output: string,
  t: (chinese: string, english: string) => string,
): string {
  if (command !== undefined) return firstLine(command)
  if (path !== undefined) return path
  const query = stringField(args, ['query', 'pattern', 'searchQuery'])
    ?? (record === undefined ? undefined : stringField(record, ['query', 'pattern']))
  if (query !== undefined) return firstLine(query)
  if (output !== '') return firstLine(output)
  return semanticTitle(normalizedName, t).empty
}

function semanticTitle(name: string, t: (chinese: string, english: string) => string) {
  if (COMMAND_NAMES.has(name)) return { title: t('执行了命令', 'Ran command'), running: t('正在执行命令', 'Running command'), empty: t('查看命令输出', 'View command output') }
  if (READ_NAMES.has(name)) return { title: t('读取了文件', 'Read file'), running: t('正在读取文件', 'Reading file'), empty: t('查看文件内容', 'View file content') }
  if (WRITE_NAMES.has(name)) return { title: t('写入了文件', 'Wrote file'), running: t('正在写入文件', 'Writing file'), empty: t('查看写入结果', 'View write result') }
  if (EDIT_NAMES.has(name)) return { title: t('编辑了文件', 'Edited file'), running: t('正在编辑文件', 'Editing file'), empty: t('查看文件差异', 'View file changes') }
  if (WEB_SEARCH_NAMES.has(name)) return { title: t('搜索了网页', 'Searched the web'), running: t('正在搜索网页', 'Searching the web'), empty: t('查看搜索结果', 'View search results') }
  if (WEB_FETCH_NAMES.has(name)) return { title: t('读取了网页', 'Fetched a page'), running: t('正在读取网页', 'Fetching a page'), empty: t('查看网页内容', 'View page content') }
  if (SEARCH_NAMES.has(name)) return { title: t('搜索了文件', 'Searched files'), running: t('正在搜索文件', 'Searching files'), empty: t('查看搜索结果', 'View search results') }
  return { title: name, running: t('正在运行', 'Running'), empty: t('查看结果', 'View result') }
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

