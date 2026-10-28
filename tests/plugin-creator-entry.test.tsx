// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import type { PluginOverview } from '../src/shared/plugins.ts'
import { setupRenderingDom } from './rendering/setup.ts'

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

const emptyOverview: PluginOverview = { marketplaces: [], plugins: [], operations: [], diagnostics: [] }

beforeEach(() => {
  setupRenderingDom()
  mocks.getPluginOverview.mockResolvedValue(emptyOverview)
  mocks.watchPlugins.mockReturnValue({ close: vi.fn() })
})
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

describe('plugin creator entry', () => {
  it('offers a create action when the host provides the callback', async () => {
    const onCreatePlugin = vi.fn()
    render(<PluginsPanel onCreatePlugin={onCreatePlugin} />)
    const button = await screen.findByRole('button', { name: '创建插件' })
    button.click()
    expect(onCreatePlugin).toHaveBeenCalledTimes(1)
  })

  it('omits the action when the host cannot start a task', async () => {
    render(<PluginsPanel />)
    await waitFor(() => expect(mocks.getPluginOverview).toHaveBeenCalled())
    expect(screen.queryByRole('button', { name: '创建插件' })).toBeNull()
  })
})
