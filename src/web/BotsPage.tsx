import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import {
  Alert, App as AntdApp, Button, ConfigProvider, Drawer, Dropdown, Empty, Form, Input, InputNumber, Mentions, Modal, Select, Skeleton, Tag, Tooltip,
  theme as antdTheme,
} from 'antd'
import type { ThemeConfig } from 'antd'
import type { FormInstance } from 'antd'
import {
  IconAgentPresetOutlineRegular, IconClockOutlineRegular, IconCloseOutlineRegular, IconEditOutlineRegular,
  IconPinFillRegular, IconPinOutlineRegular, IconPlayOutlineRegular, IconPlusOutlineRegular, IconRefreshOutlineRegular,
  IconSendOutlineRegular, IconSettingsOutlineRegular, IconShieldOutlineRegular, IconSparkleRegular, IconUsersOutlineRegular,
} from '@deepseek-ai/dsh-client-ui-primitives'
import zhCN from 'antd/locale/zh_CN'
import enUS from 'antd/locale/en_US'
import type {
  BotRecord, BotRoomFrame, BotTeamOverview, BotWatchdogReport, ChatMessage, ConversationDetail, CreateBotInput, UpdateBotInput,
} from '../shared/types.ts'
import { api } from './api.ts'
import { complianceTone, knowledgeHealthTone, relativeTime, splitMentions, statusTone } from './bots-view.ts'
import { BotAvatar, BotAvatarStack, resolveBotAvatar } from './BotAvatar.tsx'
import type { BotAvatarState } from './BotAvatar.tsx'
import { BotAvatarEditorModal } from './BotAvatarEditor.tsx'
import { AnswerMarkdown } from './AnswerMarkdown.tsx'
import { markdownLabels } from './render-labels.ts'
import { BOT_AVATAR_COLORS, BOT_COLOR_POOL, BOT_SHAPE_POOL } from './bot-avatar/shapes.ts'
import { useUiPreferences } from './ui-preferences.tsx'
import { suggestBotName } from '../shared/bot-names.ts'
import css from './BotsPage.module.css'

/** Overview and room-log poll cadence; room frames are passive entries with no SSE. */
const POLL_MS = 2_000

function messageOf(cause: unknown): string {
  return cause instanceof Error && cause.message !== '' ? cause.message : String(cause)
}

function themeConfig(dark: boolean): ThemeConfig {
  return {
    algorithm: dark ? antdTheme.darkAlgorithm : antdTheme.defaultAlgorithm,
    token: {
      colorPrimary: dark ? 'rgb(122, 170, 255)' : 'rgb(65, 118, 230)',
      colorBgContainer: dark ? 'rgb(35, 35, 36)' : '#ffffff',
      colorBgElevated: dark ? 'rgb(27, 27, 28)' : '#ffffff',
      colorBorderSecondary: dark ? 'rgba(255, 255, 255, 0.12)' : 'rgba(0, 0, 0, 0.1)',
      colorText: dark ? 'rgb(249, 250, 251)' : 'rgb(15, 17, 21)',
      colorTextSecondary: dark ? 'rgb(173, 178, 184)' : 'rgb(97, 102, 107)',
      borderRadius: 10,
      fontFamily: 'inherit',
      fontSize: 13,
    },
  }
}

/** #rrggbb → rgba() so a bot's own hue can tint surfaces at a controlled alpha. */
function rgba(hex: string, alpha: number): string {
  const value = hex.replace('#', '')
  const r = Number.parseInt(value.slice(0, 2), 16)
  const g = Number.parseInt(value.slice(2, 4), 16)
  const b = Number.parseInt(value.slice(4, 6), 16)
  return `rgba(${r}, ${g}, ${b}, ${alpha})`
}

/** The two gradient stops of a bot's avatar palette, theme-resolved. */
function identityPalette(id: string, shape: string | undefined, color: string | undefined, dark: boolean): { from: string; to: string } {
  const resolved = resolveBotAvatar(id, shape, color)
  const palette = BOT_AVATAR_COLORS[resolved.color]
  return { from: dark ? palette.darkFrom : palette.lightFrom, to: dark ? palette.darkTo : palette.lightTo }
}

/** A readable identity accent for text: the darker stop on light, the lighter on dark. */
function identityText(id: string, shape: string | undefined, color: string | undefined, dark: boolean): string {
  const { from, to } = identityPalette(id, shape, color, dark)
  return dark ? from : to
}

/** CSS variables that tint the lead card / detail hero with the bot's own character hue. */
function tintVars(id: string, shape: string | undefined, color: string | undefined, dark: boolean): CSSProperties {
  const { from, to } = identityPalette(id, shape, color, dark)
  return {
    '--lead-bg': `linear-gradient(165deg, ${rgba(from, dark ? 0.2 : 0.14)}, ${rgba(to, dark ? 0.08 : 0.04)})`,
    '--lead-border': rgba(to, dark ? 0.34 : 0.26),
    '--lead-glow': rgba(from, dark ? 0.3 : 0.24),
    '--lead-ring': rgba(to, 0.5),
    '--lead-chip': rgba(to, dark ? 0.22 : 0.14),
    '--lead-chip-text': dark ? from : to,
  } as CSSProperties
}

interface RoomEntry extends Omit<BotRoomFrame, 'id'> { id: number | string }

/** Module-bot team console: roster, shared rooms and the knowledge watchdog. */
export default function BotsPage({ onOpenConversation }: {
  onOpenConversation: (id: string) => void
}) {
  const { t, settings, dark } = useUiPreferences()
  return <main className={css.page} aria-label={t('模块 Bot 团队', 'Module bot team')}>
    <ConfigProvider locale={settings.locale === 'en' ? enUS : zhCN} theme={themeConfig(dark)}>
      <AntdApp>
        <BotsInner onOpenConversation={onOpenConversation} />
      </AntdApp>
    </ConfigProvider>
  </main>
}

function BotsInner({ onOpenConversation }: {
  onOpenConversation: (id: string) => void
}) {
  const { t, dark } = useUiPreferences()
  const { message } = AntdApp.useApp()
  const [overview, setOverview] = useState<BotTeamOverview>()
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [activeRoomId, setActiveRoomId] = useState<string>()
  const [activeBotId, setActiveBotId] = useState<string>()
  const [roomFrames, setRoomFrames] = useState<BotRoomFrame[]>([])
  const [roomError, setRoomError] = useState('')
  const [initBusy, setInitBusy] = useState(false)
  const [createBotOpen, setCreateBotOpen] = useState(false)
  const [createRoomOpen, setCreateRoomOpen] = useState(false)
  const [editingBot, setEditingBot] = useState<BotRecord>()
  const [detailBotId, setDetailBotId] = useState<string>()
  const [reportOpen, setReportOpen] = useState(false)
  const [report, setReport] = useState<BotWatchdogReport>()
  const [watchdogBusy, setWatchdogBusy] = useState(false)
  const [intervalDraft, setIntervalDraft] = useState<number | null>(null)
  const [posting, setPosting] = useState(false)
  const [draft, setDraft] = useState('')
  const [unread, setUnread] = useState(0)
  const streamRef = useRef<HTMLDivElement | null>(null)
  const lastFrameCount = useRef(0)
  const roomStick = useRef(true)
  const intervalTouched = useRef(false)

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const value = await api.getBots()
      setOverview(value)
      setError('')
    } catch (cause) {
      // Later poll failures stay silent while the last snapshot is still on screen.
      setOverview(current => {
        if (current === undefined) setError(messageOf(cause))
        return current
      })
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void refresh() }, [refresh])
  useEffect(() => {
    const timer = setInterval(() => { void refresh() }, POLL_MS)
    return () => { clearInterval(timer) }
  }, [refresh])

  const bots = overview?.bots ?? []
  const rooms = overview?.rooms ?? []
  const activeRoom = rooms.find(room => room.id === activeRoomId)
  const activeBot = bots.find(bot => bot.id === activeBotId)
  const roomConversationId = activeRoom?.conversationId

  // Default to the first room once the roster arrives, unless a bot is already selected.
  useEffect(() => {
    if (activeRoomId === undefined && activeBotId === undefined && rooms.length > 0) setActiveRoomId(rooms[0]!.id)
  }, [activeRoomId, activeBotId, rooms])

  // Selecting a bot switches the center pane to its direct conversation; selecting a room
  // switches back to the group chat. The two are mutually exclusive center views.
  const selectBot = (id: string): void => {
    setActiveBotId(id)
    setActiveRoomId(undefined)
    setDetailBotId(id)
  }
  const selectRoom = (id: string): void => {
    setActiveRoomId(id)
    setActiveBotId(undefined)
    setDetailBotId(undefined)
  }

  // Room frames are passive entries, so they never ride the conversation snapshot
  // stream; poll the dedicated read seam instead.
  useEffect(() => {
    if (activeRoomId === undefined) {
      setRoomFrames([])
      setRoomError('')
      return
    }
    let active = true
    setRoomError('')
    roomStick.current = true
    lastFrameCount.current = 0
    setUnread(0)
    const load = (): void => {
      api.getBotRoomLog(activeRoomId).then(value => {
        if (!active) return
        setRoomFrames(value)
        setRoomError('')
      }).catch(cause => {
        if (!active) return
        setRoomError(messageOf(cause))
      })
    }
    load()
    const timer = setInterval(load, POLL_MS)
    return () => {
      active = false
      clearInterval(timer)
    }
  }, [activeRoomId])

  const rosterNames = useMemo(() => new Set(bots.map(bot => bot.name)), [bots])
  // The freshest report wins: the one fetched on demand, else the one carried by the overview.
  const shownReport = useMemo(() => {
    const fromOverview = overview?.watchdog.report
    if (report === undefined) return fromOverview
    if (fromOverview === undefined) return report
    return Date.parse(report.runAt) >= Date.parse(fromOverview.runAt) ? report : fromOverview
  }, [overview?.watchdog.report, report])
  const roomEntries = useMemo(() => roomFrames
    .map((frame, index) => ({ id: index, ...frame })), [roomFrames])
  // New frames only count as unread while the reader is away from the bottom of the stream.
  useEffect(() => {
    const count = roomFrames.length
    const previous = lastFrameCount.current
    lastFrameCount.current = count
    if (count <= previous) return
    const node = streamRef.current
    const atBottom = node === null || node.scrollHeight - node.scrollTop - node.clientHeight < 48
    if (!atBottom) setUnread(value => value + count - previous)
  }, [roomFrames])

  // Open the room at the latest frame and follow new ones while pinned; scrolling up releases it.
  useLayoutEffect(() => {
    const node = streamRef.current
    if (node !== null && roomStick.current) node.scrollTop = node.scrollHeight
  }, [roomEntries])

  // Room Markdown renders asynchronously; keep pinned to the bottom while the content settles.
  useEffect(() => {
    const node = streamRef.current
    if (node === null) return
    const observer = new MutationObserver(() => {
      if (roomStick.current) node.scrollTop = node.scrollHeight
    })
    observer.observe(node, { childList: true, subtree: true, characterData: true })
    return () => observer.disconnect()
  }, [activeRoomId])
  // Grok Bot groups its roster by team; the module is the natural group key here.
  const groups = useMemo(() => {
    const byModule = new Map<string, BotRecord[]>()
    for (const bot of bots) {
      const key = bot.module.trim() === '' ? t('未分组', 'Ungrouped') : bot.module
      const members = byModule.get(key)
      if (members === undefined) byModule.set(key, [bot])
      else members.push(bot)
    }
    return [...byModule.entries()]
  }, [bots, t])

  useEffect(() => {
    if (intervalTouched.current || overview?.config === undefined) return
    setIntervalDraft(overview.config.watchdogIntervalMs)
  }, [overview?.config])

  const initTeam = async (mode: 'orchestrator' | 'preset'): Promise<void> => {
    setInitBusy(true)
    try {
      await api.initBots({ mode })
      await refresh()
    } catch (cause) { message.error(t('初始化团队失败', 'Could not initialize the team') + `：${messageOf(cause)}`) }
    finally { setInitBusy(false) }
  }

  const runWatchdog = async (refreshStale: boolean): Promise<void> => {
    setWatchdogBusy(true)
    try {
      const value = await api.runBotWatchdog({ refreshStale })
      setReport(value.report)
      await refresh()
      setReportOpen(true)
    } catch (cause) { message.error(t('看门狗运行失败', 'Watchdog run failed') + `：${messageOf(cause)}`) }
    finally { setWatchdogBusy(false) }
  }

  const saveInterval = async (): Promise<void> => {
    if (intervalDraft === null) return
    try {
      await api.updateBotsConfig({ watchdogIntervalMs: intervalDraft })
      message.success(t('看门狗设置已保存', 'Watchdog settings saved'))
      await refresh()
    } catch (cause) { message.error(t('看门狗设置保存失败', 'Could not save watchdog settings') + `：${messageOf(cause)}`) }
  }

  const openReport = async (): Promise<void> => {
    setReportOpen(true)
    try {
      const value = await api.getBotWatchdogReport()
      if (value.report !== undefined) setReport(value.report)
    } catch { /* the drawer still shows the snapshot carried by the overview */ }
  }

  const setLead = async (bot: BotRecord, lead: boolean): Promise<void> => {
    try {
      await api.updateBot(bot.id, { lead })
      await refresh()
    } catch (cause) { message.error(t('设置主 bot 失败', 'Could not change the lead bot') + `：${messageOf(cause)}`) }
  }

  const send = async (): Promise<void> => {
    const room = activeRoom
    const text = draft.trim()
    if (room === undefined || text === '') return
    setPosting(true)
    try {
      await api.postBotRoomMessage(room.id, { text })
      setDraft('')
    } catch (cause) { message.error(t('消息发送失败', 'Could not send the message') + `：${messageOf(cause)}`) }
    finally { setPosting(false) }
  }

  // The composer's "+" drops an @ so the mention picker opens; it is a real shortcut, not decoration.
  const insertMention = (): void => {
    setDraft(current => `${current}${current === '' || current.endsWith(' ') || current.endsWith('\n') ? '' : ' '}@`)
  }

  const init = overview?.init
  const shell = (body: ReactNode): ReactNode => <div className={css.shell}>{body}</div>

  if (loading && overview === undefined) return shell(<Skeleton active className={css.empty} paragraph={{ rows: 8 }} />)

  if (error !== '' && overview === undefined) {
    return shell(<Alert type="error" showIcon className={css.notice}
      message={t('无法读取 Bot 团队', 'Could not load the bot team')}
      description={error}
      action={<Button size="small" onClick={() => { void refresh() }}>{t('重试', 'Retry')}</Button>} />)
  }

  const toolbar = <header className={css.toolbar}>
    <div className={css.titleBlock}>
      <div className={css.titleRow}>
        <h1>{t('模块 Bot 团队', 'Module bot team')}</h1>
        {bots.length > 0 && <span className={css.countBadge}>{bots.length}</span>}
      </div>
      <p>{t('按代码模块分工的 bot 名册、共享群聊与知识看门狗。', 'A roster of module-scoped bots, their shared rooms and the knowledge watchdog.')}</p>
    </div>
    <div className={css.actions}>
      {init?.running === true && <>
        <Tag color="processing">{t('初始化进行中', 'Initializing')}</Tag>
        {init.conversationId !== undefined
          && <Button size="small" onClick={() => { onOpenConversation(init.conversationId as string) }}>{t('查看过程', 'View progress')}</Button>}
      </>}
      {init?.error !== undefined && init.error !== '' && <Tag color="error">{init.error}</Tag>}
      <Button type="primary" icon={<IconPlusOutlineRegular size={14} />} onClick={() => { setCreateBotOpen(true) }}>{t('新建 Bot', 'New bot')}</Button>
      <Button icon={<IconUsersOutlineRegular size={14} />} onClick={() => { setCreateRoomOpen(true) }}>{t('新建群聊', 'New room')}</Button>
      <span className={css.actionDivider} />
      <Dropdown menu={{
        items: [
          { key: 'orchestrator', label: t('模型分析切分', 'Model-driven split') },
          { key: 'preset', label: t('固定三模块骨架', 'Preset three-module skeleton') },
        ],
        onClick: ({ key }) => { void initTeam(key as 'orchestrator' | 'preset') },
      }} disabled={init?.running === true}>
        <Tooltip title={t('初始化团队', 'Initialize team')}>
          <Button aria-label={t('初始化团队', 'Initialize team')} icon={<IconAgentPresetOutlineRegular size={15} />} loading={initBusy} disabled={init?.running === true} />
        </Tooltip>
      </Dropdown>
      <Dropdown menu={{
        items: [
          { key: 'check', label: t('仅检查', 'Check only') },
          { key: 'refresh', label: t('检查并刷新 stale', 'Check and refresh stale') },
        ],
        onClick: ({ key }) => { void runWatchdog(key === 'refresh') },
      }}>
        <Tooltip title={t('运行看门狗', 'Run watchdog')}>
          <Button aria-label={t('运行看门狗', 'Run watchdog')} icon={<IconShieldOutlineRegular size={15} />} loading={watchdogBusy} />
        </Tooltip>
      </Dropdown>
      <Tooltip title={t('查看报告', 'View report')}>
        <Button aria-label={t('查看报告', 'View report')} icon={<IconPlayOutlineRegular size={15} />} onClick={() => { void openReport() }} />
      </Tooltip>
      <Tooltip title={t('刷新', 'Refresh')}>
        <Button aria-label={t('刷新', 'Refresh')} icon={<IconRefreshOutlineRegular size={15} />} onClick={() => { void refresh() }} />
      </Tooltip>
    </div>
  </header>

  const detailBot = bots.find(bot => bot.id === detailBotId)
  const leadBot = bots.find(bot => bot.lead === true)
  const roomMembers = activeRoom === undefined ? [] : bots.filter(bot => activeRoom.memberIds.includes(bot.id))

  return shell(<>
    {toolbar}
    <div className={css.board} data-detail={detailBot !== undefined || undefined}>
      <aside className={css.roster} aria-label={t('Bot 与群聊', 'Bots and rooms')}>
        <div className={css.rosterHead}>
          <span className={css.rosterTitle}>{t('名册', 'Roster')}</span>
          <span className={css.rosterCount}>{bots.length}</span>
          <span className={css.spacer} />
          <button type="button" className={css.iconButton} onClick={() => { setCreateBotOpen(true) }}
            aria-label={t('新建 Bot', 'New bot')}><IconPlusOutlineRegular size={13} /></button>
        </div>
        <div className={css.rosterScroll}>
          {leadBot !== undefined && <button type="button" className={css.leadCard}
            style={tintVars(leadBot.id, leadBot.avatarShape, leadBot.avatarColor, dark)}
            data-active={activeBotId === leadBot.id || undefined}
            onClick={() => { selectBot(leadBot.id) }}>
            <span className={css.leadAvatarWrap}>
              <BotAvatar id={leadBot.id} name={leadBot.name} shape={leadBot.avatarShape} color={leadBot.avatarColor}
                image={leadBot.avatarImage} size="xl" state={avatarStateOf(leadBot)} follow />
              <span className={css.leadBadge} aria-hidden><IconPinFillRegular size={12} /></span>
            </span>
            <span className={css.leadName}>{leadBot.name}</span>
            <span className={css.leadModule}>{leadBot.module}</span>
          </button>}
          {bots.length === 0
            ? <p className={css.sideEmpty}>{t('还没有 Bot。用「初始化团队」或「新建 Bot」创建。', 'No bots yet. Initialize the team or create one.')}</p>
            : groups.map(([group, members]) => {
              const listed = leadBot === undefined ? members : members.filter(bot => bot.id !== leadBot.id)
              if (listed.length === 0) return null
              return <div key={group} className={css.group}>
                <div className={css.groupHead}><span>{group}</span><span className={css.groupCount}>{listed.length}</span></div>
                {listed.map(bot => <button key={bot.id} type="button" className={css.botRow}
                  data-active={activeBotId === bot.id || undefined}
                  onClick={() => { selectBot(bot.id) }}>
                  <BotAvatar id={bot.id} name={bot.name} shape={bot.avatarShape} color={bot.avatarColor} image={bot.avatarImage}
                    size="lg" state={avatarStateOf(bot)} follow />
                  <span className={css.rowBody}>
                    <span className={css.rowTitle}><b>{bot.name}</b></span>
                    <span className={css.rowPreview}>{bot.description === '' ? t('暂无描述', 'No description') : bot.description}</span>
                  </span>
                  <span className={css.rowMeta}>
                    <span className={css.statusDot} data-tone={bot.status} title={statusTone(bot.status).label} />
                  </span>
                </button>)}
              </div>
            })}
          <div className={css.group}>
            <div className={css.groupHead}>
              <span>{t('群聊', 'Rooms')}</span>
              <span className={css.groupCount}>{rooms.length}</span>
              <span className={css.spacer} />
              <button type="button" className={css.iconButton} onClick={() => { setCreateRoomOpen(true) }}
                aria-label={t('新建群聊', 'New room')}><IconPlusOutlineRegular size={12} /></button>
            </div>
            {rooms.length === 0
              ? <p className={css.sideEmpty}>{t('还没有群聊。', 'No rooms yet.')}</p>
              : rooms.map(room => <button key={room.id} type="button" className={css.roomRow}
                data-active={activeRoomId === room.id || undefined}
                onClick={() => { selectRoom(room.id) }}>
                <BotAvatarStack size="md" members={bots.filter(bot => room.memberIds.includes(bot.id))} />
                <span className={css.rowBody}>
                  <span className={css.rowTitle}><b>{room.name}</b></span>
                  <span className={css.rowPreview}>
                    {room.memberIds.map(id => bots.find(bot => bot.id === id)?.name ?? id).join(' · ')}
                  </span>
                </span>
                <span className={css.roomCount}>{room.memberIds.length}</span>
              </button>)}
          </div>
        </div>
      </aside>
      <section className={css.chat} aria-label={activeBot !== undefined ? activeBot.name : t('群聊', 'Rooms')}>
        {activeBot !== undefined
          ? <BotChat bot={activeBot} dark={dark} t={t} onOpenConversation={onOpenConversation} />
          : activeRoom === undefined
          ? <div className={css.roomEmpty}>
            <div className={css.emptyAvatars}><BotAvatar id="room-empty" name="team" size="xl" state="idle" follow /></div>
            <h2 className={css.emptyTitle}>{t('把 bot 拉进一个房间', 'Bring bots into a room')}</h2>
            <p className={css.emptyText}>{t('群聊让多个 bot 围绕同一话题协作。新建一个房间，@ 它们开始。', 'Rooms let bots collaborate on one topic. Create a room and @ them to start.')}</p>
            <Button type="primary" icon={<IconUsersOutlineRegular size={14} />} onClick={() => { setCreateRoomOpen(true) }}>{t('新建群聊', 'New room')}</Button>
          </div>
          : <>
            <div className={css.chatChrome}>
              <BotAvatarStack size="md" members={roomMembers} />
              <div className={css.chatTitle}>
                <span className={css.chatName}>{activeRoom.name}</span>
                <span className={css.chatSub}>{roomMembers.length} {t('位成员', 'members')}{roomMembers.length > 0 ? ` · ${roomMembers.map(bot => bot.name).join(' · ')}` : ''}</span>
              </div>
            </div>
            {roomError !== '' && <Alert className={css.notice} type="error" showIcon message={roomError} />}
            <div className={css.stream} ref={streamRef}
              onScroll={() => {
                const node = streamRef.current
                if (node !== null) {
                  const atBottom = node.scrollHeight - node.scrollTop - node.clientHeight < 48
                  roomStick.current = atBottom
                  if (atBottom) setUnread(0)
                }
              }}>
              {roomEntries.length === 0
                ? <div className={css.roomEmpty}>
                  <div className={css.emptyAvatars}>
                    {(roomMembers.length > 0 ? roomMembers : bots).slice(0, 5).map(bot => <BotAvatar key={bot.id} id={bot.id} name={bot.name}
                      shape={bot.avatarShape} color={bot.avatarColor} image={bot.avatarImage} size="xl" state={avatarStateOf(bot)} follow />)}
                  </div>
                  <h2 className={css.emptyTitle}>{t('和团队打个招呼', 'Say hello to the team')}</h2>
                  <p className={css.emptyText}>{t('@ 一个 bot 开始对话，或试试下面的开场白。', '@ a bot to start, or try an opener below.')}</p>
                  <div className={css.emptySuggestions}>
                    {(roomMembers.length > 0 ? [
                      `@${roomMembers[0]!.name} ${t('介绍一下你负责的模块', 'introduce the module you own')}`,
                      t('大家各自说说当前进度', 'Everyone share your current progress'),
                      `@${roomMembers[0]!.name} ${t('最近有什么需要注意的？', 'anything to watch out for lately?')}`,
                    ] : []).map(opener => <button key={opener} type="button" className={css.suggestionChip} onClick={() => { setDraft(opener) }}>
                      <IconSparkleRegular size={13} />{opener}
                    </button>)}
                  </div>
                </div>
                : roomEntries.map(entry => <MessageRow key={entry.id} entry={entry} roster={rosterNames} bots={bots} dark={dark} t={t} />)}
            </div>
            {unread > 0 && <button type="button" className={css.newMessages} onClick={() => {
              const node = streamRef.current
              if (node !== null) node.scrollTo({ top: node.scrollHeight, behavior: 'smooth' })
              setUnread(0)
            }}>
              {unread} {t('条新消息', 'new messages')} ↓
            </button>}
            <div className={css.composerBar}>
              <div className={css.composer}>
                <button type="button" className={css.mentionButton} aria-label={t('插入提及', 'Insert mention')}
                  onClick={insertMention}><IconPlusOutlineRegular size={16} /></button>
                <Mentions className={css.composerInput} rows={1} value={draft}
                  placeholder={t(`给 ${activeRoom.name} 发消息`, `Message ${activeRoom.name}`)}
                  onChange={setDraft}
                  onPressEnter={event => {
                    // rc-mentions already skips this while the @ menu is open (`mergedMeasuring`).
                    if (event.shiftKey) return
                    event.preventDefault()
                    void send()
                  }}
                  options={[...roomMembers.map(bot => ({ value: bot.name, label: bot.name })), { value: 'all', label: t('全员', 'everyone') }]} />
              </div>
              <Button type="primary" className={css.sendButton} loading={posting}
                disabled={draft.trim() === ''} onClick={() => { void send() }}
                icon={<IconSendOutlineRegular size={16} />} aria-label={t('发送', 'Send')} />
            </div>
          </>}
      </section>
      {detailBot !== undefined && <aside className={css.detailPane} aria-label={t('Bot 详情', 'Bot details')}>
        <div className={css.detailTop}>
          <span className={css.spacer} />
          <button type="button" className={css.iconButton} onClick={() => { setDetailBotId(undefined) }}
            aria-label={t('关闭', 'Close')}><IconCloseOutlineRegular size={14} /></button>
        </div>
        <BotDetail bot={detailBot} dark={dark} onEdit={() => { setEditingBot(detailBot) }}
          onSetLead={lead => { void setLead(detailBot, lead) }} t={t} />
      </aside>}
    </div>
    <CreateBotModal open={createBotOpen} bots={bots} t={t} onClose={() => { setCreateBotOpen(false) }}
      onCreated={() => { setCreateBotOpen(false); void refresh() }} />
    <CreateRoomModal open={createRoomOpen} bots={bots} t={t} onClose={() => { setCreateRoomOpen(false) }}
      onCreated={() => { setCreateRoomOpen(false); void refresh() }} />
    <EditBotModal bot={editingBot} t={t} onClose={() => { setEditingBot(undefined) }}
      onSaved={() => { setEditingBot(undefined); void refresh() }} />
    <Drawer open={reportOpen} onClose={() => { setReportOpen(false) }} title={t('看门狗报告', 'Watchdog report')}
      rootClassName={css.reportDrawer}>
      <div className={css.report}>
        <div className={css.reportSettings}>
          <span className={css.reportSettingsLabel}><IconSettingsOutlineRegular size={14} />{t('看门狗间隔', 'Watchdog interval')}</span>
          <InputNumber size="small" min={0} step={10_000} value={intervalDraft}
            onChange={value => { intervalTouched.current = true; setIntervalDraft(value) }}
            onBlur={() => { void saveInterval() }}
            aria-label={t('看门狗间隔毫秒', 'Watchdog interval in ms')} />
          <span className={css.reportSettingsHint}>{t('毫秒，0 = 关闭', 'ms, 0 = off')}</span>
        </div>
        {shownReport === undefined
          ? <Empty className={css.empty} description={t('还没有看门狗报告。运行一次看门狗生成。', 'No watchdog report yet. Run the watchdog once.')} />
          : <>
            <div className={css.reportMeta}><IconClockOutlineRegular size={13} />{relativeTime(shownReport.runAt)} · {t('检查了', 'Checked')} {shownReport.entries.length} {t('个 bot', 'bots')}</div>
            {shownReport.entries.map(entry => <div key={entry.botId} className={css.reportRow}
              style={{ '--report-accent': HEALTH_CARD_TONE[entry.health] } as CSSProperties}>
              <div className={css.reportHead}>
                <strong>{entry.botName}</strong>
                <Tag color={knowledgeHealthTone(entry.health).color}>{knowledgeHealthTone(entry.health).label}</Tag>
              </div>
              <p className={css.reportDetail}>{entry.detail}</p>
              {entry.suggestion !== undefined && entry.suggestion !== '' && <p className={css.reportSuggestion}>{t('建议', 'Suggestion')}：{entry.suggestion}</p>}
              <code className={css.reportPath}>{entry.knowledgePath}</code>
            </div>)}
          </>}
      </div>
    </Drawer>
  </>)
}

const HEALTH_CARD_TONE: Record<BotRecord['knowledgeHealth'], string> = {
  fresh: 'rgb(56, 158, 96)',
  stale: 'rgb(214, 128, 34)',
  drift: 'rgb(212, 80, 76)',
  'over-limit': 'rgb(148, 96, 208)',
  unknown: 'var(--dsw-alias-label-tertiary, #999)',
}

function avatarStateOf(bot: BotRecord): BotAvatarState {
  if (bot.status === 'busy') return 'working'
  if (bot.status === 'error') return 'failed'
  if (bot.compliance === 'stalled') return 'waiting'
  return 'idle'
}

/** The host injects room-mention / direct-relay frames into the bot conversation as model
    context. They are protocol, not chat content, so the direct view shows a quiet marker. */
function internalFrame(text: string): { kind: 'room'; room: string } | { kind: 'direct'; from: string } | null {
  const room = /^\[ROOM:([^\]\s]+)/u.exec(text)
  if (room) return { kind: 'room', room: room[1]! }
  const direct = /^\[DIRECT FROM:([^\]]+)/u.exec(text)
  if (direct) return { kind: 'direct', from: direct[1]!.trim() }
  return null
}

/** An assistant turn that is really a provider failure (e.g. `429: {...}`), not a reply. */
function errorTextOf(message: ChatMessage, text: string): string | null {
  if (message.isError === true || message.status === 'error') return text.trim() === '' ? '模型调用失败' : text
  if (/^\d{3}:\s*\{/u.test(text.trim())) return text
  return null
}

function friendlyError(raw: string, t: (zh: string, en: string) => string): string {
  if (/429|usage\s*limit|quota/iu.test(raw)) return t('模型配额耗尽，请稍后再试', 'Model quota exhausted; try again later')
  const parsed = /"message"\s*:\s*"([^"]+)"/u.exec(raw)
  if (parsed) return parsed[1]!
  return raw.length > 120 ? `${raw.slice(0, 120)}…` : raw
}

type ChatItem =
  | { kind: 'user'; id: string; text: string }
  | { kind: 'error'; id: string; text: string }
  | { kind: 'bot'; id: string; text: string; tools: string[] }
  | { kind: 'activity'; id: string; tools: string[] }

function uniqueTools(names: readonly string[]): string[] {
  return [...new Set(names)]
}

/** Fold the raw transcript into the bot's DIRECT conversation only. Room mentions and bot-to-bot
    relays arrive as internal frames and belong to the room, so their whole segment — the frame and
    every reply it triggered — is excluded here; the direct box never mixes in group traffic. What
    remains is the clean user↔bot exchange: plain bubbles, compact failure chips, and tool activity
    folded into the reply, never raw protocol or tool output. */
function buildChatItems(messages: readonly ChatMessage[], t: (zh: string, en: string) => string): ChatItem[] {
  const items: ChatItem[] = []
  let pending: { id: string; names: string[] } | undefined
  let inRoomSegment = false
  const flushPending = (): void => {
    if (!inRoomSegment && pending !== undefined && pending.names.length > 0) items.push({ kind: 'activity', id: pending.id, tools: uniqueTools(pending.names) })
    pending = undefined
  }
  for (const message of messages) {
    const text = message.blocks.filter(block => block.type === 'text').map(block => block.text).join('\n')
    const tools = message.blocks.filter(block => block.type === 'toolCall').map(block => block.name)
    if (message.role === 'user') {
      flushPending()
      // An internal frame opens a room/relay segment: skip it and every reply until the next
      // genuine user message, so group traffic stays out of the direct conversation.
      if (internalFrame(text) !== null) {
        inRoomSegment = true
        continue
      }
      inRoomSegment = false
      if (text.trim() !== '') items.push({ kind: 'user', id: message.id, text })
      continue
    }
    if (inRoomSegment) continue
    const failure = errorTextOf(message, text)
    if (failure !== null) {
      flushPending()
      items.push({ kind: 'error', id: message.id, text: friendlyError(failure, t) })
      continue
    }
    if (text.trim() !== '') {
      const folded = uniqueTools([...(pending?.names ?? []), ...tools])
      pending = undefined
      items.push({ kind: 'bot', id: message.id, text, tools: folded })
    } else if (tools.length > 0) {
      pending = pending === undefined ? { id: message.id, names: [...tools] } : { id: pending.id, names: [...pending.names, ...tools] }
    }
  }
  flushPending()
  return items
}

/** Direct 1-on-1 chat with one bot: its own conversation, polled like the room log, with a
    composer pinned to the bottom. Selecting a bot in the roster switches the center pane here. */
function BotChat({ bot, dark, t, onOpenConversation }: {
  bot: BotRecord
  dark: boolean
  t: (zh: string, en: string) => string
  onOpenConversation: (id: string) => void
}) {
  const { message } = AntdApp.useApp()
  const conversationId = bot.conversationId
  const [detail, setDetail] = useState<ConversationDetail>()
  const [error, setError] = useState('')
  const [draft, setDraft] = useState('')
  const [sending, setSending] = useState(false)
  const streamRef = useRef<HTMLDivElement | null>(null)
  const stickToBottom = useRef(true)

  useEffect(() => {
    let active = true
    setDetail(undefined)
    setError('')
    setDraft('')
    stickToBottom.current = true
    const load = (): void => {
      api.getConversation(conversationId).then(value => {
        if (!active) return
        setDetail(value)
        setError('')
      }).catch(cause => { if (active) setError(messageOf(cause)) })
    }
    load()
    const timer = setInterval(load, POLL_MS)
    return () => { active = false; clearInterval(timer) }
  }, [conversationId])

  const chatItems = useMemo(
    () => buildChatItems((detail?.messages ?? []).filter(item => item.role === 'user' || item.role === 'assistant'), t),
    [detail?.messages, t],
  )

  // Open at the latest message and follow new ones while the reader stays at the bottom; scrolling
  // up to read releases the stick so history is not yanked away.
  useLayoutEffect(() => {
    const node = streamRef.current
    if (node !== null && stickToBottom.current) node.scrollTop = node.scrollHeight
  }, [chatItems])

  // Markdown renders asynchronously after the items land; keep pinned to the bottom while the
  // content settles so the first view always shows the newest message without manual scrolling.
  useEffect(() => {
    const node = streamRef.current
    if (node === null) return
    const observer = new MutationObserver(() => {
      if (stickToBottom.current) node.scrollTop = node.scrollHeight
    })
    observer.observe(node, { childList: true, subtree: true, characterData: true })
    return () => observer.disconnect()
  }, [conversationId])

  const onStreamScroll = (): void => {
    const node = streamRef.current
    if (node !== null) stickToBottom.current = node.scrollHeight - node.scrollTop - node.clientHeight < 80
  }

  const busy = detail?.conversation.busy === true

  const send = async (): Promise<void> => {
    const text = draft.trim()
    if (text === '' || sending) return
    setSending(true)
    try {
      await api.submit(conversationId, { text, requestId: crypto.randomUUID(), whenBusy: 'followUp' })
      setDraft('')
    } catch (cause) { message.error(t('消息发送失败', 'Could not send the message') + `：${messageOf(cause)}`) }
    finally { setSending(false) }
  }

  const stop = async (): Promise<void> => {
    try { await api.stop(conversationId) } catch (cause) { message.error(messageOf(cause)) }
  }

  return <>
    <div className={css.chatChrome}>
      <BotAvatar id={bot.id} name={bot.name} shape={bot.avatarShape} color={bot.avatarColor} image={bot.avatarImage}
        size="md" state={avatarStateOf(bot)} follow />
      <div className={css.chatTitle}>
        <span className={css.chatName}>{bot.name}</span>
        <span className={css.chatSub}>{bot.module} · {busy ? t('正在工作…', 'Working…') : t('单聊', 'Direct chat')}</span>
      </div>
      <span className={css.spacer} />
      {busy && <Button size="small" onClick={() => { void stop() }}>{t('停止', 'Stop')}</Button>}
      <Button size="small" type="text" onClick={() => { onOpenConversation(conversationId) }}>{t('完整会话', 'Full session')}</Button>
    </div>
    {error !== '' && <Alert className={css.notice} type="error" showIcon message={error} />}
    <div className={css.stream} ref={streamRef} onScroll={onStreamScroll}>
      {chatItems.length === 0
        ? <div className={css.roomEmpty}>
          <div className={css.emptyAvatars}>
            <BotAvatar id={bot.id} name={bot.name} shape={bot.avatarShape} color={bot.avatarColor} image={bot.avatarImage}
              size="xl" state={avatarStateOf(bot)} follow />
          </div>
          <h2 className={css.emptyTitle}>{t(`和 ${bot.name} 单聊`, `Chat with ${bot.name}`)}</h2>
          <p className={css.emptyText}>{t('直接发消息给这个 bot，它会用所负责模块的知识回答。', 'Message this bot directly; it answers from its module knowledge.')}</p>
        </div>
        : chatItems.map(item => <ChatItemView key={item.id} item={item} bot={bot} dark={dark} t={t} />)}
      {busy && <div className={css.msgBot} data-side="bot">
        <BotAvatar id={bot.id} name={bot.name} size="md" state="working" follow
          shape={bot.avatarShape} color={bot.avatarColor} image={bot.avatarImage} />
        <div className={css.msgMain}><div className={css.msgBubble}><span className={css.typingDots}>…</span></div></div>
      </div>}
    </div>
    <div className={css.composerBar}>
      <div className={css.composer}>
        <Input.TextArea className={css.composerInput} autoSize={{ minRows: 1, maxRows: 5 }} value={draft}
          placeholder={t(`给 ${bot.name} 发消息`, `Message ${bot.name}`)}
          onChange={event => { setDraft(event.target.value) }}
          onPressEnter={event => {
            if (event.shiftKey) return
            event.preventDefault()
            void send()
          }} />
      </div>
      <Button type="primary" className={css.sendButton} loading={sending} disabled={draft.trim() === ''}
        onClick={() => { void send() }} icon={<IconSendOutlineRegular size={16} />} aria-label={t('发送', 'Send')} />
    </div>
  </>
}

/** One folded direct-chat item: clean user/bot bubbles, quiet markers for internal frames and
    failures, and compact tool activity — never the raw protocol text the model receives. */
function ChatItemView({ item, bot, dark, t }: {
  item: ChatItem
  bot: BotRecord
  dark: boolean
  t: (zh: string, en: string) => string
}) {
  if (item.kind === 'error') {
    return <div className={css.systemRow}><span className={css.errorChip}>⚠ {item.text}</span></div>
  }
  if (item.kind === 'activity') {
    return <div className={css.activityRow}>
      <span className={css.activityLabel}>🔧 {t('工具活动', 'Tool activity')}</span>
      {item.tools.map(name => <span key={name} className={css.toolChip}>{name}</span>)}
    </div>
  }
  if (item.kind === 'user') {
    return <div className={css.msgUser} data-side="user"><span className={css.userBubble}>{item.text}</span></div>
  }
  return <div className={css.msgBot} data-side="bot">
    <BotAvatar id={bot.id} name={bot.name} size="md" state="idle" follow
      shape={bot.avatarShape} color={bot.avatarColor} image={bot.avatarImage} />
    <div className={css.msgMain}>
      <div className={css.msgName} style={{ color: identityText(bot.id, bot.avatarShape, bot.avatarColor, dark) }}>
        {bot.name}<span className={css.msgModule}> · {bot.module}</span>
      </div>
      {item.tools.length > 0 && <div className={css.toolChips}>
        {item.tools.map(name => <span key={name} className={css.toolChip}>🔧 {name}</span>)}
      </div>}
      <div className={css.msgBubble}>
        <div className={css.msgMarkdown}><AnswerMarkdown text={item.text} labels={markdownLabels(t)} t={t} /></div>
      </div>
    </div>
  </div>
}

/** Detail pane for one bot: identity, health and the knowledge library, as a pinned side panel. */
function BotDetail({ bot, dark, onEdit, onSetLead, t }: {
  bot: BotRecord
  dark: boolean
  onEdit: () => void
  onSetLead: (lead: boolean) => void
  t: (zh: string, en: string) => string
}) {
  const status = statusTone(bot.status)
  const health = knowledgeHealthTone(bot.knowledgeHealth)
  const compliance = complianceTone(bot.compliance)
  const [tab, setTab] = useState<'detail' | 'library'>('detail')
  const [knowledge, setKnowledge] = useState<string>()
  const [knowledgeError, setKnowledgeError] = useState('')
  useEffect(() => {
    if (tab !== 'library') return
    let active = true
    setKnowledge(undefined)
    setKnowledgeError('')
    api.getBotKnowledge(bot.id).then(result => {
      if (active) setKnowledge(result.body ?? '')
    }).catch((cause: unknown) => {
      if (active) setKnowledgeError(cause instanceof Error ? cause.message : String(cause))
    })
    return () => { active = false }
  }, [tab, bot.id])
  return <div className={css.detail}>
    <div className={css.detailHero} style={tintVars(bot.id, bot.avatarShape, bot.avatarColor, dark)}>
      <span className={css.heroAvatar}>
        <BotAvatar id={bot.id} name={bot.name} shape={bot.avatarShape} color={bot.avatarColor} image={bot.avatarImage}
          size="xl" state={avatarStateOf(bot)} follow />
      </span>
      <div className={css.detailNames}>
        <strong>{bot.name}{bot.lead === true && <IconPinFillRegular size={14} className={css.leadStar} />}</strong>
        <span className={css.detailRole}>{bot.module}</span>
        <span className={css.detailTime}>
          <IconClockOutlineRegular size={12} />
          {bot.lastActiveAt === undefined ? t('从未活动', 'Never active') : relativeTime(bot.lastActiveAt)}
        </span>
      </div>
    </div>
    <div className={css.detailTabs} role="tablist">
      <button type="button" role="tab" className={css.detailTab} data-active={tab === 'detail' || undefined}
        onClick={() => { setTab('detail') }}>{t('详情', 'Details')}</button>
      <button type="button" role="tab" className={css.detailTab} data-active={tab === 'library' || undefined}
        onClick={() => { setTab('library') }}>{t('资料库', 'Library')}</button>
    </div>
    {tab === 'detail'
      ? <>
        <div className={css.detailChips}>
          <span className={css.healthChip} data-health={bot.knowledgeHealth}
            style={bot.knowledgeHealth === 'unknown' ? { background: HEALTH_CARD_TONE.unknown } : undefined}>
            {health.label}
          </span>
          <span className={css.complianceChip}>{compliance.label}</span>
          <span className={css.statusChip} data-tone={bot.status}>{status.label}</span>
        </div>
        <p className={css.botDescription}>{bot.description === '' ? '—' : bot.description}</p>
        <dl className={css.botFacts}>
          <div><dt>{t('知识路径', 'Knowledge doc')}</dt><dd><code>{bot.knowledgePath}</code></dd></div>
          <div><dt>{t('Glob 模式', 'Globs')}</dt><dd><code>{bot.globs.join(', ') || '—'}</code></dd></div>
          {bot.model !== undefined && <div><dt>{t('模型', 'Model')}</dt><dd>{bot.model}</dd></div>}
        </dl>
        <div className={css.detailActions}>
          <Button size="small" icon={<IconEditOutlineRegular size={13} />} onClick={onEdit}>{t('编辑', 'Edit')}</Button>
          <Button size="small" type="text" icon={<IconPinOutlineRegular size={13} />} onClick={() => { onSetLead(bot.lead !== true) }}>
            {bot.lead === true ? t('取消主 bot', 'Unpin lead') : t('设为主 bot', 'Make lead')}
          </Button>
        </div>
      </>
      : <div className={css.library}>
        <p className={css.detailTime}>{bot.knowledgePath}</p>
        {knowledgeError !== ''
          ? <Alert type="error" showIcon message={knowledgeError} />
          : knowledge === undefined
            ? <Skeleton active paragraph={{ rows: 6 }} title={false} />
            : knowledge.trim() === ''
              ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t('暂无知识文档', 'No knowledge document yet')} />
              : <div className={css.libraryBody}><AnswerMarkdown text={knowledge} labels={markdownLabels(t)} t={t} /></div>}
      </div>}
  </div>
}

function MessageRow({ entry, roster, bots, dark, t }: {
  entry: RoomEntry
  roster: ReadonlySet<string>
  bots: readonly BotRecord[]
  dark: boolean
  t: (zh: string, en: string) => string
}) {
  if (entry.sender.kind === 'system') {
    return <div className={css.systemRow}><span className={css.systemText} data-system>{entry.text}</span></div>
  }
  if (entry.sender.kind === 'user') {
    // The host delivers a post to exactly the roster names its text mentions, so the receipt
    // line can be rebuilt from the frame instead of persisted separately.
    const delivered = new Set<string>()
    for (const match of entry.text.matchAll(/@([A-Za-z][A-Za-z0-9]*(?:-[A-Za-z0-9]+)*)/gu)) {
      if (roster.has(match[1]!)) delivered.add(match[1]!)
    }
    const recipients = bots.filter(bot => delivered.has(bot.id))
    return <>
      <div className={css.msgUser} data-side="user">
        <span className={css.userBubble}>{splitMentions(entry.text, roster).map((segment, index) => segment.kind === 'mention'
          ? <span key={index} className={css.mentionChip} data-mention>@{segment.value}</span>
          : <span key={index}>{segment.value}</span>)}</span>
      </div>
      {recipients.length > 0 && <div className={css.receipt}>
        <span className={css.receiptLabel}>{t('已发消息给', 'Sent to')}</span>
        {recipients.map(bot => <span key={bot.id} className={css.receiptChip}>
          <BotAvatar id={bot.id} name={bot.name} shape={bot.avatarShape} color={bot.avatarColor} image={bot.avatarImage}
            size="xs" animated={false} />
          {bot.name}
        </span>)}
      </div>}
    </>
  }
  const sender = entry.sender.name ?? ''
  const bot = bots.find(candidate => candidate.id === sender)
  return <div className={css.msgBot} data-side="bot">
    <BotAvatar id={sender} name={sender} size="md" state="idle" follow
      shape={bot?.avatarShape} color={bot?.avatarColor} image={bot?.avatarImage} />
    <div className={css.msgMain}>
      <div className={css.msgName} style={{ color: identityText(sender, bot?.avatarShape, bot?.avatarColor, dark) }}>
        {sender}{bot === undefined ? null : <span className={css.msgModule}> · {bot.module}</span>}
      </div>
      <div className={css.msgBubble}>
        <div className={css.msgMarkdown}>
          <AnswerMarkdown text={entry.text} labels={markdownLabels(t)} t={t} />
        </div>
      </div>
    </div>
  </div>
}

function AvatarFields({ form, t }: {
  form: FormInstance
  t: (zh: string, en: string) => string
}) {
  const shape = Form.useWatch('avatarShape', form) as string | undefined
  const color = Form.useWatch('avatarColor', form) as string | undefined
  return <div className={css.avatarFields}>
    <BotAvatar id="preview" shape={shape} color={color} size="xl" />
    <div className={css.avatarSelects}>
      <Form.Item name="avatarShape" label={t('头像形状', 'Avatar shape')}>
        <Select allowClear placeholder={t('按名字自动分配', 'Auto from name')}
          options={BOT_SHAPE_POOL.map(shapeName => ({ value: shapeName, label: shapeName }))} />
      </Form.Item>
      <Form.Item name="avatarColor" label={t('头像颜色', 'Avatar color')}>
        <Select allowClear placeholder={t('按名字自动分配', 'Auto from name')}
          options={BOT_COLOR_POOL.map(colorName => ({ value: colorName, label: colorName }))} />
      </Form.Item>
    </div>
  </div>
}

function CreateBotModal({ open, bots, onClose, onCreated, t }: {
  open: boolean
  bots: readonly BotRecord[]
  onClose: () => void
  onCreated: () => void
  t: (zh: string, en: string) => string
}) {
  const { message } = AntdApp.useApp()
  const [form] = Form.useForm()
  const [busy, setBusy] = useState(false)
  // Grok Bot opens the dialog with a name already in place; the pool keeps that name short
  // and person-like, and skips names the roster already took.
  useEffect(() => {
    if (!open) return
    form.setFieldsValue({ name: suggestBotName(bots.map(bot => bot.name)) })
  }, [open, bots, form])
  const submit = async (): Promise<void> => {
    const values = await form.validateFields()
    const input: CreateBotInput = {
      name: values.name,
      module: values.module,
      globs: String(values.globs ?? '').split(',').map(item => item.trim()).filter(item => item !== ''),
      description: values.description ?? '',
      ...(values.model === undefined || values.model === '' ? {} : { model: values.model }),
      ...(values.avatarShape === undefined || values.avatarShape === '' ? {} : { avatarShape: values.avatarShape }),
      ...(values.avatarColor === undefined || values.avatarColor === '' ? {} : { avatarColor: values.avatarColor }),
    }
    setBusy(true)
    try {
      await api.createBot(input)
      form.resetFields()
      onCreated()
    } catch (cause) { message.error(t('创建 bot 失败', 'Could not create the bot') + `：${messageOf(cause)}`) }
    finally { setBusy(false) }
  }
  return <Modal open={open} onCancel={onClose} onOk={() => { void submit() }} okButtonProps={{ loading: busy }}
    title={t('新建 Bot', 'New bot')} okText={t('创建', 'Create')} cancelText={t('取消', 'Cancel')}>
    <Form form={form} layout="vertical">
      <Form.Item name="name" label={t('名称', 'Name')} rules={[{ required: true }]}><Input /></Form.Item>
      <AvatarFields form={form} t={t} />
      <Form.Item name="module" label={t('模块', 'Module')} rules={[{ required: true }]}><Input /></Form.Item>
      <Form.Item name="globs" label={t('Glob 模式（逗号分隔）', 'Globs (comma separated)')}><Input /></Form.Item>
      <Form.Item name="description" label={t('描述', 'Description')}><Input.TextArea rows={3} /></Form.Item>
      <Form.Item name="model" label={t('模型（可选）', 'Model (optional)')}><Input /></Form.Item>
    </Form>
  </Modal>
}

function EditBotModal({ bot, onClose, onSaved, t }: {
  bot?: BotRecord
  onClose: () => void
  onSaved: () => void
  t: (zh: string, en: string) => string
}) {
  const { message } = AntdApp.useApp()
  const [form] = Form.useForm()
  const [busy, setBusy] = useState(false)
  const [avatarOpen, setAvatarOpen] = useState(false)
  useEffect(() => {
    if (bot === undefined) return
    form.setFieldsValue({
      module: bot.module, globs: bot.globs.join(', '), description: bot.description, model: bot.model ?? '',
    })
  }, [bot, form])
  const submit = async (): Promise<void> => {
    if (bot === undefined) return
    const values = await form.validateFields()
    const patch: UpdateBotInput = {
      module: values.module,
      globs: String(values.globs ?? '').split(',').map(item => item.trim()).filter(item => item !== ''),
      description: values.description ?? '',
      model: values.model === '' ? undefined : values.model,
    }
    setBusy(true)
    try {
      await api.updateBot(bot.id, patch)
      onSaved()
    } catch (cause) { message.error(t('保存 bot 失败', 'Could not save the bot') + `：${messageOf(cause)}`) }
    finally { setBusy(false) }
  }
  return <>
    <Modal open={bot !== undefined} onCancel={onClose} onOk={() => { void submit() }} okButtonProps={{ loading: busy }}
      title={`${t('编辑', 'Edit')} ${bot?.name ?? ''}`} okText={t('保存', 'Save')} cancelText={t('取消', 'Cancel')}>
      <div className={css.avatarFields}>
        <BotAvatar id={bot?.id ?? 'preview'} name={bot?.name} shape={bot?.avatarShape} color={bot?.avatarColor}
          image={bot?.avatarImage} size="xl" animated={false} />
        <Button size="small" onClick={() => { setAvatarOpen(true) }}>{t('编辑头像', 'Edit avatar')}</Button>
      </div>
      <Form form={form} layout="vertical">
        <Form.Item name="module" label={t('模块', 'Module')} rules={[{ required: true }]}><Input /></Form.Item>
        <Form.Item name="globs" label={t('Glob 模式（逗号分隔）', 'Globs (comma separated)')}><Input /></Form.Item>
        <Form.Item name="description" label={t('描述', 'Description')}><Input.TextArea rows={3} /></Form.Item>
        <Form.Item name="model" label={t('模型', 'Model')}><Input /></Form.Item>
      </Form>
    </Modal>
    <BotAvatarEditorModal bot={bot} open={avatarOpen} onClose={() => { setAvatarOpen(false) }}
      onSaved={() => { setAvatarOpen(false); onSaved() }} />
  </>
}

function CreateRoomModal({ open, bots, onClose, onCreated, t }: {
  open: boolean
  bots: readonly BotRecord[]
  onClose: () => void
  onCreated: () => void
  t: (zh: string, en: string) => string
}) {
  const { message } = AntdApp.useApp()
  const [form] = Form.useForm()
  const [busy, setBusy] = useState(false)
  const submit = async (): Promise<void> => {
    const values = await form.validateFields()
    setBusy(true)
    try {
      await api.createBotRoom({ name: values.name, memberIds: values.memberIds ?? [] })
      form.resetFields()
      onCreated()
    } catch (cause) { message.error(t('创建群聊失败', 'Could not create the room') + `：${messageOf(cause)}`) }
    finally { setBusy(false) }
  }
  return <Modal open={open} onCancel={onClose} onOk={() => { void submit() }} okButtonProps={{ loading: busy }}
    title={t('新建群聊', 'New room')} okText={t('创建', 'Create')} cancelText={t('取消', 'Cancel')}>
    <Form form={form} layout="vertical">
      <Form.Item name="name" label={t('群聊名称', 'Room name')} rules={[{ required: true }]}><Input /></Form.Item>
      <Form.Item name="memberIds" label={t('成员', 'Members')}>
        <Select mode="multiple" placeholder={t('选择参与 bot', 'Pick bots')} options={bots.map(bot => ({ value: bot.id, label: bot.name }))} />
      </Form.Item>
    </Form>
  </Modal>
}
