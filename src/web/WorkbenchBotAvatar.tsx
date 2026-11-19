import type { WorkbenchAgent, WorkbenchBotIcon } from '../shared/workbench.ts'
import styles from './WorkbenchBotAvatar.module.css'

const portraits: Record<WorkbenchBotIcon, [string, string, string]> = {
  bot: ['02-leonardo', '达·芬奇', 'Leonardo'],
  activity: ['27-the-astronomer', '天文学家', 'The Astronomer'],
  database: ['07-ada', '艾达', 'Ada'],
  clock: ['12-newton', '牛顿', 'Newton'],
  sparkles: ['06-beethoven', '贝多芬', 'Beethoven'],
  code: ['29-amelia-earhart', '埃尔哈特', 'Amelia Earhart'],
  search: ['03-mona-lisa', '蒙娜丽莎', 'Mona Lisa'],
  book: ['13-shakespeare', '莎士比亚', 'Shakespeare'],
  chart: ['10-van-gogh', '梵高', 'Van Gogh'],
  shield: ['16-athena', '雅典娜', 'Athena'],
  palette: ['09-frida', '弗里达', 'Frida'],
}
const builtinPortraits: Record<string, WorkbenchBotIcon> = {
  lead: 'bot', log: 'activity', import: 'database', time: 'clock', general: 'sparkles',
}

export function botPortraitLabel(icon: WorkbenchBotIcon, t: (zh: string, en: string) => string) {
  const [, zh, en] = portraits[icon]
  return t(zh, en)
}

export function TaskAvatar({ agent, icon, large = false, small = false }: {
  agent?: WorkbenchAgent
  icon?: WorkbenchBotIcon
  large?: boolean
  small?: boolean
}) {
  const selected = icon ?? agent?.config?.icon ?? builtinPortraits[agent?.id ?? 'lead'] ?? 'bot'
  const file = portraits[selected]?.[0] ?? portraits.bot[0]
  return <img className={styles.portrait} data-large={large || undefined} data-small={small || undefined}
    data-active={agent?.status === 'running' || undefined} src={`/bot-avatars/${file}.svg`} alt="" aria-hidden="true" draggable={false} />
}
