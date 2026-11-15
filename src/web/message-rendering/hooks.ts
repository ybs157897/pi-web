import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react'
import { useUiPreferences } from '../ui-preferences.tsx'

const subscribeSystemTheme = (notify: () => void) => {
  const media = window.matchMedia('(prefers-color-scheme: dark)')
  media.addEventListener('change', notify)
  return () => media.removeEventListener('change', notify)
}
const readSystemTheme = () => typeof window !== 'undefined' && window.matchMedia('(prefers-color-scheme: dark)').matches
/**
 * 功能：订阅系统深浅色偏好（prefers-color-scheme），结合用户设置算出消息区当前该用的主题。
 * @returns `{ dark, codeTheme, settings }`——dark 为最终深色判定（explicit 设置优先，system 跟随系统），
 *          codeTheme 是 Shiki 用的 'github-dark' / 'github-light'，settings 是 UI 偏好原值（含 codeFontSize）
 * 内部逻辑：useSyncExternalStore 订阅 matchMedia 变化，SSR/无 window 时 getServerSnapshot 固定 false。
 */
export function useMessageTheme() {
  const { settings } = useUiPreferences()
  const systemDark = useSyncExternalStore(subscribeSystemTheme, readSystemTheme, () => false)
  const dark = settings.theme === 'dark' || settings.theme === 'system' && systemDark
  return { dark, codeTheme: dark ? 'github-dark' as const : 'github-light' as const, settings }
}

/**
 * 功能：复制到剪贴板的三态反馈（idle → copied/error，1.6s 后自动回 idle）。
 * @returns `{ state, copy }`；copy(text) 返回是否成功
 * 内部逻辑：反馈与计时器都挂在调用它的控件本地；剪贴板 API 不可用或写入被拒时直接置 error，绝不显示成功；组件卸载清掉挂起定时器。
 */
export function useCopyFeedback() {
  const [state, setState] = useState<'idle' | 'copied' | 'error'>('idle')
  const timer = useRef<ReturnType<typeof setTimeout>>()
  useEffect(() => () => clearTimeout(timer.current), [])
  const copy = useCallback(async (text: string) => {
    clearTimeout(timer.current)
    try {
      if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable')
      await navigator.clipboard.writeText(text)
      setState('copied')
      timer.current = setTimeout(() => setState('idle'), 1600)
      return true
    } catch {
      setState('error')
      return false
    }
  }, [])
  return { state, copy }
}

/** 浏览器环境用 useLayoutEffect（DOM 测量前同步执行），SSR 环境降级为 useEffect 以免 React 告警。 */
export const useBrowserLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect
