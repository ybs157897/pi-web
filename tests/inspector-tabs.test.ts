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

function tab(id: string, overrides: Partial<InspectorTab> = {}): InspectorTab {
  return { id, type: 'document', title: id, openedAt: 1000, ...overrides }
}

function stateOf(tabs: InspectorTab[], activeTabId: string | null = tabs[tabs.length - 1]?.id ?? null): PaneState {
  return { tabs, activeTabId }
}

describe('upsertTab', () => {
  it('appends a new tab at the end and activates it', () => {
    const input = stateOf([tab('doc:file:w:a.ts'), tab('git')], 'git')
    const next = upsertTab(input, tab('doc:plan', { title: '计划' }))
    expect(next.tabs.map(t => t.id)).toEqual(['doc:file:w:a.ts', 'git', 'doc:plan'])
    expect(next.activeTabId).toBe('doc:plan')
  })

  it('replaces an existing tab in place and keeps the original openedAt', () => {
    const input = stateOf([tab('doc:file:w:a.ts', { openedAt: 111 }), tab('doc:plan')], 'doc:file:w:a.ts')
    const next = upsertTab(input, tab('doc:file:w:a.ts', { title: 'a.ts (v2)', openedAt: 999 }))
    expect(next.tabs).toHaveLength(2)
    expect(next.tabs[0].id).toBe('doc:file:w:a.ts')
    expect(next.tabs[0].title).toBe('a.ts (v2)')
    expect(next.tabs[0].openedAt).toBe(111)
    expect(next.activeTabId).toBe('doc:file:w:a.ts')
  })

  it('does not mutate the input state', () => {
    const input = stateOf([tab('git')])
    upsertTab(input, tab('browse'))
    expect(input.tabs).toHaveLength(1)
    expect(input.activeTabId).toBe('git')
  })
})

describe('openFromLauncher', () => {
  const launcher = tab('new-tab', { type: 'new-tab', title: '新标签页' })

  it('replaces the launcher tab in place when opening fresh content', () => {
    const input = stateOf([tab('browse', { type: 'browse' }), launcher, tab('git', { type: 'git' })], 'new-tab')
    const next = openFromLauncher(input, tab('doc:file:w:a.ts'))
    expect(next.tabs.map(t => t.id)).toEqual(['browse', 'doc:file:w:a.ts', 'git'])
    expect(next.tabs[1].type).toBe('document')
    expect(next.activeTabId).toBe('doc:file:w:a.ts')
  })

  it('removes the launcher and focuses the already existing tab when its id exists', () => {
    const existing = tab('browse', { type: 'browse', title: '浏览' })
    const input = stateOf([existing, launcher, tab('git', { type: 'git' })], 'new-tab')
    const next = openFromLauncher(input, tab('browse', { type: 'browse' }))
    expect(next.tabs.map(t => t.id)).toEqual(['browse', 'git'])
    expect(next.tabs[0]).toBe(existing)
    expect(next.activeTabId).toBe('browse')
  })

  it('falls back to upsertTab when the active tab is not the launcher', () => {
    const input = stateOf([launcher, tab('git', { type: 'git' })], 'git')
    const next = openFromLauncher(input, tab('doc:plan', { title: '计划' }))
    expect(next.tabs.map(t => t.id)).toEqual(['new-tab', 'git', 'doc:plan'])
    expect(next.activeTabId).toBe('doc:plan')
  })

  it('falls back to upsertTab when the opened tab is itself a launcher', () => {
    const input = stateOf([tab('git', { type: 'git' }), launcher], 'new-tab')
    const next = openFromLauncher(input, tab('new-tab', { type: 'new-tab', title: '新标签页' }))
    expect(next.tabs).toHaveLength(2)
    expect(next.activeTabId).toBe('new-tab')
  })
})

describe('closeTabs', () => {
  it('falls back to the first survivor on the right of the closed region', () => {
    const input = stateOf([tab('a'), tab('b'), tab('c'), tab('d')], 'b')
    const { state: next, activeId } = closeTabs(input, ['b'])
    expect(next.tabs.map(t => t.id)).toEqual(['a', 'c', 'd'])
    expect(activeId).toBe('c')
    expect(next.activeTabId).toBe('c')
  })

  it('falls back to the left neighbor when nothing survives on the right', () => {
    const input = stateOf([tab('a'), tab('b'), tab('c')], 'c')
    const { activeId } = closeTabs(input, ['c'])
    expect(activeId).toBe('b')
  })

  it('handles batch closes spanning a region', () => {
    const input = stateOf([tab('a'), tab('b'), tab('c'), tab('d')], 'b')
    const { state: next, activeId } = closeTabs(input, ['b', 'c'])
    expect(next.tabs.map(t => t.id)).toEqual(['a', 'd'])
    expect(activeId).toBe('d')
  })

  it('falls back left when the closed region reaches the right edge', () => {
    const input = stateOf([tab('a'), tab('b'), tab('c'), tab('d')], 'd')
    const { activeId } = closeTabs(input, ['c', 'd'])
    expect(activeId).toBe('b')
  })

  it('returns null when no tab survives', () => {
    const input = stateOf([tab('a')])
    const { state: next, activeId } = closeTabs(input, ['a'])
    expect(next.tabs).toEqual([])
    expect(next.activeTabId).toBeNull()
    expect(activeId).toBeNull()
  })

  it('keeps activation when the active tab survives the close', () => {
    const input = stateOf([tab('a'), tab('b'), tab('c')], 'a')
    const { activeId } = closeTabs(input, ['c'])
    expect(activeId).toBe('a')
  })

  it('ignores unknown ids and leaves the state alone', () => {
    const input = stateOf([tab('a'), tab('b')], 'a')
    const { state: next, activeId } = closeTabs(input, ['ghost'])
    expect(next.tabs.map(t => t.id)).toEqual(['a', 'b'])
    expect(activeId).toBe('a')
  })

  it('does not mutate the input state', () => {
    const input = stateOf([tab('a'), tab('b')], 'a')
    closeTabs(input, ['a'])
    expect(input.tabs).toHaveLength(2)
    expect(input.activeTabId).toBe('a')
  })
})

describe('closeOtherTabs and closeAllTabs', () => {
  it('keeps only the given tab and activates it', () => {
    const next = closeOtherTabs(stateOf([tab('a'), tab('b'), tab('c')], 'a'), 'b')
    expect(next.tabs.map(t => t.id)).toEqual(['b'])
    expect(next.activeTabId).toBe('b')
  })

  it('empties the pane', () => {
    const next = closeAllTabs(stateOf([tab('a'), tab('b')]))
    expect(next).toEqual({ tabs: [], activeTabId: null })
  })
})

describe('activateTab', () => {
  it('only changes the active id', () => {
    const next = activateTab(stateOf([tab('a'), tab('b')], 'a'), 'b')
    expect(next.tabs.map(t => t.id)).toEqual(['a', 'b'])
    expect(next.activeTabId).toBe('b')
  })
})

describe('reorderTab', () => {
  it('moves a tab forward with splice semantics', () => {
    const next = reorderTab(stateOf([tab('a'), tab('b'), tab('c')]), 'a', 2)
    expect(next.tabs.map(t => t.id)).toEqual(['b', 'c', 'a'])
  })

  it('moves a tab backward', () => {
    const next = reorderTab(stateOf([tab('a'), tab('b'), tab('c')]), 'c', 0)
    expect(next.tabs.map(t => t.id)).toEqual(['c', 'a', 'b'])
  })

  it('keeps activation untouched', () => {
    const next = reorderTab(stateOf([tab('a'), tab('b'), tab('c')], 'a'), 'a', 1)
    expect(next.activeTabId).toBe('a')
  })

  it('returns the state unchanged when the id is unknown', () => {
    const input = stateOf([tab('a'), tab('b')])
    expect(reorderTab(input, 'ghost', 0)).toBe(input)
  })
})

describe('nextSelectionChatOrdinal', () => {
  it('starts at 1 when no selection chat tab exists', () => {
    expect(nextSelectionChatOrdinal(stateOf([tab('git', { type: 'git' })]))).toBe(1)
  })

  it('fills the smallest gap between used ordinals', () => {
    const input = stateOf([
      tab('selection-chat:c1', { type: 'selection-chat', conversationId: 'c1', ordinal: 1 }),
      tab('selection-chat:c3', { type: 'selection-chat', conversationId: 'c3', ordinal: 3 }),
    ])
    expect(nextSelectionChatOrdinal(input)).toBe(2)
  })

  it('starts at 1 when the only ordinal in use is higher', () => {
    const input = stateOf([tab('selection-chat:c2', { type: 'selection-chat', conversationId: 'c2', ordinal: 2 })])
    expect(nextSelectionChatOrdinal(input)).toBe(1)
  })

  it('ignores ordinals carried by non selection-chat tabs', () => {
    const input = stateOf([tab('browse', { type: 'browse', ordinal: 1 })])
    expect(nextSelectionChatOrdinal(input)).toBe(1)
  })
})

describe('normalizePaneState', () => {
  it('passes null through', () => {
    expect(normalizePaneState(null)).toBeNull()
  })

  it('drops duplicate ids keeping the first occurrence', () => {
    const next = normalizePaneState(stateOf([tab('dup', { title: 'first' }), tab('other'), tab('dup', { title: 'second' })]))
    expect(next?.tabs.map(t => t.title)).toEqual(['first', 'other'])
  })

  it('falls back to the last tab when activeTabId is missing', () => {
    const next = normalizePaneState(stateOf([tab('a'), tab('b')], 'ghost'))
    expect(next?.activeTabId).toBe('b')
  })

  it('falls back when activeTabId is null or empty', () => {
    expect(normalizePaneState({ tabs: [tab('a')], activeTabId: null })?.activeTabId).toBe('a')
    expect(normalizePaneState({ tabs: [tab('a')], activeTabId: '' })?.activeTabId).toBe('a')
  })

  it('clears activeTabId when tabs are empty', () => {
    expect(normalizePaneState({ tabs: [], activeTabId: 'x' })).toEqual({ tabs: [], activeTabId: null })
  })

  it('keeps a valid activeTabId', () => {
    const next = normalizePaneState(stateOf([tab('a'), tab('b')], 'a'))
    expect(next?.activeTabId).toBe('a')
  })
})

describe('stripConversationScoped', () => {
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

  it('clears the pane when only conversation scoped tabs existed', () => {
    const next = stripConversationScoped(stateOf([tab('p1', { type: 'plugin', pageId: 'p1' })]))
    expect(next).toEqual({ tabs: [], activeTabId: null })
  })

  it('lists exactly the four conversation scoped types', () => {
    expect([...CONVERSATION_SCOPED_TYPES]).toEqual(['plugin', 'subagent', 'trajectory', 'selection-chat'])
  })
})

describe('readPaneMemory and writePaneMemory', () => {
  it('reads back a normalized state per workspace', () => {
    writePaneMemory('ws-read', stateOf([tab('dup'), tab('dup', { title: 'x' }), tab('git', { type: 'git' })], 'ghost'))
    const read = readPaneMemory('ws-read')
    expect(read?.tabs.map(t => t.id)).toEqual(['dup', 'git'])
    expect(read?.activeTabId).toBe('git')
    expect(readPaneMemory('ws-unknown')).toBeNull()
  })

  it('evicts the least recently written workspace after 50 entries', () => {
    writePaneMemory('lru-0', stateOf([tab('a')]))
    for (let i = 1; i <= 50; i += 1) writePaneMemory(`lru-${i}`, stateOf([tab('a')]))
    expect(readPaneMemory('lru-0')).toBeNull()
    expect(readPaneMemory('lru-50')?.tabs[0].id).toBe('a')
  })

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
