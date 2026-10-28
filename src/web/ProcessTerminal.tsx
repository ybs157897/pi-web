import { useLayoutEffect, useMemo, useRef, useState } from 'react'
import { ChevronDown } from 'lucide-react'
import type { KeyboardEvent } from 'react'
import type { Translate } from './render-labels.ts'
import { parseAnsiLines } from './message-rendering/terminal-ansi.ts'
import './message-rendering/theme.css'
import css from './ProcessTerminal.module.css'

type ScrollEdges = 'none' | 'top' | 'bottom' | 'both'

/** 内容还有多少被视口上下边缘遮住：决定 24px 渐隐方向。 */
function scrollEdges(element: HTMLElement): ScrollEdges {
  const maxScrollTop = element.scrollHeight - element.clientHeight
  if (maxScrollTop <= 1) return 'none'
  const hiddenTop = element.scrollTop > 1
  const hiddenBottom = element.scrollTop < maxScrollTop - 1
  return hiddenTop ? (hiddenBottom ? 'both' : 'top') : hiddenBottom ? 'bottom' : 'none'
}

/** Own command/output scrollports: no selectors or mutations inside third-party components. */
export function ProcessTerminal({ command, cwd, output, exitCode, signal, running, t }: {
  command: string; cwd?: string; output: string; exitCode?: number | null; signal?: string
  running: boolean; t: Translate
}) {
  const commandView = useRef<HTMLDivElement>(null)
  const outputView = useRef<HTMLDivElement>(null)
  const outputContent = useRef<HTMLPreElement>(null)
  const previousTop = useRef(0)
  const hasStreamed = useRef(running)
  const [commandExpanded, setCommandExpanded] = useState(false)
  const [commandOverflow, setCommandOverflow] = useState(false)
  const [frozen, setFrozen] = useState<string | null>(null)
  const [edges, setEdges] = useState<ScrollEdges>('none')
  const display = frozen ?? output
  const following = frozen === null
  const content = useMemo(() => {
    if (!/[\u001b\r\b]/u.test(display)) return display.replace(/\n$/u, '')
    const lines = parseAnsiLines(display)
    return lines.map((line, row) => <span key={row}>{line.map((part, col) => part.style ? <span key={col} style={part.style}>{part.text}</span> : part.text)}{row < lines.length - 1 ? '\n' : ''}</span>)
  }, [display])
  useLayoutEffect(() => {
    if (commandExpanded || !commandView.current) return
    const element = commandView.current
    const measure = () => setCommandOverflow(element.scrollHeight > element.clientHeight + 1)
    measure()
    const observer = new ResizeObserver(measure); observer.observe(element)
    return () => observer.disconnect()
  }, [command, commandExpanded])
  function updateEdges(element: HTMLDivElement) {
    const next = scrollEdges(element)
    setEdges(current => current === next ? current : next)
  }
  useLayoutEffect(() => {
    if (running) hasStreamed.current = true
    const element = outputView.current
    if (!element) return
    if (hasStreamed.current && following) {
      element.scrollTop = element.scrollHeight
      previousTop.current = element.scrollTop
    }
    updateEdges(element)
  }, [display, running, following])
  useLayoutEffect(() => {
    const element = outputView.current
    if (!element) return
    updateEdges(element)
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(() => updateEdges(element))
    observer.observe(element)
    if (outputContent.current) observer.observe(outputContent.current)
    return () => observer.disconnect()
  }, [display !== ''])
  function handleScroll() {
    const element = outputView.current
    if (!element) return
    const bottom = element.scrollHeight - element.scrollTop - element.clientHeight <= 8
    if (hasStreamed.current && following && element.scrollTop < previousTop.current && !bottom) setFrozen(display)
    else if (!following && bottom) setFrozen(null)
    previousTop.current = element.scrollTop
    updateEdges(element)
  }
  function scrollByKeyboard(event: KeyboardEvent<HTMLDivElement>) {
    if (event.target !== event.currentTarget) return
    const element = event.currentTarget
    const target = event.key === 'Home' ? 0 : event.key === 'End' ? element.scrollHeight
      : event.key === 'ArrowDown' ? element.scrollTop + 40 : event.key === 'ArrowUp' ? element.scrollTop - 40 : undefined
    if (target === undefined || element.scrollHeight <= element.clientHeight) return
    event.preventDefault(); element.scrollTop = target
    handleScroll()
  }
  const failure = signal ? t(`信号 ${signal}`, `Signal ${signal}`) : exitCode === null ? t('未返回退出码', 'No exit code')
    : exitCode !== undefined && exitCode !== 0 ? t(`退出码 ${exitCode}`, `Exit code ${exitCode}`) : undefined
  return <section className={css.card} data-message-terminal data-running={running || undefined} aria-label={t('终端命令和输出', 'Terminal command and output')} title={cwd}>
    <div className={css.commandSection}>
      <div className={css.commandViewport} ref={commandView} data-expanded={commandExpanded || undefined} tabIndex={commandExpanded ? 0 : undefined}>
        <div className={css.commandLine}><span className={css.prompt} aria-hidden="true">$</span><pre>{command}</pre></div>
      </div>
      {(commandOverflow || commandExpanded) && <button type="button" className={css.commandToggle} aria-expanded={commandExpanded} onClick={() => { if (commandView.current) commandView.current.scrollTop = 0; setCommandExpanded(value => !value) }}>
        {commandExpanded ? t('收起命令', 'Collapse command') : t('展开命令', 'Expand command')}<ChevronDown size={12} data-expanded={commandExpanded || undefined} />
      </button>}
    </div>
    {display !== '' ? <div className={css.outputViewport} ref={outputView} data-edges={edges} data-following={following} tabIndex={0} role="region" aria-label={t('命令输出', 'Command output')} onScroll={handleScroll} onKeyDown={scrollByKeyboard}><pre ref={outputContent}>{content}</pre></div>
      : !running ? <div className={css.empty}>{t('没有输出', 'No output')}</div> : null}
    {failure && <div className={css.failure} role="status">{failure}</div>}
  </section>
}
