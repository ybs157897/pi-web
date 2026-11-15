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

/**
 * 功能：内置浏览器面板——Inspector 中的本地 URL 预览页：工具栏含后退/前进/刷新/
 * 地址栏/新窗口打开，下方以 sandbox iframe 渲染目标网页。
 * @param props tab 浏览器标签状态（url、addressDraft、title 经 onNavigate 回写）；
 *              onNavigate 把地址草稿/导航结果补丁回传给外壳；onNotice 提示回调。
 * 内部逻辑：history/historyIndex 维护会话内的历史栈（tab.url 仅在初始挂载时回填栈底）；
 * submitAddress 用 normalizeLocalUrl 限制只预览本地地址，新导航截断前进尾巴；
 * go() 后退/前进通过递增 reloadKey 强制 iframe remount，让目标页从干净文档开始；
 * 「在新窗口打开」仅对 http/https 可用；iframe 沙箱允许脚本/同源/表单/弹窗。
 */
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

  /** 提交地址栏：归一化本地 URL 后压入历史栈并回写 tab；非法地址时提示仅支持本地预览。 */
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

  /** 后退/前进：移动历史游标并触发 iframe remount，同时回写 tab 的 url/地址栏/标题。 */
  const go = (offset: number) => {
    const next = historyIndex + offset
    if (next < 0 || next >= history.length) return
    setHistoryIndex(next)
    // 后退/前进走 remount 而不是改 src，让目标页从干净文档开始。
    setReloadKey(key => key + 1)
    const url = history[next]
    onNavigate({ url, addressDraft: displayUrl(url), title: hostTitle(url) })
  }

  /** 在系统新窗口打开当前 URL（noopener/noreferrer 防止反连）。 */
  const openExternal = () => {
    if (!currentUrl) return
    window.open(currentUrl, '_blank', 'noopener,noreferrer')
  }

  /** 仅当当前 URL 是 http/https 时才允许「在新窗口打开」。 */
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
