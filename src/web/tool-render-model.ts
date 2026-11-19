import type {
  DiffHunk, ReadBlockLine, SearchBlockProps, WebBlockProps,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { FileArtifact, InteractionStatus } from '../shared/types.ts'
import { asRecord, messageOutput, parseJsonRecord, parseRecordedCodemodeCalls, toolActivity, type ActivityCount, type RecordedCodemodeCall, type RecordedCodemodeStatus, type ToolItem, type ToolActivity } from './render-model.ts'
import type { Translate } from './render-labels.ts'
import { failedToolTitle, toolFailureReason } from './tool-failure-presentation.ts'

/** pending 提问被应答时，运行时注入会话的载荷 kind。 */
export const ANSWER_REPLY_KIND = 'answer_to_pending_question'

/** 用户关掉一组提问时，运行时注入会话的载荷 kind。 */
export const DISMISSAL_REPLY_KIND = 'dismissed_pending_question'

/** 行内展示只读提问记录（而非通用工具摘要）的提问类工具。 */
const QUESTION_TOOL_NAMES = new Set(['ask_user_question', 'request_user_input'])

/** Pi 的代码模式工具：一次调用以会话工具为依赖运行一段模型写的脚本。 */
export const CODEMODE_TOOL_NAME = 'codemode'

/** Pi 的 codemode 嵌套调用名形如 `mcp__<server>__<tool>`；DSH 的标题规则相同。 */
const MCP_TOOL_NAME = /^mcp__(.+?)__(.+)$/iu

/** DSH 对 `mcp__server__tool` 名称的行标题；其他工具返回 undefined。 */
function mcpRowTitle(name: string): string | undefined {
  const match = MCP_TOOL_NAME.exec(name)
  return match === null ? undefined : `MCP · ${match[1]} · ${match[2]}`
}

/**
 * 一条工具行的完整渲染模型：从持久工具调用解析出标题、摘要、输出与特化载荷
 * （read/diffs/search/web），以及运行/失败/取消等状态。
 */
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
  readonly read?: { readonly lines: readonly ReadBlockLine[]; readonly totalLines: number; readonly line?: number } | undefined
  readonly diffs?: readonly DiffHunk[] | undefined
  readonly search?: SearchBlockProps | undefined
  readonly web?: WebBlockProps | undefined
  readonly artifacts: readonly FileArtifact[]
  readonly details?: unknown
  readonly args: Readonly<Record<string, unknown>>
  readonly running: boolean
  readonly failed: boolean
  readonly cancelled: boolean
  readonly failureReason?: string
  readonly knownPresentation: boolean
}


/** 某分类「进行中」的分组标题文案，措辞对齐 DSH。 */
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

/** 某分类「已落定」的分组标题文案，措辞对齐 DSH。 */
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
 * 功能：DSH 式的落定分组标题——取前三类分类，用「并」或「，」连接，超过三类以「等」收尾；
 * 中文里两半都带「已」前缀时共享一次。
 * @param counts 按调用数排序的分类计数
 * @param t 双语标签函数
 * @returns 标题字符串；无分类时「已完成分析」
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

/**
 * 行标题，采用 ZCode summary 行的完成态动词（「已读取」「已执行」，运行中为「正在…」）。
 * MCP、技能、团队、计划等特殊工具保留各自的命名，不套完成态前缀。
 */
export function toolRowTitle(name: string, t: Translate, running = false): string {
  // MCP 名称渲染为 `MCP · server · tool`；分类图标保持通用。
  const mcp = mcpRowTitle(name)
  if (mcp !== undefined) return mcp
  const id = name.toLocaleLowerCase()
  if (id === CODEMODE_TOOL_NAME) return running ? t('正在运行脚本', 'Running script') : t('已运行脚本', 'Ran script')
  if (id === 'list_files') return running ? t('正在列出目录', 'Listing directory') : t('已列出目录', 'Listed directory')
  // pi-web 把 ZCode 的单个 Skill 工具拆成四个；每行各自命名自己的操作。
  if (id === 'skill' || id === 'skill_load') return t('技能', 'Skill')
  if (id === 'skill_list') return t('技能列表', 'Skill list')
  if (id === 'skill_save') return t('保存技能', 'Save skill')
  if (id === 'skill_validate') return t('校验技能', 'Validate skill')
  if (id === 'task_stop') return t('停止任务', 'Stop task')
  // 无头 Chrome 工具：按操作命名，行标题不回退到原始 JSON。
  if (id === 'browser') return t('浏览器', 'Browser')
  // 团队家族：ZCode 没有对应物，但行标题不能回退成原始 JSON。
  if (id === 'spawn_teammate') return t('组建队友', 'Spawn teammate')
  if (id === 'wait_agent') return t('等待队友', 'Wait for teammate')
  if (id === 'send_message') return t('发消息', 'Message')
  if (id === 'list_agents') return t('成员名册', 'Team roster')
  if (id === 'interrupt_agent') return t('中断队友', 'Interrupt teammate')
  if (id === 'team_task_create') return t('新建团队任务', 'New team task')
  if (id === 'team_task_list') return t('团队任务板', 'Team task board')
  if (id === 'team_task_get') return t('查看团队任务', 'Team task detail')
  if (id === 'team_task_update') return t('更新团队任务', 'Update team task')
  switch (toolActivity(id)) {
    case 'read': case 'readImage': return running ? t('正在读取', 'Reading') : t('已读取', 'Read')
    case 'search': case 'webSearch': return running ? t('正在搜索', 'Searching') : t('已搜索', 'Searched')
    case 'webFetch': return running ? t('正在抓取', 'Fetching') : t('已抓取', 'Fetched')
    case 'write': case 'edit': return running ? t('正在修改', 'Editing') : t('已修改', 'Changed')
    case 'commands': case 'code': return running ? t('正在执行', 'Running') : t('已执行', 'Ran')
    case 'plan': return t('待办', 'Todos')
    default: return t('工具调用', 'Tool call')
  }
}

/** DSH 的直播细节字段优先级：第一个有文本的字段胜出。 */
const LIVE_DETAIL_KEYS = [
  'title', 'description', 'objective', 'task', 'task_name', 'name', 'question', 'questions', 'prompt', 'message',
  'command', 'cmd', 'code', 'queries', 'query', 'pattern', 'url', 'uri', 'file_path', 'path', 'target', 'action', 'status',
] as const

/**
 * 功能：为运行中的分组标题取一行直播细节：按 LIVE_DETAIL_KEYS 优先级找第一个
 * 非空字段，空白规整为单行，160 字符截断。
 * @param args 工具调用参数
 * @returns 细节文本；无可读字段返回空串
 */
export function toolLiveDetail(args: Readonly<Record<string, unknown>>): string {
  for (const key of LIVE_DETAIL_KEYS) {
    const value = args[key]
    const text = typeof value === 'string' ? value : Array.isArray(value) && value.every(item => typeof item === 'string') ? value.join(', ') : ''
    // codemode 脚本是一段程序而非单行参数：首行即直播细节。
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

/** 各家族工具名集合，用于选择卡片形态与 knownPresentation 判定。 */
const COMMAND_NAMES = new Set(['bash', 'shell', 'exec', 'terminal', 'run_command'])
const TEAM_NAMES = new Set(['spawn_teammate', 'wait_agent', 'send_message', 'list_agents', 'interrupt_agent', 'team_task_create', 'team_task_list', 'team_task_get', 'team_task_update'])
const READ_NAMES = new Set(['read', 'read_file', 'readfile', 'cat', 'read_text_file'])
const WRITE_NAMES = new Set(['write', 'write_file', 'writefile', 'create_file'])
const EDIT_NAMES = new Set(['edit', 'edit_file', 'apply_patch', 'patch'])
const SEARCH_NAMES = new Set(['search', 'search_files', 'grep', 'ripgrep', 'glob', 'find_files', 'find'])
const WEB_SEARCH_NAMES = new Set(['web_search', 'search_web', 'browser_search'])
const WEB_FETCH_NAMES = new Set(['web_fetch', 'fetch_url', 'fetch'])

/** pi-web 把 ZCode 的单个 Skill 工具拆成四个；四者共用同一张卡片。 */
const SKILL_TOOL_NAMES = new Set(['skill_load', 'skill_list', 'skill_save', 'skill_validate'])

/**
 * 功能：把一条持久化的 Pi 工具调用转换成对应的 DSH 结果原语（工具行渲染模型）。
 * @param item 工具渲染项（调用块 + 结果消息）
 * @param t 双语标签函数
 * @param runRunning 父 run 是否在运行（无结果时用于判定 running）
 * @returns ToolRenderModel；knownPresentation 表示能用专用卡片渲染
 * 内部逻辑：details 依次从 result.details、其 JSON 字符串、输出文本解析；diffs 优先 details，其次首个写/编辑产物的 before/after，最后从参数 oldText/newText 推；read 行从 details.lines、read 产物或输出文本构建；search/web 从 details 或输出文本行解析；running = 结果流式/running，或无结果且调用消息流式/父 run 在跑。
 */
export function buildToolRenderModel(item: ToolItem, t: (chinese: string, english: string) => string, runRunning: boolean): ToolRenderModel {
  const message = item.result ?? item.message
  const name = item.call?.name ?? message.toolName ?? 'tool'
  const normalizedName = name.toLocaleLowerCase()
  const output = messageOutput(item.result)
  const detailsRecord = detailsRecordFor(item.result?.details, output)
  const args = item.call?.arguments ?? asRecord(detailsRecord?.arguments) ?? {}
  const details = parseDetails(detailsRecord, name, output)
  const artifactValues = item.result?.artifacts ?? []
  const artifacts = dedupeArtifacts(artifactValues)
  // A script can touch several files. Its artifacts are link targets for the answer,
  // while the script row still opens the code and its individual calls.
  const ownFiles = normalizedName === CODEMODE_TOOL_NAME ? [] : artifactValues
  const primaryArtifact = ownFiles.find(artifact => artifact.kind === 'edit' || artifact.kind === 'write' || artifact.kind === 'nativeEdit')
  const fileArtifactDiff = primaryArtifact?.before !== undefined && primaryArtifact.after !== undefined
    ? [{ path: primaryArtifact.path, oldText: primaryArtifact.before, newText: primaryArtifact.after }]
    : undefined
  const readArtifact = ownFiles.find(artifact => artifact.kind === 'read')
  const path = stringField(asRecord(item.result?.details) ?? {}, ['resolvedPath'])
    ?? details.path ?? stringField(args, ['path', 'filePath', 'file_path', 'file']) ?? primaryArtifact?.path ?? readArtifact?.path
  const diffValues = details.diffs ?? fileArtifactDiff ?? argsDiff(args, path)
  const command = details.command ?? stringField(args, ['command', 'cmd', 'script'])
  const cwd = details.cwd ?? stringField(args, ['cwd', 'workingDirectory'])
  const language = details.language ?? stringField(args, ['language', 'lang']) ?? languageFromPath(path)
  const resultStatus = item.result?.status ?? item.message.status
  const running = item.result?.streaming === true || resultStatus === 'running'
    || item.result === undefined && (item.message.streaming === true || runRunning)
  const failed = item.result?.isError === true || resultStatus === 'error'
  const cancelled = resultStatus === 'cancelled'
  const description = stringField(args, ['description', 'title'])
  const scriptCalls = normalizedName === CODEMODE_TOOL_NAME ? recordedScriptCalls(detailsRecord) : []
  const summary = failed
    ? failureTarget(normalizedName, args, path, command, description, scriptCalls, t)
    : cancelled ? t('已停止', 'Stopped')
      : normalizedName === CODEMODE_TOOL_NAME ? scriptSummary(scriptCalls, t)
        : summaryFor(normalizedName, args, path, command, description, detailsRecord, output, t)
  const nestedFailures = scriptCalls.filter(call => call.status === 'error')
  const nestedFailure = nestedFailures.length === 1 ? nestedFailures[0] : undefined
  const failureReason = failed
    ? (toolFailureReason(normalizedName, detailsRecord, output, details.exitCode, t)
      ?? (nestedFailure && toolFailureReason(nestedFailure.name, undefined, nestedFailure.error ?? '', undefined, t)))
    : undefined
  const specialized = command !== undefined && COMMAND_NAMES.has(normalizedName)
    || READ_NAMES.has(normalizedName) && details.lines !== undefined
    || diffValues !== undefined && diffValues.length > 0
    || details.search !== undefined
    || details.web !== undefined
  const read = !failed && (READ_NAMES.has(normalizedName) || readArtifact !== undefined)
    ? buildRead(details, output, readArtifact, normalizedName === 'read' ? args.offset : undefined)
    : undefined
  return {
    name,
    title: failed ? failedToolTitle(normalizedName, t) : toolRowTitle(name, t, running),
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
    ...(failureReason !== undefined ? { failureReason } : {}),
    knownPresentation: specialized || COMMAND_NAMES.has(normalizedName) || READ_NAMES.has(normalizedName)
      || WRITE_NAMES.has(normalizedName) || EDIT_NAMES.has(normalizedName) || SEARCH_NAMES.has(normalizedName)
      || WEB_SEARCH_NAMES.has(normalizedName) || WEB_FETCH_NAMES.has(normalizedName) || normalizedName === 'list_files',
  }
}

/**
 * 功能：把 details 归一成 record：直接是对象就用；是字符串或仅在输出里时尝试
 * JSON 解析（超 1MB 不解析）。
 */
function detailsRecordFor(value: unknown, output: string): Record<string, unknown> | undefined {
  const direct = asRecord(value)
  if (direct !== undefined) return direct
  if (typeof value === 'string') {
    const parsed = parseJsonRecord(value)
    if (parsed !== undefined) return parsed
  }
  return parseJsonRecord(output)
}

/**
 * 功能：从 details record 解析结构化载荷（read 行、diff、search、web、命令/路径等）。
 * @param record details record（可 undefined）
 * @param name 工具名（决定 search/web 解析分支）
 * @param output 结果输出文本（兜底解析来源）
 * 内部逻辑：structuredOutput 字段（对象或 JSON 字符串）覆盖到 values 上；Skill 工具的 `files` 是资源路径列表，跳过通用 search 解析以免整行退化为只有摘要的搜索卡片。
 */
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
  // Skill 结果把资源路径列在 `files` 下；通用解析器会把它误读为路径搜索结果，
  // 把整行变成只有摘要的搜索卡片。
  const search = SKILL_TOOL_NAMES.has(name.toLocaleLowerCase())
    ? undefined
    : parseSearch(values) ?? parseSearchOutput(name, output)
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

/** 解析 read 行数组（number 缺省时按序补号），无有效行返回 undefined。 */
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

/** 解析 diff hunk 数组（path/oldText/newText 齐全才算数），空集返回 undefined。 */
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

/**
 * 功能：从 details record 解析搜索块：`paths`/`files` 为路径列表形态；否则把
 * `matches`/`results` 按文件路径分组成匹配形态。
 * @returns SearchBlockProps；无法解析返回 undefined（labels 用占位空文案，展示层再注入）
 */
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

/**
 * 功能：从输出文本兜底解析搜索结果：glob/find 类每行一个路径；grep/ripgrep/search
 * 按 `path:line:content` 格式分组成匹配。
 */
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

/** 解析层放不进真实双语标签，先用空占位；展示组件注入 render-labels 的真值。 */
const placeholderSearchLabels = {
  pathsSummary: () => '', matchesSummary: () => '', copy: '', copied: '', noResults: '',
  collapseAria: '', expandAria: () => '', collapse: '', expand: () => '',
} satisfies SearchBlockProps['labels']

/**
 * 功能：从 details record 解析网页块：web_search 需要 `sources`/`answer`；web_fetch 需要 `url` + `statusCode`。
 */
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

/** 网页块的空占位标签，展示组件注入真值。 */
const placeholderWebLabels = {
  noResults: '', sourcesTruncated: '', http: 'HTTP', contentTruncated: '',
  markdown: { code: { copyLabel: '', copiedLabel: '' }, footnotes: '' },
} satisfies WebBlockProps['labels']

/**
 * 功能：构建 read 行：行数据依次取 details.lines、read 产物全文、输出文本按行编号。
 * @returns 行数组与总行数；无法构建返回 undefined
 */
function buildRead(details: ToolDetails, output: string, artifact: FileArtifact | undefined, offset: unknown) {
  const requestedLine = typeof offset === 'number' && Number.isSafeInteger(offset) && offset > 0 ? offset : undefined
  const reportedLine = details.lines?.[0]?.number ?? artifact?.lineStart
  const line = requestedLine ?? (reportedLine !== undefined && reportedLine > 1 ? reportedLine : undefined)
  const artifactLines = artifact?.after?.split(/\r?\n/u)
  const readLines = artifactLines ?? (output === '' ? undefined : output.split(/\r?\n/u))
  const lines = details.lines ?? readLines?.map((text, index) => ({ number: (line ?? 1) + index, text }))
  if (lines === undefined) return undefined
  return { lines, totalLines: details.totalLines ?? artifactLines?.length ?? lines.length, line }
}

/** 从编辑类参数（path + oldText/newText）兜底构造单文件 diff。 */
function argsDiff(args: Readonly<Record<string, unknown>>, path: string | undefined): DiffHunk[] | undefined {
  const oldText = stringField(args, ['oldText', 'old_text', 'before'])
  const newText = stringField(args, ['newText', 'new_text', 'after'])
  return path !== undefined && newText !== undefined ? [{ path, oldText: oldText ?? null, newText }] : undefined
}

/**
 * 功能：推导折叠态行的摘要文案，按工具家族给人类可读的一行。
 * 内部逻辑：命令行优先（description 或命令首行）；团队行显示成员/消息；搜索行显示搜索词；list_files 显示目录及是否递归；其余按 path → query → 输出首行 → 家族空文案兜底。
 */
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
  // 团队行显示成员或消息，而不是倾倒结果 JSON。
  if (TEAM_NAMES.has(normalizedName)) {
    const member = stringField(args, ['name', 'target'])
    const text = stringField(args, ['description', 'message', 'subject'])
    const parts = [member, firstLine(text ?? '')].filter(part => part !== undefined && part !== '')
    if (parts.length > 0) return parts.join(' · ')
    if (normalizedName === 'wait_agent') return t('等待队友状态变化', 'Wait for teammate changes')
    if (normalizedName === 'list_agents') return t('查看成员名册', 'Team roster')
  }
  const query = stringField(args, ['query', 'pattern', 'searchQuery'])
    ?? (record === undefined ? undefined : stringField(record, ['query', 'pattern']))
  // 搜索行命名「搜了什么」，而不是「在哪搜」。
  const searchQuery = query === undefined ? '' : firstLine(query)
  if (SEARCH_NAMES.has(normalizedName) && searchQuery !== '') {
    return t(`查找 ${searchQuery}`, `Find ${searchQuery}`)
  }
  if (normalizedName === 'list_files') {
    return directorySummary(path, args.recursive === true, t)
  }
  if (path !== undefined) return compactToolPath(path)
  if (query !== undefined) return firstLine(query)
  if (output !== '') return firstLine(output)
  return emptyLabel(normalizedName, t)
}

/** Keep absolute paths out of compact rows. The actual path remains available for file navigation. */
export function compactToolPath(path: string): string {
  const normalized = path.replaceAll('\\', '/')
  const parts = normalized.split('/').filter(Boolean)
  if (parts.length <= 2) return normalized
  return `…/${parts.slice(-2).join('/')}`
}

function directorySummary(path: string | undefined, recursive: boolean, t: Translate): string {
  const target = path === undefined || path === '' || path === '.' || path === './'
    ? t('工作区根目录', 'Workspace root')
    : compactToolPath(path)
  return recursive ? t(`${target}，包含子目录`, `${target}, including subdirectories`) : target
}

function recordedScriptCalls(details: Record<string, unknown> | undefined): RecordedCodemodeCall[] {
  return parseRecordedCodemodeCalls(details?.calls ?? asRecord(details?.result)?.calls)
}

function scriptSummary(calls: readonly RecordedCodemodeCall[], t: Translate): string {
  if (calls.length === 0) return ''
  const call = calls[0]
  if (calls.length === 1 && call?.name === 'list_files') {
    const args = asRecord(call.args) ?? (typeof call.args === 'string' ? parseJsonRecord(call.args) : undefined)
    if (args) {
      const target = directorySummary(typeof args.path === 'string' ? args.path : undefined, args.recursive === true, t)
      if (call.status === 'error') return t(`未能列出 ${target}`, `Could not list ${target}`)
      if (call.status === 'ok') return t(`列出 ${target}`, `Listed ${target}`)
    }
  }
  const failed = calls.filter(call => call.status === 'error').length
  const count = t(`调用了 ${calls.length} 项工具`, `Called ${calls.length} tools`)
  return failed === 0 ? count : t(`${count}，其中 ${failed} 项失败`, `${count}, ${failed} failed`)
}

function failureTarget(name: string, args: Readonly<Record<string, unknown>>, path: string | undefined, command: string | undefined,
  description: string | undefined, scriptCalls: readonly RecordedCodemodeCall[], t: Translate): string {
  if (name === CODEMODE_TOOL_NAME) return scriptSummary(scriptCalls, t)
  if (name === 'list_files') return directorySummary(path, args.recursive === true, t)
  const query = stringField(args, ['query', 'pattern', 'searchQuery'])
  if (query?.trim() && (SEARCH_NAMES.has(name) || WEB_SEARCH_NAMES.has(name))) {
    return t(`查找 ${firstLine(query)}`, `Find ${firstLine(query)}`)
  }
  if (command !== undefined) {
    if (description) return firstLine(description).slice(0, 160)
    const executable = /^\s*([\w./-]+)(?:\s|$)/u.exec(command)?.[1]
    return executable === undefined ? '' : compactToolPath(executable)
  }
  if (path !== undefined) return compactToolPath(path)
  const target = stringField(args, ['skill', 'id', 'url', 'name', 'target'])
  return firstLine(description ?? target ?? '').slice(0, 160)
}

/** 各工具家族在「无任何细节」时的兜底摘要文案。 */
function emptyLabel(name: string, t: (chinese: string, english: string) => string): string {
  if (COMMAND_NAMES.has(name)) return t('查看命令输出', 'View command output')
  if (READ_NAMES.has(name)) return t('查看文件内容', 'View file content')
  if (WRITE_NAMES.has(name)) return t('查看写入结果', 'View write result')
  if (EDIT_NAMES.has(name)) return t('查看文件差异', 'View file changes')
  if (WEB_SEARCH_NAMES.has(name) || SEARCH_NAMES.has(name)) return t('查看搜索结果', 'View search results')
  if (WEB_FETCH_NAMES.has(name)) return t('查看网页内容', 'View page content')
  return t('查看结果', 'View result')
}

/** 按产物内容（kind/path/before/after/diff）去重。 */
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

/** 从 record 里按键序取第一个字符串字段。 */
function stringField(record: Readonly<Record<string, unknown>>, keys: readonly string[]): string | undefined {
  for (const key of keys) if (typeof record[key] === 'string') return record[key]
  return undefined
}

/** 全字符串数组；混入非字符串项返回 undefined。 */
function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const items = value.filter((entry): entry is string => typeof entry === 'string')
  return items.length === value.length ? items : undefined
}

/** 有限数字，其他取值返回 undefined。 */
function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/** 首行文本（去首尾空白）。 */
function firstLine(value: string): string {
  return value.split(/\r?\n/u)[0]?.trim() ?? ''
}

/** 由文件扩展名推断语言标注（含别名表），无扩展名或 dotfile 返回 undefined。 */
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

/* ---------- 迟到的问题应答：reply 气泡与 ask_user_question 行 ---------- */

/** 迟到应答载荷里回显的一个问题。 */
export interface LateAnswerQuestion {
  readonly id: string
  readonly question: string
  readonly header?: string
  readonly detail?: string
  readonly options?: readonly LateAnswerOption[]
  readonly multiSelect?: boolean
}

/** 迟到应答载荷里回显的一个选项。 */
export interface LateAnswerOption {
  readonly label: string
  readonly description?: string
}

/** 迟到应答载荷里记录的一条答案。 */
export interface LateAnswerEntry {
  readonly id: string
  readonly selected: readonly string[]
  readonly custom?: string
}

/**
 * 一个 `answer_to_pending_question` 载荷：回显的问题集与记录的答案。运行时把它作为
 * 普通用户消息注入，因此转录区在会话边界处解析消息文本来识别它。
 */
export interface LateAnswer {
  readonly callId: string
  readonly questions: readonly LateAnswerQuestion[]
  readonly answers: readonly LateAnswerEntry[]
  /** 面向模型的载荷原文；载荷里无可读问题时按它渲染与复制。 */
  readonly text: string
}

/**
 * 功能：从用户消息文本解析迟到应答载荷。
 * @returns LateAnswer；文本不是该载荷返回 null
 * 内部逻辑：解析前先用子串包含做廉价守卫，普通提示词不会走到 JSON.parse；SyntaxError 之外的异常照常抛出。
 */
export function lateAnswerOf(text: string): LateAnswer | null {
  // 解析前的廉价守卫，让普通提示词永远不进 JSON.parse。
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

/** 回显的问题列表；严格读取器渲染不了的条目直接丢弃。 */
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

/** 回显的选项列表；没有 label 的条目丢弃；输入不是数组返回 undefined。 */
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

/** 记录的答案列表；严格读取器渲染不了的条目直接丢弃。 */
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

/** 提问调用的只读记录中的一题，附用户选定的值。 */
export interface AskQuestionRecordItem {
  readonly id: string
  readonly question: string
  readonly answers: readonly string[]
}

/** `ask_user_question` 行展开内容：一题加上用户选定的值。 */
export interface AskQuestionRecordItem {
  readonly id: string
  readonly question: string
  readonly answers: readonly string[]
}

/** `ask_user_question` 行展开后的记录：一题加上用户选定的值。 */
export interface AskQuestionRecord {
  readonly items: readonly AskQuestionRecordItem[]
}

/** `ask_user_question` 行的全部展示信息：kind 标题、计数行与只读记录。 */
export interface AskQuestionRowModel {
  readonly title: string
  readonly summary: string
  /** 只读提问记录；询问中或答案配对存在歧义时为 null。 */
  readonly record: AskQuestionRecord | null
}

/**
 * 功能：从调用参数、结果与投影交互状态构建 `ask_user_question` 行模型。
 * 投影是 DSH 也读取的状态机：`pending` 仍在等答案；`continued` 让行在智能体继续后仍可应答；
 * `expired` 已关闭；`cancelled` 是用户自己的关闭；`answered` 结算。迟到的 reply 是更新的
 * 真相，优先于两者。
 * @returns 行模型；不是提问类调用返回 null
 * 内部逻辑：asking = 工具在跑 / status pending / details pending 且无 reply 无答案 → 「正在询问」无正文；失败显示「提问失败」；未答显示「未回答，已自动继续」+ 空答案记录；已答把问题与答案按 id 配对（歧义则不给记录）。
 */
export function askQuestionRowModel(input: {
  readonly name: string
  readonly args: Readonly<Record<string, unknown>>
  readonly details: unknown
  readonly failed: boolean
  /** 工具本身仍在运行；pending 的交互是另一个「询问中」信号。 */
  readonly running?: boolean | undefined
  readonly reply?: LateAnswer | undefined
  /** 转录区拿到投影列表时，该调用的投影交互状态。 */
  readonly status?: InteractionStatus | undefined
}, t: Translate): AskQuestionRowModel | null {
  if (!QUESTION_TOOL_NAMES.has(input.name.toLocaleLowerCase())) return null
  const details = asRecord(input.details)
  const questions = askedQuestions(input.args.questions) ?? askedQuestions(details?.questions)
  const answers = input.reply !== undefined ? input.reply.answers : recordedAnswers(details?.answers)
  const title = t('已询问', 'Asked')
  const waitingRecord = (): AskQuestionRecord | null => questions === null
    ? null
    : { items: questions.map(question => ({ ...question, answers: [] })) }
  if (input.failed) return { title, summary: t('提问失败', 'Question failed'), record: waitingRecord() }
  // 问题落定前，ZCode 的行保持「正在询问」且无正文。
  const asking = input.running === true || input.status === 'pending'
    || input.status === undefined && details?.status === 'pending' && input.reply === undefined && answers === null
  if (asking) return { title: t('正在询问', 'Asking questions'), summary: '', record: null }
  const answered = input.reply !== undefined || details?.status === 'answered' || answers !== null || input.status === 'answered'
  const count = questions === null ? '' : t(`${questions.length} 个问题`, `${questions.length} questions`)
  if (!answered) return { title, summary: t('未回答，已自动继续', 'No answer; continued automatically'), record: waitingRecord() }
  const paired = questions === null || answers === null ? null : pairAskedAnswers(questions, answers)
  return { title, summary: count, record: paired === null ? null : { items: paired } }
}

/** 从参数或 details 字段读问题 id 与文本；集合有歧义（缺字段、重复 id）返回 null。 */
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

/** 从工具结果读答案批次；缺席或畸形返回 null。 */
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

/** 按 id 把问题与答案配对；任一集合导致配对有歧义（数量不齐、重复 id、缺答案）返回 null。 */
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

/** `subagent` 调用行的全部展示信息：DSH 的 `started subagent <id>` 回执。 */
export interface SubagentRowModel {
  /** 行标题（DSH 措辞）。 */
  readonly title: string
  /** 折叠态摘要：已开始委派 + 标签 + 子会话 id。 */
  readonly summary: string
  /** 该行可打开的子会话；工具未记录时缺席。 */
  readonly childId?: string
  /** 子会话记录的委派标签；条带用它命名 chip。 */
  readonly label?: string
  /** 被委派的任务文本，代替原始 JSON 参数展示。 */
  readonly task?: string
}

/** ZCode 的 Skill 卡片：kind 标题、等宽的技能 id，与可选资源名。 */
export interface SkillRowModel {
  readonly title: string
  readonly skill?: string
  readonly resource?: string
}

/**
 * 功能：按 ZCode `SkillToolCallBlock` 的方式构建 Skill 行：kind 标题命名操作，
 * 技能 id 以等宽字体随行；`skill_load` 还可带资源名。正文是工具自己的文本而非 JSON。
 * @returns 行模型；不是 Skill 工具返回 null
 */
export function skillRowModel(input: {
  readonly name: string
  readonly args: Readonly<Record<string, unknown>>
  readonly running: boolean
}, t: Translate): SkillRowModel | null {
  const id = input.name.toLocaleLowerCase()
  if (!SKILL_TOOL_NAMES.has(id)) return null
  const skill = stringField(input.args, ['skill', 'name', 'id'])
  const resource = id === 'skill_load' ? stringField(input.args, ['resource']) : undefined
  const title = id === 'skill_load'
    ? input.running ? t('正在运行技能', 'Running a skill') : t('技能', 'Skill')
    : id === 'skill_list' ? t('技能列表', 'Skill list')
      : id === 'skill_save' ? t('保存技能', 'Save skill')
        : t('校验技能', 'Validate skill')
  return {
    title,
    ...(skill === undefined || skill.trim() === '' ? {} : { skill: skill.trim() }),
    ...(resource === undefined || resource.trim() === '' ? {} : { resource: resource.trim() }),
  }
}
/**
 * 功能：从调用参数与 details 构建 `subagent` 行。DSH 把激活渲染为
 * `started subagent <id>` 加一张带委派任务的回执卡；Pi 的前台工具返回子会话的答案，
 * 所以正文保留答案，摘要命名已开始的委派、标签与子会话 id。
 * @returns 行模型；不是 subagent 调用返回 null
 */
export function subagentRowModel(input: {
  readonly name: string
  readonly args: Readonly<Record<string, unknown>>
  readonly details: unknown
  readonly failed: boolean
}, t: Translate): SubagentRowModel | null {
  if (input.name.toLocaleLowerCase() !== 'subagent') return null
  // 「活」的工具消息把扩展载荷嵌在 `result` 下（`projection.ts:liveToolMessages`）；
  // 落定的结果直接携带。
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

/* ---------- 代码模式：`codemode` 行与其脚本发起的工具调用 ---------- */

/** 脚本发起的一次工具调用，对应 Pi 的 `CodemodeNestedCall` 结果 details。 */
export type CodemodeCallStatus = RecordedCodemodeStatus

/** codemode 行内展示的一次嵌套调用视图。 */
export interface CodemodeCallView extends Omit<RecordedCodemodeCall, 'args'> {
  /** 调用参数的紧凑 JSON，保留为行悬停文本。 */
  readonly args: string
}

/** `codemode` 行的全部展示信息：脚本、嵌套调用与结果文本。 */
export interface CodemodeRowModel {
  /** 行标题（DSH 措辞）。 */
  readonly title: string
  /** 折叠时展示实际调用的工具摘要。 */
  readonly summary: string
  /** 调用运行的脚本；结果未记录调用时为空。 */
  readonly script: string
  /** 工具结果文本（脚本的 console 输出与返回值）。 */
  readonly output: string
  /** 脚本发起的工具调用，按发起顺序。 */
  readonly calls: readonly CodemodeCallView[]
  /** 结果文本被截到 token 预算时的完整输出文件。 */
  readonly fullOutputPath?: string
}

/**
 * 功能：从调用的脚本参数与结果的 details 构建 `codemode` 行。
 * @returns 行模型；没有脚本、调用明细和完整输出路径时回退到通用工具卡片。
 */
export function codemodeRowModel(input: {
  readonly name: string
  readonly args: Readonly<Record<string, unknown>>
  readonly details: unknown
  readonly output: string
}, t: Translate): CodemodeRowModel | null {
  if (input.name.toLocaleLowerCase() !== CODEMODE_TOOL_NAME) return null
  // 持久 details 可能以对象或 JSON 字符串到达。
  const details = detailsRecordFor(input.details, '')
  const script = typeof input.args.code === 'string' ? input.args.code : ''
  const fullOutputPath = typeof details?.fullOutputPath === 'string' && details.fullOutputPath.trim() !== ''
    ? details.fullOutputPath
    : undefined
  const calls = recordedScriptCalls(details)
  if (script === '' && calls.length === 0 && fullOutputPath === undefined) return null
  return {
    title: toolRowTitle(CODEMODE_TOOL_NAME, t),
    summary: scriptSummary(calls, t),
    script,
    output: input.output,
    calls: calls.map(call => ({ ...call, args: codemodeCallArgs(call.args) })),
    ...(fullOutputPath === undefined ? {} : { fullOutputPath }),
  }
}

/** 紧凑的参数文本；数组与对象序列化，读不了的值显示为空。 */
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

