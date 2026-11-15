import { useMemo } from 'react'
import type { ReactNode } from 'react'
import { Search, SquareTerminal } from 'lucide-react'
import type { InteractionRequest } from '../shared/types.ts'
import type { InspectorDiff } from './Inspector.tsx'
import type { PlanDocument } from './plan-preview.ts'
import type { Translate } from './render-labels.ts'
import type { ToolItem } from './render-model.ts'
import type { LateAnswer } from './tool-render-model.ts'
import { buildToolRenderModel, type ToolRenderModel } from './tool-render-model.ts'
import { exploreBucket, type ProcessToolGroupKind } from './process-grouping.ts'
import { ProcessRow } from './ProcessRow.tsx'
import { useProcessExpansion } from './message-rendering/ProcessExpansion.tsx'
import ToolCard from './ToolCard.tsx'
import css from './ProcessToolGroup.module.css'

/** ProcessToolGroup 的属性定义：分组键、分组类型、工具项列表与各子项打开回调。 */
export interface ProcessToolGroupViewProps {
  readonly groupKey: string
  readonly group: ProcessToolGroupKind
  readonly items: readonly ToolItem[]
  readonly runRunning: boolean
  readonly t: Translate
  readonly replies?: ReadonlyMap<string, LateAnswer>
  readonly interactions?: readonly InteractionRequest[]
  readonly onOpenFile?: (path: string, line?: number) => void
  readonly onInspectDiff?: (diff: InspectorDiff) => void
  readonly onOpenTool?: (messageId: string, toolCallId?: string) => void
  readonly onOpenSubagent?: (conversationId: string) => void
  readonly onOpenPlan?: (plan: PlanDocument) => void
}

/**
 * 功能：ZCode 的合成流程父行——连续的只读操作聚合为「查阅」组，连续的 shell
 * 操作聚合为「终端」组。父行默认折叠、展开时摘要（计数）仍然可见，每个子工具
 * 保留自己的行与操作入口。
 * @param props groupKey 展开态持久化键；group 分组类型（explore/execute）；
 *              items 组内工具项；runRunning 所在运行是否进行中；replies 迟到的
 *              工具结果；interactions 待交互请求；onOpenFile/onInspectDiff/onOpenTool/
 *              onOpenSubagent/onOpenPlan 为各类子项的打开回调；t 翻译函数。
 * 内部逻辑：open 经 useProcessExpansion 按组键持久化；models 用 useMemo 构建渲染模型，
 * running 取任一子项运行中；latest 取最后一个运行中的（否则最后一个）模型，用于
 * 运行态摘要；摘要按组类型分流到 exploreSummary/executeSummary 与对应的 live 摘要。
 */
export function ProcessToolGroup({ groupKey, group, items, runRunning, t, replies, interactions, onOpenFile, onInspectDiff, onOpenTool, onOpenSubagent, onOpenPlan }: ProcessToolGroupViewProps) {
  const [open, setOpen] = useProcessExpansion(groupKey)
  const models = useMemo(() => items.map(item => buildToolRenderModel(item, t, runRunning)), [items, runRunning, t])
  const running = models.some(model => model.running)
  const latest = models.findLast(model => model.running) ?? models.at(-1)
  const counts = group === 'explore' ? exploreSummary(items, t) : executeSummary(models, t)
  const live = group === 'explore' ? exploreLiveSummary(latest, t) : executeLiveSummary(latest, t)
  const title = group === 'explore' ? t('查阅', 'Explore') : t('终端', 'Terminal')
  const icon = group === 'explore' ? <Search size={16} /> : <SquareTerminal size={16} />
  return (
    <div className={css.root} data-tool-group={group}>
      <ProcessRow
        icon={icon}
        title={title}
        open={open}
        expandable
        running={running}
        keepSummaryWhenOpen
        toggleLabel={open ? t('收起工具详情', 'Collapse tool details') : t('展开工具详情', 'Expand tool details')}
        onToggle={() => { setOpen(value => !value) }}
        summary={<><span className={css.separator} aria-hidden="true">·</span><span className={css.summary}>{open || !running ? counts : live}</span></>}
      >
        <div className={css.groupChildren}>
          {items.map(item => <ToolCard key={item.key} item={item} runRunning={runRunning} t={t} showIcon={false}
            replies={replies} interactions={interactions} onOpenFile={onOpenFile} onInspectDiff={onInspectDiff}
            onOpenTool={onOpenTool} onOpenSubagent={onOpenSubagent} onOpenPlan={onOpenPlan} />)}
        </div>
      </ProcessRow>
    </div>
  )
}

/** 查阅组的静态摘要：按 fetch/搜索/列表/文件四类计数拼接，如「2 次网页抓取, 3 搜索」。 */
function exploreSummary(items: readonly ToolItem[], t: Translate): string {
  const counts = { fetch: 0, search: 0, list: 0, file: 0 }
  for (const item of items) counts[exploreBucket(item)] += 1
  const parts: string[] = []
  if (counts.fetch > 0) parts.push(`${counts.fetch} ${t('次网页抓取', 'fetch')}`)
  if (counts.search > 0) parts.push(`${counts.search} ${t('搜索', 'search')}`)
  if (counts.list > 0) parts.push(`${counts.list} ${t('列表', 'list')}`)
  if (counts.file > 0) parts.push(`${counts.file} ${t('文件', 'file')}`)
  return parts.length > 0 ? parts.join(', ') : t('0 个文件', '0 files')
}

/** 终端组的静态摘要：命令总数，附失败/已停止计数（如「3 个命令, 1 个失败」）。 */
function executeSummary(models: readonly ToolRenderModel[], t: Translate): string {
  const parts = [`${models.length} ${t('个命令', 'commands')}`]
  const failed = models.filter(model => model.failed).length
  const stopped = models.filter(model => model.cancelled).length
  if (failed > 0) parts.push(`${failed} ${t('个失败', 'failed')}`)
  if (stopped > 0) parts.push(`${stopped} ${t('个已停止', 'stopped')}`)
  return parts.join(', ')
}

/** 查阅组的运行态摘要：按最近一个工具的名称给出「正在读取/抓取/搜索/执行」标签加详情。 */
function exploreLiveSummary(model: ToolRenderModel | undefined, t: Translate): ReactNode {
  if (model === undefined) return t('正在执行', 'Running')
  const label = model.name === 'read' || model.name === 'read_image' || model.name === 'read_file'
    ? t('正在读取', 'Reading')
    : model.name === 'web_fetch' || model.name === 'fetch_url' || model.name === 'fetch'
      ? t('正在抓取', 'Fetching')
      : model.command !== undefined
        ? t('正在执行', 'Running')
        : t('正在搜索', 'Searching')
  return <LiveDetail label={label} detail={model.command ?? model.summary} />
}

/** 终端组的运行态摘要：固定「正在执行」标签加最近一条命令或摘要详情。 */
function executeLiveSummary(model: ToolRenderModel | undefined, t: Translate): ReactNode {
  if (model === undefined) return t('正在执行', 'Running')
  return <LiveDetail label={t('正在执行', 'Running')} detail={model.command ?? model.summary} />
}

/** 运行态摘要的通用片段：左侧标签 + 右侧单行截断的详情文本（悬浮显示全文）。 */
function LiveDetail({ label, detail }: { label: string; detail: string }) {
  return <><span className={css.liveLabel}>{label}</span><span className={css.liveDetail} title={detail}>{detail}</span></>
}
