import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react'
import { useUiPreferences } from '../ui-preferences.tsx'

const subscribeSystemTheme = (notify: () => void) => {
  const media = window.matchMedia('(prefers-color-scheme: dark)')
  media.addEventListener('change', notify)
  return () => media.removeEventListener('change', notify)
}
const readSystemTheme = () => typeof window !== 'undefined' && window.matchMedia('(prefers-color-scheme: dark)').matches
export function useMessageTheme() {
  const { settings } = useUiPreferences()
  const systemDark = useSyncExternalStore(subscribeSystemTheme, readSystemTheme, () => false)
  const dark = settings.theme === 'dark' || settings.theme === 'system' && systemDark
  return { dark, codeTheme: dark ? 'github-dark' as const : 'github-light' as const, settings }
}

/** Keep feedback and cleanup local to the control; rejected writes never show success. */
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

export const useBrowserLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect
