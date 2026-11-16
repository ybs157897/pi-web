import { afterEach, describe, expect, it, vi } from 'vitest'
import { matchesShortcut, shortcutFromEvent } from '../src/web/keyboard.ts'

/**
 * 构造一个 KeyboardEvent 测试基底：Enter 键、非组合态、无修饰键。
 * @param overrides 需要覆盖的事件字段（metaKey/ctrlKey/altKey/shiftKey/isComposing/keyCode/key 等）
 * @returns 可直接传给快捷键函数的事件对象
 */
function key(overrides: Partial<KeyboardEvent> = {}): KeyboardEvent {
  return { key: 'Enter', code: 'Enter', isComposing: false, keyCode: 13, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...overrides } as KeyboardEvent
}
/** 每个用例后：恢复被 stub 的 navigator 全局对象。 */
afterEach(() => vi.unstubAllGlobals())

/**
 * 会话快捷键匹配测试。
 *
 * 关键契约：
 * - 主修饰键 Mod 按平台解析：macOS 为 Cmd(meta)、其他系统为 Ctrl，二者互不混淆；
 * - 输入法组合态（isComposing 或 keyCode=229）永不触发发送；Shift+Enter 与 Enter 保持区分（换行 vs 发送）；
 * - shortcutFromEvent 记录物理键位（code + Option 修饰产生的字符键），普通无修饰输入不产生快捷键。
 */
describe('conversation shortcuts', () => {
  // Mac 上 Mod+Enter 匹配 metaKey 不匹配 ctrlKey；Linux 上反之，平台间互不误认。
  it('resolves the primary modifier independently on macOS and other systems', () => {
    vi.stubGlobal('navigator', { platform: 'MacIntel' })
    expect(matchesShortcut(key({ metaKey: true }), 'Mod+Enter')).toBe(true)
    expect(matchesShortcut(key({ ctrlKey: true }), 'Mod+Enter')).toBe(false)
    vi.stubGlobal('navigator', { platform: 'Linux x86_64' })
    expect(matchesShortcut(key({ ctrlKey: true }), 'Mod+Enter')).toBe(true)
    expect(matchesShortcut(key({ metaKey: true }), 'Mod+Enter')).toBe(false)
  })
  // 输入法组合中（isComposing 或 keyCode 229）Enter 不触发发送；Shift+Enter 与纯 Enter 各自匹配自己的快捷键。
  it('never sends a composition confirmation and keeps newline distinct', () => {
    vi.stubGlobal('navigator', { platform: 'MacIntel' })
    expect(matchesShortcut(key({ isComposing: true }), 'Enter')).toBe(false)
    expect(matchesShortcut(key({ keyCode: 229 }), 'Enter')).toBe(false)
    expect(matchesShortcut(key({ shiftKey: true }), 'Enter')).toBe(false)
    expect(matchesShortcut(key({ shiftKey: true }), 'Shift+Enter')).toBe(true)
  })
  // Option 修饰的按键按物理键位（code=Comma → ','）记录为 Alt+Mod+,；无修饰的普通输入（key a）不产生快捷键。
  it('records physical option-modified keys without binding ordinary typing', () => {
    vi.stubGlobal('navigator', { platform: 'MacIntel' })
    const event = key({ key: '≤', code: 'Comma', altKey: true, metaKey: true })
    expect(shortcutFromEvent(event)).toBe('Alt+Mod+,')
    expect(matchesShortcut(event, 'Alt+Mod+,')).toBe(true)
    expect(shortcutFromEvent(key({ key: 'a', code: 'KeyA' }))).toBeUndefined()
  })
})
