import { createContext, useContext, useMemo, useState } from 'react'
import type { ReactNode, SetStateAction } from 'react'
const Expansions = createContext<Map<string, boolean> | null>(null)
export function ProcessExpansionProvider({ children }: { children: ReactNode }) {
  const state = useMemo(() => new Map<string, boolean>(), [])
  return <Expansions.Provider value={state}>{children}</Expansions.Provider>
}
/**
 * 功能：进程/工具分组条目的展开状态；外部 work group 重挂载后保留用户手动展开/收起的选择。
 * @param key 全局唯一键（一般用分组 id）
 * @param defaultOpen 无手动记录时的默认展开值
 * @returns `[open, setOpen]`，open = 手动值 ?? 默认值
 * 内部逻辑：setOpen 同时写进 Provider 的 Map（跨重挂载记忆）与本地 state（触发重渲染）。
 */
export function useProcessExpansion(key: string, defaultOpen = false) {
  const store = useContext(Expansions)
  const [manual, setManual] = useState<boolean | undefined>(() => store?.get(key))
  const open = manual ?? defaultOpen
  const setOpen = (value: SetStateAction<boolean>) => {
    const next = typeof value === 'function' ? value(open) : value
    store?.set(key, next); setManual(next)
  }
  return [open, setOpen] as const
}
