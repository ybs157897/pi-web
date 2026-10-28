import { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import Transcript from '../../src/web/transcript.tsx'
import { DEFAULT_UI_SETTINGS, UiPreferencesProvider } from '../../src/web/ui-preferences.tsx'
import type { TranscriptViewMode } from '../../src/shared/types.ts'
import { answerMessages, processMessages, prose, code, table, media } from './samples.ts'
import '../../vendor/dsh-theme/base.css'
import '../../vendor/dsh-theme/brand-font.css'
import '../../vendor/dsh-theme/design-platform.css'
import '../../vendor/dsh-theme/focus.css'
import '../../vendor/dsh-theme/gradient-shadow-text.css'
import '../../vendor/dsh-theme/scrollbar.css'
import '../../vendor/dsh-theme/shiki.css'
import '../../src/web/styles.css'
import './fixture.css'

const samples = { prose, code, table, media }
function Fixture() {
  const [sample, setSample] = useState('prose')
  const [dark, setDark] = useState(false)
  const [mode, setMode] = useState<TranscriptViewMode>('detailed')
  const [event, setEvent] = useState('')
  const [playing, setPlaying] = useState(false)
  const [tick, setTick] = useState(0)
  useEffect(() => {
    if (!playing) return
    const timer = window.setInterval(() => setTick(value => value + 1), 100)
    return () => window.clearInterval(timer)
  }, [playing])
  useEffect(() => { if (tick >= 120) setPlaying(false) }, [tick])
  const stage = tick < 25 ? 0 : tick < 65 ? 1 : tick < 120 ? 2 : 3
  const amount = stage === 0 ? tick / 25 : stage === 1 ? (tick - 25) / 40 : (tick - 65) / 55
  const messages = sample === 'process' ? processMessages(playing ? stage : 3, amount) : answerMessages(samples[sample as keyof typeof samples] ?? prose)
  return <UiPreferencesProvider value={{ ...DEFAULT_UI_SETTINGS, fontSize: 14, codeFontSize: 12, terminalFontSize: 14, theme: dark ? 'dark' : 'light', transcriptView: mode }}>
    <header className="fixture-toolbar"><strong>AI 输出对照</strong><select aria-label="场景" value={sample} onChange={e => { setSample(e.target.value); setPlaying(false) }}>
      <option value="prose">正文</option><option value="code">代码与图表</option><option value="table">表格</option><option value="media">图片与链接</option><option value="process">思考与工具</option></select>
      <button onClick={() => setDark(value => !value)}>{dark ? '浅色' : '暗色'}</button>
      <select aria-label="展示模式" value={mode} onChange={e => setMode(e.target.value as TranscriptViewMode)}><option value="compact">简洁</option><option value="standard">标准</option><option value="detailed">详细</option><option value="verbose">完全展开</option></select>
      <button onClick={() => { setSample('process'); setTick(0); setPlaying(true) }}>流式重播</button><button onClick={() => { setPlaying(false); setTick(120) }}>完成</button>
      <output aria-label="动作结果">{event}</output>
    </header>
    <main className="fixture-scroll"><Transcript messages={messages} running={playing} onOpenFile={(path, line) => setEvent(`打开文件 ${path}:${line ?? ''}`)}
      onOpenTool={(id, call) => setEvent(`查看工具 ${id}:${call ?? ''}`)} onInspectDiff={diff => setEvent(`查看差异 ${diff.path}`)}
      resolveFileImage={path => new URL(path.includes('missing') ? '/tests/rendering/missing.png' : '/tests/rendering/fixture-image.svg', location.origin).href} />
    </main>
  </UiPreferencesProvider>
}
createRoot(document.getElementById('root')!).render(<Fixture />)
