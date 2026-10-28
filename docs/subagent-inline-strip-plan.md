# 子智能体正文一行条（SubagentRunStrip）实施文档

> 状态：已实施（分支 `devin/subagent-strip`）。自动化验证：`npm run typecheck` 通过；
> `tests/subagent-run-model.test.ts` 14 项通过；与 render-model（59）、transcript-live-state（1）、
> rendering-interactions（14）、subagent-pane（8）、process-presentation（8）合计 6 文件 104 项全绿。
> 真实模型 / codemode / ego 截图验收由主智能体统一执行。
> 决策变更：`docs/spec.md` 2026-10-28 的「子智能体执行渲染」条目明确写了「原 DSH 彩色
> `SubagentRunStrip` 不再用于主转录」。本方案**恢复**正文一行条，但保留该条目里的
> 单行 `ToolCard` 和右侧只读 Inspector tab。实施时请同步修订该条决策，避免文档自相矛盾。

---

## 1. 目标与边界

### 1.1 要解决的问题

一个回合里并发多个 `subagent`（尤其是代码模式里 `tools.subagent` 的嵌套调用）时，
当前正文要么是一串几乎一样的工具行，要么因为 `ToolCard` 已经过滤掉 nested subagent 行而
**完全看不到**这些子智能体。需要一条紧凑的、能表达「有几个、各自什么状态」的横向条带。

### 1.2 目标形态

```
✓ 5 个子智能体已完成   [✓ essay-1 49.5K] [✓ essay-2 46.7K] [✓ essay-3 8.6K] …
```

- 一行显示本组所有子智能体，不换行、不横向滚动。
- 每个子会话一个稳定颜色（6 色循环）；颜色是身份，不是状态。
- 状态：
  - **创建中**：转圈 + 「创建中」；抬头「正在创建子智能体」。
  - **运行中**：转圈 + 已用时（无 settled 时长时退换成 live tokens）；抬头「子智能体运行中」+ `{已结束}/{总数} 结束`。
  - **已完成**：彩色 ✓ + tokens。
  - **失败**：红色 × + 红色描边，chip 文案「失败」。
- 点任意 chip：在右侧 Inspector 打开/聚焦该子会话的**只读转录 tab**（`SubagentPane`），
  **不替换主列会话**。这是当前产品的子会话查看方式，也是本次唯一改动点。
- 抬头：运行中显示 `{已结束}/{总数} 结束`；全部完成后显示「N 个子智能体已完成」；
  有失败时显示「N 个已完成 · M 个失败」。

### 1.3 不做什么

- 不改 `SubagentPanel`（会话头计数触发器）、`StatusPanel`（右下状态卡）、`SubagentPane`
  的加载/SSE 逻辑。
- 不把子会话切到主列；不自动切「轨迹」tab；这些由现有产品交互决定。
- 不处理 `spawn_teammate` 的团队成员。团队成员属于「智能体团队」面板，不是 `subagent` 条带。
  如果以后要合并，另开条目。
- 不改服务端协议、数据库或 Pi Durable。
- 如果产品要求 chip 点击**替换主列会话**（而不是右侧只读 tab），先改产品决策；本方案按当前
  `openSubagentTab` 实现，避免又造一套导航状态。

---

## 2. 当前代码现状（实施前必读）

已经有、直接复用的部分：

| 位置 | 现状 |
|---|---|
| `src/web/tool-render-model.ts` `subagentRowModel` | 已包含 `childId/label/task`，并已识别运行中投影把 details 嵌在 `result` 下的形状 |
| `src/web/ToolCard.tsx` `visibleChildren` | 已过滤 nested `subagent` 子行（注释写着「lifted into the transcript's colored strip」），但 strip 不存在，所以这些行现在**不可见** |
| `src/web/ToolCard.tsx` `CodemodeBody` | 已从「脚本内工具调用」列表里过滤掉 `subagent` |
| `src/server/demo-model.ts` | 已有 `[subagents]` 演示分支（同一 assistant 消息三次并行委派） |
| `src/web/transcript.tsx` | 已有 `conversationId` 入参；顶部注释已经提到 strip；已 import `api` |
| `src/web/App.tsx` `openSubagentTab` | 子会话以只读 tab 打开在 Inspector；签名 `(childId, title?) => void` |
| `src/web/SubagentPane.tsx` | 子会话只读转录，挂载即订阅 SSE |
| `src/shared/types.ts` `SubagentSummary` | `id/label/title/status/answer/tokens/durationMs/metricsAt/createdAt/updatedAt` |
| `src/web/api.ts` `listChildren(id)` | `GET /api/conversations/:id/children` |

缺失、需要新增的部分：

1. `src/web/subagent-run-model.ts`：分组、状态归一、颜色、标题。
2. `src/web/SubagentRunStrip.tsx` + `.module.css`：条带与 chip。
3. `src/web/transcript.tsx`：`subagents` 入参、1.5s 轮询、`ProcessGroup` 分组渲染。
4. `src/web/App.tsx`：把 `activeDetail.subagents` 传给 `Transcript`。
5. `tests/subagent-run-model.test.ts`：纯函数测试。
6. 文档：修订 `docs/spec.md` 的「不再用于主转录」决策，并在 `docs/parity.md` 或
   `docs/rendering-state-machines.md` 补一条验收记录。

> 注意：`ToolCard` 和 `CodemodeBody` 的过滤逻辑保留，不要回退。它们与 strip 是一对：
> strip 负责展示，工具卡负责不重复展示。

---

## 3. 数据合同

### 3.1 父会话投影

`ConversationDetail.subagents` 是唯一权威的「子会话列表」，按创建时间从旧到新：

```ts
type SubagentSummary = {
  id: string                 // child conversation id
  label: string              // 委派 label（缺省取 task 首行，服务端已归一化）
  title: string
  status: 'running' | 'inactive'   // 注意：没有 failed；失败要靠工具结果判断
  answer: string
  tokens?: number
  durationMs?: number
  metricsAt?: number         // 采样时间；运行中用它推进时长
  createdAt: number
  updatedAt: number
}
```

### 3.2 工具调用形状

**顶层 `subagent` 调用**（`item.result.details`）：

- 已完成：`{ conversationId, status: 'completed' | 'failed', label }`，直接挂在 `details` 上。
- 运行中：live 投影是 `{ status: 'running', result: { conversationId, status: 'running', label } }`。
  `subagentRowModel` 已经处理了这个嵌套，`groupSubagentRuns` 直接复用即可。

**`codemode` 里的嵌套调用**：

- 运行中：nested tool message 的 `details` 是
  `{ status, parentCallId, arguments: { label, task }, summary? }`；**没有 conversationId**。
- 已结束后：`codemode` 的 `details.calls` 是
  `{ id, name, args, status: 'ok' | 'error' | 'running', durationMs?, error? }`。
  **`args` 是 JSON 字符串且会被投影截断**（实测约 200 字符，末尾 `...`），不能直接
  `JSON.parse`；要从原始前缀里取 `"label"` / `"task"` 字段。

### 3.3 状态判定

```
failed  := 工具结果 isError / model.failed / call.status === 'error'
creating:= childId 尚未匹配 且 call 仍在进行
running := call 进行中（或 child row status === 'running'）
done    := 其余
```

优先级：`failed > running/creating > done`。注意 `SubagentSummary.status` 只有
`running | inactive`，不能把它当 failed；失败必须看工具结果。

### 3.4 颜色

- 优先用子会话在 `subagents` 列表里的下标 `index % 6`，跨回合稳定。
- 还没匹配到子会话时，用 `childId ?? label ?? key` 做 32 位哈希 `% 6` 兜底。
- 颜色只表达身份；状态用环/✓/× 表达。暗色主题单独一套更亮的 6 色。

---

## 4. 实施步骤

### 步骤 1：新增 `src/web/subagent-run-model.ts`

纯函数模块，不依赖 React。完整职责：

- `groupSubagentRuns(parts, t, runRunning, summaries)`：把 `ProcessPart[]` 折成
  `TranscriptPart[]`（`ProcessPart | SubagentRunGroup`）。
  - 顶层连续 `subagent`：**只有 2 个及以上才折成 strip**；单个保留现有 `ToolCard` 单行
    （当前 ZCode 风格是产品已验收的，不要退掉）。
  - `codemode`：从 `item.children`（运行中）或 `model.details.calls`（已结束）里提
    subagent 调用；**1 个也折成 strip**，因为 `ToolCard` 已隐藏这些 nested 行，没有 strip
    就等于丢失信息。strip 放在 codemode part **之前**，脚本卡保持原样。
  - `subagentGroup` / `toolGroup` 等其它 part 原样透传。
- `subagentRunEntries(group, summaries, t)`：把 call 与 `SubagentSummary` join 起来，
  产出 chip 数据（label/status/tokens/duration/metricsAt/colorIndex/childId）。
- `subagentRunHeadline(entries, t)`：抬头文案与 tone（creating/running/done/failed）。
- `subagentEntryDurationMs(entry, now)`、`formatSubagentSeconds(ms)`。
- 匹配顺序：精确 label → label 前缀（处理截断）→ 已完成调用按「最新子会话」顺序兜底。
  兜底只用于 `!pending` 的调用；**创建中的调用不得抢占已有子会话**，否则会点错会话。
- `childId` 可选；没有 childId 时 chip 禁用点击但必须显示「创建中」。

核心代码（可直接照此创建文件）：

```ts
import type { SubagentSummary } from '../shared/types.ts'
import type { ProcessPart, ToolItem } from './render-model.ts'
import type { Translate } from './render-labels.ts'
import { buildToolRenderModel, subagentRowModel } from './tool-render-model.ts'

export const SUBAGENT_COLOR_COUNT = 6
export type SubagentRunStatus = 'creating' | 'running' | 'done' | 'failed'

export interface SubagentCallItem {
  readonly key: string
  readonly childId?: string
  readonly label?: string
  readonly task?: string
  readonly failed: boolean
  readonly pending: boolean
}

export interface SubagentRunGroup {
  readonly kind: 'subagentRun'
  readonly key: string
  readonly order: number
  readonly source: 'calls' | 'codemode'
  readonly items: readonly SubagentCallItem[]
}

export type TranscriptPart = ProcessPart | SubagentRunGroup

export function groupSubagentRuns(
  parts: readonly ProcessPart[],
  t: Translate,
  runRunning: boolean,
  summaries?: readonly SubagentSummary[],
): readonly TranscriptPart[] {
  const grouped: TranscriptPart[] = []
  let current: {
    kind: 'subagentRun'; key: string; order: number; source: 'calls'
    items: SubagentCallItem[]; original: ProcessPart
  } | undefined
  const flush = (): void => {
    if (current === undefined) return
    // 单个顶层调用保留 ZCode 单行 ToolCard；两个及以上才折成条带。
    if (current.items.length >= 2) {
      grouped.push({
        kind: 'subagentRun', key: current.key, order: current.order,
        source: 'calls', items: current.items,
      })
    } else {
      grouped.push(current.original)
    }
    current = undefined
  }
  for (const part of parts) {
    if (part.kind === 'tool') {
      const name = (part.item.call?.name ?? part.item.result?.toolName)?.toLocaleLowerCase()
      if (name === 'subagent') {
        const call = topLevelSubagentCall(part.item, t, runRunning, summaries)
        if (call !== undefined) {
          if (current === undefined) {
            current = {
              kind: 'subagentRun', key: `subagent-run:${part.key}`, order: part.order,
              source: 'calls', items: [], original: part,
            }
          }
          current.items.push(call)
          continue
        }
      }
      if (name === 'codemode') {
        flush()
        const nested = nestedSubagentCalls(part.item, t, runRunning, summaries)
        if (nested.length > 0) {
          grouped.push({ kind: 'subagentRun', key: `subagent-run:${part.key}:codemode`, order: part.order - 0.0005, source: 'codemode', items: nested })
          grouped.push(part)
          continue
        }
      }
    }
    flush()
    grouped.push(part)
  }
  flush()
  return grouped
}
```

> 注意 `flush` 的分支：单个顶层调用推回 `current.original`，不是推回 strip。不要用下标
> 去原数组里找，跨 part 的 `order` 在 `toolGroup` 重排后不可靠。

顶层调用的构造（复用现有 `subagentRowModel`）：

```ts
function topLevelSubagentCall(item: ToolItem, t: Translate, runRunning: boolean, summaries?: readonly SubagentSummary[]) {
  const model = buildToolRenderModel(item, t, runRunning)
  const row = subagentRowModel({ name: model.name, args: model.args, details: model.details, failed: model.failed }, t)
  const label = row?.label ?? labelFromArgs(model.args)
  const task = row?.task ?? taskFromArgs(model.args)
  const childId = row?.childId ?? matchChildId(label, summaries)
  return {
    key: item.key,
    ...(childId === undefined ? {} : { childId }),
    ...(label === undefined ? {} : { label }),
    ...(task === undefined ? {} : { task }),
    failed: model.failed,
    pending: model.running,
  }
}
```

嵌套调用：

```ts
function nestedSubagentCalls(item, t, runRunning, summaries): SubagentCallItem[] {
  const live = item.children.flatMap(child => {
    if ((child.result?.toolName ?? child.message.toolName)?.toLocaleLowerCase() !== 'subagent') return []
    const details = recordOf(child.result?.details)
    const args = recordOf(details?.arguments) ?? {}
    const label = labelFromArgs(args)
    const childId = matchChildId(label, summaries)
    return [{
      key: `nested:${item.key}:${child.result?.toolCallId ?? child.key}`,
      ...(childId === undefined ? {} : { childId }),
      ...(label === undefined ? {} : { label }),
      ...(taskFromArgs(args) === undefined ? {} : { task: taskFromArgs(args) }),
      failed: child.result?.isError === true || recordOf(details?.summary)?.isError === true,
      pending: child.result?.status === 'running' || child.result?.streaming === true,
    }]
  })
  if (live.length > 0) return live

  const model = buildToolRenderModel(item, t, runRunning)
  const details = recordOf(model.details)
  const values = Array.isArray(details?.calls) ? details.calls
    : Array.isArray(recordOf(details?.result)?.calls) ? recordOf(details?.result)?.calls as unknown[] : []
  return values.flatMap((value, index) => {
    const call = recordOf(value)
    if (call === undefined || typeof call.name !== 'string' || call.name.toLocaleLowerCase() !== 'subagent') return []
    const args = parseArgsOrPrefix(call.args)   // 见下方「截断 args」
    const label = labelFromArgs(args)
    const childId = matchChildId(label, summaries)
    const status = typeof call.status === 'string' ? call.status.toLocaleLowerCase() : ''
    return [{
      key: `nested:${item.key}:${String(call.id ?? index)}`,
      ...(childId === undefined ? {} : { childId }),
      ...(label === undefined ? {} : { label }),
      ...(taskFromArgs(args) === undefined ? {} : { task: taskFromArgs(args) }),
      failed: status === 'error',
      pending: status === 'running' || status === 'pending',
    }]
  })
}
```

**截断 args 的还原**（关键坑）：

```ts
function parseArgsOrPrefix(value: unknown): Record<string, unknown> {
  if (typeof value !== 'string') return recordOf(value) ?? {}
  try { return recordOf(JSON.parse(value)) ?? {} } catch { /* 投影截断，走前缀 */ }
  return {
    ...(rawStringField(value, 'label') === undefined ? {} : { label: rawStringField(value, 'label') }),
    ...(rawStringField(value, 'task') === undefined ? {} : { task: rawStringField(value, 'task') }),
  }
}

function rawStringField(raw: string, key: 'label' | 'task'): string | undefined {
  const marker = `"${key}"`
  const at = raw.indexOf(marker)
  if (at < 0) return undefined
  let index = at + marker.length
  while (raw[index] === ' ' || raw[index] === ':') index += 1
  if (raw[index] !== '"') return undefined
  index += 1
  let value = ''
  while (index < raw.length) {
    const char = raw[index]
    if (char === '\\') {
      const next = raw[index + 1]
      if (next === undefined) break
      value += next === 'n' ? '\n' : next === 't' ? '\t' : next === 'r' ? '\r' : next
      index += 2
      continue
    }
    if (char === '"') return value
    value += char
    index += 1
  }
  return value === '' ? undefined : value
}
```

Entries 与兜底：

```ts
export interface SubagentRunEntry {
  readonly key: string
  readonly childId?: string
  readonly label: string
  readonly task?: string
  readonly status: SubagentRunStatus
  readonly tokens?: number
  readonly durationMs?: number
  readonly metricsAt?: number
  readonly colorIndex: number
}

export function subagentRunEntries(group, summaries, t): SubagentRunEntry[] {
  const taken = new Set(group.items.flatMap(item => item.childId === undefined ? [] : [item.childId]))
  const unmatched = group.items.filter(item => item.childId === undefined && !item.pending).length
  // 已完成的委派通常是最新创建的一批子会话，取尾部顺序兜底。
  const spare = unmatched === 0 ? []
    : (summaries ?? []).filter(row => !taken.has(row.id)).slice(-unmatched)
  return group.items.map(item => {
    const childId = item.childId ?? (item.pending ? undefined : spare.shift()?.id)
    const row = childId === undefined ? undefined : summaries?.find(candidate => candidate.id === childId)
    const status = item.failed ? 'failed'
      : childId === undefined && item.pending ? 'creating'
        : item.pending || row?.status === 'running' ? 'running'
          : 'done'
    return {
      key: item.key,
      ...(childId === undefined ? {} : { childId }),
      label: row?.label || item.label || t('子智能体', 'Subagent'),
      ...(item.task === undefined ? {} : { task: item.task }),
      status,
      ...(row?.tokens === undefined ? {} : { tokens: row.tokens }),
      ...(row?.durationMs === undefined ? {} : { durationMs: row.durationMs }),
      ...(row?.metricsAt === undefined ? {} : { metricsAt: row.metricsAt }),
      colorIndex: subagentColorIndex(childId ?? item.label ?? item.key, summaries),
    }
  })
}
```

辅助函数（与上面的核心片段配套，缺一不可）：

```ts
function recordOf(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined
}

function taskFromArgs(args: Readonly<Record<string, unknown>>): string | undefined {
  const task = typeof args.task === 'string' ? args.task.trim() : ''
  return task === '' ? undefined : task
}

/** 与服务端 normalizeLabel 一致：显式 label，否则 task 首行，最多 60 字符。 */
function labelFromArgs(args: Readonly<Record<string, unknown>>): string | undefined {
  const explicit = typeof args.label === 'string' ? args.label.trim() : ''
  const raw = explicit === '' ? taskFromArgs(args)?.split('\n').find(line => line.trim() !== '')?.trim() ?? '' : explicit
  return raw === '' ? undefined : raw.length > 60 ? `${raw.slice(0, 59)}…` : raw
}

function matchChildId(label: string | undefined, summaries?: readonly SubagentSummary[]): string | undefined {
  if (label === undefined) return undefined
  const exact = summaries?.find(row => row.label === label)
  if (exact !== undefined) return exact.id
  // 截断/空白归一化后尾部可能不同，接受前缀匹配（重复 label 取第一个）。
  return summaries?.find(row => row.label.startsWith(label) || label.startsWith(row.label))?.id
}

export function subagentColorIndex(id: string, summaries?: readonly SubagentSummary[]): number {
  const index = summaries?.findIndex(row => row.id === id) ?? -1
  if (index >= 0) return index % 6
  let hash = 0
  for (let at = 0; at < id.length; at += 1) hash = (hash * 31 + id.charCodeAt(at)) >>> 0
  return hash % 6
}

export function subagentEntryDurationMs(entry: SubagentRunEntry, now: number): number | undefined {
  if (entry.durationMs === undefined) return undefined
  if (entry.status !== 'running' || entry.metricsAt === undefined) return entry.durationMs
  return entry.durationMs + Math.max(0, now - entry.metricsAt)
}

export function formatSubagentSeconds(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1_000))
  return total < 60 ? `${total}秒` : `${Math.floor(total / 60)}分${String(total % 60).padStart(2, '0')}秒`
}
```

`formatTokens` 直接复用 `src/web/render-labels.ts` 的导出。

抬头：

```ts
export function subagentRunHeadline(entries, t) {
  const total = entries.length
  const creating = entries.filter(entry => entry.status === 'creating').length
  const running = entries.filter(entry => entry.status === 'running').length
  const failed = entries.filter(entry => entry.status === 'failed').length
  const done = total - creating - running - failed
  if (creating > 0 && running === 0) return { tone: 'creating', title: t('正在创建子智能体', 'Creating subagents'), count: t(`${done + failed}/${total} 结束`, `${done + failed}/${total} settled`) }
  if (running > 0) return { tone: 'running', title: t('子智能体运行中', 'Subagents running'), count: t(`${done + failed}/${total} 结束`, `${done + failed}/${total} settled`) }
  if (failed > 0) return { tone: 'failed', title: t(`${done} 个已完成 · ${failed} 个失败`, `${done} finished · ${failed} failed`), count: '' }
  return { tone: 'done', title: t(`${total} 个子智能体已完成`, `${total} subagents finished`), count: '' }
}
```

### 步骤 2：新增 `SubagentRunStrip.tsx` / `.module.css`

组件合同：

```ts
export default function SubagentRunStrip({ group, summaries, t, onOpen }: {
  group: SubagentRunGroup
  summaries?: readonly SubagentSummary[]
  t: Translate
  /** 打开子会话只读 tab；标题用 chip 的 label。 */
  onOpen?: (conversationId: string, title?: string) => void
})
```

要点：

- 有 running/creating 时 1s tick 一次，用于推进运行中的时长；`settled` 后停止。
- chip 是 `<button>`；`disabled={onOpen === undefined || entry.childId === undefined}`。
- `data-color={0..5}`、`data-status={creating|running|done|failed}`，方便测试和 CSS。
- 抬头 `role="status"`；chip 的 `aria-label` 带 label + 状态 + tokens。
- 点 chip：`onOpen?.(entry.childId, entry.label)`。**不要**调用 `selectConversation`，
  也不要切轨迹；当前架构是打开右侧 `SubagentPane`。
- 单个顶层调用不会进这个组件（见分组规则）；嵌套调用即使是 1 个也会进。

```tsx
const entries = useMemo(() => subagentRunEntries(group, summaries, t), [group, summaries, t])
const headline = subagentRunHeadline(entries, t)
const live = entries.some(entry => entry.status === 'running' || entry.status === 'creating')
const [now, setNow] = useState(() => Date.now())
useEffect(() => {
  if (!live) return
  const timer = window.setInterval(() => setNow(Date.now()), 1_000)
  return () => window.clearInterval(timer)
}, [live])
```

chip meta：

```tsx
function chipMeta(entry, now, t) {
  if (entry.status === 'creating') return t('创建中', 'Creating')
  if (entry.status === 'failed') return t('失败', 'Failed')
  if (entry.status === 'running') {
    const duration = subagentEntryDurationMs(entry, now)
    if (duration !== undefined) return formatSubagentSeconds(duration)
    return entry.tokens === undefined || entry.tokens === 0 ? '' : formatTokens(entry.tokens)
  }
  return entry.tokens === undefined ? '' : formatTokens(entry.tokens)
}
```

CSS 关键点（完整类名可按项目习惯微调）：

- 根节点 `display:flex; overflow:hidden; border-radius:var(--dsw-radius-lg); container-type:inline-size;`
  背景用 `color-mix(in srgb, var(--dsw-alias-label-primary) 4%, transparent)`。
- chip：`flex:0 1 auto; min-width:0; border-radius:999px;` 背景
  `color-mix(in srgb, var(--sa-agent) var(--sa-tint), transparent)`，文字 `var(--sa-ink)`。
- 6 组颜色变量定义在根节点；`body[data-ds-dark-theme]` 下覆盖成暗色更亮的 6 色。
- 状态：running/creating 用旋转环；done 用实心圆 + 勾；failed 用红底 × + 1px 红色内描边。
- **容器查询查的是 strip 自己**（根节点 `container-type: inline-size`），不是主列：
  - `<= 740px`：隐藏 done chip 的 tokens（保 label）；
  - `<= 620px`：隐藏 label、count；
  - `<= 430px`：连 running/creating 的 meta 也隐藏，只留彩色环。
- `prefers-reduced-motion: reduce`：停掉旋转和过渡。
- 实测主列宽度约 680px：5 个 chip 的 label 必须完整；tokens 让位。不要在窄容器里把
  label 挤成 `es...`。

### 步骤 3：接入 `transcript.tsx`

1. `TranscriptProps` 增加：

```ts
/** 当前会话的直接子会话投影；strip 的首次绘制，之后由自己的轮询刷新。 */
subagents?: readonly SubagentSummary[]
```

2. 在 `Transcript` 里加 hook（`api` 已经 import）：

```ts
function useLiveSubagents(conversationId: string | undefined, projected: readonly SubagentSummary[] | undefined) {
  const [rows, setRows] = useState<readonly SubagentSummary[]>(() => projected ?? [])
  useEffect(() => { setRows(projected ?? []) }, [projected])
  const running = rows.some(row => row.status === 'running')
  useEffect(() => {
    if (conversationId === undefined || !running) return
    let active = true
    const timer = window.setInterval(() => {
      api.listChildren(conversationId).then(next => { if (active) setRows(next) }).catch(() => undefined)
    }, 1_500)
    return () => { active = false; window.clearInterval(timer) }
  }, [conversationId, running])
  return rows
}
```

3. 把 `liveSubagents` 经 `RunTranscript` 传到 `ProcessGroup`（新增 `subagents` prop）。

4. 在 `ProcessGroup` 里对 **`inline`**（pinned 插件行已剔除）做分组：

```ts
const parts = useMemo(
  () => groupSubagentRuns(inline, t, live, subagents),
  [inline, t, live, subagents],
)
const renderPart = (part: TranscriptPart): JSX.Element => part.kind === 'subagentRun'
  ? <SubagentRunStrip key={part.key} group={part} summaries={subagents} t={t} onOpen={onOpenSubagent} />
  : <ProcessPartView key={part.key} part={part as ProcessPart} runRunning={live} ... />
const body = parts.map(renderPart)
```

注意：

- `pinned` 的插件行保持原逻辑；strip 不参与 pinned。
- `run.process` 里已有 `toolGroup` part（查阅/终端），strip 只处理 `kind === 'tool'` 的
  `subagent` / `codemode`；`toolGroup` 原样透传。
- strip 在 `processBody` 里，会随工作分组折叠；这是预期行为，不要为了它单独跳出折叠区。
- 单个顶层 `subagent` 仍由 `ProcessPartView` → `ToolCard` 渲染（分组规则保证）。
- `codemode` 的 nested 行已经被 `ToolCard`/`CodemodeBody` 过滤；strip 必须接管，否则丢失。

### 步骤 4：接入 `App.tsx`

当前 `<Transcript ... conversationId={...}>` 在 `activeDetail` 分支里。增加一行：

```tsx
subagents={activeDetail.subagents}
```

不要改 `onOpenSubagent`：它已经是
`(childId, title) => { openSubagentTab(childId, title) }`，strip 直接复用。

### 步骤 5：测试

新增 `tests/subagent-run-model.test.ts`（纯函数，node 环境）：

| 用例 | 断言 |
|---|---|
| 连续 3 个顶层 subagent | 折成一个 `source: 'calls'` 组；item 顺序与 childId 对应 |
| 单个顶层 subagent | 不折组，原 `ProcessPart` 保留 |
| 顶层 + bash + 顶层 | 两组，中间 bash 原样 |
| 无 childId 的顶层调用 | 组内 `childId` 缺失、`pending: true`，entry 为 `creating` |
| live 投影 `{status,result:{conversationId,label}}` | childId/label 正确 |
| codemode live children（nested tool message） | 组在 codemode 前，`source: 'codemode'`，label 匹配 childId |
| codemode 已结束 `details.calls` | 从 `calls` 提取；`ok→done`、`error→failed` |
| 截断的 args（`{"label":"essay-1","task":"...`） | label 仍能还原并匹配 childId |
| label 尾部截断 | 前缀匹配 |
| 完成态 label 完全对不上 | 按最新子会话顺序兜底，chip 仍可点 |
| 创建中的调用 | 不抢已有子会话，`childId` 为空、`creating` |
| 抬头 | creating/running/done/failed 四种文案与计数 |
| 时长 | `subagentEntryDurationMs` 运行中推进、settled 不变；`formatSubagentSeconds` |

现有 `tests/render-model.test.ts` 已经覆盖 `subagentRowModel` 的 label 和 live
`result` 形状，不要重复写；实施时确认这两个用例仍通过。

### 步骤 6：文档同步

- `docs/spec.md`：修订「原 DSH 彩色 `SubagentRunStrip` 不再用于主转录」这一条，改成
  「单行 `ToolCard` 保留给单个调用；多个调用/嵌套调用使用正文条带；点击仍开只读 Inspector tab」。
- `docs/parity.md`：补一条变更记录和证据（demo `[subagents]`、真实 codemode 会话、ego 截图）。
- 本文件保留为实施计划；实施完成后把状态改为「已实施」并补实际测试数字。

---

## 5. 验收判据

### 5.1 自动化

```sh
npm run typecheck
npm test
npm run build
```

新测试至少覆盖第 5 节表格中的分组/状态/兜底/截断/抬头/时长。

### 5.2 demo（无需真实模型）

`PI_WEB_DEMO=1 PI_WEB_PORT=4318 PI_WEB_DATA_DIR=.data/demo npm run dev`，
新会话发送 `[subagents]`：

- 出现 3 个彩色 chip；完成后 label 为 spring/city/book，tokens 可见（宽度允许时）。
- 运行期间抬头「子智能体运行中」+ `x/3 结束`；首次创建瞬间出现「创建中」。
- 点任意 chip → 右侧 Inspector 打开该子会话只读 tab；同一 childId 只开一个 tab。
- 父会话保持主列，不被替换。

### 5.3 真实模型 / 代码模式（关键）

用真实模型（例如 `opencode-go/deepseek-v4.1-flash`）发一条：
「请用 codemode 工具同时启动 5 个子 agent，各写一篇 500 字小作文，label 用 essay-1…5」。

必须验证：

| 判据 | 期望 |
|---|---|
| 正文出现一行 5 个 chip | `essay-1…5`，颜色互不相同 |
| 脚本卡 | 不再出现 5 条嵌套 subagent 行 |
| 完成态 chip 可点 | 点 essay-1 → 右侧只读子会话 tab，标题 essay-1 |
| 返回 | 关闭/切回父会话，strip 仍在 |
| 运行态 | 抬头 `x/5 结束`；timer 每秒推进 |
| 创建瞬间 | 至少能观察到「创建中」（真实运行可能很快，必要时用单测锁状态） |
| 失败态 | 无真实失败时由单测覆盖（红 × + 描边） |

建议用 ego 在 4317 上做真实浏览器验收，截图存 `artifacts/subagent-strip-check/`（gitignored）。

### 5.4 视觉

- 1440×900 浅色/深色：chip 文字可读，颜色区分明确。
- 主列 680px 左右：5 个 label 完整，tokens 自动隐藏；不要在 5 个 chip 时把 label 挤成
  `es...`。
- 窄窗口（约 800px 主列宽）：labels 隐藏后只剩彩色环/状态，仍保持一行。
- `prefers-reduced-motion`：无旋转动画。

---

## 6. 已知坑（按出现频率排序）

1. **嵌套 subagent 行被隐藏但没有 strip**：`ToolCard`/`CodemodeBody` 的过滤已经存在；
   如果只实现顶层分组，codemode 里的子智能体会彻底消失。必须同时实现
   `source: 'codemode'` 的分组。
2. **运行中 details 在 `result` 下**：`subagentRowModel` 已处理；但自己写解析时不要
   只看 `details.conversationId`。
3. **codemode `args` 被截断**：不要 `JSON.parse` 后放弃；用第 4 节的字段前缀还原。
4. **完成态 chip 不可点**：label 可能因截断/重命名对不上。必须有前缀匹配和
   「最新子会话顺序」兜底；兜底只给已完成调用，避免创建中抢错。
5. **颜色跳变**：创建中 chip 用 hash 色，匹配到 childId 后按子会话下标取色；短暂跳变
   可接受，但不要每次 render 重新随机。
6. **容器查询放错层**：查主列宽度会误判；`container-type` 放在 strip 根节点，查 strip 自己。
7. **把 tokens 放在 label 之前保**：窄条带会先把 label 挤成省略号；优先保 label，再保
   done 的 tokens。
8. **点 chip 去主列/轨迹**：当前产品语义是右侧只读 `SubagentPane`；不要调用
   `selectConversation`，也不要切轨迹。
9. **单个调用也折成条带**：会退掉当前已验收的 ZCode 单行工具卡；顶层只有 1 个时保留
   `ToolCard`，嵌套调用例外（因为 nested 行已被隐藏）。
10. **进程组折叠**：strip 在 `processBody` 内，历史回合折叠时看不到；这是与现有工具行
    一致的预期，不要单独把 strip 提升到折叠区外。
11. **React key 不稳定**：live → settled 时 nested call 的 id 要稳定（`nested:${codemodeKey}:${callId}`），
    不要用数组下标，否则 DOM 重建导致闪烁。
12. **单个顶层调用的文案**：按本方案单个顶层调用仍走当前 `ToolCard`，它的状态词是
    「运行中/已完成」，不会显示「创建中」。如果产品要求单个调用也显示「创建中」，在
    `ToolCard` 的 `subagentStatus` 里补 `model.running && childId === undefined` 的分支；
    这属于额外范围，不要顺手改掉现有的单行交互。
13. **nested 调用尚未启动时会少一个 chip**：`codemode` 的 `item.children` 只包含已经出现
    live nested tool message 的调用；还没开始的调用不在里面。strip 会先少一个、启动后补齐。
    这是正常的渐进渲染，不要用数组下标做 key，也不要把「少一个」当成数据丢失。

---

## 7. 变更清单

- [x] `src/web/subagent-run-model.ts` 新增
- [x] `src/web/SubagentRunStrip.tsx` 新增
- [x] `src/web/SubagentRunStrip.module.css` 新增
- [x] `src/web/transcript.tsx`：`subagents` prop、`useLiveSubagents`、`ProcessGroup` 分组
- [x] `src/web/App.tsx`：`subagents={activeDetail.subagents}`
- [x] `tests/subagent-run-model.test.ts` 新增（14 项）
- [x] `docs/spec.md` 修订旧决策
- [ ] `docs/parity.md` 补变更记录（由主智能体合并时统一补）
- [x] typecheck / 测试全绿（build 与 demo / 真实模型验收由主智能体负责）
- [x] 真实 codemode 5 子 agent + ego 截图（demo 分支按用户要求跳过）：`opencode-go/deepseek-v4.1-flash`，codemode 并行 5 个 `tools.subagent`（essay-1…5）——正文一行条带 5 个 chip、颜色 0–4 互异、抬头「子智能体运行中 0/5 结束」→「5 个子智能体已完成」、tokens（14.1K…）结算后可见；codemode 卡内嵌套 subagent 行 0 条；点 essay-1 → 右侧只读 tab（标题 essay-1，内容为子会话原文），主列与 strip 保持不变；主列变窄时 chip 按容器查询降级为纯色点。截图 `artifacts/subagent-strip-check/{live-early,settled,inspector-tab}.png`。「创建中」瞬态真实运行过快未捕获，由单测锁定状态文案。
