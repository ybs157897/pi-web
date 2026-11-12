// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { BotRecord, BotRoomFrame, BotTeamOverview } from '../src/shared/types.ts'
import { setupRenderingDom } from './rendering/setup.ts'

const mocks = vi.hoisted(() => ({
  getBots: vi.fn(),
  createBot: vi.fn(),
  updateBot: vi.fn(),
  initBots: vi.fn(),
  updateBotsConfig: vi.fn(),
  createBotRoom: vi.fn(),
  postBotRoomMessage: vi.fn(),
  runBotWatchdog: vi.fn(),
  getBotWatchdogReport: vi.fn(),
  getBotRoomLog: vi.fn(),
}))

vi.mock('../src/web/api.ts', () => ({ api: mocks }))

const { parseBotRoomFrame } = await import('../src/web/bots-view.ts')
const { default: BotsPage } = await import('../src/web/BotsPage.tsx')
const { DEFAULT_UI_SETTINGS, UiPreferencesProvider } = await import('../src/web/ui-preferences.tsx')

const NOW = '2026-11-12T09:00:00.000Z'

function bot(overrides: Partial<BotRecord> = {}): BotRecord {
  return {
    id: 'bot-1', name: 'bot-a', module: 'runtime', globs: ['src/server/runtime/**'],
    description: '负责运行时装配', knowledgePath: 'docs/bots/runtime.md', conversationId: 'conv-bot-1',
    createdAt: NOW, status: 'idle', knowledgeHealth: 'fresh', compliance: 'complied', lastActiveAt: NOW, ...overrides,
  }
}

function overview(overrides: Partial<BotTeamOverview> = {}): BotTeamOverview {
  return {
    bots: [
      bot({ id: 'bot-a', name: 'bot-a', knowledgeHealth: 'fresh', compliance: 'complied', status: 'idle', lastActiveAt: NOW }),
      bot({ id: 'bot-b', name: 'bot-b', module: 'conversation', knowledgeHealth: 'stale', compliance: 'stalled', status: 'busy' }),
      bot({ id: 'bot-c', name: 'bot-c', module: 'tools', knowledgeHealth: 'drift', compliance: 'pending', status: 'error' }),
      bot({ id: 'bot-d', name: 'bot-d', module: 'mcp', knowledgeHealth: 'over-limit', compliance: 'pending', lastActiveAt: undefined }),
      bot({ id: 'bot-e', name: 'bot-e', module: 'memory', knowledgeHealth: 'unknown', compliance: 'complied' }),
    ],
    rooms: [{ id: 'room-1', name: '全员大厅', conversationId: 'conv-room-1', memberIds: ['bot-a', 'bot-b'], createdAt: NOW }],
    watchdog: { lastRunAt: NOW },
    init: { running: false },
    config: { watchdogIntervalMs: 60_000 },
    ...overrides,
  }
}

function frame(sender: BotRoomFrame['sender'], text: string): BotRoomFrame {
  return { sender, text }
}

const ROOM_FRAMES: BotRoomFrame[] = [
  frame({ kind: 'user' }, '请 @bot-a 检查运行时\n顺便看看 @bot-b'),
  frame({ kind: 'bot', name: 'bot-a' }, '收到，@bot-b 一起处理 @nobody'),
  frame({ kind: 'system' }, 'bot-c 已重新上线'),
]

function renderPage(props: { onOpenConversation?: (id: string) => void } = {}) {
  return render(
    <UiPreferencesProvider value={DEFAULT_UI_SETTINGS}>
      <BotsPage onOpenConversation={props.onOpenConversation ?? (() => undefined)} />
    </UiPreferencesProvider>,
  )
}

beforeEach(() => {
  setupRenderingDom()
  for (const mock of Object.values(mocks)) mock.mockReset()
  mocks.getBots.mockResolvedValue(overview())
  mocks.getBotRoomLog.mockResolvedValue(ROOM_FRAMES)
  mocks.getBotWatchdogReport.mockResolvedValue({ lastRunAt: NOW, report: undefined })
  mocks.updateBotsConfig.mockResolvedValue({ config: { watchdogIntervalMs: 60_000 } })
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('parseBotRoomFrame', () => {
  it('splits user, bot and system frames from the first line', () => {
    expect(parseBotRoomFrame('[USER] 你好\n第二条')).toEqual({ sender: { kind: 'user' }, text: '你好\n第二条' })
    expect(parseBotRoomFrame('[BOT:bot-a] 已完成')).toEqual({ sender: { kind: 'bot', name: 'bot-a' }, text: '已完成' })
    expect(parseBotRoomFrame('[SYSTEM] 已重置')).toEqual({ sender: { kind: 'system' }, text: '已重置' })
  })

  it('returns null for entries without a frame header', () => {
    expect(parseBotRoomFrame('no header at all')).toBeNull()
    expect(parseBotRoomFrame('')).toBeNull()
  })
})

describe('bots page', () => {
  it('renders the roster with knowledge-health and compliance badges', async () => {
    renderPage()
    await waitFor(() => { expect(screen.getByText('bot-a')).toBeTruthy() })
    for (const health of ['知识新鲜', '知识过期', '知识漂移', '超出限额', '状态未知']) {
      expect(screen.getByText(health)).toBeTruthy()
    }
    expect(screen.getAllByText('已回写 ✓')).toHaveLength(2)
    expect(screen.getByText('回写停滞 ⚠')).toBeTruthy()
    expect(screen.getAllByText('待回写')).toHaveLength(2)
    expect(screen.getByText('runtime')).toBeTruthy()
    expect(screen.getAllByText('src/server/runtime/**')).toHaveLength(5)
    expect(screen.getByText('从未活动')).toBeTruthy()
  })

  it('renders interleaved room messages with name chips and mention chips', async () => {
    renderPage()
    await waitFor(() => { expect(screen.getByText('全员大厅')).toBeTruthy() })
    await waitFor(() => { expect(document.querySelector('[data-side]')).toBeTruthy() })
    // One user line and one bot line; entries without a frame header are skipped.
    const sides = Array.from(document.querySelectorAll('[data-side]')).map(node => node.getAttribute('data-side'))
    expect(sides).toEqual(['user', 'bot'])
    expect(document.querySelectorAll('[data-name-chip]')).toHaveLength(1)
    expect(document.querySelector('[data-name-chip]')?.textContent).toBe('bot-a')
    expect(screen.getByText('bot-c 已重新上线')).toBeTruthy()
    const mentions = Array.from(document.querySelectorAll('[data-mention]')).map(node => node.textContent)
    expect(mentions).toEqual(['@bot-a', '@bot-b', '@bot-b'])
    // @nobody is not on the roster, so it stays plain text instead of a chip.
    expect(document.body.textContent).toContain('@nobody')
    expect(screen.queryByText('没有帧头的普通日志')).toBeNull()
  })

  it('renders frames from the log endpoint and stops polling on unmount', async () => {
    const page = renderPage()
    await waitFor(() => { expect(document.querySelector('[data-side]')).toBeTruthy() })
    const callsAfterMount = mocks.getBotRoomLog.mock.calls.length
    expect(callsAfterMount).toBeGreaterThanOrEqual(1)
    expect(mocks.getBotRoomLog.mock.calls[0]?.[0]).toBe('room-1')
    // The poll cadence picks up new frames without any manual refresh.
    await new Promise(resolve => { setTimeout(resolve, 2_300) })
    expect(mocks.getBotRoomLog.mock.calls.length).toBeGreaterThan(callsAfterMount)
    page.unmount()
    const callsAtUnmount = mocks.getBotRoomLog.mock.calls.length
    await new Promise(resolve => { setTimeout(resolve, 2_300) })
    expect(mocks.getBotRoomLog.mock.calls.length).toBe(callsAtUnmount)
  })

  it('shows the watchdog report drawer with health, detail and suggestion per bot', async () => {
    mocks.getBots.mockResolvedValue(overview({
      watchdog: {
        lastRunAt: NOW,
        report: {
          runAt: NOW,
          entries: [
            { botId: 'bot-b', botName: 'bot-b', knowledgePath: 'docs/bots/conversation.md', health: 'stale', detail: '知识文档落后于 3 次提交', suggestion: '运行一次刷新' },
          ],
        },
      },
    }))
    renderPage()
    await waitFor(() => { expect(screen.getByText('bot-b')).toBeTruthy() })
    fireEvent.click(screen.getByRole('button', { name: '查看报告' }))
    await waitFor(() => { expect(screen.getByText('知识文档落后于 3 次提交')).toBeTruthy() })
    expect(screen.getByText('建议：运行一次刷新')).toBeTruthy()
    expect(screen.getByText('docs/bots/conversation.md')).toBeTruthy()
  })

  it('shows the init running state and jumps to its conversation', async () => {
    const opened: string[] = []
    mocks.getBots.mockResolvedValue(overview({ init: { running: true, conversationId: 'conv-init-1' } }))
    renderPage({ onOpenConversation: id => { opened.push(id) } })
    await waitFor(() => { expect(screen.getByText('初始化进行中')).toBeTruthy() })
    const viewProgress = screen.getByRole('button', { name: '查看过程' })
    fireEvent.click(viewProgress)
    expect(opened).toEqual(['conv-init-1'])
    expect(screen.getByRole('button', { name: '初始化团队' }).hasAttribute('disabled')).toBe(true)
  })

  it('shows an error state when the overview fails to load', async () => {
    mocks.getBots.mockRejectedValue(new Error('后端不可用'))
    renderPage()
    await waitFor(() => { expect(screen.getByText('无法读取 Bot 团队')).toBeTruthy() })
    expect(screen.getByText('后端不可用')).toBeTruthy()
    expect(screen.getByRole('button', { name: /重\s?试/ })).toBeTruthy()
  })

  it('reports a failed create-bot action through message.error', async () => {
    mocks.createBot.mockRejectedValue(new Error('名称冲突'))
    renderPage()
    await waitFor(() => { expect(screen.getByText('bot-a')).toBeTruthy() })
    fireEvent.click(screen.getByRole('button', { name: '新建 bot' }))
    await waitFor(() => { expect(screen.getByLabelText('名称')).toBeTruthy() })
    fireEvent.change(screen.getByLabelText('名称'), { target: { value: 'bot-x' } })
    fireEvent.change(screen.getByLabelText('模块'), { target: { value: 'server' } })
    fireEvent.click(screen.getByRole('button', { name: /创\s?建/ }))
    await waitFor(() => { expect(screen.getByText(/创建 bot 失败/)).toBeTruthy() })
    expect(screen.getByText(/名称冲突/)).toBeTruthy()
  })
})
