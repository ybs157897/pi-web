import { createContext, useContext, useMemo, useState } from 'react'
import type { ReactNode, SetStateAction } from 'react'
const Expansions = createContext<Map<string, boolean> | null>(null)
export function ProcessExpansionProvider({ children }: { children: ReactNode }) {
  const state = useMemo(() => new Map<string, boolean>(), [])
  return <Expansions.Provider value={state}>{children}</Expansions.Provider>
}
/** Tool details keep their explicit expansion when the enclosing work group is remounted. */
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
