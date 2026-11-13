// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { BotRecord, BotTeamOverview, ModelCatalog } from '../src/shared/types.ts'
import { setupRenderingDom } from './rendering/setup.ts'

const mocks = vi.hoisted(() => ({
  getBots: vi.fn(),
  updateBot: vi.fn(),
}))

vi.mock('../src/web/api.ts', () => ({ api: mocks }))

const { BotModelSettings } = await import('../src/web/BotModelSettings.tsx')
const { DEFAULT_UI_SETTINGS, UiPreferencesProvider } = await import('../src/web/ui-preferences.tsx')

const NOW = '2026-11-12T09:00:00.000Z'

function bot(overrides: Partial<BotRecord> = {}): BotRecord {
  return {
    id: 'Atlas', name: 'Atlas', module: 'server', globs: ['src/server/**'],
    description: '服务端', knowledgePath: 'docs/bots/Atlas.md', conversationId: 'conv-atlas',
    createdAt: NOW, status: 'idle', knowledgeHealth: 'fresh', compliance: 'complied', ...overrides,
  }
}

function overview(bots: BotRecord[]): BotTeamOverview {
  return {
    bots,
    rooms: [],
    watchdog: {},
    init: { running: false },
    config: { watchdogIntervalMs: 0 },
  }
}

const catalog: ModelCatalog = {
  models: [
    { provider: 'repro', modelId: 'repro-model', name: 'Repro model', reasoning: false, available: true },
    { provider: 'repro', modelId: 'repro-flash', name: 'Repro flash', reasoning: false, available: true },
    { provider: 'gone', modelId: 'old', name: 'Gone', reasoning: false, available: false },
  ],
  providers: [],
  thinkingLevels: ['off', 'low', 'medium', 'high'],
}

function renderPanel() {
  return render(
    <UiPreferencesProvider value={DEFAULT_UI_SETTINGS}>
      <BotModelSettings catalog={catalog} />
    </UiPreferencesProvider>,
  )
}

beforeEach(() => {
  setupRenderingDom()
  mocks.getBots.mockReset()
  mocks.updateBot.mockReset()
})

afterEach(() => {
  cleanup()
})

describe('BotModelSettings', () => {
  it('shows an empty state when the roster has no bots', async () => {
    mocks.getBots.mockResolvedValue(overview([]))
    renderPanel()
    expect((await screen.findByRole('status')).textContent).toContain('还没有 Bot')
    expect(screen.queryByRole('combobox')).toBeNull()
  })

  it('lets each bot pick a model or follow the project default', async () => {
    mocks.getBots.mockResolvedValue(overview([
      bot(),
      bot({ id: 'Aurora', name: 'Aurora', module: 'web', model: 'repro/repro-flash', conversationId: 'conv-aurora' }),
    ]))
    mocks.updateBot.mockResolvedValue({
      bot: bot({ model: 'repro/repro-flash' }),
    })
    renderPanel()
    const atlas = await screen.findByLabelText('Atlas 的模型')
    const aurora = screen.getByLabelText('Aurora 的模型')
    expect((atlas as HTMLSelectElement).value).toBe('')
    expect((aurora as HTMLSelectElement).value).toBe('repro/repro-flash')
    fireEvent.change(atlas, { target: { value: 'repro/repro-flash' } })
    await waitFor(() => {
      expect(mocks.updateBot).toHaveBeenCalledWith('Atlas', { model: 'repro/repro-flash' })
    })
  })
})
