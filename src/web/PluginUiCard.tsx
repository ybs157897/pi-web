import { useContext, useEffect, useRef } from 'react'
import type { PluginContextEntry, PluginUiPage } from '../shared/plugin-ui.ts'
import { PluginPageHost, PluginPageHostContext } from './plugin-page-pool.tsx'
import { useUiPreferences } from './ui-preferences.tsx'
import css from './PluginUiCard.module.css'

export interface PluginUiCardProps {
  page: PluginUiPage
  /** Open (or focus) the same page in the right inspector tab. */
  onOpenSidePane?: (page: PluginUiPage, host?: HTMLElement) => void
  onContext: (entry: PluginContextEntry) => void
  onMessage: (text: string) => void
  onOpenLink: (url: string) => void
}

/** Inline height: the plugin's hint, defaulting to 320 and never taller than 640. */
export function pluginUiCardHeight(heightHint: number | undefined): number {
  if (heightHint === undefined || !Number.isFinite(heightHint) || heightHint <= 0) return 320
  return Math.min(heightHint, 640)
}

/**
 * The transcript's compact plugin surface: a title row plus the sandboxed page the inspector
 * shows. Both surfaces share one host (`PluginPageHost`); the host moves between them, though
 * Chromium may reload a re-parented frame (see `plugin-page-pool.tsx`).
 */
export function PluginUiCard({ page, onOpenSidePane, onContext, onMessage, onOpenLink }: PluginUiCardProps) {
  return (
    <PluginPageHost page={page} onContext={onContext} onMessage={onMessage} onOpenLink={onOpenLink}
      frameStyle={{ height: `${pluginUiCardHeight(page.heightHint)}px` }}>
      {host => <PluginUiCardBody page={page} host={host} onOpenSidePane={onOpenSidePane} />}
    </PluginPageHost>
  )
}

function PluginUiCardBody({ page, host, onOpenSidePane }: {
  page: PluginUiPage
  host: HTMLDivElement
  onOpenSidePane?: PluginUiCardProps['onOpenSidePane']
}) {
  const { t } = useUiPreferences()
  const pool = useContext(PluginPageHostContext)
  // The inspector owns the host while the page is open there; the card must not steal it back.
  const inSide = pool !== undefined && pool.sidePageIds.has(page.id)
  const mount = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const element = mount.current
    if (element === null || inSide || host.parentElement === element) return
    element.appendChild(host)
  }, [host, inSide])
  // Collapsing the row unmounts the card and its portal, so a re-expanded card tells the side
  // pane about its new host instead of leaving the tab pointed at the old, now-empty one.
  const announced = useRef<HTMLElement | undefined>(undefined)
  useEffect(() => {
    if (!inSide || announced.current === host) return
    announced.current = host
    pool?.openSide(page, host)
  }, [host, inSide, page, pool])
  const title = page.title ?? page.pluginId
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
