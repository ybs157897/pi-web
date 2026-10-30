import { createContext, useContext, useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import type { AppSettings } from '../shared/types.ts'

export const DEFAULT_UI_SETTINGS: AppSettings = {
  theme: 'system', locale: 'zh', fontSize: 14, codeFontSize: 11, terminalFontSize: 13,
  transcriptView: 'detailed', collapseTiming: 'completion', performanceUsage: 'detailed', codingViews: true,
  busySendMode: 'followUp', defaultThinkingLevel: 'off', defaultAccessMode: 'fullAccess', modelAllowlist: [], codemodeMode: 'on', memoryEnabled: false,
}

interface UiPreferences {
  settings: AppSettings
  /** Resolved color scheme, so components outside the DSH tokens (antd) follow the theme. */
  dark: boolean
  t: (chinese: string, english: string) => string
}

const UiPreferencesContext = createContext<UiPreferences>({ settings: DEFAULT_UI_SETTINGS, dark: false, t: chinese => chinese })

/** Applies the DSH theme and typography axes once for the complete application. */
export function UiPreferencesProvider({ value, children }: { value: AppSettings; children: ReactNode }) {
  const [dark, setDark] = useState(() => value.theme === 'dark'
    || value.theme === 'system' && typeof window !== 'undefined' && window.matchMedia('(prefers-color-scheme: dark)').matches)
  const preferences = useMemo<UiPreferences>(
    () => ({ settings: value, dark, t: (zh, en) => value.locale === 'en' ? en : zh }),
    [value, dark],
  )
  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)')
    const apply = () => {
      const isDark = value.theme === 'dark' || value.theme === 'system' && media.matches
      setDark(isDark)
      document.body.toggleAttribute('data-ds-dark-theme', isDark)
      document.documentElement.style.colorScheme = isDark ? 'dark' : 'light'
      document.documentElement.lang = value.locale === 'en' ? 'en' : 'zh-CN'
      const secondary = value.fontSize - (value.fontSize <= 14 ? 1 : 2)
      const variables = {
        '--dsh-content-font-size': `${value.fontSize}px`,
        '--dsh-content-font-delta': `${value.fontSize - 14}px`,
        '--dsh-content-font-size-secondary': `${secondary}px`,
        '--dsh-content-font-delta-secondary': `${secondary - 13}px`,
        '--dsh-code-font-size': `${value.codeFontSize}px`,
        '--dsh-code-font-delta': `${value.codeFontSize - 11}px`,
        '--dsh-terminal-font-size': `${value.terminalFontSize}px`,
        '--dsh-terminal-font-delta': `${value.terminalFontSize - 13}px`,
      }
      for (const [name, setting] of Object.entries(variables)) document.body.style.setProperty(name, setting)
    }
    apply()
    if (value.theme === 'system') media.addEventListener('change', apply)
    return () => { media.removeEventListener('change', apply) }
  }, [value.theme, value.locale, value.fontSize, value.codeFontSize, value.terminalFontSize])
  return <UiPreferencesContext.Provider value={preferences}>{children}</UiPreferencesContext.Provider>
}

export function useUiPreferences(): UiPreferences { return useContext(UiPreferencesContext) }
