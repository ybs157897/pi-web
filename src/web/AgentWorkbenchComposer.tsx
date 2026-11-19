import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react'
import { ArrowUp, AtSign, Bot, Diamond, Monitor, User, X } from 'lucide-react'
import type { SkillSummary } from '../shared/skills.ts'
import type { WorkbenchAgent, WorkbenchSubmitInput } from '../shared/workbench.ts'
import { api, ApiFailure } from './api.ts'
import type { ConversationFailure } from '../shared/conversation-failure.ts'
import ConversationFailureNotice from './ConversationFailureNotice.tsx'
import { matchesShortcut, resolveShortcuts } from './keyboard.ts'
import { useUiPreferences } from './ui-preferences.tsx'
import { TaskAvatar } from './WorkbenchBotAvatar.tsx'
import css from './AgentWorkbench.module.css'

type Trigger = { from: number; to: number; query: string; fromButton?: boolean }
export type WorkbenchContextReference = { kind: 'member' | 'computer'; name: string }
export type WorkbenchDraft = { text: string; key: number; mention?: string; references?: WorkbenchContextReference[] }

type MentionOption = {
  id: string
  name: string
  description: string
  reference?: WorkbenchContextReference
}

type ComposerProps = {
  workspaceId: string
  placeholder: string
  agents?: readonly WorkbenchAgent[]
  user?: string
  hero?: boolean
  example?: WorkbenchDraft
  replyBlocked?: string
  onOpenModels?: () => void
  onSend: (input: WorkbenchSubmitInput) => Promise<void>
}

function editorTrigger(value: string, caret: number): Trigger | null {
  const match = /(?:^|\s|\p{Script=Han}|[([{"'，。！？：；、])[@＠]([^\s@＠，。！？：；、()[\]{}]*)$/u.exec(value.slice(0, caret))
  if (match === null) return null
  const query = match[1]!
  const remaining = /^[^\s@＠，。！？：；、()[\]{}]*/u.exec(value.slice(caret))?.[0] ?? ''
  return { from: caret - query.length - 1, to: caret + remaining.length, query }
}

function errorText(cause: unknown, fallback: string): string {
  return cause instanceof Error && cause.message.trim() ? cause.message : fallback
}

const contextPrefix = '上下文引用'

/** The lead only receives a routing id when a Bot is chosen. Context references
 * use an explicit, human-readable preamble in the original persisted request. */
function withReferences(text: string, references: readonly WorkbenchContextReference[]): string {
  if (references.length === 0) return text
  const lines = references.map(reference => `${reference.kind === 'member' ? '成员' : '电脑'} @${reference.name}`)
  return [contextPrefix, ...lines, '', text].join('\n')
}

export function splitWorkbenchReferences(text: string): { text: string; references: WorkbenchContextReference[] } {
  const boundary = text.indexOf('\n\n')
  if (boundary === -1 || !text.startsWith(`${contextPrefix}\n`)) return { text, references: [] }
  const lines = text.slice(contextPrefix.length + 1, boundary).split('\n')
  const references: WorkbenchContextReference[] = []
  for (const line of lines) {
    const match = /^(成员|电脑) @([^\r\n]+)$/u.exec(line)
    if (!match) return { text, references: [] }
    references.push({ kind: match[1] === '成员' ? 'member' : 'computer', name: match[2]! })
  }
  return { text: text.slice(boundary + 2), references }
}

export function WorkbenchReferenceIcon({ kind }: { kind?: WorkbenchContextReference['kind'] }) {
  const Icon = kind === 'member' ? User : kind === 'computer' ? Monitor : Bot
  return <Icon size={13} aria-hidden="true" />
}

/** A native textarea keeps native composition and plain-text paste intact. The chosen Agent
 * appears as an atomic sibling chip inside the same composer and is sent separately from text. */
export function AgentWorkbenchComposer({ workspaceId, placeholder, agents, user, hero = false, example, replyBlocked, onOpenModels, onSend }: ComposerProps) {
  const { settings, t } = useUiPreferences()
  const form = useRef<HTMLFormElement>(null)
  const field = useRef<HTMLTextAreaElement>(null)
  const mentionMenu = useRef<HTMLDivElement>(null)
  const skillsButton = useRef<HTMLButtonElement>(null)
  const composing = useRef(false)
  const dismissedMention = useRef<{ text: string; caret: number }>()
  const submitting = useRef(false)
  const request = useRef<{ text: string; mention?: string; requestId: string }>()
  const listId = useId()
  const skillsId = useId()
  const replyBlockedId = useId()
  const [text, setText] = useState(example?.text ?? '')
  const [mentionId, setMentionId] = useState(example?.mention)
  const [references, setReferences] = useState<WorkbenchContextReference[]>(() => example?.references ?? [])
  const [trigger, setTrigger] = useState<Trigger | null>(null)
  const [selected, setSelected] = useState<string>()
  const [skillMenu, setSkillMenu] = useState(false)
  const [skills, setSkills] = useState<SkillSummary[] | null>(null)
  const [skillError, setSkillError] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [failure, setFailure] = useState<ConversationFailure>()
  const shortcuts = resolveShortcuts(settings.shortcuts)
  const needle = trigger?.query.toLocaleLowerCase() ?? ''
  const mention = agents?.find(agent => agent.id === mentionId)
  const mentionName = mention?.name ?? mentionId
  const memberName = user?.replace(/[\r\n]+/gu, ' ').trim()
  const member = memberName ? {
    id: 'context-member', name: memberName, description: t('当前成员', 'Current member'),
    reference: { kind: 'member', name: memberName },
  } satisfies MentionOption : undefined
  const computer = {
    id: 'context-computer', name: t('本机', 'This computer'), description: t('执行环境', 'Execution host'),
    reference: { kind: 'computer', name: '本机' },
  } satisfies MentionOption
  const matches = (candidate: MentionOption) =>
    `${candidate.name} ${candidate.id} ${candidate.description}`.toLocaleLowerCase().includes(needle)
  const groups: Array<{ name: string; options: MentionOption[] }> = [
    { name: t('成员', 'Members'), options: member === undefined ? [] : [member].filter(matches) },
    { name: t('电脑', 'Computers'), options: [computer].filter(matches) },
    { name: t('Bot 与任务', 'Bots and tasks'), options: (agents ?? []).filter(agent => agent.id !== 'lead' && matches(agent)) },
  ]
  const options = groups.flatMap(group => group.options)
  const option = options.find(candidate => candidate.id === selected) ?? options.find(candidate => candidate.reference === undefined) ?? options[0]

  useLayoutEffect(() => {
    if (example === undefined) return
    setText(example.text)
    setMentionId(example.mention)
    setReferences(example.references ?? [])
    setTrigger(null)
    field.current?.focus()
  }, [example])

  useEffect(() => {
    if (trigger === null && !skillMenu) return
    const dismiss = (event: MouseEvent) => {
      if (event.target instanceof Node && !form.current?.contains(event.target)) {
        setTrigger(null)
        setSkillMenu(false)
      }
    }
    document.addEventListener('pointerdown', dismiss)
    return () => document.removeEventListener('pointerdown', dismiss)
  }, [trigger, skillMenu])

  useEffect(() => {
    const input = field.current
    if (input === null) return
    input.style.height = 'auto'
    input.style.height = `${Math.max(hero ? 62 : 42, Math.min(input.scrollHeight, 190))}px`
  }, [text, hero])

  const observeCaret = (element: HTMLTextAreaElement, changed = false) => {
    if (trigger?.fromButton && !changed) return
    if (agents === undefined || composing.current || element.selectionStart !== element.selectionEnd) {
      setTrigger(null)
      return
    }
    const next = editorTrigger(element.value, element.selectionStart)
    if (changed || next === null) dismissedMention.current = undefined
    if (dismissedMention.current?.text === element.value && dismissedMention.current.caret === element.selectionStart) return
    if (next !== null) setSkillMenu(false)
    if (next?.query !== trigger?.query || next?.from !== trigger?.from) setSelected(undefined)
    setTrigger(next)
  }

  const closeMentions = () => {
    const input = field.current
    if (input && trigger !== null) dismissedMention.current = { text: input.value, caret: input.selectionStart }
    setTrigger(null)
  }

  const focusAt = (position: number) => requestAnimationFrame(() => {
    field.current?.focus()
    field.current?.setSelectionRange(position, position)
  })

  const replace = (insertion: string, from: number, to: number) => {
    setText(current => current.slice(0, from) + insertion + current.slice(to))
    focusAt(from + insertion.length)
  }

  const choose = (candidate: MentionOption) => {
    if (trigger === null) return
    const { reference } = candidate
    if (reference === undefined) setMentionId(candidate.id)
    else setReferences(current => current.some(item => item.kind === reference.kind) ? current : [...current, reference])
    if (trigger.fromButton) focusAt(trigger.from)
    else replace('', trigger.from, trigger.to)
    setTrigger(null)
  }

  const toggleMentions = () => {
    if (trigger !== null) { closeMentions(); return }
    const input = field.current
    if (input === null) return
    const caret = input.selectionStart
    focusAt(caret)
    setSkillMenu(false)
    setSelected(undefined)
    setTrigger({ from: caret, to: caret, query: '', fromButton: true })
  }

  const loadSkills = async () => {
    setSkillError('')
    try { setSkills((await api.getSkills(workspaceId)).skills) }
    catch (cause) { setSkillError(errorText(cause, t('无法读取技能', 'Could not load skills'))) }
  }

  const toggleSkills = () => {
    closeMentions()
    setSkillMenu(previous => !previous)
    if (!skillMenu && skills === null) void loadSkills()
  }

  const send = async () => {
    const content = text.trim()
    if (!content || replyBlocked !== undefined || trigger !== null || composing.current || submitting.current) return
    const body = withReferences(content, references)
    const target = mentionId
    const previous = request.current
    const input = previous?.text === body && previous.mention === target
      ? previous
      : { text: body, requestId: crypto.randomUUID(), ...(target === undefined ? {} : { mention: target }) }
    request.current = input
    submitting.current = true
    setFailure(undefined)
    setSaving(true)
    setError('')
    setTrigger(null)
    setSkillMenu(false)
    try {
      await onSend(input)
      setText('')
      setMentionId(undefined)
      setReferences([])
      request.current = undefined
    } catch (cause) {
      if (cause instanceof ApiFailure && cause.failure) setFailure(cause.failure)
      else setError(errorText(cause, t('发送失败，请重试', 'The message could not be sent. Try again.')))
    } finally {
      submitting.current = false
      setSaving(false)
      focusAt(0)
    }
  }

  const handleKey = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (submitting.current || composing.current || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return
    if (trigger !== null) {
      if (event.key === 'Tab') {
        closeMentions()
        return
      }
      if (options.length > 0 && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
        event.preventDefault()
        const delta = event.key === 'ArrowDown' ? 1 : -1
        const current = options.findIndex(candidate => candidate.id === option?.id)
        const next = options[(current + delta + options.length) % options.length]!
        setSelected(next.id)
        const menu = mentionMenu.current
        const row = document.getElementById(`${listId}-${next.id}`)
        if (menu !== null && row !== null) {
          const panel = menu.getBoundingClientRect()
          const item = row.getBoundingClientRect()
          const top = panel.top + menu.clientTop
          const bottom = top + menu.clientHeight
          menu.scrollTop += Math.floor(Math.min(0, item.top - top)) + Math.ceil(Math.max(0, item.bottom - bottom))
        }
        return
      }
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault()
        if (option !== undefined && !event.ctrlKey && !event.metaKey && !event.altKey) choose(option)
        return
      }
    }
    if (event.key === 'Backspace' && event.currentTarget.value === '' && (mentionId !== undefined || references.length > 0)) {
      event.preventDefault()
      if (mentionId !== undefined) setMentionId(undefined)
      else setReferences(current => current.slice(0, -1))
      return
    }
    if (matchesShortcut(event.nativeEvent, shortcuts.send) || matchesShortcut(event.nativeEvent, shortcuts.alternateSend)) {
      event.preventDefault()
      void send()
    }
  }

  return <form ref={form} className={css.composer} data-hero={hero}
    onKeyDown={event => {
      if (event.key !== 'Escape' || event.nativeEvent.isComposing || composing.current) return
      if (trigger === null && !skillMenu) return
      event.preventDefault()
      event.stopPropagation()
      if (skillMenu) skillsButton.current?.focus()
      closeMentions()
      setSkillMenu(false)
    }}
    onBlur={event => {
      if (event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)) return
      setTrigger(null)
      setSkillMenu(false)
    }}
    onSubmit={event => { event.preventDefault(); void send() }}>
    {trigger !== null && <div ref={mentionMenu} className={css.popover}>
      {options.length === 0 && <div className={css.popoverEmpty}>
        <p className={css.popoverNotice} role="status">{t('没有匹配的提及对象', 'No matching targets')}</p>
        <button type="button" className={css.linkButton} onClick={() => {
          closeMentions()
          field.current?.focus()
        }}>{t('保留文字并关闭', 'Keep text and close')}</button>
      </div>}
      <div id={listId} role="listbox" aria-label={t('提及对象', 'Mention targets')}>
        {groups.filter(group => group.options.length > 0).map(group => <div role="group" key={group.name} aria-label={group.name}>
          <div className={css.popoverLabel}>{group.name}</div>
          {group.options.map(candidate => <button key={candidate.id}
            type="button" role="option" id={`${listId}-${candidate.id}`} tabIndex={-1} className={css.popoverItem}
            aria-selected={candidate.id === option?.id} onMouseDown={event => event.preventDefault()} onClick={() => choose(candidate)}>
            {candidate.reference ? <span className={css.avatar} aria-hidden="true"><WorkbenchReferenceIcon kind={candidate.reference.kind} /></span>
              : <TaskAvatar agent={agents?.find(agent => agent.id === candidate.id)} />}
            <span className={css.popoverText}><strong>{candidate.name}</strong><small title={candidate.description}>{candidate.description}</small></span>
          </button>)}
        </div>)}
      </div>
    </div>}
    {(references.length > 0 || mentionName !== undefined) && <div className={css.mentionPills}>
      {references.map(reference => <span key={reference.kind} className={css.mentionPill}>
        <WorkbenchReferenceIcon kind={reference.kind} /><span>@{reference.kind === 'computer' ? t('本机', 'This computer') : reference.name}</span>
        <button className={css.chipRemove} type="button" disabled={saving}
          aria-label={t(`移除提及 ${reference.name}`, `Remove mention ${reference.name}`)}
          onClick={() => { setReferences(current => current.filter(item => item.kind !== reference.kind)); field.current?.focus() }}><X size={13} aria-hidden="true" /></button>
      </span>)}
      {mentionName !== undefined && <span className={css.mentionPill}>
        <TaskAvatar agent={mention} small /><span>@{mentionName}</span>
        <button className={css.chipRemove} type="button" disabled={saving}
          aria-label={t(`移除提及 ${mentionName}`, `Remove mention ${mentionName}`)}
          onClick={() => { setMentionId(undefined); field.current?.focus() }}><X size={13} aria-hidden="true" /></button>
      </span>}
    </div>}
    <textarea ref={field} aria-label={agents === undefined ? t('继续对话', 'Continue conversation') : t('发消息给 Agent', 'Message Agent')}
      aria-autocomplete={agents === undefined ? undefined : 'list'}
      aria-describedby={replyBlocked === undefined ? undefined : replyBlockedId}
      aria-controls={trigger === null ? undefined : listId}
      aria-activedescendant={trigger !== null && option !== undefined ? `${listId}-${option.id}` : undefined}
      rows={2} value={text} placeholder={placeholder} readOnly={saving}
      onCompositionStart={() => { composing.current = true; setTrigger(null) }}
      onCompositionEnd={event => { composing.current = false; observeCaret(event.currentTarget) }}
      onSelect={event => observeCaret(event.currentTarget)}
      onChange={event => { setText(event.currentTarget.value); observeCaret(event.currentTarget, true) }}
      onKeyDown={handleKey} />
    {failure && <ConversationFailureNotice failure={failure} onRetry={send} onModelSettings={onOpenModels} />}
    {error && <div className={css.error} role="alert">{error}</div>}
    {replyBlocked !== undefined && <div id={replyBlockedId} className={css.composerNotice} role="status">{replyBlocked}</div>}
    <div className={css.composerActions}>
      <button ref={skillsButton} type="button" className={css.utilityButton} disabled={saving} aria-expanded={skillMenu} aria-controls={skillMenu ? skillsId : undefined}
        onClick={toggleSkills}><Diamond size={13} aria-hidden="true" /> {t('技能', 'Skills')}</button>
      {skillMenu && <div id={skillsId} role="group" aria-label={t('工作区技能', 'Workspace skills')} className={css.popover}>
        {skills === null && (skillError
          ? <div className={css.popoverEmpty} role="status"><p className={css.popoverNotice}>{skillError}</p>
            <button type="button" className={css.linkButton} onClick={() => void loadSkills()}>{t('重试', 'Retry')}</button>
          </div>
          : <p className={css.popoverNotice} role="status">{t('正在读取技能…', 'Loading skills…')}</p>)}
        {skills?.length === 0 && <p className={css.popoverNotice}>{t('这个工作区没有可用技能', 'No skills in this workspace')}</p>}
        {skills?.map(skill => <button key={skill.id} type="button" className={css.popoverItem} onClick={() => {
          const input = field.current
          if (input !== null) {
            const before = input.value.slice(0, input.selectionStart)
            const separator = before && !/\s$/u.test(before) ? ' ' : ''
            replace(`${separator}$${skill.name} `, input.selectionStart, input.selectionEnd)
          }
          setSkillMenu(false)
        }}><Diamond size={16} aria-hidden="true" /><span className={css.popoverText}>
          <strong>{skill.name}</strong><small title={skill.description}>{skill.description}</small>
        </span></button>)}
      </div>}
      {agents !== undefined && <button type="button" className={css.utilityButton} disabled={saving} aria-label={t('提及智能体', 'Mention agent')}
        aria-expanded={trigger !== null} onClick={toggleMentions}><AtSign size={14} aria-hidden="true" /></button>}
      <button type="submit" className={css.send} disabled={saving || replyBlocked !== undefined || trigger !== null || text.trim() === ''}
        aria-label={saving ? t('正在发送', 'Sending') : t('发送', 'Send')} title={t('发送', 'Send')}><ArrowUp size={17} aria-hidden="true" /></button>
    </div>
  </form>
}
