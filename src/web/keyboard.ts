import { SHORTCUT_COMMANDS } from '../shared/types.ts'
import type { ShortcutCommand } from '../shared/types.ts'
export type { ShortcutCommand } from '../shared/types.ts'

/** 全部命令的默认快捷键（chord 字符串，Mod 在 mac 上指 ⌘、其他平台指 Ctrl）。 */
export const DEFAULT_SHORTCUTS = {
  newConversation: 'Alt+Mod+n', search: 'Mod+k', settings: 'Alt+Mod+,', toggleSidebar: 'Mod+b',
  rename: 'Alt+Mod+g', fork: 'Shift+Mod+f', archive: 'Alt+Mod+a',
  send: 'Enter', newline: 'Shift+Enter', alternateSend: 'Mod+Enter',
  // ZCode's side pane chords; the full-view F chord avoids pi-web's fork (Shift+Mod+f).
  toggleInspector: 'Alt+Mod+b', toggleInspectorFullView: 'Alt+Mod+f',
} satisfies Record<ShortcutCommand, string>

/** 命令名 → chord 字符串的完整映射（覆盖所有 ShortcutCommand，无缺省）。 */
export type Shortcuts = Record<ShortcutCommand, string>


/**
 * 功能：合并用户覆盖项得到生效快捷键表。
 * @param overrides 用户设置里按命令名覆盖的部分
 * @returns 完整映射：默认值打底，覆盖项逐个替换；未提供覆盖或覆盖为 undefined 的命令保留默认
 * 冲突处理：本模块只做映射不检测冲突，冲突规避靠默认值设计（如 full-view 用 Alt+Mod+f 避开 fork 的 Shift+Mod+f）。
 */
export function resolveShortcuts(overrides?: Partial<Shortcuts>): Shortcuts {
  const resolved: Shortcuts = { ...DEFAULT_SHORTCUTS }
  for (const name of SHORTCUT_COMMANDS) {
    const value = overrides?.[name]
    if (value !== undefined) resolved[name] = value
  }
  return resolved
}

/**
 * 功能：把一个 chord 解析为逐个按键帽的标签序列（按当前平台解析 Mod）。
 * @param chord 如 `Alt+Mod+n` / `Shift+Enter`
 * @returns 按修饰键在前、主键在后的顺序排列的标签数组，如 `['⌥','⌘','N']` / `['Ctrl','⌘','K']`（Win 平台）
 */
export function shortcutKeyLabels(chord: string): string[] {
  const mac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform)
  const keys: string[] = []
  for (const part of chord.split('+')) {
    const name = part.toLowerCase()
    if (name === 'mod') keys.push(mac ? '⌘' : 'Ctrl')
    else if (name === 'alt' || name === 'option') keys.push(mac ? '⌥' : 'Alt')
    else if (name === 'meta' || name === 'cmd' || name === 'command') keys.push(mac ? '⌘' : 'Win')
    else if (name === 'ctrl' || name === 'control') keys.push(mac ? '⌃' : 'Ctrl')
    else if (name === 'shift') keys.push('⇧')
    else if (name.length === 1) keys.push(name.toUpperCase())
    else keys.push(part)
  }
  return keys
}

/**
 * 功能：判断一次键盘事件是否命中某个 chord。
 * @param event 原生键盘事件
 * @param chord 快捷键描述串
 * @returns 命中返回 true
 * 内部逻辑：Mod 按平台解析为 mac 的 Meta / 其他平台的 Ctrl；主键同时比对 event.key 与 event.code（KeyX、逗号/句号等物理键），保证中文输入法下物理键也能命中；输入法合成中（isComposing 或 keyCode 229）一律不命中；修饰键四项（meta/ctrl/alt/shift）逐一严格相等。
 */
export function matchesShortcut(event: KeyboardEvent, chord: string): boolean {
  if (!chord || event.isComposing || event.keyCode === 229) return false
  const parts = chord.toLowerCase().split('+')
  const key = parts.pop()
  const mac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform)
  const meta = parts.includes('meta') || parts.includes('cmd') || parts.includes('mod') && mac
  const ctrl = parts.includes('ctrl') || parts.includes('control') || parts.includes('mod') && !mac
  const physicalKey = event.code.startsWith('Key') ? event.code.slice(3).toLowerCase() : event.code === 'Comma' ? ',' : event.code === 'Period' ? '.' : event.key.toLowerCase()
  return (event.key.toLowerCase() === key || physicalKey === key) && event.metaKey === meta && event.ctrlKey === ctrl
    && event.altKey === parts.includes('alt') && event.shiftKey === parts.includes('shift')
}

/**
 * 功能：把一次键盘事件反序列化成 chord 字符串，供设置页录制自定义快捷键。
 * @param event 原生键盘事件
 * @returns 归一化 chord（如 `Alt+Shift+Mod+f`）；纯修饰键、输入法合成中、无修饰的普通字符键返回 undefined（避免抢占打字）
 * 内部逻辑：修饰键顺序固定为 Alt → Shift → Mod；mac 上 Ctrl 与 Meta 分别写作 Ctrl/Mod，其他平台 Meta 写作 Mod；主键优先取 event.code 的物理键字母。
 */
export function shortcutFromEvent(event: KeyboardEvent): string | undefined {
  if (event.isComposing || ['Meta', 'Control', 'Alt', 'Shift', 'Dead', 'Process'].includes(event.key)) return undefined
  if (event.key !== 'Enter' && !event.metaKey && !event.ctrlKey && !event.altKey) return undefined
  const mac = /Mac|iPhone|iPad/.test(navigator.platform)
  const modifiers = [event.altKey && 'Alt', event.shiftKey && 'Shift', event.metaKey && (mac ? 'Mod' : 'Meta'), event.ctrlKey && (mac ? 'Ctrl' : 'Mod')].filter(Boolean)
  const key = event.code.startsWith('Key') ? event.code.slice(3).toLowerCase() : event.code === 'Comma' ? ',' : event.code === 'Period' ? '.' : event.key
  return [...modifiers, key.length === 1 ? key.toLowerCase() : key].join('+')
}

/**
 * 功能：把 chord 渲染成一行可读文本（`Alt+Mod+n` → mac `⌥⌘ n` / Win `Alt Ctrl n`）。
 * @param chord 快捷键描述串
 * @returns 替换 Mod/Alt/Shift 为符号、`+` 换成空格后的展示串
 */
export function displayShortcut(chord: string): string {
  const mac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform)
  return chord.replaceAll('Mod', mac ? '⌘' : 'Ctrl').replaceAll('Alt', mac ? '⌥' : 'Alt').replaceAll('Shift', '⇧').replaceAll('+', ' ')
}
