import { createContext, useEffect, useState, type CSSProperties, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import type { PluginContextEntry, PluginUiPage } from '../shared/plugin-ui.ts'
import { PluginUiPane } from './PluginUiPane.tsx'

/**
 * The page pool shared by the transcript's inline cards and the inspector tabs: one host element
 * per page, moved between the two surfaces instead of mounting a second iframe.
 */
export interface PluginPageHostPool {
  /** Page ids the side pane currently owns; their inline card shows a placeholder instead. */
  sidePageIds: ReadonlySet<string>
  /** Move the inline card's host into the side pane; the iframe inside it is not rebuilt. */
  openSide: (page: PluginUiPage, host: HTMLElement) => void
  /** Park a host in a connected holding node so it is never detached while changing surfaces. */
  hold: (host: HTMLElement) => void
}

/** `undefined` outside the provider, so a card rendered alone can fall back to its own callback. */
export const PluginPageHostContext = createContext<PluginPageHostPool | undefined>(undefined)

export interface PluginPageHostProps {
  page: PluginUiPage
  onContext: (entry: PluginContextEntry) => void
  onMessage: (text: string) => void
  onOpenLink: (url: string) => void
  /** The inline card's compact height; the side pane lets the host fill its slot. */
  frameStyle?: CSSProperties
  /** Renders the caller's mount point and hands it the stable host element to attach. */
  children: (host: HTMLDivElement) => ReactNode
}

/**
 * Keep one plugin page mounted across both surfaces. The host is created once and the pane is
 * portalled into it, so React never unmounts the iframe. Chromium may still reload a re-parented
 * frame; a true zero-reload page plane would keep the host in a fixed parent and position it.
 */
export function PluginPageHost({ page, onContext, onMessage, onOpenLink, frameStyle, children }: PluginPageHostProps) {
  const [host] = useState<HTMLDivElement>(() => {
    const element = document.createElement('div')
    element.style.display = 'flex'
    element.style.flex = '1 1 auto'
    element.style.flexDirection = 'column'
    element.style.minWidth = '0'
    element.style.minHeight = '0'
    element.style.overflow = 'hidden'
    return element
  })
  useEffect(() => { host.dataset.pluginPageHost = page.id }, [host, page.id])
  const frame: CSSProperties = {
    display: 'flex',
    flexDirection: 'column',
    flex: '1 1 auto',
    minWidth: 0,
    minHeight: 0,
    overflow: 'hidden',
    ...frameStyle,
  }
  return (
    <>
      {children(host)}
      {createPortal(
        <div style={frame} data-plugin-page-frame={page.id}>
          <PluginUiPane page={page} onContext={onContext} onMessage={onMessage} onOpenLink={onOpenLink} />
        </div>,
        host,
      )}
    </>
  )
}

export default PluginPageHost
