import type { RenderRun, ToolActivity, ToolItem } from './render-model.ts'
import { toolActivity } from './render-model.ts'
import { buildToolRenderModel } from './tool-render-model.ts'
import type { ChatPresentationPolicy } from './presentation-policy.ts'
import type { Translate } from './render-labels.ts'

/**
 * 功能：推导一个工作组的默认展开态，保证交错出现的用户输入可见并遵循所选详情档位。
 * @param policy 当前呈现策略
 * @param latest 是否为最新回合
 * @param live 是否正在运行
 * @param hasInterleavedUser 回合内是否夹带用户输入
 * @returns true 表示默认展开
 * 内部逻辑：折叠条件 = 策略允许折叠 且（完成时机 / 非最新回合）；夹带用户输入、正在直播、不满足折叠条件、或 history 档的最新回合一律展开。
 */
export function defaultProcessOpen(policy: ChatPresentationPolicy, latest: boolean, live: boolean, hasInterleavedUser: boolean): boolean {
  const folds = policy.foldCompletedTurns && (policy.collapseTiming === 'completion' || !latest)
  return hasInterleavedUser || live || !folds || policy.stepGrouping === 'history' && latest
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
 * 内部逻辑：只用已记录的 durationMs，拿不到时长不从墙钟猜；≥60s 显示「X 分 Y 秒」。
 */
export function workGroupTitle(run: Pick<RenderRun, 'status' | 'durationMs'>, t: Translate, live = run.status === 'running'): string {
  // 两次工具轮之间 run.status 会短暂回落为 completed；会话级 live 标志
  // 让标题保持「工作中」，直到回合真正落定。
  if (live) return t('工作中', 'Working')
  if (run.status === 'error') return t('处理失败', 'Turn failed')
  if (run.status === 'cancelled') return t('已停止', 'Stopped')
  // 0 与未知同义（毫秒级 run 不值得展示「0 秒」），回落到不带耗时的「已工作」。
  const duration = run.durationMs === undefined || !Number.isFinite(run.durationMs) || run.durationMs <= 0
    ? undefined
    : Math.floor(run.durationMs / 1000)
  const time = duration === undefined ? undefined : duration >= 60
    ? t(`${Math.floor(duration / 60)} 分 ${duration % 60} 秒`, `${Math.floor(duration / 60)} min ${duration % 60} sec`)
    : t(`${duration} 秒`, `${duration} sec`)
  if (run.status === 'running') return time === undefined ? t('工作中', 'Working') : t(`工作中 ${time}`, `Working ${time}`)
  return time === undefined ? t('已工作', 'Worked') : t(`已工作 ${time}`, `Worked ${time}`)
}

/**
 * 功能：取折叠的工作组会「吞掉」的正文摘要——run 过程里模型伴随工具调用写的文字块
 * （提问的引子、验证前的解释），取含正文的最长一段的首行。
 * @param run 渲染 run（只需 process）
 * @param limit 最大字符数（码点计），超出截断加省略号，默认 120
 * @returns 预览文本；无可读正文时 undefined
 */
export function foldedProsePreview(run: Pick<RenderRun, 'process'>, limit = 120): string | undefined {
  let line = ''
  let longest = 0
  for (const part of run.process) {
    if (part.kind !== 'content' || part.block.type !== 'text') continue
    const text = part.block.text.trim()
    if (text.length <= longest) continue
    const prose = firstProseLine(text)
    if (!prose) continue
    line = prose
    longest = text.length
  }
  if (!line) return undefined
  const characters = [...line]
  return characters.length > limit ? `${characters.slice(0, limit).join('')}…` : line
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
 * 功能：生成 ZCode 风格的折叠头统计文案：「已查阅 8 项，已执行 12 命令，已修改 3 文件」。
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
  for (let index = run.process.length - 1; index >= 0; index -= 1) {
    const part = run.process[index]
    if (part === undefined) continue
    if (part.kind === 'reasoning') {
      if (!part.streaming) continue
      const line = latestReasoningLine(part.text)
      return line === '' ? undefined : line
    }
    if (part.kind === 'content') {
      if (!part.streaming || part.block.type !== 'text') continue
      const line = firstProseLine(part.block.text)
      return line === '' ? undefined : line
    }
    if (part.kind !== 'tool' || !toolItemRunning(part.item, runRunning)) continue
    const model = buildToolRenderModel(part.item, t, runRunning)
    return `${model.title} ${model.command ?? model.summary}`.trim()
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
 * 功能：三类工作（探索/执行/修改）之外的活动兜底摘要：子智能体、计划、提问、其他
 * 工具与失败/停止计数。ZCode 的统计只覆盖三类，但 pi-web 的折叠组会吞掉这些行，
 * 折叠头至少要让用户知道它们存在。
 * @param run 渲染 run（活动计数 + 失败/停止数）
 * @param t 双语标签函数
 * @returns 如「提问 1 次」；没有其他活动返回 undefined
 */
export function otherActivitySummary(run: Pick<RenderRun, 'activityCounts' | 'failedTools' | 'stoppedTools'>, t: Translate): string | undefined {
  const counts = new Map(run.activityCounts.map(({ kind, count }) => [kind, count]))
  const parts: string[] = []
  const add = (count: number, zh: string, en: string): void => {
    if (count > 0) parts.push(t(`${zh} ${count} 次`, `${en} ${count}`))
  }
  add(counts.get('subagents') ?? 0, '协调子智能体', 'Subagent calls')
  add(counts.get('plan') ?? 0, '处理计划或目标', 'Plan and goal calls')
  add(counts.get('questions') ?? 0, '提问', 'Questions')
  add(counts.get('tools') ?? 0, '调用其他工具', 'Other tool calls')
  add(run.failedTools, '失败', 'Failed')
  add(run.stoppedTools, '停止', 'Stopped')
  return parts.length > 0 ? parts.join(' · ') : undefined
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
