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

/** 插件页宿主池 context；provider 之外为 undefined，单独渲染的卡片可回落到自己的回调。 */
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
 * 功能：让一个插件页在「transcript 内联卡片」与「inspector 侧栏 tab」两个表面之间共用同一宿主。
 * 宿主 div 只创建一次，pane portal 进去，React 永远不卸载其中的 iframe。
 * @param page 插件页描述（对应 host DTO 的 plugin-ui 页）
 * @param onContext 插件回传 context 的回调
 * @param onMessage 插件回传消息文本的回调
 * @param onOpenLink 插件请求打开链接的回调
 * @param frameStyle 内联卡片的紧凑高度样式；侧栏里让宿主撑满槽位
 * @param children render-prop：渲染调用方的挂载点并交出稳定的宿主元素
 * 内部逻辑：换表面靠宿主 DOM 移动而非重挂 iframe；但 Chromium 对重新挂父的 frame 仍可能重载，真正零重载需固定父容器加定位。
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
