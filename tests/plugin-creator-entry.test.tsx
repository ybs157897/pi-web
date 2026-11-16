// @vitest-environment jsdom
/**
 * 插件面板"创建插件"入口的条件渲染测试。
 *
 * 关键契约：仅当宿主（宿主页面/工作台）通过 onCreatePlugin 回调提供创建能力时，
 * PluginsPanel 才渲染"创建插件"按钮并点击触发回调；宿主不支持时按钮整体不出现。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import type { PluginOverview } from '../src/shared/plugins.ts'
import { setupRenderingDom } from './rendering/setup.ts'

/** vi.hoisted 提升的 api mock 句柄，供 vi.mock 工厂引用。 */
const mocks = vi.hoisted(() => ({
  getPluginOverview: vi.fn(),
  watchPlugins: vi.fn(),
}))

vi.mock('../src/web/api.ts', () => ({
  api: {
    getPluginOverview: mocks.getPluginOverview,
    watchPlugins: mocks.watchPlugins,
  },
}))

import PluginsPanel from '../src/web/PluginsPanel.tsx'

/** 空的插件总览：无市场、无插件、无操作记录、无诊断，避免面板渲染出无关内容。 */
const emptyOverview: PluginOverview = { marketplaces: [], plugins: [], operations: [], diagnostics: [] }

/** 每个用例前重置 DOM 并给 api mock 填默认返回值（空总览 + 可关闭的 watch 句柄）。 */
beforeEach(() => {
  setupRenderingDom()
  mocks.getPluginOverview.mockResolvedValue(emptyOverview)
  mocks.watchPlugins.mockReturnValue({ close: vi.fn() })
})
/** 卸载组件、恢复 mock、清除全局 stub。 */
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

/** "创建插件"按钮的出现条件与点击行为。 */
describe('plugin creator entry', () => {
  // 验证宿主提供 onCreatePlugin 回调时渲染"创建插件"按钮，点击恰好触发一次回调。
  it('offers a create action when the host provides the callback', async () => {
    const onCreatePlugin = vi.fn()
    render(<PluginsPanel onCreatePlugin={onCreatePlugin} />)
    const button = await screen.findByRole('button', { name: '创建插件' })
    button.click()
    expect(onCreatePlugin).toHaveBeenCalledTimes(1)
  })

  // 验证宿主未提供 onCreatePlugin 时按钮不渲染（面板其余内容照常加载，等待 overview 数据到达后断言）。
  it('omits the action when the host cannot start a task', async () => {
    render(<PluginsPanel />)
    await waitFor(() => expect(mocks.getPluginOverview).toHaveBeenCalled())
    expect(screen.queryByRole('button', { name: '创建插件' })).toBeNull()
  })
})
