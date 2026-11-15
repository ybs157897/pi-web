import { useContext, useEffect, useRef } from 'react'
import type { PluginContextEntry, PluginUiPage } from '../shared/plugin-ui.ts'
import { PluginPageHost, PluginPageHostContext } from './plugin-page-pool.tsx'
import { useUiPreferences } from './ui-preferences.tsx'
import css from './PluginUiCard.module.css'

/** PluginUiCard 的属性定义：插件页面数据、桥接回调与右侧面板打开回调。 */
export interface PluginUiCardProps {
  page: PluginUiPage
  /** 在右侧 Inspector 标签页中打开（或聚焦）同一页面。 */
  onOpenSidePane?: (page: PluginUiPage, host?: HTMLElement) => void
  onContext: (entry: PluginContextEntry) => void
  onMessage: (text: string) => void
  onOpenLink: (url: string) => void
}

/** 内联高度：取插件声明的 heightHint，缺省 320，最高不超过 640。 */
export function pluginUiCardHeight(heightHint: number | undefined): number {
  if (heightHint === undefined || !Number.isFinite(heightHint) || heightHint <= 0) return 320
  return Math.min(heightHint, 640)
}

/**
 * 功能：会话流中的紧凑插件界面卡片——标题行加一段与右侧 Inspector 共用的沙箱化
 * 插件页面。卡片与 Inspector 共享同一个宿主容器（`PluginPageHost`），宿主在两者间
 * 搬移（Chromium 可能会重新加载被重新挂父的 frame，见 `plugin-page-pool.tsx`）。
 * @param props page 插件页面数据；onOpenSidePane 打开右侧面板回调（无页面池时兜底）；
 *              onContext/onMessage/onOpenLink 桥接回调，透传给 PluginPageHost。
 * 内部逻辑：包一层 PluginPageHost 提供共享宿主 div，frame 高度按 pluginUiCardHeight
 * 计算；主体渲染交给 PluginUiCardBody。
 */
export function PluginUiCard({ page, onOpenSidePane, onContext, onMessage, onOpenLink }: PluginUiCardProps) {
  return (
    <PluginPageHost page={page} onContext={onContext} onMessage={onMessage} onOpenLink={onOpenLink}
      frameStyle={{ height: `${pluginUiCardHeight(page.heightHint)}px` }}>
      {host => <PluginUiCardBody page={page} host={host} onOpenSidePane={onOpenSidePane} />}
    </PluginPageHost>
  )
}

/** 卡片主体：标题行（页面名 + 插件 id）、「在右侧打开」按钮与共享宿主挂载区。 */
function PluginUiCardBody({ page, host, onOpenSidePane }: {
  page: PluginUiPage
  host: HTMLDivElement
  onOpenSidePane?: PluginUiCardProps['onOpenSidePane']
}) {
  const { t } = useUiPreferences()
  const pool = useContext(PluginPageHostContext)
  // 页面在右侧面板打开期间宿主归 Inspector 所有；卡片不得把它抢回来。
  const inSide = pool !== undefined && pool.sidePageIds.has(page.id)
  const mount = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const element = mount.current
    if (element === null || inSide || host.parentElement === element) return
    element.appendChild(host)
  }, [host, inSide])
  // 折叠行会卸载卡片及其 portal，因此重新展开的卡片要把新宿主告知右侧面板，
  // 而不是让标签页继续指向已腾空的旧宿主。
  const announced = useRef<HTMLElement | undefined>(undefined)
  useEffect(() => {
    if (!inSide || announced.current === host) return
    announced.current = host
    pool?.openSide(page, host)
  }, [host, inSide, page, pool])
  const title = page.title ?? page.pluginId
  /** 打开右侧面板：有页面池时由 pool.openSide 接管宿主，否则走 onOpenSidePane 兜底。 */
  const openSide = (): void => {
    if (pool !== undefined) pool.openSide(page, host)
    else onOpenSidePane?.(page)
  }
  return (
    <section className={css.card} data-plugin-ui-card={page.id}>
      <div className={css.header}>
        <span className={css.titleRow}>
          <span className={css.title} title={title}>{title}</span>
          {page.title !== undefined && page.title !== page.pluginId && (
            <span className={css.pluginId} title={page.pluginId}>{page.pluginId}</span>
          )}
        </span>
        <button
          type="button"
          className={css.openButton}
          disabled={pool === undefined && onOpenSidePane === undefined}
          onClick={openSide}
        >
          {t('在右侧打开', 'Open in side pane')}
        </button>
      </div>
      <div className={css.frameHost} style={{ height: pluginUiCardHeight(page.heightHint) }}>
        <div className={css.frameMount} ref={mount} hidden={inSide} />
        {inSide && <div className={css.sidePlaceholder} data-plugin-ui-side-placeholder>
          {t('已在右侧面板打开', 'Open in the side pane')}
        </div>}
      </div>
    </section>
  )
}

export default PluginUiCard
