// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import SubagentDirectory from '../src/web/SubagentDirectory.tsx'
import type { SubagentSummary } from '../src/shared/types.ts'
import { setupRenderingDom } from './rendering/setup.ts'

beforeEach(() => { setupRenderingDom() })
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

const running: SubagentSummary = {
  id: 'child-run', label: 'reviewer', title: '检查状态卡', status: 'running', answer: '正在比对',
  tokens: 900, durationMs: 30_000, metricsAt: Date.now(), createdAt: 1, updatedAt: 2,
}
const ended: SubagentSummary = {
  id: 'child-done', label: 'writer', title: '整理验收记录', status: 'inactive', answer: '已完成',
  tokens: 12_345, durationMs: 65_000, createdAt: 1, updatedAt: 2,
}

describe('SubagentDirectory', () => {
  it('groups live and ended children and shows their metrics', () => {
    render(<SubagentDirectory subagents={[running, ended]} onOpen={() => {}} />)
    expect(screen.getByText('正在运行')).toBeTruthy()
    expect(document.querySelector('[data-subagent-group="ended"] h3')?.textContent).toBe('已结束')
    expect(screen.getByText('检查状态卡')).toBeTruthy()
    expect(screen.getByText('整理验收记录')).toBeTruthy()
    expect(screen.getByText('12.3K tok · 1 分 05 秒')).toBeTruthy()
    expect(document.querySelector('[data-subagent-group="running"] [data-subagent-id="child-run"]')).toBeTruthy()
    expect(document.querySelector('[data-subagent-group="ended"] [data-subagent-id="child-done"]')).toBeTruthy()
  })

  it('opens the child session tab for a row', () => {
    const onOpen = vi.fn()
    render(<SubagentDirectory subagents={[running, ended]} onOpen={onOpen} />)
    fireEvent.click(screen.getByText('整理验收记录'))
    expect(onOpen).toHaveBeenCalledWith('child-done', '整理验收记录')
  })

  it('explains the empty conversation instead of drawing an empty list', () => {
    render(<SubagentDirectory subagents={[]} onOpen={() => {}} />)
    expect(screen.getByText('这个会话还没有子智能体')).toBeTruthy()
    expect(screen.queryByText('正在运行')).toBeNull()
  })
})
