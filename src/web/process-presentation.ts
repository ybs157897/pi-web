import type { ProcessPart, RenderRun, ToolActivity, ToolItem } from './render-model.ts'
import { summarizeToolActivities, toolActivity } from './render-model.ts'
import { buildToolRenderModel } from './tool-render-model.ts'
import type { ChatPresentationPolicy } from './presentation-policy.ts'
import type { Translate } from './render-labels.ts'
import type { TranscriptPart } from './subagent-run-model.ts'

/**
 * 功能：按用户选择的详情档位和收起时机推导工作组的默认状态。
 * @param policy 当前呈现策略
 * @param latest 是否为最新回合
 * @param live 是否正在运行
 * @returns true 表示默认展开
 * 正在运行和不满足折叠时机的回合一律展开。
 */
export function defaultProcessOpen(policy: ChatPresentationPolicy, latest: boolean, live: boolean): boolean {
  const folds = policy.foldCompletedTurns && (policy.collapseTiming === 'completion' || !latest)
  return live || !folds
}

/** 工作组自动展开状态允许变化的边界：仅这四种，普通帧不会改变它。 */
export type ProcessGroupBoundary = 'live-start' | 'live-end' | 'demote' | 'none'

/**
 * 功能：比较前后两帧的 live/latest 推导出边界事件。
 * @param was 上一帧的 {live, latest}
 * @param now 当前帧的 {live, latest}
 * @returns 边界类型：live-start（run 接管）、live-end（run 落定）、demote（出现更新的 run）；都不满足为 none
 * 内部逻辑：live 与 latest 是用户未手动触碰的组唯一允许折叠/展开的两个事实，且各自只触发一次。
 */
export function processGroupBoundary(was: { live: boolean; latest: boolean }, now: { live: boolean; latest: boolean }): ProcessGroupBoundary {
  if (!was.live && now.live) return 'live-start'
  if (was.live && !now.live) return 'live-end'
  if (!now.live && was.latest && !now.latest) return 'demote'
  return 'none'
}

/**
 * 功能：跨边界计算自动展开态：live-start 强制展开，live-end / demote 回到默认态，其余保持原值——
 * 保证连续重投影的帧不会让组自己开合抖动。
 * @param previousOpen 上一帧的展开态
 * @param boundary 本次边界事件
 * @param defaultOpen 策略推导的默认展开态
 * @returns 新的展开态
 */
export function processGroupAutoOpen(previousOpen: boolean, boundary: ProcessGroupBoundary, defaultOpen: boolean): boolean {
  if (boundary === 'live-start') return true
  if (boundary === 'live-end' || boundary === 'demote') return defaultOpen
  return previousOpen
}

/**
 * 功能：取思考流中最后一个非空行，作为直播态折叠头的摘要。
 * @param text 思考全文
 * @returns 去空白后的摘要行；全空返回空串
 */
export function latestReasoningLine(text: string): string {
  return text.replace(/\r\n?/gu, '\n').split('\n').findLast(line => line.trim() !== '')?.trim() ?? ''
}

/**
 * 功能：生成工作组的标题文案（工作中/已工作 + 耗时，或 处理失败/已停止）。
 * @param run 运行状态与时长
 * @param t 双语标签函数
 * @param live 是否仍在工作（默认取 run.status === 'running'）
 * @returns 双语标题字符串
 * 内部逻辑：只用已记录的 durationMs，拿不到时长不从墙钟猜；不足 1 秒的亚秒 run
 * 与未知同义（否则显示「已工作 0 秒」）；≥60s 显示「X 分 Y 秒」。
 */
export function workGroupTitle(run: Pick<RenderRun, 'status' | 'durationMs'>, t: Translate, live = run.status === 'running'): string {
  // 0 与未知同义（毫秒级 run 不值得展示「0 秒」），不足 1 秒同理，回落到不带耗时的「工作中/已工作」；
  // 其余四舍五入到秒（2.8 秒的回合显示「3 秒」更贴近实际工作时长）。
  const duration = run.durationMs === undefined || !Number.isFinite(run.durationMs) || run.durationMs < 1000
    ? undefined
    : Math.max(1, Math.round(run.durationMs / 1000))
  const time = duration === undefined ? undefined : duration >= 60
    ? t(`${Math.floor(duration / 60)} 分 ${duration % 60} 秒`, `${Math.floor(duration / 60)} min ${duration % 60} sec`)
    : t(`${duration} 秒`, `${duration} sec`)
  // 两次工具轮之间 run.status 会短暂回落为 completed；会话级 live 标志让标题保持「工作中」，
  // 直到回合真正落定（ZCode 的运行中折叠头同样带实时时长）。
  if (live) return time === undefined ? t('工作中', 'Working') : t(`工作中 ${time}`, `Working ${time}`)
  if (run.status === 'error') return t('处理失败', 'Turn failed')
  if (run.status === 'cancelled') return t('已停止', 'Stopped')
  if (run.status === 'running') return time === undefined ? t('工作中', 'Working') : t(`工作中 ${time}`, `Working ${time}`)
  return time === undefined ? t('已工作', 'Worked') : t(`已工作 ${time}`, `Worked ${time}`)
}

type WorkStep = Extract<ProcessPart, { kind: 'tool' | 'reasoning' }>

export interface WorkStepGroup {
  readonly kind: 'workSteps'
  readonly key: string
  readonly parts: readonly WorkStep[]
  readonly counts: WorkSummaryCounts
  readonly failedTools: number
  readonly stoppedTools: number
}

const workActivities = new Set<ToolActivity>(['read', 'readImage', 'search', 'webSearch', 'webFetch', 'commands', 'code', 'write', 'edit'])

/** 正文和交互结束当前工作片段；片段内的思考和工具按原顺序一起折叠。 */
export function groupWorkSteps(parts: readonly TranscriptPart[]): readonly (TranscriptPart | WorkStepGroup)[] {
  const rows: (TranscriptPart | WorkStepGroup)[] = []
  let steps: WorkStep[] = []
  let tools: ToolItem[] = []
  const flush = () => {
    if (tools.length === 0 || steps.length === 1) {
      rows.push(...steps)
    } else {
      const { activityCounts, failedTools, stoppedTools } = summarizeToolActivities(tools)
      const counts = workSummaryCounts({ activityCounts, process: steps })
      rows.push({ kind: 'workSteps', key: `work-steps:${tools[0]!.key}`, parts: steps, counts, failedTools, stoppedTools })
    }
    steps = []
    tools = []
  }
  for (const part of parts) {
    if (part.kind === 'tool' && workActivities.has(toolActivity(part.item.call?.name ?? part.item.result?.toolName ?? ''))) {
      steps.push(part)
      tools.push(part.item)
    } else if (part.kind === 'reasoning') {
      steps.push(part)
    } else {
      flush()
      rows.push(part)
    }
  }
  flush()
  return rows
}

/** ZCode summary group 口径的工作统计：探索 / 执行 / 修改。 */
export interface WorkSummaryCounts {
  readonly explore: number
  readonly run: number
  readonly change: number
  /** 修改类调用但抽不出路径的次数（ZCode 的 unresolved 桶）。 */
  readonly unresolved: number
}

/**
 * 功能：按 ZCode summary group 口径汇总一个 run 的工作量。
 * @param run 渲染 run（活动计数 + 过程部件）
 * @returns explore/run/change/unresolved 四类计数
 * 内部逻辑：读取（含读图）、搜索、网页抓取归 explore；命令与代码执行归 run；写入与
 * 编辑按去重文件路径归 change（抽不出路径的计入 unresolved）；其余活动类（子智能体、
 * 计划、提问等）不进摘要，与 ZCode 的 explore/run/change 三桶一致。
 */
export function workSummaryCounts(run: Pick<RenderRun, 'activityCounts' | 'process'>): WorkSummaryCounts {
  const counts = new Map(run.activityCounts.map(({ kind, count }) => [kind, count]))
  const total = (...kinds: ToolActivity[]): number => kinds.reduce((sum, kind) => sum + (counts.get(kind) ?? 0), 0)
  const changed = changedTargets(run.process)
  return {
    explore: total('read', 'readImage', 'search', 'webSearch', 'webFetch'),
    run: total('commands', 'code'),
    change: changed.files.size,
    unresolved: changed.unresolved,
  }
}

/**
 * 功能：生成展开区小组的统计文案。
 * @param counts 三类计数
 * @param t 双语标签函数
 * @param live 仍在运行时不加「已」前缀（对齐 ZCode 的进行中措辞）
 * @returns 统计文案；三类都为 0 返回 undefined
 */
export function workSummaryText(counts: WorkSummaryCounts, t: Translate, live: boolean): string | undefined {
  const parts: string[] = []
  if (counts.explore > 0) {
    parts.push(live
      ? t(`查阅 ${counts.explore} 项`, `Explore ${counts.explore} ${counts.explore === 1 ? 'item' : 'items'}`)
      : t(`已查阅 ${counts.explore} 项`, `Explored ${counts.explore} ${counts.explore === 1 ? 'item' : 'items'}`))
  }
  if (counts.run > 0) {
    parts.push(live
      ? t(`执行 ${counts.run} 命令`, `Run ${counts.run} ${counts.run === 1 ? 'command' : 'commands'}`)
      : t(`已执行 ${counts.run} 命令`, `Ran ${counts.run} ${counts.run === 1 ? 'command' : 'commands'}`))
  }
  if (counts.change > 0) {
    parts.push(live
      ? t(`修改 ${counts.change} 文件`, `Change ${counts.change} ${counts.change === 1 ? 'file' : 'files'}`)
      : t(`已修改 ${counts.change} 文件`, `Changed ${counts.change} ${counts.change === 1 ? 'file' : 'files'}`))
  }
  if (counts.unresolved > 0) {
    parts.push(live
      ? t(`修改 ${counts.unresolved} 次（路径未知）`, `Change ${counts.unresolved} ${counts.unresolved === 1 ? 'time' : 'times'} (path unknown)`)
      : t(`已修改 ${counts.unresolved} 次（路径未知）`, `Changed ${counts.unresolved} ${counts.unresolved === 1 ? 'time' : 'times'} (path unknown)`))
  }
  return parts.length > 0 ? parts.join(t('，', ', ')) : undefined
}

/**
 * 功能：取折叠头在运行中要显示的「当前动作」一行。
 * @param run 渲染 run
 * @param t 双语标签函数
 * @param runRunning run 是否在运行
 * @returns 运行中动作的文案；没有运行中的部件返回 undefined
 * 内部逻辑：从过程末尾向前找第一个运行中的部件——流式思考取最后一行、流式正文取
 * 首行可读文本、工具行复用工具渲染模型的标题与命令/摘要。ZCode 在折叠且仍在工作时
 * 用当前动作代替统计文案。
 */
export function currentWorkLine(run: Pick<RenderRun, 'process'>, t: Translate, runRunning: boolean): string | undefined {
  const part = runningPart(run, runRunning)
  if (part === undefined) return undefined
  if (part.kind === 'reasoning') {
    const line = latestReasoningLine(part.text)
    return line === '' ? undefined : line
  }
  if (part.kind === 'content') {
    const line = part.block.type === 'text' ? firstProseLine(part.block.text) : ''
    return line === '' ? undefined : line
  }
  const model = buildToolRenderModel(part.item, t, runRunning)
  return `${model.title} ${model.command ?? model.summary}`.trim()
}

/** 过程里可能处于运行态的部件种类（runningPart 的返回类型）。 */
export type RunningPart = Extract<ProcessPart, { kind: 'reasoning' } | { kind: 'content' } | { kind: 'tool' }>

/**
 * 功能：找出过程里正在运行的部件（供折叠头显示当前动作行）。
 * @param run 渲染 run
 * @param runRunning run 是否在运行
 * @returns 最后一个运行中的 reasoning / 流式正文 / 工具行；没有返回 undefined
 * 内部逻辑：从末尾向前找，思考看 streaming、正文看 streaming text 块、工具行用与
 * 工具渲染模型一致的运行中判定。ZCode 的运行中折叠头就是这一行的动态展示。
 */
export function runningPart(run: Pick<RenderRun, 'process'>, runRunning: boolean): RunningPart | undefined {
  for (let index = run.process.length - 1; index >= 0; index -= 1) {
    const part = run.process[index]
    if (part === undefined || part.kind === 'user') continue
    if (part.kind === 'reasoning') {
      if (part.streaming) return part
      continue
    }
    if (part.kind === 'content') {
      if (part.streaming && part.block.type === 'text') return part
      continue
    }
    if (toolItemRunning(part.item, runRunning)) return part
  }
  return undefined
}

/** 与 buildToolRenderModel 相同的运行中判定：结果流式/状态 running，或无结果且调用/父 run 在跑。 */
function toolItemRunning(item: ToolItem, runRunning: boolean): boolean {
  const status = item.result?.status ?? item.message.status
  return item.result?.streaming === true || status === 'running'
    || item.result === undefined && (item.message.streaming === true || runRunning)
}

/** 收集修改类调用落到的文件路径（含 codemode 嵌套子调用）；抽不出路径的次数单列。 */
function changedTargets(process: RenderRun['process']): { files: Set<string>; unresolved: number } {
  const files = new Set<string>()
  let unresolved = 0
  const visit = (item: ToolItem): void => {
    const activity = toolActivity(item.call?.name ?? item.result?.toolName ?? '')
    if (activity === 'write' || activity === 'edit') {
      const path = changedPath(item)
      if (path === undefined) unresolved += 1
      else files.add(path)
    }
    for (const child of item.children) visit(child)
  }
  for (const part of process) {
    if (part.kind === 'tool') visit(part.item)
  }
  return { files, unresolved }
}

/** 修改类调用的目标路径：先看参数里的 path 家族字段，再看写/编辑产物；都没有则不猜。 */
function changedPath(item: ToolItem): string | undefined {
  const args = item.call?.arguments
  for (const key of ['path', 'file_path', 'filePath', 'file']) {
    const value = args?.[key]
    if (typeof value === 'string' && value.trim() !== '') return value.trim()
  }
  return item.result?.artifacts?.find(artifact => artifact.kind === 'edit' || artifact.kind === 'write' || artifact.kind === 'nativeEdit')?.path
}

/**
 * 功能：取 Markdown 块的第一行可读正文：跳过围栏代码块内各行与没有正文语义的行。
 * @returns 清洗后的首行正文；没有则空串
 */
function firstProseLine(markdown: string): string {
  let fence: string | undefined
  for (const source of markdown.split('\n')) {
    const line = source.trim()
    const marker = /^(\x60{3,}|~{3,})(.*)$/u.exec(line)
    if (marker !== null) {
      const [, opening, info] = marker
      if (fence === undefined) fence = opening
      else if (info === '' && opening?.startsWith(fence)) fence = undefined
      continue
    }
    if (fence !== undefined) continue
    const prose = plainProse(line)
    if (prose !== '') return prose
  }
  return ''
}

/**
 * 功能：剥掉会让单行预览读起来像标点的 Markdown 标记（标题、引用、列表、图片/链接、强调、代码），压缩空白。
 * @param line 原始行
 * @returns 清洗后的正文；整行只剩分隔符（`- * _ : |` 空格）时返回空串
 */
function plainProse(line: string): string {
  const text = line
    .replace(/^#{1,6}\s+/u, '')
    .replace(/^>\s*/u, '')
    .replace(/^[-*+]\s+/u, '')
    .replace(/^\d+[.)]\s+/u, '')
    .replace(/!\[([^\]]*)\]\([^)]*\)/gu, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/gu, '$1')
    .replace(/\*\*|__|~~|`/gu, '')
  if (/^[-*_:| ]+$/u.test(text)) return ''
  return text.replace(/\s+/gu, ' ').trim()
}
