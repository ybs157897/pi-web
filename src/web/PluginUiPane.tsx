import { useEffect, useMemo, useRef } from 'react'
import type { PluginContextEntry, PluginUiPage } from '../shared/plugin-ui.ts'
import { api } from './api.ts'
import {
  handleBridgeMessage, parseBridgeMessage, sendInitialize, sendToolResult,
  type PluginUiBridgeHandlers,
} from './plugin-ui-bridge.ts'
import css from './PluginUiPane.module.css'

export interface PluginUiPaneProps {
  page: PluginUiPage
  /** The inspector keeps inactive tabs mounted; CSS hides them without reloading the page. */
  hidden?: boolean
  onContext: (entry: PluginContextEntry) => void
  onMessage: (text: string) => void
  onOpenLink: (url: string) => void
}

/**
 * One sandboxed plugin page. The iframe has `allow-scripts` but no `allow-same-origin`, so the
 * page never shares the host origin; every capability it needs goes through the JSON-RPC bridge
 * below, which re-checks the method allowlist and forwards the call through the host API.
 */
export function PluginUiPane({ page, hidden = false, onContext, onMessage, onOpenLink }: PluginUiPaneProps) {
  const frame = useRef<HTMLIFrameElement>(null)
  const handlers = useMemo<PluginUiBridgeHandlers>(
    () => ({ onContext, onMessage, onOpenLink }),
    [onContext, onMessage, onOpenLink],
  )
  useEffect(() => {
    const listener = (event: MessageEvent): void => {
      const frameWindow = frame.current?.contentWindow
      // Only the frame this pane mounted may speak to the host; other windows are ignored.
      if (frameWindow === null || frameWindow === undefined || event.source !== frameWindow) return
      const message = parseBridgeMessage(event.data)
      if (message === null) return
      void handleBridgeMessage(message, page, handlers).then((response) => {
        if (response !== null) frameWindow.postMessage(response, '*')
      }).catch(() => undefined)
    }
    window.addEventListener('message', listener)
    return () => { window.removeEventListener('message', listener) }
  }, [handlers, page])
  const loaded = (): void => {
    const element = frame.current
    if (element === null) return
    sendInitialize(element, page)
    sendToolResult(element, page)
  }
  return (
    <iframe
      ref={frame}
      className={css.frame}
      data-plugin-ui-page={page.id}
      data-hidden={hidden || undefined}
      style={hidden ? { display: 'none' } : undefined}
      sandbox="allow-scripts"
      referrerPolicy="no-referrer"
      title={page.title ?? page.pluginId}
      src={api.pluginUiPageUrl(page)}
      onLoad={loaded}
    />
  )
}

export default PluginUiPane
