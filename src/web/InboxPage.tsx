import { useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { Menu } from '@deepseek-ai/dsh-client-ui-primitives'
import {
  Archive, ArchiveRestore, BadgeCheck, Check, Files, Inbox, ListFilter, Mail, MailOpen, MailPlus, Send, Star,
} from 'lucide-react'
import { MessageDialog } from './message-rendering/Dialog.tsx'
import deel from './assets/inbox/deel.png'
import gpt from './assets/inbox/gpt.png'
import opus from './assets/inbox/opus.png'
import railArchive from './assets/inbox/rail-archive.png'
import railCompose from './assets/inbox/rail-compose.png'
import railDrafts from './assets/inbox/rail-drafts.png'
import railInbox from './assets/inbox/rail-inbox.png'
import railMark from './assets/inbox/rail-mark.png'
import railSelect from './assets/inbox/rail-select.png'
import railStarred from './assets/inbox/rail-starred.png'
import railUnread from './assets/inbox/rail-unread.png'
import rico from './assets/inbox/rico.png'
import substack from './assets/inbox/substack.png'
import hero from './assets/inbox/upgrade.webp'
import css from './InboxPage.module.css'

const MODELS = {
  opus: { name: 'Opus 4.8', plan: 'Max (20x)', icon: opus },
  gpt: { name: 'GPT 5.5', plan: 'Pro (20x)', icon: gpt },
}

const FOLDERS = {
  inbox: 'Inbox', sent: 'Sent items', starred: 'Starred', archive: 'Archive', drafts: 'Drafts',
}

const FILTERS = [
  { id: 'all', label: 'All messages' }, { id: 'unread', label: 'Unread' }, { id: 'read', label: 'Read' },
] as const

type Model = keyof typeof MODELS
type Folder = keyof typeof FOLDERS
type Filter = typeof FILTERS[number]['id']
type Draft = { to: string; subject: string; body: string }
type Message = {
  id: string
  sender: string
  subject: string
  body: string
  date: string
  avatar?: string
  unread?: boolean
  archived?: boolean
  starred?: boolean
  sent?: boolean
}

const SAMPLE_MESSAGES: Message[] = [
  {
    id: 'rico', sender: 'Rico Oktananda', date: '05.16', avatar: rico, unread: true,
    subject: 'A quick question about your experience',
    body: 'We’re refining our product and need your insights on our user experience (UX) design. What feels easy to use today, and where do you find yourself getting stuck?\n\nThanks for sharing your feedback!\nRico',
  },
  {
    id: 'deel', sender: 'Alicia from Deel', date: 'June 29', avatar: deel,
    subject: 'Your Deel withdrawal is on the way',
    body: 'Your money is on the way! Your Deel withdrawal is all set, and your money is on its way to your account.\n\nAlicia from Deel',
  },
  {
    id: 'substack', sender: 'Substack Read', date: 'June 29', avatar: substack,
    subject: 'Your weekly reading list',
    body: 'Your weekly reading list is ready. Catch up on new posts from the writers you follow and discover a few new favorites.',
  },
  {
    id: 'sent-sample', sender: 'Design team', date: 'June 28', sent: true,
    subject: 'Re: Design review',
    body: 'Thanks for sending the latest draft. I’ve finished my review and we’re ready for Friday’s meeting.',
  },
]

function ModelIdentity({ model }: { model: Model }) {
  const { name, plan, icon } = MODELS[model]
  return <>
    <img className={css.modelIcon} src={icon} alt="" width="32" height="32" />
    <span className={css.modelText}><strong>{name}</strong><small>{plan}</small></span>
  </>
}

function MessageAvatar({ message }: { message: Message }) {
  return message.avatar
    ? <img className={css.avatar} src={message.avatar} alt="" width="34" height="34" />
    : <span className={css.avatar} aria-hidden="true"><Send size={16} /></span>
}

export default function InboxPage() {
  const [folder, setFolder] = useState<Folder>('inbox')
  const [filter, setFilter] = useState<Filter>('all')
  const [filterOpen, setFilterOpen] = useState(false)
  const [messages, setMessages] = useState(SAMPLE_MESSAGES)
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set())
  const [selectMode, setSelectMode] = useState(false)
  const [model, setModel] = useState<Model>('opus')
  const [draft, setDraft] = useState<Draft | null>(null)
  const [dialog, setDialog] = useState<'models' | 'compose' | 'message' | null>(null)
  const [messageId, setMessageId] = useState<string | null>(null)
  const filterButton = useRef<HTMLButtonElement>(null)

  const inboxCount = 14_171 - messages.filter(message => !message.sent && message.archived).length
  const inboxCountText = inboxCount.toLocaleString('de-DE')
  const folderMessages = messages.filter(message => {
    if (folder === 'archive') return message.archived
    if (message.archived || folder === 'drafts') return false
    if (folder === 'starred') return message.starred
    return folder === 'sent' ? message.sent : !message.sent
  })
  const visible = folderMessages.filter(message => filter === 'all' || Boolean(message.unread) === (filter === 'unread'))
  const activeMessage = messages.find(message => message.id === messageId)
  const allSelected = visible.length > 0 && visible.every(message => selected.has(message.id))
  const folderCount = folder === 'drafts' ? Number(draft !== null) : folderMessages.length

  const clearSelection = () => {
    setSelected(new Set())
    setSelectMode(false)
  }

  const openFolder = (next: Folder, nextFilter: Filter = 'all') => {
    setFolder(next)
    setFilter(nextFilter)
    setFilterOpen(false)
    clearSelection()
  }

  const updateMessages = (ids: ReadonlySet<string>, patch: Partial<Message>) => {
    setMessages(current => current.map(message => ids.has(message.id) ? { ...message, ...patch } : message))
  }

  const removeSelection = (id: string) => {
    setSelected(current => {
      if (!current.has(id)) return current
      const next = new Set(current)
      next.delete(id)
      return next
    })
  }

  const openMessage = (message: Message) => {
    if (filter === 'unread') {
      removeSelection(message.id)
      filterButton.current?.focus({ preventScroll: true })
    }
    updateMessages(new Set([message.id]), { unread: false })
    setMessageId(message.id)
    setDialog('message')
  }

  const changeMessage = (message: Message, patch: Partial<Message>, movesOut: boolean) => {
    updateMessages(new Set([message.id]), patch)
    setDialog(null)
    if (movesOut) {
      removeSelection(message.id)
      requestAnimationFrame(() => filterButton.current?.focus({ preventScroll: true }))
    }
  }

  const saveDraft = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    const next = {
      to: String(form.get('to')).trim(),
      subject: String(form.get('subject')).trim(),
      body: String(form.get('body')).trim(),
    }
    setDraft(next.to || next.subject || next.body ? next : null)
    setDialog(null)
    openFolder('drafts')
  }

  return <section className={css.page} lang="en" aria-label="Email workspace">
    <div className={css.window}>
      <nav className={css.rail} aria-label="Mail folders">
        <button className={css.mark} type="button" title="AI models" aria-label="AI models" aria-haspopup="dialog" onClick={() => setDialog('models')}><img src={railMark} alt="" /></button>
        <button type="button" title="Compose" aria-label="Compose" aria-haspopup="dialog" onClick={() => setDialog('compose')}><img src={railCompose} alt="" /></button>
        <button type="button" title="Starred" aria-label="Starred" aria-current={folder === 'starred' ? 'page' : undefined} onClick={() => openFolder('starred')}><img src={railStarred} alt="" /></button>
        <button type="button" title="Inbox" aria-label="Inbox" aria-current={folder === 'inbox' && filter !== 'unread' ? 'page' : undefined} onClick={() => openFolder('inbox')}><img src={railInbox} alt="" /></button>
        <button type="button" title="Archive" aria-label="Archive" aria-current={folder === 'archive' ? 'page' : undefined} onClick={() => openFolder('archive')}><img src={railArchive} alt="" /></button>
        <button type="button" title="Unread messages" aria-label="Unread messages" aria-current={folder === 'inbox' && filter === 'unread' ? 'page' : undefined}
          onClick={() => openFolder('inbox', 'unread')}><img src={railUnread} alt="" /></button>
        <button type="button" title="Select messages" aria-label="Select messages" aria-pressed={selectMode || selected.size > 0}
          onClick={() => {
            if (selectMode || selected.size > 0) { clearSelection(); return }
            if (folder === 'drafts') openFolder('inbox')
            setSelectMode(true)
          }}><img src={railSelect} alt="" /></button>
        <button type="button" title="Drafts" aria-label="Drafts" aria-current={folder === 'drafts' ? 'page' : undefined} onClick={() => openFolder('drafts')}><img src={railDrafts} alt="" /></button>
      </nav>

      <div className={css.surface}>
        <header className={css.heading}>
          <h1>{FOLDERS[folder]}</h1><span className={css.dot} aria-hidden="true" />
          <span>{folder === 'inbox' ? `${inboxCountText} emails` : `${folderCount} ${folderCount === 1 ? 'email' : 'emails'}`}</span>
        </header>
        <div className={css.toolbar}>
          <button className={css.continue} type="button" aria-haspopup="dialog" onClick={() => setDialog('compose')}><MailPlus size={21} aria-hidden="true" /> Continue</button>
          <div className={css.tabs} role="group" aria-label="Mailboxes">
            <button type="button" aria-pressed={folder === 'inbox'} onClick={() => openFolder('inbox')}><Inbox size={18} aria-hidden="true" /> Inbox <span>{inboxCountText}</span></button>
            <button type="button" aria-pressed={folder === 'sent'} onClick={() => openFolder('sent')}><Send size={18} aria-hidden="true" /> Sent items</button>
          </div>
        </div>

        <div className={css.content}>
          <button type="button" className={css.model} data-model={model} aria-haspopup="dialog" aria-label={`Choose an AI model, current model: ${MODELS[model].name} ${MODELS[model].plan}`}
            onClick={() => setDialog('models')}>
            <ModelIdentity model={model} />
            <span className={css.usage} aria-hidden="true">
              {Array.from({ length: 25 }, (_, index) => <span key={index} />)}
            </span>
          </button>

          <section className={css.list} aria-label={`${FOLDERS[folder]} messages`}>
            <header className={css.listHead}>
              {folder !== 'drafts' && <input className={css.checkbox} type="checkbox" aria-label="Select all messages" checked={allSelected}
                ref={element => { if (element) element.indeterminate = selected.size > 0 && !allSelected }}
                disabled={visible.length === 0} onChange={event => {
                  setSelected(event.target.checked ? new Set(visible.map(message => message.id)) : new Set())
                  setSelectMode(event.target.checked)
                }} />}
              <h2>{selected.size > 0 ? `${selected.size} selected` : FOLDERS[folder]}</h2>
              {selected.size > 0 && <div className={css.bulkActions}>
                <button type="button" title="Mark as read" aria-label="Mark as read" onClick={() => { updateMessages(selected, { unread: false }); clearSelection() }}><MailOpen size={17} /></button>
                <button type="button" title={folder === 'archive' ? 'Restore selected' : 'Archive selected'} aria-label={folder === 'archive' ? 'Restore selected' : 'Archive selected'}
                  onClick={() => { updateMessages(selected, { archived: folder !== 'archive' }); clearSelection() }}>
                  {folder === 'archive' ? <ArchiveRestore size={17} /> : <Archive size={17} />}
                </button>
              </div>}
              {folder !== 'drafts' && <Menu open={filterOpen} onClose={() => setFilterOpen(false)} align="end" portal
                items={FILTERS} selectedId={filter} onSelect={id => {
                  const next = FILTERS.find(item => item.id === id)
                  if (next) setFilter(next.id)
                  setFilterOpen(false)
                  clearSelection()
                }} anchor={<button ref={filterButton} type="button" className={css.filter} data-filtered={filter !== 'all' || undefined}
                  title="Filter messages" aria-label="Filter messages" aria-haspopup="menu" aria-expanded={filterOpen}
                  onClick={() => setFilterOpen(value => !value)}><ListFilter size={20} /></button>} />}
            </header>

            {folder === 'inbox' && <button type="button" className={css.upgrade} aria-haspopup="dialog" onClick={() => setDialog('models')}>
              <img src={hero} alt="" />
              <span><strong>Upgrade with AI</strong><small>For more powerful Inbox</small></span>
            </button>}

            {folder === 'drafts' && (draft === null
              ? <p className={css.empty}>No drafts.</p>
              : <button className={css.draft} type="button" onClick={() => setDialog('compose')}>
                  <Files size={19} aria-hidden="true" /><span><strong>{draft.subject || 'Untitled draft'}</strong><small>{draft.body || draft.to}</small></span>
                </button>)}

            {folder !== 'drafts' && (visible.length === 0
              ? <p className={css.empty}>{filter === 'all' ? 'No messages in this folder.' : `No ${filter} messages.`}</p>
              : <ul className={css.messages}>
                  {visible.map(message => <li key={message.id} className={css.row} data-unread={message.unread || undefined}
                    data-selected={selected.has(message.id) || undefined} data-select-mode={(selectMode || selected.size > 0) || undefined}>
                    <label className={css.rowCheck}>
                      <input className={css.checkbox} type="checkbox" aria-label={`Select message from ${message.sender}`} checked={selected.has(message.id)}
                        onChange={event => {
                          const checked = event.target.checked
                          setSelected(current => {
                            const next = new Set(current)
                            if (checked) next.add(message.id)
                            else next.delete(message.id)
                            return next
                          })
                        }} />
                    </label>
                    <button className={css.message} type="button" aria-haspopup="dialog" aria-label={`Open message ${message.sent ? 'to' : 'from'} ${message.sender}`} onClick={() => openMessage(message)}>
                      <MessageAvatar message={message} />
                      <span className={css.messageText}>
                        <span className={css.messageHead}>
                          <span className={css.sender}><strong>{message.sender}</strong>{message.avatar && <BadgeCheck className={css.verified} size={18} role="img" aria-label="Verified sender" />}</span>
                          <span className={css.date}>{message.date}</span>
                        </span>
                        <span className={css.preview}>{message.body}</span>
                      </span>
                    </button>
                  </li>)}
                </ul>)}
          </section>
        </div>
      </div>
    </div>

    <MessageDialog open={dialog !== null} onClose={() => setDialog(null)} t={(_, en) => en}
      title={dialog === 'models' ? 'Choose an AI model' : dialog === 'compose' ? 'Compose' : activeMessage?.subject ?? ''}>
      {dialog === 'models' && <div className={css.modelOptions} lang="en">
        {(Object.keys(MODELS) as Model[]).map(option => <button key={option} type="button" className={css.modelOption} aria-pressed={model === option}
          onClick={() => { setModel(option); setDialog(null) }}>
          <ModelIdentity model={option} />{model === option && <Check className={css.modelCheck} size={18} aria-hidden="true" />}
        </button>)}
      </div>}
      {dialog === 'compose' && <form className={css.compose} lang="en" onSubmit={saveDraft}>
        <label>To <input name="to" defaultValue={draft?.to} /></label>
        <label>Subject <input name="subject" defaultValue={draft?.subject} /></label>
        <label>Message <textarea name="body" defaultValue={draft?.body} rows={5} /></label>
        <div className={css.dialogActions}><button className={css.continue} type="submit">Save draft</button></div>
      </form>}
      {dialog === 'message' && activeMessage && <article className={css.readMessage} lang="en">
        <div className={css.readSender}><MessageAvatar message={activeMessage} /><strong>{activeMessage.sent ? 'To: ' : ''}{activeMessage.sender}</strong><span>{activeMessage.date}</span></div>
        <p>{activeMessage.body}</p>
        <div className={css.dialogActions}>
          <button type="button" aria-pressed={Boolean(activeMessage.starred)} onClick={() => updateMessages(new Set([activeMessage.id]), { starred: !activeMessage.starred })}>
            <Star size={16} aria-hidden="true" />{activeMessage.starred ? 'Starred' : 'Star'}
          </button>
          {!activeMessage.sent && <button type="button" onClick={() => changeMessage(activeMessage, { unread: true }, filter === 'read')}>
            <Mail size={16} aria-hidden="true" /> Mark as unread
          </button>}
          <button type="button" onClick={() => changeMessage(activeMessage, { archived: !activeMessage.archived }, true)}>
            {activeMessage.archived ? <ArchiveRestore size={16} aria-hidden="true" /> : <Archive size={16} aria-hidden="true" />}
            {activeMessage.archived ? 'Restore' : 'Archive'}
          </button>
        </div>
      </article>}
    </MessageDialog>
  </section>
}
