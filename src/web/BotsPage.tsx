import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import {
  Alert, App as AntdApp, Button, ConfigProvider, Drawer, Dropdown, Empty, Form, Input, InputNumber, Mentions, Modal, Select, Skeleton, Tabs, Tag,
  theme as antdTheme,
} from 'antd'
import type { ThemeConfig } from 'antd'
import { IconAgentPresetOutlineRegular, IconPlayOutlineRegular, IconPlusOutlineRegular, IconRefreshOutlineRegular, IconShieldOutlineRegular, IconUsersOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import zhCN from 'antd/locale/zh_CN'
import enUS from 'antd/locale/en_US'
import type {
  BotRecord, BotRoomFrame, BotTeamOverview, BotWatchdogReport, CreateBotInput, UpdateBotInput,
} from '../shared/types.ts'
import { api } from './api.ts'
import {
  botHue, complianceTone, globsSummary, knowledgeHealthTone, relativeTime, splitMentions, statusTone,
} from './bots-view.ts'
import { useUiPreferences } from './ui-preferences.tsx'
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

interface RoomEntry extends BotRoomFrame { id: number }

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
  const { t } = useUiPreferences()
  const { message } = AntdApp.useApp()
  const [overview, setOverview] = useState<BotTeamOverview>()
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [activeRoomId, setActiveRoomId] = useState<string>()
  const [roomFrames, setRoomFrames] = useState<BotRoomFrame[]>([])
  const [roomError, setRoomError] = useState('')
  const [initBusy, setInitBusy] = useState(false)
  const [createBotOpen, setCreateBotOpen] = useState(false)
  const [createRoomOpen, setCreateRoomOpen] = useState(false)
  const [editingBot, setEditingBot] = useState<BotRecord>()
  const [expandedBotId, setExpandedBotId] = useState<string>()
  const [reportOpen, setReportOpen] = useState(false)
  const [report, setReport] = useState<BotWatchdogReport>()
  const [watchdogBusy, setWatchdogBusy] = useState(false)
  const [intervalDraft, setIntervalDraft] = useState<number | null>(null)
  const [posting, setPosting] = useState(false)
  const [draft, setDraft] = useState('')
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
  const roomConversationId = activeRoom?.conversationId

  // Default to the first room once the roster arrives.
  useEffect(() => {
    if (activeRoomId === undefined && rooms.length > 0) setActiveRoomId(rooms[0]!.id)
  }, [activeRoomId, rooms])

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
    <div><h1>{t('模块 Bot 团队', 'Module bot team')}</h1>
      <p>{t('按代码模块分工的 bot 名册、共享群聊与知识看门狗。', 'A roster of module-scoped bots, their shared rooms and the knowledge watchdog.')}</p>
    </div>
    <div className={css.actions}>
      {init?.running === true && <>
        <Tag color="processing">{t('初始化进行中', 'Initializing')}</Tag>
        {init.conversationId !== undefined
          && <Button size="small" onClick={() => { onOpenConversation(init.conversationId as string) }}>{t('查看过程', 'View progress')}</Button>}
      </>}
      {init?.error !== undefined && init.error !== '' && <Tag color="error">{init.error}</Tag>}
      <Dropdown menu={{
        items: [
          { key: 'orchestrator', label: t('模型分析切分', 'Model-driven split') },
          { key: 'preset', label: t('固定三模块骨架', 'Preset three-module skeleton') },
        ],
        onClick: ({ key }) => { void initTeam(key as 'orchestrator' | 'preset') },
      }} disabled={init?.running === true}>
        <Button icon={<IconAgentPresetOutlineRegular size={14} />} loading={initBusy} disabled={init?.running === true}>
          {t('初始化团队', 'Initialize team')}
        </Button>
      </Dropdown>
      <Button icon={<IconPlusOutlineRegular size={14} />} onClick={() => { setCreateBotOpen(true) }}>{t('新建 bot', 'New bot')}</Button>
      <Button icon={<IconUsersOutlineRegular size={14} />} onClick={() => { setCreateRoomOpen(true) }}>{t('新建群聊', 'New room')}</Button>
      <Dropdown menu={{
        items: [
          { key: 'check', label: t('仅检查', 'Check only') },
          { key: 'refresh', label: t('检查并刷新 stale', 'Check and refresh stale') },
        ],
        onClick: ({ key }) => { void runWatchdog(key === 'refresh') },
      }}>
        <Button icon={<IconShieldOutlineRegular size={14} />} loading={watchdogBusy}>{t('运行看门狗', 'Run watchdog')}</Button>
      </Dropdown>
      <span className={css.intervalBox}>
        <span className={css.intervalLabel}>{t('看门狗间隔', 'Watchdog interval')}</span>
        <InputNumber size="small" min={0} step={10_000} value={intervalDraft}
          onChange={value => { intervalTouched.current = true; setIntervalDraft(value) }}
          onBlur={() => { void saveInterval() }}
          aria-label={t('看门狗间隔毫秒', 'Watchdog interval in ms')} />
        <span className={css.intervalHint}>{t('毫秒，0=关', 'ms, 0 = off')}</span>
      </span>
      <Button icon={<IconPlayOutlineRegular size={14} />} onClick={() => { void openReport() }}>{t('查看报告', 'View report')}</Button>
      <Button icon={<IconRefreshOutlineRegular size={14} />} onClick={() => { void refresh() }} aria-label={t('刷新', 'Refresh')} />
    </div>
  </header>

  return shell(<>
    {toolbar}
    <div className={css.columns}>
      <section className={css.roster} aria-label={t('Bot 名册', 'Bot roster')}>
        <h2>{t('Bot 名册', 'Bot roster')}</h2>
        {bots.length === 0
          ? <Empty className={css.empty} description={t('还没有 bot。用「初始化团队」或「新建 bot」创建。', 'No bots yet. Initialize the team or create one manually.')} />
          : <div className={css.rosterList}>
            {bots.map(bot => <BotCard key={bot.id} bot={bot} expanded={expandedBotId === bot.id}
              now={Date.now()}
              onToggle={() => { setExpandedBotId(current => current === bot.id ? undefined : bot.id) }}
              onEdit={() => { setEditingBot(bot) }} t={t} />)}
          </div>}
      </section>
      <section className={css.roomPane} aria-label={t('群聊', 'Rooms')}>
        <h2>{t('群聊', 'Rooms')}</h2>
        {rooms.length === 0
          ? <Empty className={css.empty} description={t('还没有群聊。用「新建群聊」把 bot 拉进一个房间。', 'No rooms yet. Create one to bring bots together.')} />
          : <>
            <Tabs activeKey={activeRoomId} onChange={setActiveRoomId} className={css.roomTabs}
              items={rooms.map(room => ({ key: room.id, label: room.name }))} />
            {roomError !== '' && <Alert className={css.notice} type="error" showIcon message={roomError} />}
            <div className={css.stream}>
              {roomEntries.length === 0
                ? <Empty className={css.empty} description={t('还没有消息。@ 一个 bot 开始对话。', 'No messages yet. @ a bot to start.')} />
                : roomEntries.map(entry => <MessageRow key={entry.id} entry={entry} roster={rosterNames} />)}
            </div>
            <div className={css.composer}>
              <Mentions className={css.composerInput} rows={2} value={draft} placeholder={t('@ 一个 bot 或 all，然后回车发送', '@ a bot or all, press Enter to send')}
                onChange={setDraft} onPressEnter={() => { void send() }}
                options={[...bots.map(bot => ({ value: bot.name })), { value: 'all' }]} />
              <Button type="primary" loading={posting} disabled={draft.trim() === ''} onClick={() => { void send() }}>{t('发送', 'Send')}</Button>
            </div>
          </>}
      </section>
    </div>
    <CreateBotModal open={createBotOpen} t={t} onClose={() => { setCreateBotOpen(false) }}
      onCreated={() => { setCreateBotOpen(false); void refresh() }} />
    <CreateRoomModal open={createRoomOpen} bots={bots} t={t} onClose={() => { setCreateRoomOpen(false) }}
      onCreated={() => { setCreateRoomOpen(false); void refresh() }} />
    <EditBotModal bot={editingBot} t={t} onClose={() => { setEditingBot(undefined) }}
      onSaved={() => { setEditingBot(undefined); void refresh() }} />
    <Drawer open={reportOpen} onClose={() => { setReportOpen(false) }} title={t('看门狗报告', 'Watchdog report')}
      rootClassName={css.reportDrawer}>
      {shownReport === undefined
        ? <Empty className={css.empty} description={t('还没有看门狗报告。运行一次看门狗生成。', 'No watchdog report yet. Run the watchdog once.')} />
        : <div className={css.report}>
          <div className={css.reportMeta}>{relativeTime(shownReport.runAt)} · {t('检查了', 'Checked')} {shownReport.entries.length} {t('个 bot', 'bots')}</div>
          {shownReport.entries.map(entry => <div key={entry.botId} className={css.reportRow}>
            <div className={css.reportHead}>
              <strong>{entry.botName}</strong>
              <Tag color={knowledgeHealthTone(entry.health).color}>{knowledgeHealthTone(entry.health).label}</Tag>
            </div>
            <p className={css.reportDetail}>{entry.detail}</p>
            {entry.suggestion !== undefined && entry.suggestion !== '' && <p className={css.reportSuggestion}>{t('建议', 'Suggestion')}：{entry.suggestion}</p>}
            <code className={css.reportPath}>{entry.knowledgePath}</code>
          </div>)}
        </div>}
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

function BotCard({ bot, expanded, now, onToggle, onEdit, t }: {
  bot: BotRecord
  expanded: boolean
  now: number
  onToggle: () => void
  onEdit: () => void
  t: (zh: string, en: string) => string
}) {
  const status = statusTone(bot.status)
  const health = knowledgeHealthTone(bot.knowledgeHealth)
  const compliance = complianceTone(bot.compliance)
  return <article className={css.botCard} data-expanded={expanded || undefined}>
    <button type="button" className={css.botHead} aria-expanded={expanded} onClick={onToggle}>
      <span className={css.statusDot} data-tone={bot.status} title={status.label} />
      <span className={css.botName}>{bot.name}</span>
      <Tag>{bot.module}</Tag>
      <span className={css.spacer} />
      <span className={css.healthChip} data-health={bot.knowledgeHealth} style={bot.knowledgeHealth === 'unknown' ? { background: HEALTH_CARD_TONE.unknown } : undefined}>
        {health.label}
      </span>
      <span className={css.complianceChip}>{compliance.label}</span>
    </button>
    <div className={css.botMeta}>
      <span className={css.botGlobs}>{globsSummary(bot.globs)}</span>
      <span className={css.spacer} />
      <span className={css.time}>{bot.lastActiveAt === undefined ? t('从未活动', 'Never active') : relativeTime(bot.lastActiveAt, now)}</span>
    </div>
    {expanded && <div className={css.botDetail}>
      <p className={css.botDescription}>{bot.description === '' ? '—' : bot.description}</p>
      <dl className={css.botFacts}>
        <div><dt>{t('知识路径', 'Knowledge doc')}</dt><dd><code>{bot.knowledgePath}</code></dd></div>
        <div><dt>{t('Glob 模式', 'Globs')}</dt><dd><code>{bot.globs.join(', ') || '—'}</code></dd></div>
        {bot.model !== undefined && <div><dt>{t('模型', 'Model')}</dt><dd>{bot.model}</dd></div>}
      </dl>
      <Button size="small" onClick={onEdit}>{t('编辑', 'Edit')}</Button>
    </div>}
  </article>
}

function MessageRow({ entry, roster }: {
  entry: RoomEntry
  roster: ReadonlySet<string>
}) {
  const hue = entry.sender.kind === 'bot' ? botHue(entry.sender.name ?? '') : 0
  if (entry.sender.kind === 'system') {
    return <div className={css.systemRow}><span className={css.systemText} data-system>{entry.text}</span></div>
  }
  const mine = entry.sender.kind === 'user'
  return <div className={`${css.msgRow} ${mine ? css.msgUser : css.msgBot}`} data-side={mine ? 'user' : 'bot'}>
    {!mine && <span className={css.nameChip} data-name-chip style={{ backgroundColor: `hsl(${hue} 55% 42%)` }}>{entry.sender.name}</span>}
    <span className={css.msgBody}>{splitMentions(entry.text, roster).map((segment, index) => segment.kind === 'mention'
      ? <span key={index} className={css.mentionChip} data-mention>@{segment.value}</span>
      : <span key={index}>{segment.value}</span>)}</span>
  </div>
}

function CreateBotModal({ open, onClose, onCreated, t }: {
  open: boolean
  onClose: () => void
  onCreated: () => void
  t: (zh: string, en: string) => string
}) {
  const { message } = AntdApp.useApp()
  const [form] = Form.useForm()
  const [busy, setBusy] = useState(false)
  const submit = async (): Promise<void> => {
    const values = await form.validateFields()
    const input: CreateBotInput = {
      name: values.name,
      module: values.module,
      globs: String(values.globs ?? '').split(',').map(item => item.trim()).filter(item => item !== ''),
      description: values.description ?? '',
      ...(values.model === undefined || values.model === '' ? {} : { model: values.model }),
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
    title={t('新建 bot', 'New bot')} okText={t('创建', 'Create')} cancelText={t('取消', 'Cancel')}>
    <Form form={form} layout="vertical">
      <Form.Item name="name" label={t('名称', 'Name')} rules={[{ required: true }]}><Input /></Form.Item>
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
  return <Modal open={bot !== undefined} onCancel={onClose} onOk={() => { void submit() }} okButtonProps={{ loading: busy }}
    title={`${t('编辑', 'Edit')} ${bot?.name ?? ''}`} okText={t('保存', 'Save')} cancelText={t('取消', 'Cancel')}>
    <Form form={form} layout="vertical">
      <Form.Item name="module" label={t('模块', 'Module')} rules={[{ required: true }]}><Input /></Form.Item>
      <Form.Item name="globs" label={t('Glob 模式（逗号分隔）', 'Globs (comma separated)')}><Input /></Form.Item>
      <Form.Item name="description" label={t('描述', 'Description')}><Input.TextArea rows={3} /></Form.Item>
      <Form.Item name="model" label={t('模型', 'Model')}><Input /></Form.Item>
    </Form>
  </Modal>
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
