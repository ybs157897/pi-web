import type { RenderRun, ToolActivity } from './render-model.ts'
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

/** 折叠组没有可读正文时，按真实工具调用次数显示工作摘要。 */
export function foldedActivitySummary(run: Pick<RenderRun, 'activityCounts' | 'failedTools' | 'stoppedTools'>, t: Translate): string | undefined {
  const counts = new Map(run.activityCounts.map(({ kind, count }) => [kind, count]))
  const times = (...kinds: ToolActivity[]): number => kinds.reduce((sum, kind) => sum + (counts.get(kind) ?? 0), 0)
  const parts: string[] = []
  const add = (count: number, zh: string, en: string): void => {
    if (count > 0) parts.push(t(`${zh} ${count} 次`, `${en} ${count}`))
  }
  add(times('read', 'readImage'), '读取', 'Reads')
  add(times('search', 'webSearch'), '搜索', 'Searches')
  add(times('webFetch'), '查阅网页', 'Page fetches')
  add(times('commands', 'code'), '执行', 'Executions')
  add(times('write', 'edit'), '改动', 'Edits')
  add(times('subagents'), '协调子智能体', 'Subagent calls')
  add(times('plan'), '处理计划或目标', 'Plan and goal calls')
  add(times('questions'), '提问', 'Questions')
  add(times('tools'), '调用其他工具', 'Other tool calls')
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
