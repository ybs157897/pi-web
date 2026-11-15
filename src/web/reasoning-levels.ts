import type { ProviderModelInput } from '../shared/types.ts'

/** 编辑器里一行思考档位：档位名与它对应的线上取值。 */
export interface ReasoningEntry {
  level: string
  /** 线上值；null 表示 Off 行（不发送任何参数）。 */
  value: string | null
}

/** API 接受的全部档位，按强度升序。 */
export const REASONING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const

/**
 * 功能：为单个模型推导编辑器要显示的思考档位行：实际声明了线上值的档位，加上
 * 「可关闭思考」时的 Off 行。
 * @param model 模型输入（含 thinkingLevelMap）
 * @returns 档位行数组；模型未声明 thinkingLevelMap 时 undefined（编辑器不显示该区）
 * 内部逻辑：值为 null 的档位是「不存在」而非一行——把它渲染成行会让删掉的档位在每次保存后复活；off 缺席表示「支持、不发参数」，补一行 Off；off 显式为 null 表示模型无法停止思考，不给 Off 行。
 */
export function draftReasoningLevels(model: ProviderModelInput): ReasoningEntry[] | undefined {
  const map = model.thinkingLevelMap
  if (map === undefined || map === null) return undefined
  const entries: ReasoningEntry[] = Object.entries(map)
    .filter(([, value]) => typeof value === 'string' && value !== '')
    .map(([level, value]) => ({ level, value: value as string }))
  // off 缺席 = 支持、不发送任何东西；显式 null = 模型无法停止思考，没有 Off 行可编辑。
  if (map.off !== null && !entries.some(entry => entry.level === 'off')) {
    entries.unshift({ level: 'off', value: null })
  }
  return entries
}

/**
 * 功能：把编辑器行固化成 thinkingLevelMap：未声明的档位钉为 null（对齐 DSH 的
 * `reasoningEfforts` 适配器——用户没配置的档位不提供，而不是由 pi-ai 默认五个基础
 * 档位为「支持」）。无值的 Off 行保持缺席，这样关闭思考就不发送任何参数。
 * @param entries 编辑器当前档位行
 * @returns 档位名 → 线上值（或 null）的映射
 */
export function pinReasoningLevels(entries: readonly ReasoningEntry[]): Record<string, string | null> {
  const map: Record<string, string | null> = Object.fromEntries(
    REASONING_LEVELS.filter(level => level !== 'off').map(level => [level, null]),
  )
  for (const entry of entries) {
    if (entry.level === 'off' && entry.value === null) {
      delete map.off
      continue
    }
    map[entry.level] = entry.value ?? entry.level
  }
  return map
}
