import type { Context } from '@earendil-works/chord/context'
import type { AssistantMessage } from '@earendil-works/pi-ai'
import {
  CompactionTask,
  defineDoc,
  defineExtension,
  GenerationTask,
  hook,
  ToolTask,
  type ConversationId,
  type Extension,
  type HookApi,
  type JsonObject,
  type ToolExecutionResult,
  type ToolHookCall,
  type Tx,
} from '@earendil-works/pi-durable'
import { Interactions } from '../tools/interaction.ts'
import { awaitingUser } from '../tools/goal.ts'
import {
  configDefaults,
  matchHookMatcher,
  MAX_STOP_CONTINUATIONS,
  type HookEntry,
  type HookEvent,
  type HookRunRecord,
} from './schema.ts'
import { eventGroups, hookDigest, type HooksStore, type LoadedConfig } from './store.ts'
import { runEventHooks, type EventRunResult, type HookRunInput } from './runner.ts'

/**
 * 功能：用户/项目级 hooks 的 pi-durable 适配层——把内核三个钩子点接到 hooks 子系统：
 * ToolTask.beforeTool/afterTool → PreToolUse/PostToolUse/PostToolUseFailure，
 * GenerationTask.onYield → Stop（续跑驱动），CompactionTask.beforeCompact → PreCompact。
 * 内部逻辑：双来源热读（user 在前 project 在后）；项目级逐条 digest 信任门（trust store
 * 损坏 fail-closed 全拒）；PreToolUse 默认只拦模型直发调用；任何异常收敛为放行/不干预，
 * 绝不拖垮会话。SessionStart/UserPromptSubmit 两个事件由其他接线点负责，不在本扩展。
 */

/** 工作区引用：id 用于信任集键，path 用于项目级配置与脚本。 */
export interface WorkspaceRef {
  id: string
  path: string
}

/** hooks 扩展注册名，供装配与工具过滤引用。 */
export const HOOKS_EXTENSION_NAME = 'hooks'

/**
 * 会话级 hooks 状态：本轮修改文件聚合与 Stop 续跑计数。
 * 内部逻辑：必须用会话 doc 而非 `api.memo`——memo 是 per-task 的（scheduler live record，
 * 任务结算即消失），tool task 写的 changedFiles 在 generation task 的 Stop 里读不到、
 * 续跑计数也跨不过 generation 移交。commit 内读改写保证并行工具轮不丢更新（goal 同款）。
 */
export type HooksStateValue = {
  changedFiles?: string[]
  stopContinuations?: number
}
export const HooksState = defineDoc<HooksStateValue>({
  kind: 'pi-web.hooks',
  version: 1,
  scope: 'conversation',
  history: 'latest',
  fork: 'initial',
  checkpointWhen: () => false,
  initial: () => ({}),
})

/** `HookApi` 面只承诺已提交读取与 memo；跨任务状态需要原子写，窄化出 commit（goal 同款）。 */
type CommittingHookApi = HookApi & {
  commit<T>(change: (tx: Tx) => T | Promise<T>, context: Context): Promise<T>
}

/** hooks 扩展的装配选项。 */
export interface HooksExtensionOptions {
  store: HooksStore
  /** 解析会话当前工作区；无工作区返回 undefined（只跑用户级）。 */
  resolveWorkspace: (conversationId: ConversationId, context: Context) => Promise<WorkspaceRef | undefined>
  /** 运行记录采集（trajectory JSONL / 设置页）；缺省不采集。 */
  capture?: (record: HookRunRecord) => void
}

/** Stop 续跑追加的用户消息前缀——beforeRequest 据此区分真实用户输入与 hook 续跑。 */
export const STOP_CONTINUATION_PREFIX = '[hook 要求继续]'
/** last_assistant_message 预览截断长度。 */
const ANSWER_PREVIEW_LIMIT = 4000
/** 参与 changedFiles 聚合的工具名（小写比较）。 */
const FILE_WRITE_TOOLS = new Set(['write', 'edit', 'multi_edit'])

/** 一条预期执行的 hook 元信息，与 runEventHooks 的 runs 按序一一对应。 */
interface ExpectedRun {
  source: 'user' | 'project'
  matcher?: string
  entry: HookEntry
}

/** 传给 runEventHooks 的组（带来源级默认值）。 */
type RunGroup = { matcher?: string; hooks: HookEntry[]; sourceTimeoutMs?: number; sourceMaxOutputBytes?: number }

/**
 * 功能：安全采集一条运行记录——采集回调自身异常不得进入会话。
 * @param options 扩展选项。
 * @param conversationId 会话 id。
 * @param record 除 ts/conversationId 外的记录字段。
 */
function captureRecord(options: HooksExtensionOptions, conversationId: ConversationId, record: Omit<HookRunRecord, 'ts' | 'conversationId'>): void {
  try {
    options.capture?.({ ts: Date.now(), conversationId: String(conversationId), ...record })
  } catch {
    // 采集通道故障静默（trajectory 侧同款约定）。
  }
}

/**
 * 功能：加载双来源配置并构建本次事件的执行计划（信任门 + 嵌套过滤在此完成）。
 * 内部逻辑：user 组在前 project 组在后；项目级每条算 hookDigest 与信任集比对——
 * 信任集 undefined（store 损坏）全拒记 skipped，digest 不在集记 pending_trust；
 * PreToolUse 嵌套调用只保留 includeNested:true 的条目。expected 序列与 runner 的
 * matcher/enabled 过滤口径一致，供 runs 逐条对应元信息。
 * @param options 扩展选项。
 * @param event 事件名。
 * @param matchValue matcher 匹配值（工具名）；无查询值事件传 undefined。
 * @param conversationId 会话 id。
 * @param context 执行上下文。
 * @param nested 是否嵌套调用（仅 PreToolUse 有意义）。
 * @returns 执行组、预期序列与工作区引用。
 */
async function planEvent(
  options: HooksExtensionOptions,
  event: HookEvent,
  matchValue: string | undefined,
  conversationId: ConversationId,
  context: Context,
  nested: boolean,
): Promise<{ groups: RunGroup[]; expected: ExpectedRun[]; workspace: WorkspaceRef | undefined }> {
  const workspace = await options.resolveWorkspace(conversationId, context)
  const sources: Array<{ source: 'user' | 'project'; loaded: LoadedConfig }> = [
    { source: 'user', loaded: await options.store.loadUser() },
  ]
  if (workspace !== undefined) sources.push({ source: 'project', loaded: await options.store.loadProject(workspace.path) })
  const groups: RunGroup[] = []
  const expected: ExpectedRun[] = []
  for (const { source, loaded } of sources) {
    if (loaded.error !== undefined) {
      captureRecord(options, conversationId, { event, source, command: loaded.path, outcome: 'failed', durationMs: 0, exitCode: -1, error: loaded.error })
    }
    const sourceGroups = eventGroups(loaded.config, event)
    if (sourceGroups.length === 0) continue
    const defaults = configDefaults(loaded.config)
    // 项目级信任门：仅在该来源确有本事件条目时才读信任集。
    let trusted: Set<string> | undefined
    if (source === 'project' && workspace !== undefined) trusted = await options.store.trustedDigests(workspace.id)
    for (const group of sourceGroups) {
      const kept: HookEntry[] = []
      for (const entry of group.hooks) {
        if (event === 'PreToolUse' && nested && entry.includeNested !== true) continue
        if (source === 'project' && workspace !== undefined) {
          if (trusted === undefined) {
            captureRecord(options, conversationId, { event, source, matcher: group.matcher, command: entry.command, outcome: 'skipped', durationMs: 0, exitCode: -1, error: 'hooks 信任存储损坏，项目级钩子全部拒绝执行' })
            continue
          }
          if (!trusted.has(hookDigest(event, group.matcher, entry, defaults))) {
            captureRecord(options, conversationId, { event, source, matcher: group.matcher, command: entry.command, outcome: 'pending_trust', durationMs: 0, exitCode: -1 })
            continue
          }
        }
        kept.push(entry)
        const { matched, invalid } = matchHookMatcher(group.matcher, matchValue)
        if (matched && !invalid && entry.enabled !== false) expected.push({ source, matcher: group.matcher, entry })
      }
      if (kept.length > 0) groups.push({ matcher: group.matcher, hooks: kept, sourceTimeoutMs: defaults.timeoutMs, sourceMaxOutputBytes: defaults.maxOutputBytes })
    }
  }
  return { groups, expected, workspace }
}

/**
 * 功能：执行事件钩子并把每条 run 采集为 HookRunRecord（按 expected 序列对应来源/matcher）。
 * @param options 扩展选项。
 * @param plan planEvent 的执行计划。
 * @param event 事件名。
 * @param matchValue matcher 匹配值。
 * @param input stdin 载荷。
 * @param conversationId 会话 id。
 * @param context 执行上下文（取 abortSignal）。
 * @returns 聚合决策。
 */
async function executeEvent(
  options: HooksExtensionOptions,
  plan: { groups: RunGroup[]; expected: ExpectedRun[]; workspace?: WorkspaceRef },
  event: HookEvent,
  matchValue: string | undefined,
  input: HookRunInput,
  conversationId: ConversationId,
  context: Context,
): Promise<EventRunResult> {
  const result = await runEventHooks(plan.groups, event, matchValue, input, {
    abortSignal: context.abortSignal,
    // 环境变量注入（ZCode 契约同款）：脚本可用 PI_WEB_SESSION_ID / PI_WEB_PROJECT_DIR 定位。
    env: {
      PI_WEB_SESSION_ID: String(conversationId),
      PI_WEB_PROJECT_DIR: plan.workspace?.path ?? input.cwd,
    },
  })
  result.runs.forEach((run, i) => {
    const meta = plan.expected[i]
    captureRecord(options, conversationId, {
      event,
      source: meta?.source ?? 'user',
      matcher: meta?.matcher,
      command: meta?.entry.command ?? '',
      outcome: run.outcome,
      durationMs: run.durationMs,
      exitCode: run.exitCode,
      ...(run.error === undefined ? {} : { error: run.error }),
    })
  })
  return result
}

/**
 * 功能：构造 stdin 基础载荷（snake_case 兼容字段）。
 * @param event 事件名。
 * @param conversationId 会话 id。
 * @param workspace 工作区（缺省回落 process.cwd()）。
 * @param extra 事件专属字段。
 * @returns HookRunInput。
 */
function baseInput(event: HookEvent, conversationId: ConversationId, workspace: WorkspaceRef | undefined, extra: Record<string, unknown>): HookRunInput {
  return { hook_event_name: event, session_id: String(conversationId), cwd: workspace?.path ?? process.cwd(), ...extra }
}

/**
 * 功能：从工具结果 diagnostics 提取错误消息（PostToolUseFailure 的 error 字段）。
 * @param result 工具执行结果。
 * @returns 首条 error 级诊断消息；无则回落 isError 提示。
 */
function failureMessage(result: ToolExecutionResult): string {
  const diagnostic = result.diagnostics?.find(item => item.severity === 'error')
  return diagnostic?.message ?? '工具执行失败'
}

/**
 * 功能：聚合本轮修改文件——write/edit/multi_edit 成功调用（含嵌套）的 path/file_path 去重累积。
 * 内部逻辑：读改写全部在 commit 事务内（并行工具轮不丢更新），状态落会话 doc 而非 memo
 * （memo 是 per-task 的，跨不到 Stop 的 generation task）。
 * @param api 钩子 api（commit 窄化）。
 * @param call 工具调用。
 * @param context 执行上下文。
 */
async function aggregateChangedFiles(api: HookApi, call: ToolHookCall, context: Context): Promise<void> {
  if (!FILE_WRITE_TOOLS.has(call.name.toLowerCase())) return
  const args = call.arguments as Record<string, unknown>
  const path = typeof args.path === 'string' ? args.path : typeof args.file_path === 'string' ? args.file_path : undefined
  if (path === undefined || path === '') return
  await (api as CommittingHookApi).commit(async (tx) => {
    const state = await tx.doc(HooksState, api.conversationId)
    const current = state.changedFiles ?? []
    if (!current.includes(path)) state.changedFiles = [...current, path]
  }, context)
}

/**
 * 功能：PreToolUse 适配——模型直发调用默认全拦，嵌套调用仅 includeNested:true 条目参与；
 * block 返回阻断原因，updatedInput 替换调用参数，放行时 additionalContext 暂存 memo
 * 供 afterTool 注入（内核 beforeTool 无注入通道）。
 */
function createPreToolUseHook(options: HooksExtensionOptions) {
  return async (call: ToolHookCall, api: HookApi, context: Context): Promise<{ arguments?: JsonObject; block?: string } | undefined> => {
    try {
      const nested = call.parent !== undefined
      const plan = await planEvent(options, 'PreToolUse', call.name, api.conversationId, context, nested)
      if (plan.groups.length === 0) return undefined
      const input = baseInput('PreToolUse', api.conversationId, plan.workspace, {
        tool_name: call.name,
        tool_input: call.arguments,
        tool_use_id: call.id,
      })
      const result = await executeEvent(options, plan, 'PreToolUse', call.name, input, api.conversationId, context)
      if (result.block) return { block: result.blockReason ?? 'hook 阻断' }
      if (result.additionalContext !== undefined) {
        await api.memo(`hooks:preContext:${call.id}`, result.additionalContext, context)
      }
      // stdout JSON 解析产物必为 JSON 值；schema 的 z.unknown() 宽类型在此窄化。
      if (result.updatedInput !== undefined) return { arguments: result.updatedInput as JsonObject }
      return undefined
    } catch (error) {
      captureRecord(options, api.conversationId, { event: 'PreToolUse', source: 'user', command: '', outcome: 'failed', durationMs: 0, exitCode: -1, error: `hooks 子系统异常：${error instanceof Error ? error.message : String(error)}` })
      return undefined
    }
  }
}

/**
 * 功能：PostToolUse/PostToolUseFailure 适配——成功走 PostToolUse（stdin 带 tool_response），
 * 失败走 PostToolUseFailure（stdin 带 error 与 is_interrupt:false）；additionalContext
 * 追加到结果 output 末尾（含 PreToolUse 暂存部分）；成功写文件调用聚合 changedFiles。
 */
function createPostToolUseHook(options: HooksExtensionOptions) {
  return async (call: ToolHookCall, result: ToolExecutionResult, api: HookApi, context: Context): Promise<ToolExecutionResult | undefined> => {
    try {
      const failed = result.isError === true
      const event: HookEvent = failed ? 'PostToolUseFailure' : 'PostToolUse'
      const plan = await planEvent(options, event, call.name, api.conversationId, context, call.parent !== undefined)
      let next = result
      if (plan.groups.length > 0) {
        const input = baseInput(event, api.conversationId, plan.workspace, {
          tool_name: call.name,
          tool_input: call.arguments,
          tool_use_id: call.id,
          ...(failed ? { error: failureMessage(result), is_interrupt: false } : { tool_response: result }),
        })
        const run = await executeEvent(options, plan, event, call.name, input, api.conversationId, context)
        const preContext = await api.memo<string>(`hooks:preContext:${call.id}`, context)
        const contextText = [preContext, run.additionalContext].filter((part): part is string => typeof part === 'string' && part !== '').join('\n')
        if (contextText !== '') {
          next = { ...result, output: [...(result.output ?? []), { type: 'text' as const, text: `\n\n[hook context]\n${contextText}` }] }
        }
      }
      if (!failed) await aggregateChangedFiles(api, call, context)
      return next === result ? undefined : next
    } catch (error) {
      captureRecord(options, api.conversationId, { event: 'PostToolUse', source: 'user', command: '', outcome: 'failed', durationMs: 0, exitCode: -1, error: `hooks 子系统异常：${error instanceof Error ? error.message : String(error)}` })
      return undefined
    }
  }
}

/**
 * 功能：Stop 适配（onYield）——有 pending 提问不续跑（goal.ts 同款）；续跑计数达
 * MAX_STOP_CONTINUATIONS 硬停；hook block 且有原因/上下文时续跑一轮并清空 changedFiles；
 * 无论是否配置 Stop hook 都清空 changedFiles（防跨轮泄漏）。
 * 内部逻辑：状态读改写走会话 doc 的 commit 事务（goal 同款），计数与清空同事务落盘，
 * 两次 generation 不会重复计数；无 hook 且 changedFiles 已空时不写事务（免每轮开销）。
 */
function createStopHook(options: HooksExtensionOptions) {
  return async (answer: AssistantMessage, api: HookApi, context: Context): Promise<{ continue: string } | undefined> => {
    try {
      if (awaitingUser(await api.snapshot(Interactions, api.conversationId, context))) return undefined
      const state = await api.snapshot(HooksState, api.conversationId, context)
      const count = state?.stopContinuations ?? 0
      if (count >= MAX_STOP_CONTINUATIONS) return undefined
      const plan = await planEvent(options, 'Stop', undefined, api.conversationId, context, false)
      const changedFiles = state?.changedFiles ?? []
      const hadChangedFiles = changedFiles.length > 0
      if (plan.groups.length === 0 && !hadChangedFiles) return undefined
      let continuation: string | undefined
      if (plan.groups.length > 0) {
        const preview = answer.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n').slice(0, ANSWER_PREVIEW_LIMIT)
        const input = baseInput('Stop', api.conversationId, plan.workspace, {
          stop_hook_active: count > 0,
          last_assistant_message: preview,
          changed_files: changedFiles,
        })
        const result = await executeEvent(options, plan, 'Stop', undefined, input, api.conversationId, context)
        if (result.block && (result.blockReason !== undefined || result.additionalContext !== undefined)) {
          continuation = `${STOP_CONTINUATION_PREFIX} ${result.blockReason ?? result.additionalContext}`
        }
      }
      await (api as CommittingHookApi).commit(async (tx) => {
        const doc = await tx.doc(HooksState, api.conversationId)
        if (continuation !== undefined) doc.stopContinuations = (doc.stopContinuations ?? 0) + 1
        doc.changedFiles = []
      }, context)
      return continuation === undefined ? undefined : { continue: continuation }
    } catch (error) {
      captureRecord(options, api.conversationId, { event: 'Stop', source: 'user', command: '', outcome: 'failed', durationMs: 0, exitCode: -1, error: `hooks 子系统异常：${error instanceof Error ? error.message : String(error)}` })
      return undefined
    }
  }
}

/**
 * 功能：PreCompact 适配——block（decision:block 或 exit 2）→ decline 拒绝压缩；
 * 否则消费 hookSpecificOutput.summary（passthrough 字段）作为替代摘要；无则不干预。
 */
function createPreCompactHook(options: HooksExtensionOptions) {
  return async (
    compaction: { reason: string; messages: readonly unknown[] },
    api: HookApi,
    context: Context,
  ): Promise<{ decline: true } | { summary: string } | undefined> => {
    try {
      const plan = await planEvent(options, 'PreCompact', undefined, api.conversationId, context, false)
      if (plan.groups.length === 0) return undefined
      const input = baseInput('PreCompact', api.conversationId, plan.workspace, {
        reason: compaction.reason,
        message_count: compaction.messages.length,
      })
      const result = await executeEvent(options, plan, 'PreCompact', undefined, input, api.conversationId, context)
      if (result.block) return { decline: true }
      for (const run of result.runs) {
        const summary = (run.output?.hookSpecificOutput as Record<string, unknown> | undefined)?.summary
        if (typeof summary === 'string' && summary !== '') return { summary }
      }
      return undefined
    } catch (error) {
      captureRecord(options, api.conversationId, { event: 'PreCompact', source: 'user', command: '', outcome: 'failed', durationMs: 0, exitCode: -1, error: `hooks 子系统异常：${error instanceof Error ? error.message : String(error)}` })
      return undefined
    }
  }
}

/**
 * 功能：真实用户输入时重置 Stop 续跑计数——「最多连续 3 次」的连续语义（ZCode 同款）。
 * 内部逻辑：续跑移交会创建新 generation task（taskId 不可用于区分 run），改以消息内容
 * 判别：最后一条 user 消息不带续跑前缀即为真实输入。仅在已提交计数非零时检查与写事务
 * （免每请求开销）；重置在 commit 内复核，避免与并发续跑交叉。
 */
function createStopCountResetHook(options: HooksExtensionOptions) {
  return async (request: { readonly messages: readonly { role: string; content?: unknown }[] }, api: HookApi, context: Context): Promise<undefined> => {
    try {
      const state = await api.snapshot(HooksState, api.conversationId, context)
      if ((state?.stopContinuations ?? 0) === 0) return undefined
      const lastUser = [...request.messages].reverse().find(message => message.role === 'user')
      const content = lastUser?.content
      const text = typeof content === 'string'
        ? content
        : Array.isArray(content) ? content.map(block => (block as { type?: string; text?: string }).type === 'text' ? (block as { text?: string }).text ?? '' : '').join('') : ''
      if (!text.startsWith(STOP_CONTINUATION_PREFIX)) {
        await (api as CommittingHookApi).commit(async (tx) => {
          const doc = await tx.doc(HooksState, api.conversationId)
          doc.stopContinuations = 0
        }, context)
      }
    } catch {
      // 重置失败不阻断请求；计数上限仍兜底防无限续跑。
    }
    return undefined
  }
}

/**
 * 功能：装配 hooks 扩展——注册 ToolTask（beforeTool/afterTool）、GenerationTask（onYield
 * 与续跑计数重置）、CompactionTask（beforeCompact）三组内核钩子，把用户/项目级 hooks
 * 配置接到会话生命周期。
 * @param options store、工作区解析与可选采集回调。
 * @returns 名为 `hooks` 的扩展。
 */
export function createHooksExtension(options: HooksExtensionOptions): Extension {
  return defineExtension({
    name: HOOKS_EXTENSION_NAME,
    hooks: [
      hook(ToolTask, {
        beforeTool: createPreToolUseHook(options),
        afterTool: createPostToolUseHook(options),
      }),
      hook(GenerationTask, { onYield: createStopHook(options), beforeRequest: createStopCountResetHook(options) }),
      hook(CompactionTask, { beforeCompact: createPreCompactHook(options) }),
    ],
  })
}