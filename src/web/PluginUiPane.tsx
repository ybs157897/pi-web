import { useEffect, useMemo, useRef } from 'react'
import type { PluginContextEntry, PluginUiPage } from '../shared/plugin-ui.ts'
import { api } from './api.ts'
import {
  handleBridgeMessage, parseBridgeMessage, sendInitialize, sendToolResult,
  type PluginUiBridgeHandlers,
} from './plugin-ui-bridge.ts'
import css from './PluginUiPane.module.css'

/** PluginUiPane 的属性定义：页面数据、隐藏态与三类桥接回调。 */
export interface PluginUiPaneProps {
  page: PluginUiPage
  /** Inspector 会保持未激活 tab 挂载；由 CSS 隐藏，避免页面重新加载。 */
  hidden?: boolean
  onContext: (entry: PluginContextEntry) => void
  onMessage: (text: string) => void
  onOpenLink: (url: string) => void
}

/**
 * 功能：单个沙箱化插件页面，以 iframe 渲染插件 UI（出现在 Inspector 的插件面板中）。
 * @param props page 插件页面数据；hidden 为 true 时隐藏但不卸载；onContext/onMessage/onOpenLink
 *              分别处理插件回传的上下文条目、消息文本与外链打开请求。
 * 内部逻辑：iframe 设 `allow-scripts` 且无 `allow-same-origin`，页面永不共享宿主 origin；
 * 插件所需的一切能力都经由 JSON-RPC 桥（plugin-ui-bridge）处理——桥接层会重新校验方法
 * 白名单并转发到宿主 API。window message 监听只接受本 pane 挂载的 frame 发来的消息；
 * page.id/content/structuredContent 变化时向已加载的 frame 增量推送新数据而不重挂载；
 * frame 首次加载完成时依次发送 initialize 与工具结果。
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
      // 只有本 pane 挂载的 frame 允许与宿主通信；其余来源的 window 一律忽略。
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
  // 页面 id 稳定（例如多个工具复用同一插件看板）时，拿到新的结构化数据无需重挂载；
  // 直接推送给已加载的 frame。
  useEffect(() => {
    const element = frame.current
    if (element === null) return
    sendToolResult(element, page)
  }, [page.id, page.content, page.structuredContent])
  /** iframe 首次加载完成：向插件页面发送 initialize 握手与初始工具结果。 */
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
