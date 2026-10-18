export const DEFAULT_SHORTCUTS = {
  newConversation: 'Alt+Mod+n', search: 'Mod+k', settings: 'Alt+Mod+,', toggleSidebar: 'Mod+b',
  send: 'Enter', newline: 'Shift+Enter', alternateSend: 'Mod+Enter',
} as const

export type ShortcutCommand = keyof typeof DEFAULT_SHORTCUTS
export type Shortcuts = Record<ShortcutCommand, string>

export function resolveShortcuts(overrides?: Partial<Shortcuts>): Shortcuts {
  const resolved: Shortcuts = { ...DEFAULT_SHORTCUTS }
  for (const name of Object.keys(DEFAULT_SHORTCUTS) as ShortcutCommand[]) {
    const value = overrides?.[name]
    if (value !== undefined) resolved[name] = value
  }
  return resolved
}

/** Resolves Mod to the platform's primary command modifier. */
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

export function shortcutFromEvent(event: KeyboardEvent): string | undefined {
  if (event.isComposing || ['Meta', 'Control', 'Alt', 'Shift', 'Dead', 'Process'].includes(event.key)) return undefined
  if (event.key !== 'Enter' && !event.metaKey && !event.ctrlKey && !event.altKey) return undefined
  const mac = /Mac|iPhone|iPad/.test(navigator.platform)
  const modifiers = [event.altKey && 'Alt', event.shiftKey && 'Shift', event.metaKey && (mac ? 'Mod' : 'Meta'), event.ctrlKey && (mac ? 'Ctrl' : 'Mod')].filter(Boolean)
  const key = event.code.startsWith('Key') ? event.code.slice(3).toLowerCase() : event.code === 'Comma' ? ',' : event.code === 'Period' ? '.' : event.key
  return [...modifiers, key.length === 1 ? key.toLowerCase() : key].join('+')
}

export function displayShortcut(chord: string): string {
  const mac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform)
  return chord.replaceAll('Mod', mac ? '⌘' : 'Ctrl').replaceAll('Alt', mac ? '⌥' : 'Alt').replaceAll('Shift', '⇧').replaceAll('+', ' ')
}
