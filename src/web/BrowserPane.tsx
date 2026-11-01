import { useEffect, useState } from 'react'
import { ArrowLeft, ArrowRight, ExternalLink, Globe, RotateCw } from 'lucide-react'
import type { InspectorTab } from './inspector-tabs.ts'
import { displayUrl, normalizeLocalUrl } from './browser-url.ts'
import { useUiPreferences } from './ui-preferences.tsx'
import css from './BrowserPane.module.css'

export interface BrowserPaneProps {
  /** url/addressDraft 可变部分经 onNavigate 回写到外壳的 tab 上。 */
  tab: InspectorTab
  onNavigate: (patch: { url?: string; addressDraft?: string; title?: string }) => void
  onNotice: (text: string) => void
}

/** tab 条标题：跨源拿不到页面标题，用 host[:port]（默认端口省略）。 */
function hostTitle(url: string): string {
  try {
    const parsed = new URL(url)
    return parsed.port ? `${parsed.hostname}:${parsed.port}` : parsed.hostname
  } catch {
    return url
  }
}

export default function BrowserPane({ tab, onNavigate, onNotice }: BrowserPaneProps) {
  const { t } = useUiPreferences()
  // 会话内历史栈；tab.url 是当前项的镜像，初始挂载时（严格模式重挂载等）用它回填栈底。
  const [history, setHistory] = useState<string[]>(() => (tab.url ? [tab.url] : []))
  const [historyIndex, setHistoryIndex] = useState(() => (tab.url ? 0 : -1))
  const [reloadKey, setReloadKey] = useState(0)
  const [loading, setLoading] = useState(false)

  const currentUrl = tab.url ?? ''
  const addressValue = tab.addressDraft ?? displayUrl(currentUrl)

  useEffect(() => {
    if (tab.url) setLoading(true)
  }, [tab.url, reloadKey])

  const submitAddress = () => {
    const normalized = normalizeLocalUrl(addressValue)
    if (!normalized) {
      onNotice(t('仅支持本地地址预览', 'Only local URLs can be previewed'))
      return
    }
    // 新导航截断前进尾巴；同址重复提交也按 push 处理（表现为一次刷新）。
    const next = [...history.slice(0, historyIndex + 1), normalized]
    setHistory(next)
    setHistoryIndex(next.length - 1)
    onNavigate({ url: normalized, addressDraft: normalized, title: hostTitle(normalized) })
  }

  const go = (offset: number) => {
    const next = historyIndex + offset
    if (next < 0 || next >= history.length) return
    setHistoryIndex(next)
    // 后退/前进走 remount 而不是改 src，让目标页从干净文档开始。
    setReloadKey(key => key + 1)
    const url = history[next]
    onNavigate({ url, addressDraft: displayUrl(url), title: hostTitle(url) })
  }

  const openExternal = () => {
    if (!currentUrl) return
    window.open(currentUrl, '_blank', 'noopener,noreferrer')
  }

  const canOpenExternal = (() => {
    if (!currentUrl) return false
    try {
      const parsed = new URL(currentUrl)
      return parsed.protocol === 'http:' || parsed.protocol === 'https:'
    } catch {
      return false
    }
  })()

  const backLabel = t('后退', 'Back')
  const forwardLabel = t('前进', 'Forward')
  const reloadLabel = t('刷新', 'Reload')

  return (
    <div className={css.root}>
      <div className={css.toolbar}>
        <button type="button" className={css.iconButton} aria-label={backLabel} title={backLabel} disabled={historyIndex <= 0} onClick={() => go(-1)}>
          <ArrowLeft size={14} />
        </button>
        <button type="button" className={css.iconButton} aria-label={forwardLabel} title={forwardLabel} disabled={historyIndex >= history.length - 1} onClick={() => go(1)}>
          <ArrowRight size={14} />
        </button>
        <button
          type="button"
          className={css.iconButton}
          aria-label={reloadLabel}
          title={reloadLabel}
          disabled={!tab.url}
          onClick={() => setReloadKey(key => key + 1)}
        >
          <RotateCw size={13} />
        </button>
        <input
          className={css.address}
          value={addressValue}
          placeholder={t('输入网址后回车', 'Type a URL and press Enter')}
          spellCheck={false}
          onChange={event => onNavigate({ addressDraft: event.target.value })}
          onKeyDown={event => {
            if (event.key === 'Enter') submitAddress()
          }}
        />
        <button
          type="button"
          className={css.iconButton}
          aria-label={t('在新窗口打开', 'Open in new window')}
          title={t('在新窗口打开', 'Open in new window')}
          disabled={!canOpenExternal}
          onClick={openExternal}
        >
          <ExternalLink size={14} />
        </button>
      </div>
      <div className={css.content}>
        {loading && <div className={css.progress} />}
        {tab.url ? (
          <iframe
            key={reloadKey}
            className={css.frame}
            src={tab.url}
            title={tab.title}
            // allow-same-origin 让本地 dev server（HMR/websocket）可用；地址栏已限本地地址，风险面收在 localhost/127/::1。
            sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
            referrerPolicy="no-referrer"
            onLoad={() => setLoading(false)}
          />
        ) : (
          <div className={css.empty}>
            <Globe size={26} />
            <span>{t('粘贴或输入 URL 以打开网页', 'Paste or type a URL to open a web page')}</span>
          </div>
        )}
      </div>
    </div>
  )
}
