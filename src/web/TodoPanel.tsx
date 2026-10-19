import { useState } from 'react'
import { IconChevronDownOutlineRegular, IconFlatListOutlineRegular, StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import type { TodoItem, TodoStatus } from '../shared/types.ts'
import { useUiPreferences } from './ui-preferences.tsx'
import css from './TodoPanel.module.css'

/** DSH's todo dock: collapsed by default, counts in the header, one row per item. */
export default function TodoPanel({ todos }: { todos?: readonly TodoItem[] | null }) {
  const { t } = useUiPreferences()
  const [expanded, setExpanded] = useState(false)
  const items = todos ?? []
  if (items.length === 0) return null
  const done = items.filter(item => item.status === 'completed').length
  const active = items.filter(item => item.status === 'in_progress').length
  const pending = items.length - done - active
  const summary = [
    done > 0 ? t(`${done} 已完成`, `${done} done`) : '',
    active > 0 ? t(`${active} 进行中`, `${active} in progress`) : '',
    pending > 0 ? t(`${pending} 待处理`, `${pending} pending`) : '',
  ].filter(part => part !== '').join(' · ')
  return <div className={css.panel}>
    <button type="button" className={css.header} aria-expanded={expanded} onClick={() => setExpanded(value => !value)}>
      <IconFlatListOutlineRegular size={14} />
      <span className={css.title}>{t('任务', 'To-dos')}</span>
      <span className={css.summary}>{summary}</span>
      <IconChevronDownOutlineRegular size={12} className={expanded ? css.chevronOpen : css.chevron} />
    </button>
    {expanded && <ul className={css.list}>{items.map(item => <li key={item.content} className={css.row} data-status={item.status}>
      <StateDot state={dotState(item.status)} size={8} />
      <span className={css.content}>{item.content}</span>
    </li>)}</ul>}
  </div>
}

function dotState(status: TodoStatus): 'done' | 'ongoing' | 'idle' {
  if (status === 'completed') return 'done'
  if (status === 'in_progress') return 'ongoing'
  return 'idle'
}
