// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { AnalysisPanel } from '../src/web/WetrackPage.tsx'
import { DEFAULT_UI_SETTINGS, UiPreferencesProvider } from '../src/web/ui-preferences.tsx'
import { setupRenderingDom } from './rendering/setup.ts'

/** WeTrack 分析面板对「分析受阻（blocked）」状态的呈现契约测试（jsdom 环境）。 */
setupRenderingDom()
afterEach(cleanup)

describe('WeTrack analysis attempts', () => {
  it('keeps the previous conclusion visible alongside a blocked attempt', () => {
    render(<UiPreferencesProvider value={DEFAULT_UI_SETTINGS}><AnalysisPanel
      state={{ loading: false, error: '', value: {
        defectNumber: 'DTS006761203', status: 'analyzed', title: '既有结论', summary: '', markdown: '既有证据', updatedAt: '',
        latestAttempt: { status: 'blocked', blockedReason: 'budget-exhausted', title: '受阻', summary: '缺少验证', markdown: '本次已核对的范围', updatedAt: '' },
      } }} error="" onOpenConversation={() => undefined} /></UiPreferencesProvider>)
    expect(screen.getByText('最近一次分析受阻，已保留此前结论')).toBeTruthy()
    expect(screen.getByText(/检索预算已用尽/)).toBeTruthy()
    expect(screen.getByText('本次已核对的范围')).toBeTruthy()
    expect(screen.getByText('既有证据')).toBeTruthy()
  })

  // 边界：首次分析就受阻、没有任何既有结论时，只展示受阻原因，不出现「已保留此前结论」。
  it('shows the reason when the first analysis is blocked', () => {
    render(<UiPreferencesProvider value={DEFAULT_UI_SETTINGS}><AnalysisPanel
      state={{ loading: false, error: '', value: {
        defectNumber: 'DTS006761203', status: 'blocked', title: '受阻', summary: '', markdown: '无法核对仓库', updatedAt: '',
        latestAttempt: { status: 'blocked', blockedReason: 'access', title: '受阻', summary: '', markdown: '无法核对仓库', updatedAt: '' },
      } }} error="" onOpenConversation={() => undefined} /></UiPreferencesProvider>)
    expect(screen.getByText('本次分析受阻')).toBeTruthy()
    expect(screen.getByText('缺少访问权限', { selector: 'p' })).toBeTruthy()
  })
})
