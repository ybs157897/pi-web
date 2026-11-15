import { createContext, useContext, useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import type { AppSettings } from '../shared/types.ts'

/** UI 偏好的出厂默认值：跟随系统主题、中文、三档字号、详细档转录视图等。 */
export const DEFAULT_UI_SETTINGS: AppSettings = {
  theme: 'system', locale: 'zh', fontSize: 14, codeFontSize: 11, terminalFontSize: 13,
  textFontFamily: '', codeFontFamily: '', terminalFontFamily: '',
  transcriptView: 'detailed', collapseTiming: 'completion', performanceUsage: 'detailed', codingViews: true,
  busySendMode: 'followUp', defaultThinkingLevel: 'off', defaultAccessMode: 'fullAccess', modelAllowlist: [], codemodeMode: 'on', memoryEnabled: false,
  chineseReasoning: false,
  showAnalysisConversations: false,
}

/** 主题/语言 context 的值：当前设置、解析后的深浅色、双语标签函数 t。 */
interface UiPreferences {
  settings: AppSettings
  /** 解析后的配色方案（深色为 true），让 DSH token 覆盖之外的组件（antd）也跟随主题。 */
  dark: boolean
  t: (chinese: string, english: string) => string
}

/** context 兜底值：默认设置、浅色、t 只返回中文——provider 缺席时应用仍可渲染。 */
const UiPreferencesContext = createContext<UiPreferences>({ settings: DEFAULT_UI_SETTINGS, dark: false, t: chinese => chinese })

/**
 * 功能：应用级「主题/语言/字号」偏好 provider：一次性把 DSH 主题与排版轴应用到整棵文档树，
 * 并把 settings、dark、t 通过 context 下发。
 * @param value 服务端读出的当前设置
 * @param children 应用内容
 * 内部逻辑：dark = 显式主题或 system 跟随 prefers-color-scheme（监听 matchMedia 变化）；
 * 副作用把 body 的 data-ds-dark-theme、documentElement 的 colorScheme/lang 与
 * --dsh-* 字号/字体 CSS 变量同步到 DOM——字号变量挂在 body，字体列表挂在根节点
 * （空列表移除属性而不是在 fallback 栈里留悬空逗号）；卸载时移除监听。
 */
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
      // 字体列表放在文档根节点上，body 层的字体栈才能继承它们；空列表是
      // 移除属性，而不是在 fallback 栈里留一个悬空逗号。
      const families = {
        '--dsh-font-family-text': value.textFontFamily,
        '--dsh-font-family-code': value.codeFontFamily,
        '--dsh-font-family-terminal': value.terminalFontFamily,
      }
      for (const [name, family] of Object.entries(families)) {
        if (family === '') document.documentElement.style.removeProperty(name)
        else document.documentElement.style.setProperty(name, family)
      }
    }
    apply()
    if (value.theme === 'system') media.addEventListener('change', apply)
    return () => { media.removeEventListener('change', apply) }
  }, [value.theme, value.locale, value.fontSize, value.codeFontSize, value.terminalFontSize, value.textFontFamily, value.codeFontFamily, value.terminalFontFamily])
  return <UiPreferencesContext.Provider value={preferences}>{children}</UiPreferencesContext.Provider>
}

/**
 * 功能：读取主题/语言偏好 context。
 * @returns `{ settings, dark, t }`；provider 缺席时返回兜底值（默认设置 + 浅色 + 中文）
 */
export function useUiPreferences(): UiPreferences { return useContext(UiPreferencesContext) }
