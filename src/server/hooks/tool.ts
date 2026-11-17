import type { Context } from '@earendil-works/chord/context'
import { defineExtension, defineTool, type ConversationId, type Extension, type JsonObject, type ToolExecutionApi } from '@earendil-works/pi-durable'
import { Type, type Static } from '@earendil-works/pi-ai'
import {
  DEFAULT_TIMEOUT_MS,
  HOOK_EVENTS,
  hookEntrySchema,
  type HookEntry,
  type HookEvent,
  type HooksConfig,
  type MatcherGroup,
} from './schema.ts'
import { configDefaults, flattenEventEntries, hookDigest, locateEntry, type HooksStore } from './store.ts'
import type { WorkspaceRef } from './extension.ts'

/**
 * 功能：manage_hooks 工具——用户/项目级 hooks 的一站式管理（list/create/update/delete/set_enabled）。
 * 内部逻辑：写操作先过 canWrite 授权门；create 支持 script 落盘 + 配置追加 + 项目级自动信任
 * （agent 经用户确认创建即视为批准）；update/delete 维护 digest 信任的增删；index 定位复用
 * store 的 flattenEventEntries/locateEntry 口径（与设置页一致）。
 */

/** manage_hooks 的装配选项。 */
export interface ManageHooksToolOptions {
  store: HooksStore
  /** 写操作授权门；false 拒绝（如只读会话）。 */
  canWrite: (conversationId: ConversationId, context: Context) => Promise<boolean>
  /** 解析会话当前工作区；无工作区返回 undefined（项目级操作拒绝）。 */
  resolveWorkspace: (conversationId: ConversationId, context: Context) => Promise<WorkspaceRef | undefined>
}

/** manage_hooks 扩展注册名，供装配引用。 */
export const MANAGE_HOOKS_EXTENSION_NAME = 'manage-hooks'

/** 工具参数 schema：action/scope 必填，其余按动作可选。 */
const parameters = Type.Object({
  action: Type.Union([
    Type.Literal('list'), Type.Literal('create'), Type.Literal('update'), Type.Literal('delete'), Type.Literal('set_enabled'),
  ], { description: 'list 列出双来源条目与信任状态；create 创建；update 按 index 替换；delete 删除；set_enabled 启停。' }),
  scope: Type.Union([Type.Literal('user'), Type.Literal('project')], { description: 'user 用户级（本机个人习惯）；project 项目级（随仓库共享）。' }),
  event: Type.Optional(Type.Union(HOOK_EVENTS.map(event => Type.Literal(event)), { description: '钩子事件名。' })),
  matcher: Type.Optional(Type.String({ description: '工具名匹配（精确列表如 Write|Edit，或正则）；缺省匹配全部。create/update 用。' })),
  hook: Type.Optional(Type.Object({
    type: Type.Union([Type.Literal('process'), Type.Literal('command')], { description: 'process 型 argv 直传不经 shell（跨平台首选）；command 型整条 shell 字符串。' }),
    command: Type.String({ description: 'process 型为程序路径（如 node）；command 型为 shell 命令。' }),
    args: Type.Optional(Type.Array(Type.String(), { description: 'process 型参数列表（如 ["hook-scripts/check.mjs"]）。' })),
    timeoutMs: Type.Optional(Type.Number({ description: '超时毫秒；缺省用来源级默认（全局默认 15000）。须经用户确认。' })),
    enabled: Type.Optional(Type.Boolean()),
    includeNested: Type.Optional(Type.Boolean({ description: '仅 PreToolUse 有意义：true 时也拦 codemode 嵌套调用，缺省 false 只拦模型直发。' })),
    statusMessage: Type.Optional(Type.String({ description: '运行时展示给用户的状态文案。' })),
  }, { description: '钩子定义；create/update 必填。' })),
  script: Type.Optional(Type.Object({
    name: Type.String({ description: '脚本文件名（如 check.mjs），落入对应来源的 hook-scripts 目录。' }),
    content: Type.String({ description: '脚本内容；推荐 node .mjs 跨平台写法。' }),
  }, { description: '可选：create 时一站式落盘脚本。' })),
  index: Type.Optional(Type.Number({ description: '事件内条目序号（list 返回的 index，从 0 连续计数）；update/delete/set_enabled 必填。' })),
  enabled: Type.Optional(Type.Boolean({ description: 'set_enabled 的目标状态。' })),
})

/** 工具参数静态类型。 */
type ManageHooksArgs = Static<typeof parameters>

/** 工具输出文本与结构化 details。 */
interface ToolOutput {
  output: Array<{ type: 'text'; text: string }>
  details: JsonObject
}

/** 输出构造助手（details 均为配置/字面量产物，必为 JSON 值）。 */
function textOutput(text: string, details: object): ToolOutput {
  return { output: [{ type: 'text', text }], details: details as JsonObject }
}

/**
 * 功能：校验事件名合法（HOOK_EVENTS 之一）。
 * @param event 模型传入的事件名。
 * @returns 窄化后的 HookEvent。
 */
function requireEvent(event: string | undefined): HookEvent {
  if (event === undefined || !(HOOK_EVENTS as readonly string[]).includes(event)) {
    throw new Error(`缺少或非法的 event：${event ?? '(未提供)'}；可选值：${HOOK_EVENTS.join(' / ')}`)
  }
  return event as HookEvent
}

/**
 * 功能：校验并规范化 hook 定义（经基础层 hookEntrySchema，拒绝非法字段类型）。
 * @param hook 模型传入的 hook 对象。
 * @returns 校验后的 HookEntry。
 */
function requireHook(hook: unknown): HookEntry {
  const parsed = hookEntrySchema.safeParse(hook)
  if (!parsed.success) throw new Error(`hook 定义不合法：${parsed.error.issues.map(issue => `${issue.path.join('.')} ${issue.message}`).join('；')}`)
  return parsed.data
}

/**
 * 功能：解析写操作的目标来源配置与工作区（project 无工作区即拒绝）。
 * @param options 工具选项。
 * @param scope 来源级别。
 * @param api 工具执行 api。
 * @param context 执行上下文。
 * @returns 当前配置（缺失为空对象）、工作区引用与落盘函数。
 */
async function resolveSource(options: ManageHooksToolOptions, scope: 'user' | 'project', api: ToolExecutionApi, context: Context) {
  if (scope === 'user') {
    const loaded = await options.store.loadUser()
    return {
      config: loaded.config ?? {},
      workspace: undefined as WorkspaceRef | undefined,
      save: (config: HooksConfig) => options.store.saveUser(config),
      scriptsDir: options.store.userScriptsDir(),
    }
  }
  const workspace = await options.resolveWorkspace(api.conversationId, context)
  if (workspace === undefined) throw new Error('当前会话没有工作区，无法管理项目级钩子')
  const loaded = await options.store.loadProject(workspace.path)
  return {
    config: loaded.config ?? {},
    workspace,
    save: (config: HooksConfig) => options.store.saveProject(workspace.path, config),
    scriptsDir: options.store.projectScriptsDir(workspace.path),
  }
}

/**
 * 功能：把新条目追加到事件的 matcher 组——已有同 matcher 组则并入，否则新建组。
 * @param config 来源配置（原地修改）。
 * @param event 事件名。
 * @param matcher 组 matcher（缺省归一化为 undefined）。
 * @param entry 新条目。
 */
function appendEntry(config: HooksConfig, event: HookEvent, matcher: string | undefined, entry: HookEntry): void {
  const events = (config.events ??= {})
  const groups = (events[event] ??= [])
  const existing = groups.find(group => (group.matcher ?? '') === (matcher ?? ''))
  if (existing) existing.hooks.push(entry)
  else groups.push({ ...(matcher === undefined ? {} : { matcher }), hooks: [entry] })
}

/**
 * 功能：按 index 定位条目（复用 store.locateEntry 口径），越界抛中文错误。
 * @param config 来源配置。
 * @param event 事件名。
 * @param index 事件内序号。
 * @returns 组下标、组内下标与条目本身。
 */
function locateOrThrow(config: HooksConfig, event: HookEvent, index: number | undefined): { groupIndex: number; hookIndex: number; entry: HookEntry } {
  if (index === undefined || !Number.isSafeInteger(index) || index < 0) throw new Error('该操作需要 index（list 返回的事件内条目序号，从 0 起）')
  const located = locateEntry(config, event, index)
  if (located === undefined) throw new Error(`index ${index} 越界：事件 ${event} 下没有该条目；先用 list 查看当前序号`)
  const entry = config.events?.[event]?.[located.groupIndex]?.hooks[located.hookIndex]
  if (entry === undefined) throw new Error(`index ${index} 定位失败：条目不存在`)
  return { ...located, entry }
}

/**
 * 功能：list——双来源全部条目 + trust 状态 + 来源级默认值。
 * 内部逻辑：user 条目 trust 恒为 not_required；project 按 digest 比对 trusted/pending，
 * trust store 损坏时全部 blocked（fail-closed 口径与执行层一致）。
 */
async function listHooks(options: ManageHooksToolOptions, api: ToolExecutionApi, context: Context): Promise<ToolOutput> {
  const workspace = await options.resolveWorkspace(api.conversationId, context)
  const user = await options.store.loadUser()
  const project = workspace === undefined ? undefined : await options.store.loadProject(workspace.path)
  const trusted = workspace === undefined ? new Set<string>() : await options.store.trustedDigests(workspace.id)
  const sources: Array<Record<string, unknown>> = []
  const lines: string[] = []
  for (const source of ['user', 'project'] as const) {
    const loaded = source === 'user' ? user : project
    const defaults = configDefaults(loaded?.config)
    const flat = HOOK_EVENTS.flatMap(event => flattenEventEntries(loaded?.config, event).map(item => ({ event, ...item })))
    const rows = flat.map(item => {
      const trust = source === 'user'
        ? 'not_required'
        : trusted === undefined
          ? 'blocked'
          : trusted.has(hookDigest(item.event, item.matcher, item.entry, defaults)) ? 'trusted' : 'pending'
      return { ...item, trust }
    })
    sources.push({
      source,
      enabled: loaded?.config?.enabled !== false,
      defaults,
      ...(loaded?.error === undefined ? {} : { error: loaded.error }),
      entries: rows,
    })
    lines.push(`【${source === 'user' ? '用户级' : '项目级'}】${loaded === undefined ? '（当前会话无工作区）' : `enabled=${String(loaded.config?.enabled !== false)}，默认超时 ${defaults.timeoutMs}ms`}`)
    if (loaded?.error !== undefined) lines.push(`  配置损坏：${loaded.error}`)
    if (rows.length === 0) lines.push('  （无条目）')
    for (const row of rows) {
      lines.push(`  [${row.index}] ${row.event}${row.matcher === undefined ? '' : ` matcher=${row.matcher}`} ${row.entry.type}:${row.entry.command}${row.entry.args === undefined ? '' : ` ${row.entry.args.join(' ')}`} enabled=${String(row.entry.enabled !== false)} trust=${row.trust}`)
    }
  }
  return textOutput(lines.join('\n'), { sources })
}

/**
 * 功能：create——校验 hook、可选 script 落盘、追加配置、项目级自动信任、落盘。
 * 内部逻辑：agent 创建须经用户确认（描述硬约束），故项目级新增条目直接 admit；
 * 脚本先于配置写入，脚本失败不留半截配置。
 */
async function createHook(options: ManageHooksToolOptions, args: ManageHooksArgs, api: ToolExecutionApi, context: Context): Promise<ToolOutput> {
  const event = requireEvent(args.event)
  const entry = requireHook(args.hook)
  const source = await resolveSource(options, args.scope, api, context)
  let scriptPath: string | undefined
  if (args.script !== undefined) {
    scriptPath = await options.store.writeScript(source.scriptsDir, args.script.name, args.script.content)
  }
  appendEntry(source.config, event, args.matcher, entry)
  const defaults = configDefaults(source.config)
  if (source.workspace !== undefined) {
    await options.store.admit(source.workspace.id, hookDigest(event, args.matcher, entry, defaults))
  }
  await source.save(source.config)
  const flat = flattenEventEntries(source.config, event)
  const index = flat[flat.length - 1]?.index
  const text = [
    `已创建${args.scope === 'user' ? '用户级' : '项目级'}钩子：${event}${args.matcher === undefined ? '' : `（matcher=${args.matcher}）`}，index=${String(index)}。`,
    scriptPath === undefined ? undefined : `脚本已写入：${scriptPath}`,
    source.workspace === undefined ? undefined : '项目级条目已自动信任（经用户确认创建）。',
    '立即生效，无需重启。',
  ].filter((line): line is string => line !== undefined).join('\n')
  return textOutput(text, { action: 'create', scope: args.scope, event, index, ...(scriptPath === undefined ? {} : { scriptPath }) })
}

/**
 * 功能：update——按 index 替换条目；项目级旧 digest revoke、新 digest admit。
 */
async function updateHook(options: ManageHooksToolOptions, args: ManageHooksArgs, api: ToolExecutionApi, context: Context): Promise<ToolOutput> {
  const event = requireEvent(args.event)
  const entry = requireHook(args.hook)
  const source = await resolveSource(options, args.scope, api, context)
  const { groupIndex, hookIndex, entry: old } = locateOrThrow(source.config, event, args.index)
  const group = source.config.events?.[event]?.[groupIndex]
  if (group === undefined) throw new Error(`事件 ${event} 的配置组缺失`)
  const defaults = configDefaults(source.config)
  if (source.workspace !== undefined) {
    await options.store.revoke(source.workspace.id, hookDigest(event, group.matcher, old, defaults))
    await options.store.admit(source.workspace.id, hookDigest(event, args.matcher ?? group.matcher, entry, defaults))
  }
  // matcher 变更时把条目迁到目标组（保持组语义）。
  const targetMatcher = args.matcher ?? group.matcher
  if ((targetMatcher ?? '') !== (group.matcher ?? '')) {
    group.hooks.splice(hookIndex, 1)
    if (group.hooks.length === 0) source.config.events?.[event]?.splice(groupIndex, 1)
    appendEntry(source.config, event, args.matcher, entry)
  } else {
    group.hooks[hookIndex] = entry
  }
  await source.save(source.config)
  return textOutput(`已更新${args.scope === 'user' ? '用户级' : '项目级'}钩子：${event} index=${String(args.index)}。立即生效，无需重启。`, { action: 'update', scope: args.scope, event, index: args.index })
}

/**
 * 功能：delete——移除条目并清理空组；项目级 revoke 对应 digest。
 */
async function deleteHook(options: ManageHooksToolOptions, args: ManageHooksArgs, api: ToolExecutionApi, context: Context): Promise<ToolOutput> {
  const event = requireEvent(args.event)
  const source = await resolveSource(options, args.scope, api, context)
  const { groupIndex, hookIndex, entry } = locateOrThrow(source.config, event, args.index)
  const groups = source.config.events?.[event]
  const group = groups?.[groupIndex]
  if (groups === undefined || group === undefined) throw new Error(`事件 ${event} 的配置组缺失`)
  if (source.workspace !== undefined) {
    await options.store.revoke(source.workspace.id, hookDigest(event, group.matcher, entry, configDefaults(source.config)))
  }
  group.hooks.splice(hookIndex, 1)
  if (group.hooks.length === 0) groups.splice(groupIndex, 1)
  if (groups.length === 0) delete source.config.events?.[event]
  await source.save(source.config)
  return textOutput(`已删除${args.scope === 'user' ? '用户级' : '项目级'}钩子：${event} index=${String(args.index)}。立即生效，无需重启。`, { action: 'delete', scope: args.scope, event, index: args.index })
}

/**
 * 功能：set_enabled——改条目 enabled（启停是管理操作，不影响 digest 信任）。
 */
async function setEnabled(options: ManageHooksToolOptions, args: ManageHooksArgs, api: ToolExecutionApi, context: Context): Promise<ToolOutput> {
  const event = requireEvent(args.event)
  if (args.enabled === undefined) throw new Error('set_enabled 需要 enabled（true 启用 / false 停用）')
  const source = await resolveSource(options, args.scope, api, context)
  const { groupIndex, hookIndex } = locateOrThrow(source.config, event, args.index)
  const group = source.config.events?.[event]?.[groupIndex]
  if (group === undefined) throw new Error(`事件 ${event} 的配置组缺失`)
  group.hooks[hookIndex] = { ...group.hooks[hookIndex], enabled: args.enabled }
  await source.save(source.config)
  return textOutput(`已${args.enabled ? '启用' : '停用'}${args.scope === 'user' ? '用户级' : '项目级'}钩子：${event} index=${String(args.index)}。立即生效，无需重启。`, { action: 'set_enabled', scope: args.scope, event, index: args.index, enabled: args.enabled })
}

/**
 * 功能：装配 manage_hooks 工具扩展——写操作先过 canWrite 门（拒绝时抛中文错误带修复指引），
 * list 只读不检查；任何错误直接 throw 中文文案由工具层呈现给模型。
 * @param options store、写授权门与工作区解析。
 * @returns 名为 `manage-hooks` 的扩展（含单个 manage_hooks 工具）。
 */
export function createManageHooksTool(options: ManageHooksToolOptions): Extension {
  const tool = defineTool({
    name: 'manage_hooks',
    description: [
      '管理用户级与项目级钩子：在工具调用前后、本轮结束（Stop）、压缩前（PreCompact）等事件自动运行脚本，实现检查、拦截、更新文档等自动化。',
      '创建或修改钩子前，必须先用 ask_user_question 向用户确认超时时间（默认推荐 15 秒，可选 5/30/60 秒或自定义）与级别（用户级/项目级）；未获答复不得创建。',
      '脚本推荐 node .mjs 跨平台写法：读 stdin 单行 JSON，exit 0 成功 / 2 阻断 / 其他失败，stdout 输出 JSON 决策。',
      'action=list 列出双来源全部条目、index 与信任状态（只读）；create 创建（可带 script 一站式落盘）；update 按 index 替换；delete 删除；set_enabled 启停。',
      '项目级钩子随仓库共享：经本工具确认创建的自动信任；外部带来的（如 git clone）默认 pending 不执行，须用户在设置页批准。',
    ].join(' '),
    parameters,
    /**
     * 功能：按 action 分派管理操作。
     * 权限：写操作（非 list）先过 canWrite；项目级操作须有工作区。
     */
    execute: async (args, api, context): Promise<ToolOutput> => {
      if (args.action !== 'list' && await options.canWrite(api.conversationId, context) !== true) {
        throw new Error('当前会话不允许管理钩子（写操作被拒绝）。请让用户在设置页手动管理，或确认会话具有写权限后重试。')
      }
      switch (args.action) {
        case 'list': return listHooks(options, api, context)
        case 'create': return createHook(options, args, api, context)
        case 'update': return updateHook(options, args, api, context)
        case 'delete': return deleteHook(options, args, api, context)
        case 'set_enabled': return setEnabled(options, args, api, context)
      }
    },
  })
  return defineExtension({ name: MANAGE_HOOKS_EXTENSION_NAME, tools: [tool] })
}