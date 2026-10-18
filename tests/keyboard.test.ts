import { afterEach, describe, expect, it, vi } from 'vitest'
import { matchesShortcut, shortcutFromEvent } from '../src/web/keyboard.ts'

function key(overrides: Partial<KeyboardEvent> = {}): KeyboardEvent {
  return { key: 'Enter', code: 'Enter', isComposing: false, keyCode: 13, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...overrides } as KeyboardEvent
}
afterEach(() => vi.unstubAllGlobals())
describe('conversation shortcuts', () => {
  it('resolves the primary modifier independently on macOS and other systems', () => {
    vi.stubGlobal('navigator', { platform: 'MacIntel' })
    expect(matchesShortcut(key({ metaKey: true }), 'Mod+Enter')).toBe(true)
    expect(matchesShortcut(key({ ctrlKey: true }), 'Mod+Enter')).toBe(false)
    vi.stubGlobal('navigator', { platform: 'Linux x86_64' })
    expect(matchesShortcut(key({ ctrlKey: true }), 'Mod+Enter')).toBe(true)
    expect(matchesShortcut(key({ metaKey: true }), 'Mod+Enter')).toBe(false)
  })
  it('never sends a composition confirmation and keeps newline distinct', () => {
    vi.stubGlobal('navigator', { platform: 'MacIntel' })
    expect(matchesShortcut(key({ isComposing: true }), 'Enter')).toBe(false)
    expect(matchesShortcut(key({ keyCode: 229 }), 'Enter')).toBe(false)
    expect(matchesShortcut(key({ shiftKey: true }), 'Enter')).toBe(false)
    expect(matchesShortcut(key({ shiftKey: true }), 'Shift+Enter')).toBe(true)
  })
  it('records physical option-modified keys without binding ordinary typing', () => {
    vi.stubGlobal('navigator', { platform: 'MacIntel' })
    const event = key({ key: '≤', code: 'Comma', altKey: true, metaKey: true })
    expect(shortcutFromEvent(event)).toBe('Alt+Mod+,')
    expect(matchesShortcut(event, 'Alt+Mod+,')).toBe(true)
    expect(shortcutFromEvent(key({ key: 'a', code: 'KeyA' }))).toBeUndefined()
  })
})
