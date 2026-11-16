import { describe, expect, it } from 'vitest'
import type { ChatMessage, ContentBlock, SubagentSummary } from '../src/shared/types.ts'
import type { ProcessPart, ToolItem } from '../src/web/render-model.ts'
import {
  formatSubagentSeconds, groupSubagentRuns, subagentColorIndex, subagentEntryDurationMs, subagentRunEntries,
  subagentRunHeadline, type SubagentRunEntry, type SubagentRunGroup, type SubagentRunStatus,
} from '../src/web/subagent-run-model.ts'

/**
 * 子智能体运行条（run strip）渲染模型契约测试：把连续/嵌套的 subagent 调用折叠成
 * 一个运行条、子会话 id 与标签的匹配规则（含截断/改名/未知标签的回退）、
 * 分组标题文案、运行时长与配色索引。
 */

/** 仅中文翻译器，与应用自身的 locale 开关一致。 */
const t = (chinese: string): string => chinese

/**
 * 构造 toolCall 内容块。
 * @returns id/name/arguments 齐全的 toolCall 块
 */
function callBlock(id: string, name: string, args: Record<string, unknown> = {}): Extract<ContentBlock, { type: 'toolCall' }> {
  return { type: 'toolCall', id, name, arguments: args }
}

/**
 * 构造工具结果消息 fixture。
 * @returns 空文本块的 tool 消息，字段可覆盖
 */
function toolMessage(id: string, fields: Partial<ChatMessage> = {}): ChatMessage {
  return { id, role: 'tool', blocks: [{ type: 'text', text: '' }], timestamp: 0, ...fields }
}

/**
 * 构造一条根级工具 part：携带已结算的助手调用块，可选附加投影结果。
 * @param key part 唯一键（同时派生消息/调用 id）
 * @param name 工具名
 * @param options args 参数、result 结果消息、children 嵌套子项、order 排序
 */
function toolPart(key: string, name: string, options: {
  args?: Record<string, unknown>
  result?: ChatMessage
  children?: ToolItem[]
  order?: number
} = {}): ProcessPart {
  return {
    kind: 'tool',
    key,
    order: options.order ?? 0,
    item: {
      key,
      message: { id: `${key}:msg`, role: 'assistant', blocks: [callBlock(`${key}:call`, name, options.args ?? {})], timestamp: 0 },
      call: callBlock(`${key}:call`, name, options.args ?? {}),
      ...(options.result === undefined ? {} : { result: options.result }),
      children: options.children ?? [],
      order: options.order ?? 0,
    },
  }
}

/**
 * 已结算的顶层 `subagent` 调用：details 直接命名其子会话（conversationId + status + label）。
 */
function settledSubagent(key: string, childId: string, label: string, failed = false): ProcessPart {
  return toolPart(key, 'subagent', {
    args: { label, task: `do ${label}` },
    result: toolMessage(`${key}:result`, {
      toolCallId: `${key}:call`,
      toolName: 'subagent',
      status: failed ? 'error' : 'completed',
      isError: failed,
      details: { conversationId: childId, status: failed ? 'failed' : 'completed', label },
    }),
  })
}

/**
 * 运行中的顶层 `subagent` 调用：运行时投影把载荷嵌套在 details.result 之下。
 */
function liveSubagent(key: string, childId: string, label: string): ProcessPart {
  return toolPart(key, 'subagent', {
    args: { label },
    result: toolMessage(`${key}:result`, {
      toolCallId: `${key}:call`,
      toolName: 'subagent',
      status: 'running',
      streaming: true,
      details: { status: 'running', result: { conversationId: childId, status: 'running', label } },
    }),
  })
}

/**
 * codemode part：脚本发起的嵌套 subagent 调用仍在运行，挂在 children 下。
 */
function liveCodemode(key: string, children: ToolItem[]): ProcessPart {
  return toolPart(key, 'codemode', {
    args: { code: 'const a = await tools.subagent(...)' },
    children,
  })
}

/**
 * 构造 codemode 脚本内的嵌套 subagent 调用项。
 * @returns parentToolCallId 指向 codemode 调用、details 带 parentCallId 的 ToolItem
 */
function nestedCallItem(key: string, id: string, label: string): ToolItem {
  const message = toolMessage(id, {
    toolCallId: id,
    toolName: 'subagent',
    status: 'running',
    parentToolCallId: 'codemode:call',
    details: { status: 'running', parentCallId: 'codemode:call', arguments: { label, task: `do ${label}` } },
  })
  return { key, message, result: message, children: [], order: 1 }
}

/**
 * 已结算的 codemode part：脚本的嵌套调用记录存放在 details.calls（JSON 字符串 args）。
 */
function settledCodemode(key: string, calls: Array<{ id: string; name: string; args: string; status: string }>): ProcessPart {
  return toolPart(key, 'codemode', {
    args: { code: 'const a = await tools.subagent(...)' },
    result: toolMessage(`${key}:result`, {
      toolCallId: `${key}:call`,
      toolName: 'codemode',
      status: 'completed',
      details: { calls },
    }),
  })
}

/**
 * 构造子会话摘要 fixture。
 * @param id 子会话 id
 * @param label 委派标签
 * @returns status 为 inactive 的 SubagentSummary，字段可覆盖
 */
function summary(id: string, label: string, overrides: Partial<SubagentSummary> = {}): SubagentSummary {
  return { id, label, title: label, status: 'inactive', answer: '', createdAt: 0, updatedAt: 0, ...overrides }
}

/** 类型收窄谓词：part 是否是折叠出的运行条分组。 */
const isStrip = (part: ProcessPart | SubagentRunGroup): part is SubagentRunGroup => part.kind === 'subagentRun'

describe('subagent run model', () => {
  it('folds three consecutive top-level subagent calls into one strip with matching child ids', () => {
    const parts = [
      settledSubagent('a', 'child-1', 'essay-1'),
      settledSubagent('b', 'child-2', 'essay-2'),
      settledSubagent('c', 'child-3', 'essay-3'),
    ]
    const summaries = [summary('child-1', 'essay-1'), summary('child-2', 'essay-2'), summary('child-3', 'essay-3')]
    const grouped = groupSubagentRuns(parts, t, false, summaries)
    expect(grouped).toHaveLength(1)
    const strip = grouped[0]
    expect(isStrip(strip) && strip.source).toBe('calls')
    expect(isStrip(strip) && strip.items.map(item => item.childId)).toEqual(['child-1', 'child-2', 'child-3'])
    expect(isStrip(strip) && strip.items.map(item => item.label)).toEqual(['essay-1', 'essay-2', 'essay-3'])
  })

  // 边界：只有一个调用时不折叠，保持原 tool part 渲染。
  it('keeps a single top-level subagent call as its original tool part', () => {
    const parts = [settledSubagent('a', 'child-1', 'essay-1')]
    const grouped = groupSubagentRuns(parts, t, false, [summary('child-1', 'essay-1')])
    expect(grouped).toHaveLength(1)
    expect(grouped[0]).toHaveProperty('kind', 'tool')
    expect(grouped[0]).toHaveProperty('key', 'a')
  })

  // 边界：中间夹了其他工具行（bash）就不再相连，各成独立 part。
  it('does not join two top-level calls across an interleaved bash row', () => {
    const bash = toolPart('b', 'bash', { args: { command: 'ls' }, result: toolMessage('b:result', { toolCallId: 'b:call', toolName: 'bash', status: 'completed' }) })
    const parts = [settledSubagent('a', 'child-1', 'essay-1'), bash, settledSubagent('c', 'child-2', 'essay-2')]
    const summaries = [summary('child-1', 'essay-1'), summary('child-2', 'essay-2')]
    const grouped = groupSubagentRuns(parts, t, false, summaries)
    expect(grouped.map(part => part.kind)).toEqual(['tool', 'tool', 'tool'])
    expect(grouped.map(part => part.key)).toEqual(['a', 'b', 'c'])
  })

  // 创建中状态：无结果的顶层调用（投影尚未生成子会话）标记 pending，
  // 运行条条目状态为 creating 且不挂 childId。
  it('shows childless pending top-level calls as creating', () => {
    const parts = [
      toolPart('a', 'subagent', { args: { label: 'fresh-task' } }),
      toolPart('b', 'subagent', { args: { label: 'fresh-2' } }),
    ]
    const summaries = [summary('child-1', 'other-delegation')]
    const grouped = groupSubagentRuns(parts, t, true, summaries)
    const strip = grouped[0]
    expect(isStrip(strip) && strip.items[0]?.pending).toBe(true)
    expect(isStrip(strip) && strip.items[0]?.childId).toBeUndefined()
    const entries = isStrip(strip) ? subagentRunEntries(strip, summaries, t) : []
    expect(entries).toHaveLength(2)
    expect(entries.every(entry => entry.status === 'creating')).toBe(true)
    expect(entries.every(entry => entry.childId === undefined)).toBe(true)
  })

  // 运行中投影的载荷形状：childId/label 从 details.result 解出，
  // 条目状态 running 且配色按顺序索引 0/1。
  it('reads the live projection whose details nest the payload under result', () => {
    const parts = [liveSubagent('a', 'child-9', 'city'), liveSubagent('b', 'child-8', 'spring')]
    const summaries = [summary('child-9', 'city', { status: 'running' }), summary('child-8', 'spring', { status: 'running' })]
    const grouped = groupSubagentRuns(parts, t, true, summaries)
    const strip = grouped[0]
    expect(isStrip(strip) && strip.items[0]?.childId).toBe('child-9')
    expect(isStrip(strip) && strip.items[0]?.label).toBe('city')
    const entries = isStrip(strip) ? subagentRunEntries(strip, summaries, t) : []
    expect(entries[0]?.status).toBe('running')
    expect(entries[0]?.colorIndex).toBe(0)
    expect(entries[1]?.colorIndex).toBe(1)
  })

  // 嵌套提升：codemode 脚本运行中的嵌套 subagent 调用被提升为运行条，
  // 排在脚本卡片（原 codemode part）之前，source 标记为 codemode。
  it('lifts codemode live nested subagent calls into a strip before the script card', () => {
    const codemode = liveCodemode('cm', [
      nestedCallItem('n1', 'nested-1', 'essay-1'),
      nestedCallItem('n2', 'nested-2', 'essay-2'),
    ])
    const parts = [codemode]
    const summaries = [summary('child-1', 'essay-1'), summary('child-2', 'essay-2')]
    const grouped = groupSubagentRuns(parts, t, true, summaries)
    expect(grouped).toHaveLength(2)
    expect(grouped[0]).toHaveProperty('kind', 'subagentRun')
    expect(grouped[1]).toHaveProperty('kind', 'tool')
    const strip = grouped[0]
    expect(isStrip(strip) && strip.source).toBe('codemode')
    expect(isStrip(strip) && strip.items.map(item => item.childId)).toEqual(['child-1', 'child-2'])
    expect(isStrip(strip) && strip.items.map(item => item.label)).toEqual(['essay-1', 'essay-2'])
  })

  // 已结算 codemode：details.calls 提取条目，status ok→done、error→failed；
  // 非 subagent 调用（bash）不进运行条。
  it('extracts codemode settled calls from details.calls with ok to done and error to failed', () => {
    const codemode = settledCodemode('cm', [
      { id: '1', name: 'subagent', args: JSON.stringify({ label: 'essay-1' }), status: 'ok' },
      { id: '2', name: 'subagent', args: JSON.stringify({ label: 'essay-2' }), status: 'error' },
      { id: '3', name: 'bash', args: '{}', status: 'ok' },
    ])
    const summaries = [summary('child-1', 'essay-1'), summary('child-2', 'essay-2')]
    const grouped = groupSubagentRuns([codemode], t, false, summaries)
    expect(grouped).toHaveLength(2)
    const strip = grouped[0]
    expect(isStrip(strip) && strip.items).toHaveLength(2)
    const entries = isStrip(strip) ? subagentRunEntries(strip, summaries, t) : []
    expect(entries.map(entry => entry.status)).toEqual(['done', 'failed'])
    expect(entries.map(entry => entry.childId)).toEqual(['child-1', 'child-2'])
  })

  // 容错：details.calls 的 args 可能是被截断的 JSON 前缀（脚本日志超长），
  // label/task 仍要从部分前缀恢复出来。
  it('recovers label and task from a truncated codemode args prefix', () => {
    const truncated = '{"label":"essay-1","task":"write a long essay about spring'
    const codemode = settledCodemode('cm', [{ id: '1', name: 'subagent', args: truncated, status: 'ok' }])
    const summaries = [summary('child-1', 'essay-1'), summary('child-0', 'unrelated')]
    const grouped = groupSubagentRuns([codemode], t, false, summaries)
    const strip = grouped[0]
    expect(isStrip(strip) && strip.items[0]?.label).toBe('essay-1')
    expect(isStrip(strip) && strip.items[0]?.task).toBe('write a long essay about spring')
    const entries = isStrip(strip) ? subagentRunEntries(strip, summaries, t) : []
    expect(entries[0]?.childId).toBe('child-1')
  })

  it('prefix-matches a label truncated before its child was renamed or capped', () => {
    // details 不带会话 id，只能靠 label 匹配：调用里的 label 是子会话标签
    // 被截断/改名前的前缀，按前缀匹配找回 childId。
    const parts = [
      settledSubagent('a', '', 'write-a-long-essay-repo'),
      settledSubagent('b', 'child-2', 'essay-2'),
    ]
    const summaries = [summary('child-1', 'write-a-long-essay-report'), summary('child-2', 'essay-2')]
    const grouped = groupSubagentRuns(parts, t, false, summaries)
    const strip = grouped[0]
    expect(isStrip(strip) && strip.items[0]?.childId).toBe('child-1')
    const entries = isStrip(strip) ? subagentRunEntries(strip, summaries, t) : []
    expect(entries[0]?.childId).toBe('child-1')
    expect(entries[0]?.status).toBe('done')
  })

  it('falls back to the newest unmatched children for settled calls with unknown labels', () => {
    // 空 conversationId 使调用无从精确匹配，只能走回退：
    // 按尾序把两条已完成的委派映射到「最新且未匹配」的两个子会话。
    const parts = [settledSubagent('a', '', 'zzz-1'), settledSubagent('b', '', 'zzz-2')]
    const summaries = [
      summary('child-old', 'oldest'),
      summary('child-2', 'essay-2'),
      summary('child-3', 'essay-3'),
    ]
    const grouped = groupSubagentRuns(parts, t, false, summaries)
    const strip = grouped[0]
    const entries = isStrip(strip) ? subagentRunEntries(strip, summaries, t) : []
    // 两条已完成委派按尾序映射到最新的两个子会话。
    expect(entries.map(entry => entry.childId)).toEqual(['child-2', 'child-3'])
    expect(entries.every(entry => entry.status === 'done')).toBe(true)
  })

  // 安全边界：creating（无投影结果）的调用不得抢占任何已存在的子会话，
  // 即使摘要里留有未匹配的 child 也保持 childId 为空。
  it('never lets a creating call claim an existing child conversation', () => {
    const parts = [
      toolPart('a', 'subagent', { args: { label: 'brand-new' } }),
      settledSubagent('b', 'child-2', 'essay-2'),
    ]
    const summaries = [summary('child-1', 'essay-1'), summary('child-2', 'essay-2')]
    const grouped = groupSubagentRuns(parts, t, true, summaries)
    const strip = grouped[0]
    const entries = isStrip(strip) ? subagentRunEntries(strip, summaries, t) : []
    expect(entries).toHaveLength(2)
    expect(entries[0]?.status).toBe('creating')
    expect(entries[0]?.childId).toBeUndefined()
    expect(entries[1]?.childId).toBe('child-2')
    expect(entries[1]?.status).toBe('done')
  })

  // 分组标题矩阵：有未结束条目时显示「N/M 结束」进度；全部 done 与混合 failed
  // 各有独立标题措辞。
  it('titles the strip for creating, running, done, and failed groups', () => {
    const entry = (status: SubagentRunStatus, key?: string): SubagentRunEntry => ({ key: key ?? status, label: 'x', status, colorIndex: 0 })
    expect(subagentRunHeadline([entry('creating'), entry('done', 'd')], t))
      .toEqual({ tone: 'creating', title: '正在创建子智能体', count: '1/2 结束' })
    expect(subagentRunHeadline([entry('running'), entry('done', 'd')], t))
      .toEqual({ tone: 'running', title: '子智能体运行中', count: '1/2 结束' })
    expect(subagentRunHeadline([entry('done'), entry('done', 'd2')], t))
      .toEqual({ tone: 'done', title: '2 个子智能体已完成', count: '' })
    expect(subagentRunHeadline([entry('done'), entry('failed', 'f')], t))
      .toEqual({ tone: 'failed', title: '1 个已完成 · 1 个失败', count: '' })
  })

  // 时长语义：running 条目的时长随 metricsAt 推进（now - metricsAt + durationMs 基线，
  // now 早于 metricsAt 时保持基线）；done 条目时长固定；无 metricsAt 的 running 不显示时长。
  // formatSubagentSeconds 按秒取整，分钟进位为「3分05秒」。
  it('advances a running entrys duration from metricsAt and keeps a settled one fixed', () => {
    expect(subagentEntryDurationMs({ key: 'a', label: 'x', status: 'running', durationMs: 1_000, metricsAt: 10_000, colorIndex: 0 }, 12_500)).toBe(3_500)
    expect(subagentEntryDurationMs({ key: 'a', label: 'x', status: 'running', durationMs: 1_000, metricsAt: 10_000, colorIndex: 0 }, 9_000)).toBe(1_000)
    expect(subagentEntryDurationMs({ key: 'a', label: 'x', status: 'done', durationMs: 1_000, metricsAt: 10_000, colorIndex: 0 }, 99_000)).toBe(1_000)
    expect(subagentEntryDurationMs({ key: 'a', label: 'x', status: 'running', colorIndex: 0 }, 12_500)).toBeUndefined()
    expect(formatSubagentSeconds(42_500)).toBe('42秒')
    expect(formatSubagentSeconds(185_000)).toBe('3分05秒')
    expect(formatSubagentSeconds(0)).toBe('0秒')
  })

  // 配色契约：已匹配子会话按其在父列表中的位置取色（超出取色数回绕到 0）；
  // 未匹配 id 经确定性散列落入同样的六个槽位，同 id 每次同色。
  it('colors entries by their index in the parent list and hashes unmatched ones', () => {
    const summaries = [0, 1, 2, 3, 4, 5, 6].map(index => summary(`child-${index}`, `label-${index}`))
    expect(subagentColorIndex('child-3', summaries)).toBe(3)
    expect(subagentColorIndex('child-6', summaries)).toBe(0)
    expect(subagentColorIndex('child-0', summaries)).toBe(0)
    // 列表之外的 id 经确定性散列落入同样的六个槽位。
    const hashed = subagentColorIndex('unmatched-child')
    expect(hashed).toBe(subagentColorIndex('unmatched-child'))
    expect(hashed).toBeGreaterThanOrEqual(0)
    expect(hashed).toBeLessThan(6)
  })
})
