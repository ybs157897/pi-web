import { describe, expect, it } from 'vitest'

import type { InspectorTab, PaneState } from '../src/web/inspector-tabs.ts'
import {
  activateTab,
  closeAllTabs,
  closeOtherTabs,
  closeTabs,
  CONVERSATION_SCOPED_TYPES,
  nextSelectionChatOrdinal,
  normalizePaneState,
  openFromLauncher,
  readPaneMemory,
  reorderTab,
  stripConversationScoped,
  upsertTab,
  writePaneMemory,
} from '../src/web/inspector-tabs.ts'

/**
 * 构造一个标签：默认 type=document、title=id、openedAt=1000。
 * @param id 标签 id
 * @param overrides 需要覆盖的字段（type/title/ordinal 等）
 * @returns 完整的 InspectorTab
 */
function tab(id: string, overrides: Partial<InspectorTab> = {}): InspectorTab {
  return { id, type: 'document', title: id, openedAt: 1000, ...overrides }
}

/**
 * 用标签数组构造面板状态，激活标签默认为最后一个。
 * @param tabs 标签列表
 * @param activeTabId 激活标签 id，默认取最后一个标签
 * @returns PaneState
 */
function stateOf(tabs: InspectorTab[], activeTabId: string | null = tabs[tabs.length - 1]?.id ?? null): PaneState {
  return { tabs, activeTabId }
}

/**
 * upsertTab 契约：新标签追加到末尾并激活；已存在标签原地更新（保留原 openedAt）；不修改输入状态。
 */
describe('upsertTab', () => {
  // 新标签追加在末尾并成为激活标签。
  it('appends a new tab at the end and activates it', () => {
    const input = stateOf([tab('doc:file:w:a.ts'), tab('git')], 'git')
    const next = upsertTab(input, tab('doc:plan', { title: '计划' }))
    expect(next.tabs.map(t => t.id)).toEqual(['doc:file:w:a.ts', 'git', 'doc:plan'])
    expect(next.activeTabId).toBe('doc:plan')
  })

  // 同 id 标签原地替换（位置与 openedAt 都保留原值，只有新字段生效），激活状态指向它。
  it('replaces an existing tab in place and keeps the original openedAt', () => {
    const input = stateOf([tab('doc:file:w:a.ts', { openedAt: 111 }), tab('doc:plan')], 'doc:file:w:a.ts')
    const next = upsertTab(input, tab('doc:file:w:a.ts', { title: 'a.ts (v2)', openedAt: 999 }))
    expect(next.tabs).toHaveLength(2)
    expect(next.tabs[0].id).toBe('doc:file:w:a.ts')
    expect(next.tabs[0].title).toBe('a.ts (v2)')
    expect(next.tabs[0].openedAt).toBe(111)
    expect(next.activeTabId).toBe('doc:file:w:a.ts')
  })

  // 纯函数保证：upsert 后原输入状态保持不变（不原地修改）。
  it('does not mutate the input state', () => {
    const input = stateOf([tab('git')])
    upsertTab(input, tab('browse'))
    expect(input.tabs).toHaveLength(1)
    expect(input.activeTabId).toBe('git')
  })
})

/**
 * openFromLauncher 契约：从「新标签页」打开内容时，若激活的是启动页则原地替换它；
 * 目标 id 已存在时移除启动页并聚焦已有标签；激活页不是启动页、或打开的本身就是启动页时回退 upsertTab。
 */
describe('openFromLauncher', () => {
  /** 启动页标签夹具。 */
  const launcher = tab('new-tab', { type: 'new-tab', title: '新标签页' })

  // 激活的是启动页：新内容原地替换启动页的位置（browse、新标签、git），新标签激活。
  it('replaces the launcher tab in place when opening fresh content', () => {
    const input = stateOf([tab('browse', { type: 'browse' }), launcher, tab('git', { type: 'git' })], 'new-tab')
    const next = openFromLauncher(input, tab('doc:file:w:a.ts'))
    expect(next.tabs.map(t => t.id)).toEqual(['browse', 'doc:file:w:a.ts', 'git'])
    expect(next.tabs[1].type).toBe('document')
    expect(next.activeTabId).toBe('doc:file:w:a.ts')
  })

  // 打开的目标 id 已存在：移除启动页、聚焦已有标签（复用同一标签对象），不产生重复标签。
  it('removes the launcher and focuses the already existing tab when its id exists', () => {
    const existing = tab('browse', { type: 'browse', title: '浏览' })
    const input = stateOf([existing, launcher, tab('git', { type: 'git' })], 'new-tab')
    const next = openFromLauncher(input, tab('browse', { type: 'browse' }))
    expect(next.tabs.map(t => t.id)).toEqual(['browse', 'git'])
    expect(next.tabs[0]).toBe(existing)
    expect(next.activeTabId).toBe('browse')
  })

  it('updates an already open document with the requested line and content from the launcher', () => {
    const id = 'doc:file:ws:docs/readme.md'
    const existing = tab(id, { doc: { kind: 'file', file: { path: 'docs/readme.md', content: 'old' } } })
    const file = { path: 'docs/readme.md', content: '# New\nTarget', line: 2, lineRequestId: 3 }
    const next = openFromLauncher(stateOf([existing, launcher]), tab(id, { openedAt: 999, doc: { kind: 'file', file } }))
    expect(next.tabs).toEqual([{ ...existing, doc: { kind: 'file', file } }])
    expect(next.activeTabId).toBe(id)
  })

  // 激活页不是启动页时回退 upsertTab 语义：启动页保留，新标签追加末尾并激活。
  it('falls back to upsertTab when the active tab is not the launcher', () => {
    const input = stateOf([launcher, tab('git', { type: 'git' })], 'git')
    const next = openFromLauncher(input, tab('doc:plan', { title: '计划' }))
    expect(next.tabs.map(t => t.id)).toEqual(['new-tab', 'git', 'doc:plan'])
    expect(next.activeTabId).toBe('doc:plan')
  })

  // 打开的本身就是启动页时不做替换处理，状态保持原样（2 个标签、启动页仍激活）。
  it('falls back to upsertTab when the opened tab is itself a launcher', () => {
    const input = stateOf([tab('git', { type: 'git' }), launcher], 'new-tab')
    const next = openFromLauncher(input, tab('new-tab', { type: 'new-tab', title: '新标签页' }))
    expect(next.tabs).toHaveLength(2)
    expect(next.activeTabId).toBe('new-tab')
  })
})

/**
 * closeTabs 契约：关闭后焦点回退到关闭区右侧第一个幸存标签，右侧没有则回退左侧邻居；
 * 关闭区到右缘时向左回退；全部关闭时状态清空；激活标签幸存则保持激活；未知 id 与输入状态不受影响。
 */
describe('closeTabs', () => {
  // 关闭 b：焦点回退到右侧第一个幸存者 c（状态与返回的 activeId 一致）。
  it('falls back to the first survivor on the right of the closed region', () => {
    const input = stateOf([tab('a'), tab('b'), tab('c'), tab('d')], 'b')
    const { state: next, activeId } = closeTabs(input, ['b'])
    expect(next.tabs.map(t => t.id)).toEqual(['a', 'c', 'd'])
    expect(activeId).toBe('c')
    expect(next.activeTabId).toBe('c')
  })

  // 右侧没有幸存者时焦点回退到左侧邻居。
  it('falls back to the left neighbor when nothing survives on the right', () => {
    const input = stateOf([tab('a'), tab('b'), tab('c')], 'c')
    const { activeId } = closeTabs(input, ['c'])
    expect(activeId).toBe('b')
  })

  // 批量关闭连续区间（b、c）：焦点回退到区间右侧第一个幸存者 d。
  it('handles batch closes spanning a region', () => {
    const input = stateOf([tab('a'), tab('b'), tab('c'), tab('d')], 'b')
    const { state: next, activeId } = closeTabs(input, ['b', 'c'])
    expect(next.tabs.map(t => t.id)).toEqual(['a', 'd'])
    expect(activeId).toBe('d')
  })

  // 关闭区到达右缘（c、d）：焦点向左回退到 b。
  it('falls back left when the closed region reaches the right edge', () => {
    const input = stateOf([tab('a'), tab('b'), tab('c'), tab('d')], 'd')
    const { activeId } = closeTabs(input, ['c', 'd'])
    expect(activeId).toBe('b')
  })

  // 所有标签都被关闭：状态清空（tabs=[]、activeTabId=null）、activeId=null。
  it('returns null when no tab survives', () => {
    const input = stateOf([tab('a')])
    const { state: next, activeId } = closeTabs(input, ['a'])
    expect(next.tabs).toEqual([])
    expect(next.activeTabId).toBeNull()
    expect(activeId).toBeNull()
  })

  // 被关的不是激活标签时激活状态保持不变。
  it('keeps activation when the active tab survives the close', () => {
    const input = stateOf([tab('a'), tab('b'), tab('c')], 'a')
    const { activeId } = closeTabs(input, ['c'])
    expect(activeId).toBe('a')
  })

  // 关闭不存在的 id：状态原样返回，不影响任何标签。
  it('ignores unknown ids and leaves the state alone', () => {
    const input = stateOf([tab('a'), tab('b')], 'a')
    const { state: next, activeId } = closeTabs(input, ['ghost'])
    expect(next.tabs.map(t => t.id)).toEqual(['a', 'b'])
    expect(activeId).toBe('a')
  })

  // 纯函数保证：关闭操作不修改输入状态。
  it('does not mutate the input state', () => {
    const input = stateOf([tab('a'), tab('b')], 'a')
    closeTabs(input, ['a'])
    expect(input.tabs).toHaveLength(2)
    expect(input.activeTabId).toBe('a')
  })
})

/**
 * 批量关闭契约：closeOtherTabs 只保留指定标签并激活；closeAllTabs 清空整个面板。
 */
describe('closeOtherTabs and closeAllTabs', () => {
  // 关闭其他标签：只剩 b 且 b 被激活。
  it('keeps only the given tab and activates it', () => {
    const next = closeOtherTabs(stateOf([tab('a'), tab('b'), tab('c')], 'a'), 'b')
    expect(next.tabs.map(t => t.id)).toEqual(['b'])
    expect(next.activeTabId).toBe('b')
  })

  // 全部关闭后面板为空状态。
  it('empties the pane', () => {
    const next = closeAllTabs(stateOf([tab('a'), tab('b')]))
    expect(next).toEqual({ tabs: [], activeTabId: null })
  })
})

/** activateTab 契约：只改激活 id，标签列表与顺序不动。 */
describe('activateTab', () => {
  // 激活 b 只改 activeTabId，标签顺序保持原样。
  it('only changes the active id', () => {
    const next = activateTab(stateOf([tab('a'), tab('b')], 'a'), 'b')
    expect(next.tabs.map(t => t.id)).toEqual(['a', 'b'])
    expect(next.activeTabId).toBe('b')
  })
})

/**
 * reorderTab 契约：splice 语义移动标签位置；激活状态不随移动改变；未知 id 原样返回同一状态引用。
 */
describe('reorderTab', () => {
  // 向前移动：a 移到下标 2，等价 splice。
  it('moves a tab forward with splice semantics', () => {
    const next = reorderTab(stateOf([tab('a'), tab('b'), tab('c')]), 'a', 2)
    expect(next.tabs.map(t => t.id)).toEqual(['b', 'c', 'a'])
  })

  // 向后移动：c 移到下标 0。
  it('moves a tab backward', () => {
    const next = reorderTab(stateOf([tab('a'), tab('b'), tab('c')]), 'c', 0)
    expect(next.tabs.map(t => t.id)).toEqual(['c', 'a', 'b'])
  })

  // 移动标签不改变激活状态（移动的是激活标签本身也保持激活）。
  it('keeps activation untouched', () => {
    const next = reorderTab(stateOf([tab('a'), tab('b'), tab('c')], 'a'), 'a', 1)
    expect(next.activeTabId).toBe('a')
  })

  // id 不存在时返回原输入引用，状态完全不变。
  it('returns the state unchanged when the id is unknown', () => {
    const input = stateOf([tab('a'), tab('b')])
    expect(reorderTab(input, 'ghost', 0)).toBe(input)
  })
})

/**
 * nextSelectionChatOrdinal 契约：为新的划词会话标签分配最小可用 ordinal。
 */
describe('nextSelectionChatOrdinal', () => {
  // 没有任何 selection-chat 标签时从 1 开始。
  it('starts at 1 when no selection chat tab exists', () => {
    expect(nextSelectionChatOrdinal(stateOf([tab('git', { type: 'git' })]))).toBe(1)
  })

  // 已用 1 和 3 时补最小空隙 2。
  it('fills the smallest gap between used ordinals', () => {
    const input = stateOf([
      tab('selection-chat:c1', { type: 'selection-chat', conversationId: 'c1', ordinal: 1 }),
      tab('selection-chat:c3', { type: 'selection-chat', conversationId: 'c3', ordinal: 3 }),
    ])
    expect(nextSelectionChatOrdinal(input)).toBe(2)
  })

  // 只占用高位 ordinal（2）时仍从 1 开始，保持编号紧凑。
  it('starts at 1 when the only ordinal in use is higher', () => {
    const input = stateOf([tab('selection-chat:c2', { type: 'selection-chat', conversationId: 'c2', ordinal: 2 })])
    expect(nextSelectionChatOrdinal(input)).toBe(1)
  })

  // 非 selection-chat 标签携带的 ordinal 不参与计算。
  it('ignores ordinals carried by non selection-chat tabs', () => {
    const input = stateOf([tab('browse', { type: 'browse', ordinal: 1 })])
    expect(nextSelectionChatOrdinal(input)).toBe(1)
  })
})

/**
 * normalizePaneState 契约：持久化状态恢复时的防御性归一化。
 * null 透传；去重保留首个；activeTabId 缺失/空时回退最后一个标签；无标签时清空激活；合法值原样保留。
 */
describe('normalizePaneState', () => {
  // null 输入直接返回 null。
  it('passes null through', () => {
    expect(normalizePaneState(null)).toBeNull()
  })

  // 重复 id 只保留第一个出现（title=first 的那个）。
  it('drops duplicate ids keeping the first occurrence', () => {
    const next = normalizePaneState(stateOf([tab('dup', { title: 'first' }), tab('other'), tab('dup', { title: 'second' })]))
    expect(next?.tabs.map(t => t.title)).toEqual(['first', 'other'])
  })

  // activeTabId 指向不存在的标签（ghost）时回退到最后一个标签 b。
  it('falls back to the last tab when activeTabId is missing', () => {
    const next = normalizePaneState(stateOf([tab('a'), tab('b')], 'ghost'))
    expect(next?.activeTabId).toBe('b')
  })

  // activeTabId 为 null 或空串时同样回退到最后一个标签。
  it('falls back when activeTabId is null or empty', () => {
    expect(normalizePaneState({ tabs: [tab('a')], activeTabId: null })?.activeTabId).toBe('a')
    expect(normalizePaneState({ tabs: [tab('a')], activeTabId: '' })?.activeTabId).toBe('a')
  })

  // 标签列表为空时 activeTabId 必须清成 null。
  it('clears activeTabId when tabs are empty', () => {
    expect(normalizePaneState({ tabs: [], activeTabId: 'x' })).toEqual({ tabs: [], activeTabId: null })
  })

  // 合法的激活 id 原样保留。
  it('keeps a valid activeTabId', () => {
    const next = normalizePaneState(stateOf([tab('a'), tab('b')], 'a'))
    expect(next?.activeTabId).toBe('a')
  })
})

/**
 * stripConversationScoped 契约：切换会话时移除会话级标签（plugin/subagent/trajectory/selection-chat），保留工作区级标签。
 */
describe('stripConversationScoped', () => {
  // 会话级标签（trajectory、plugin 页）被移除，工作区级（document、git）保留；激活回退到幸存标签 git。
  it('removes conversation scoped tabs and keeps workspace scoped ones', () => {
    const input = stateOf([
      tab('doc:plan'),
      tab('p1', { type: 'plugin', pageId: 'p1' }),
      tab('trajectory:c1', { type: 'trajectory', conversationId: 'c1' }),
      tab('git', { type: 'git' }),
    ], 'trajectory:c1')
    const next = stripConversationScoped(input)
    expect(next.tabs.map(t => t.id)).toEqual(['doc:plan', 'git'])
    expect(next.activeTabId).toBe('git')
  })

  // 全部是会话级标签时面板清空。
  it('clears the pane when only conversation scoped tabs existed', () => {
    const next = stripConversationScoped(stateOf([tab('p1', { type: 'plugin', pageId: 'p1' })]))
    expect(next).toEqual({ tabs: [], activeTabId: null })
  })

  // 会话级类型集合恰好是这四种（新增类型必须显式加入或确认豁免）。
  it('lists exactly the four conversation scoped types', () => {
    expect([...CONVERSATION_SCOPED_TYPES]).toEqual(['plugin', 'subagent', 'trajectory', 'selection-chat'])
  })
})

/**
 * 面板记忆（readPaneMemory / writePaneMemory）契约：按 workspace 读写归一化后的面板状态，容量 50 条 LRU 淘汰。
 */
describe('readPaneMemory and writePaneMemory', () => {
  // 写入的状态读取时已归一化（重复 id 去除、激活 id 回退）；未写入过的 workspace 读到 null。
  it('reads back a normalized state per workspace', () => {
    writePaneMemory('ws-read', stateOf([tab('dup'), tab('dup', { title: 'x' }), tab('git', { type: 'git' })], 'ghost'))
    const read = readPaneMemory('ws-read')
    expect(read?.tabs.map(t => t.id)).toEqual(['dup', 'git'])
    expect(read?.activeTabId).toBe('git')
    expect(readPaneMemory('ws-unknown')).toBeNull()
  })

  // 超过 50 条时淘汰最早写入的 workspace（lru-0），最新写入的（lru-50）保留。
  it('evicts the least recently written workspace after 50 entries', () => {
    writePaneMemory('lru-0', stateOf([tab('a')]))
    for (let i = 1; i <= 50; i += 1) writePaneMemory(`lru-${i}`, stateOf([tab('a')]))
    expect(readPaneMemory('lru-0')).toBeNull()
    expect(readPaneMemory('lru-50')?.tabs[0].id).toBe('a')
  })

  // 重写同一 workspace 会刷新其最近使用时间：lru-r0 重写后存活，而未被重写的 lru-r1 被淘汰、lru-r2 保留。
  it('refreshes write recency when a workspace is rewritten', () => {
    writePaneMemory('lru-r0', stateOf([tab('a')]))
    for (let i = 1; i <= 49; i += 1) writePaneMemory(`lru-r${i}`, stateOf([tab('a')]))
    writePaneMemory('lru-r0', stateOf([tab('c')]))
    writePaneMemory('lru-r50', stateOf([tab('a')]))
    expect(readPaneMemory('lru-r0')?.tabs[0].id).toBe('c')
    expect(readPaneMemory('lru-r1')).toBeNull()
    expect(readPaneMemory('lru-r2')?.tabs[0].id).toBe('a')
  })
})
