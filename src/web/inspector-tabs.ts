// 右侧 Inspector 面板的 tab 纯模型：判重、关闭回退、launcher 原地替换与 workspace 级内存记忆。
// 语义对齐 ZCode side pane（useAppPanels / commitOpenedSidePaneState / closeSidePaneTab）。

export type InspectorTabType =
  | 'document' | 'browse' | 'git' | 'browser' | 'trajectory'
  | 'selection-chat' | 'plugin' | 'subagent' | 'subagents' | 'new-tab'

export interface TabFile {
  path: string
  content?: string
  mimeType?: string
  language?: string
  line?: number
  size?: number
  workspaceId?: string
  url?: string
}

export interface TabDiff {
  path: string
  oldText?: string | null
  newText?: string
  diff?: string
}

export type DocumentDoc =
  | { kind: 'file'; file: TabFile }
  | { kind: 'diff'; diff: TabDiff }
  | { kind: 'plan' }

export interface InspectorTab {
  id: string
  type: InspectorTabType
  title: string
  openedAt: number
  /** document */
  doc?: DocumentDoc
  /** browse */
  workspaceId?: string
  /** browse 当前目录（'' 为工作区根；随 tab 一起在 workspace 记忆桶里恢复） */
  path?: string
  /** plugin（引用 App 的 pluginPages 页 id） */
  pageId?: string
  /** subagent */
  childId?: string
  /** trajectory / selection-chat */
  conversationId?: string
  /** selection-chat */
  ordinal?: number
  /** browser */
  url?: string
  /** browser 当前输入框草稿（可选，切换 tab 不丢） */
  addressDraft?: string
}

export interface PaneState { tabs: InspectorTab[]; activeTabId: string | null }

const PANE_MEMORY_LIMIT = 50

// workspace 级内存记忆：Map 插入序即最近一次写入序（重写先 delete 再 set），LRU 按「写」驱动。
const paneMemory = new Map<string, PaneState>()

export function readPaneMemory(workspaceId: string): PaneState | null {
  return normalizePaneState(paneMemory.get(workspaceId) ?? null)
}

export function writePaneMemory(workspaceId: string, state: PaneState): void {
  const next = normalizePaneState(state)
  paneMemory.delete(workspaceId)
  if (next) paneMemory.set(workspaceId, next)
  while (paneMemory.size > PANE_MEMORY_LIMIT) {
    const oldest = paneMemory.keys().next().value
    if (oldest === undefined) break
    paneMemory.delete(oldest)
  }
}

export function activateTab(state: PaneState, id: string): PaneState {
  return { tabs: [...state.tabs], activeTabId: id }
}

/** 批量关闭；返回回退激活 id（关闭区间右侧第一个幸存者，否则左侧；null=无 tab）。激活 tab 幸存时保持不变。 */
export function closeTabs(state: PaneState, ids: readonly string[]): { state: PaneState; activeId: string | null } {
  const closed = new Set(ids)
  const tabs = state.tabs.filter(tab => !closed.has(tab.id))
  if (tabs.length === state.tabs.length) {
    return { state: { tabs, activeTabId: state.activeTabId }, activeId: state.activeTabId }
  }
  const active = state.activeTabId
  if (active !== null && !closed.has(active) && tabs.some(tab => tab.id === active)) {
    return { state: { tabs, activeTabId: active }, activeId: active }
  }
  // 关闭区间 = 被移除 tab 占据的原数组位置并集；回退从区间右缘向右、再从左缘向左找第一个幸存者。
  let minClosed = state.tabs.length
  let maxClosed = -1
  state.tabs.forEach((tab, index) => {
    if (!closed.has(tab.id)) return
    minClosed = Math.min(minClosed, index)
    maxClosed = Math.max(maxClosed, index)
  })
  const survivor = (start: number, step: 1 | -1): string | null => {
    for (let i = start; i >= 0 && i < state.tabs.length; i += step) {
      if (!closed.has(state.tabs[i].id)) return state.tabs[i].id
    }
    return null
  }
  const activeId = survivor(maxClosed + 1, 1) ?? survivor(minClosed - 1, -1)
  return { state: { tabs, activeTabId: activeId }, activeId }
}

export function closeOtherTabs(state: PaneState, id: string): PaneState {
  return normalizePaneState({ tabs: state.tabs.filter(tab => tab.id === id), activeTabId: id })
    ?? { tabs: [], activeTabId: null }
}

export function closeAllTabs(state: PaneState): PaneState {
  return { tabs: [], activeTabId: null }
}

/** 按 id 幂等打开：存在则替换 payload 并激活（保持位置），不存在则 append 并激活 */
export function upsertTab(state: PaneState, tab: InspectorTab): PaneState {
  const existing = state.tabs.find(candidate => candidate.id === tab.id)
  if (!existing) return { tabs: [...state.tabs, tab], activeTabId: tab.id }
  // 重复打开同一来源 = 聚焦 + 更新 payload；openedAt 保留首次打开时间。
  const tabs = state.tabs.map(candidate =>
    candidate.id === tab.id ? { ...tab, openedAt: existing.openedAt } : candidate)
  return { tabs, activeTabId: tab.id }
}

/** launcher 原地替换语义：若激活 tab 是 new-tab 且新 tab 非 new-tab，则新 tab 替换其位置；否则 upsertTab */
export function openFromLauncher(state: PaneState, tab: InspectorTab): PaneState {
  const active = state.tabs.find(candidate => candidate.id === state.activeTabId)
  if (!active || active.type !== 'new-tab' || tab.type === 'new-tab') return upsertTab(state, tab)
  if (state.tabs.some(candidate => candidate.id === tab.id)) {
    // 目标已存在：移除 launcher 占位 tab，已有 tab 留在原位并聚焦。
    const tabs = state.tabs.filter(candidate => candidate.id !== active.id)
    return { tabs, activeTabId: tab.id }
  }
  // launcher tab 在原位置被新 tab 替换（flatMap 保位）。
  const tabs = state.tabs.flatMap(candidate => candidate.id === active.id ? [tab] : [candidate])
  return { tabs, activeTabId: tab.id }
}

export function reorderTab(state: PaneState, fromId: string, toIndex: number): PaneState {
  const from = state.tabs.findIndex(tab => tab.id === fromId)
  if (from === -1) return state
  const tabs = [...state.tabs]
  const [moved] = tabs.splice(from, 1)
  tabs.splice(toIndex, 0, moved)
  return { tabs, activeTabId: state.activeTabId }
}

/** 同会话 selection-chat 的最小未用正整数 ordinal */
export function nextSelectionChatOrdinal(state: PaneState): number {
  const used = new Set(
    state.tabs
      .filter(tab => tab.type === 'selection-chat')
      .map(tab => tab.ordinal)
      .filter((ordinal): ordinal is number => typeof ordinal === 'number'),
  )
  let ordinal = 1
  while (used.has(ordinal)) ordinal += 1
  return ordinal
}

/** 归一：去重 id、activeTabId 失效时回退最后一个 tab、空则 null */
export function normalizePaneState(state: PaneState | null): PaneState | null {
  if (!state) return null
  const seen = new Set<string>()
  const tabs: InspectorTab[] = []
  for (const tab of state.tabs ?? []) {
    if (seen.has(tab.id)) continue
    seen.add(tab.id)
    tabs.push(tab)
  }
  if (tabs.length === 0) return { tabs, activeTabId: null }
  const active = state.activeTabId
  const activeTabId = active !== null && active !== '' && seen.has(active) ? active : tabs[tabs.length - 1].id
  return { tabs, activeTabId }
}

/** 会话作用域类型集合（切换会话时移除） */
export const CONVERSATION_SCOPED_TYPES: readonly InspectorTabType[] =
  ['plugin', 'subagent', 'trajectory', 'selection-chat']

export function stripConversationScoped(state: PaneState): PaneState {
  const scoped = new Set<string>(CONVERSATION_SCOPED_TYPES)
  const tabs = state.tabs.filter(tab => !scoped.has(tab.type))
  return normalizePaneState({ tabs, activeTabId: state.activeTabId }) ?? { tabs: [], activeTabId: null }
}
