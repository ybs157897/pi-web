import { z } from 'zod'

/**
 * 功能：用户/项目级 hooks 的配置与输出 schema——格式兼容 ZCode/Claude Code 的 hooks.json，
 * 使既有插件脚本与用户习惯可直接迁移。
 * 内部逻辑：配置与 stdout 输出均 passthrough 保留未知字段（ZCode 运行时契约：未知字段
 * 不得使整个 hook 失败）；事件枚举一次定义七个，第一批接线其中五个内核钩子点。
 */

/** 支持的事件全集。PermissionRequest 不在列：pi-web 权限模型是 accessMode，无逐工具 ask。 */
export const HOOK_EVENTS = [
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'Stop',
  'PreCompact',
] as const
export type HookEvent = (typeof HOOK_EVENTS)[number]

/** 工具类事件：matcher 匹配工具名。 */
export const TOOL_EVENTS: ReadonlySet<HookEvent> = new Set(['PreToolUse', 'PostToolUse', 'PostToolUseFailure'])

/** 默认超时 15 秒（需求约定）；创建前须经 ask_user_question 向用户确认。 */
export const DEFAULT_TIMEOUT_MS = 15_000
/** stdout 收集上限，超出截断（ZCode 同款默认值）。 */
export const DEFAULT_MAX_OUTPUT_BYTES = 32_768
/** Stop 续跑硬上限，防无限循环（ZCode MAX_STOP_HOOK_CONTINUATIONS 同款）。 */
export const MAX_STOP_CONTINUATIONS = 3
/** additionalContext 注入预算（字符），超出截断（ZCode 注入层同款）。 */
export const ADDITIONAL_CONTEXT_BUDGET = 24_000

/**
 * 单条 hook 定义。process 型 argv 直传不经 shell（跨平台首选）；command 型整条 shell
 * 字符串（兼容 Claude 插件）。`enabled` 缺省 true；`includeNested` 仅 PreToolUse 有意义，
 * 缺省 false 表示只拦模型直发调用、不拦 codemode 嵌套调用。
 */
export const hookEntrySchema = z.object({
  type: z.enum(['process', 'command']),
  command: z.string().min(1),
  args: z.array(z.string()).optional(),
  timeoutMs: z.number().int().positive().max(600_000).optional(),
  enabled: z.boolean().optional(),
  includeNested: z.boolean().optional(),
  statusMessage: z.string().max(500).optional(),
}).passthrough()
export type HookEntry = z.infer<typeof hookEntrySchema>

/** 一个 matcher 组：matcher 缺省匹配全部；组内 hooks 串行执行。 */
export const matcherGroupSchema = z.object({
  matcher: z.string().optional(),
  hooks: z.array(hookEntrySchema),
}).passthrough()
export type MatcherGroup = z.infer<typeof matcherGroupSchema>

/** 单来源（用户级或项目级）的 hooks 配置块。 */
export const hooksConfigSchema = z.object({
  enabled: z.boolean().optional(),
  timeoutMs: z.number().int().positive().max(600_000).optional(),
  maxOutputBytes: z.number().int().positive().max(1_048_576).optional(),
  events: z.partialRecord(z.enum(HOOK_EVENTS), z.array(matcherGroupSchema)).optional(),
}).passthrough()
export type HooksConfig = z.infer<typeof hooksConfigSchema>

/** hooks.json 文件顶层：`{ hooks: {...} }`。 */
export const hooksFileSchema = z.object({
  hooks: hooksConfigSchema.optional(),
}).passthrough()
export type HooksFile = z.infer<typeof hooksFileSchema>

/** hook stdout 的 JSON 输出 schema。顶层兼容字段 + 事件专属 hookSpecificOutput；
 * 未知字段忽略（passthrough），已知字段类型错误才判失败。
 */
export const hookOutputSchema = z.object({
  continue: z.boolean().optional(),
  decision: z.enum(['approve', 'block']).optional(),
  reason: z.string().optional(),
  stopReason: z.string().optional(),
  additionalContext: z.string().optional(),
  additional_context: z.string().optional(),
  suppressOutput: z.boolean().optional(),
  systemMessage: z.string().optional(),
  hookSpecificOutput: z.object({
    hookEventName: z.enum(HOOK_EVENTS),
    permissionDecision: z.enum(['allow', 'ask', 'deny']).optional(),
    permissionDecisionReason: z.string().optional(),
    updatedInput: z.record(z.string(), z.unknown()).optional(),
    additionalContext: z.string().optional(),
  }).passthrough().optional(),
}).passthrough()
export type HookOutput = z.infer<typeof hookOutputSchema>

/** 一次 hook 运行的可观测记录（trajectory JSONL `type:'hook'` 行与设置页展示共用）。 */
export interface HookRunRecord {
  ts: number
  conversationId: string
  event: HookEvent
  source: 'user' | 'project'
  matcher?: string
  command: string
  outcome: 'success' | 'blocked' | 'failed' | 'timeout' | 'cancelled' | 'pending_trust' | 'skipped'
  durationMs: number
  exitCode: number
  error?: string
}

/**
 * 功能：解析配置来源的生效默认值。
 * @param config 已校验的配置块（可能为 undefined）。
 * @returns 超时与输出上限的生效值（条目级 > 来源级 > 全局默认）。
 */
export function configDefaults(config: HooksConfig | undefined): { timeoutMs: number; maxOutputBytes: number } {
  return {
    timeoutMs: config?.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    maxOutputBytes: config?.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES,
  }
}

/**
 * 功能：按 ZCode matcher 契约判断是否匹配。
 * 内部逻辑：缺省/空串/`*` 匹配全部；仅含字母数字下划线与 `|` 时按精确名称列表匹配；
 * 其余按 JavaScript 正则（大小写敏感），非法正则永不匹配并返回诊断标记。
 * @param matcher 配置的 matcher 字符串。
 * @param value 事件的匹配值（工具名 / SessionStart source）；无查询值的事件传 undefined 表示不过滤。
 * @returns matched 与 invalid（非法正则时为 true，调用方记诊断）。
 */
export function matchHookMatcher(matcher: string | undefined, value: string | undefined): { matched: boolean; invalid: boolean } {
  if (matcher === undefined || matcher === '' || matcher === '*') return { matched: true, invalid: false }
  if (value === undefined) return { matched: true, invalid: false }
  if (/^[A-Za-z0-9_|]+$/.test(matcher)) {
    return { matched: matcher.split('|').includes(value), invalid: false }
  }
  try {
    return { matched: new RegExp(matcher).test(value), invalid: false }
  } catch {
    return { matched: false, invalid: true }
  }
}

/**
 * 功能：归一化 hook 输出——合并 snake_case 别名与事件专属字段，产出统一决策形态。
 * @param output 已校验的 stdout JSON。
 * @param event 触发事件。
 * @returns block（阻断/续跑请求）、additionalContext、updatedInput 与原因。
 * 内部逻辑：exit 2 的阻断语义由 runner 注入 decision:block；这里只消费 JSON 字段。
 * Stop 的 block 表示「不要结束、续跑一轮」；PreToolUse 的 deny/continue:false 表示阻断调用。
 */
export function normalizeHookOutput(output: HookOutput, event: HookEvent): {
  block: boolean
  blockReason: string | undefined
  additionalContext: string | undefined
  updatedInput: Record<string, unknown> | undefined
} {
  const specific = output.hookSpecificOutput?.hookEventName === event ? output.hookSpecificOutput : undefined
  const contextParts = [output.additionalContext, output.additional_context, specific?.additionalContext]
    .filter((part): part is string => typeof part === 'string' && part !== '')
  const deny = specific?.permissionDecision === 'deny'
  const block = output.decision === 'block' || output.continue === false || deny
  return {
    block,
    blockReason: output.reason ?? output.stopReason ?? specific?.permissionDecisionReason,
    additionalContext: contextParts.length > 0 ? contextParts.join('\n') : undefined,
    updatedInput: specific?.updatedInput,
  }
}