import { z } from 'zod'
import {
  configDefaults,
  hooksConfigSchema,
  HOOK_EVENTS,
  type HookEntry,
  type HookEvent,
  type HooksConfig,
} from '../hooks/schema.ts'
import { flattenEventEntries, hookDigest, HooksStore, locateEntry } from '../hooks/store.ts'

/**
 * 功能：hooks 设置页 feature 服务——双来源（用户级/项目级）清单投影、配置写回、
 * 信任批准/撤销、条目删除与启停。路由层（app.ts）只做 HTTP 映射，业务都在这里。
 * 内部逻辑：list 把项目级条目的 digest 与信任集比对产出 trust 状态（store 损坏→blocked，
 * fail-closed 展示）；save 整体替换来源配置但**不自动 admit**——设置页编辑项目级配置后
 * 新 digest 自然回落 pending，须显式批准，这是与 manage_hooks（agent 创建即用户确认）
 * 不同的安全边界。
 */

/** 设置页的一条 hook 视图：index 与 manage_hooks 工具同口径（事件内展开序号）。 */
export interface HookEntryView {
  event: HookEvent
  matcher?: string
  index: number
  entry: HookEntry
  digest: string
  trust: 'not_required' | 'trusted' | 'pending' | 'blocked'
}

/** 一个配置来源的视图。 */
export interface HookSourceView {
  path: string
  enabled: boolean
  timeoutMs: number
  maxOutputBytes: number
  error?: string
  entries: HookEntryView[]
}

/** hooks 清单视图：用户级恒在，项目级仅在有工作区时出现。 */
export interface HooksListView {
  user: HookSourceView
  project?: HookSourceView
}

/** 写回输入：scope + 可选 workspaceId + 完整配置块。 */
export const hooksSaveSchema = z.object({
  scope: z.enum(['user', 'project']),
  workspaceId: z.string().min(1).optional(),
  config: hooksConfigSchema,
}).strict()
export type HooksSaveInput = z.infer<typeof hooksSaveSchema>

/** 信任操作输入。 */
export const hooksTrustSchema = z.object({
  workspaceId: z.string().min(1),
  digest: z.string().regex(/^[0-9a-f]{64}$/),
}).strict()
export type HooksTrustInput = z.infer<typeof hooksTrustSchema>

/** 条目操作输入（删除/启停）：scope + 事件 + 事件内 index。 */
export const hooksEntrySchema = z.object({
  scope: z.enum(['user', 'project']),
  workspaceId: z.string().min(1).optional(),
  event: z.enum(HOOK_EVENTS),
  index: z.number().int().min(0),
})
export type HooksEntryInput = z.infer<typeof hooksEntrySchema>

export interface HooksFeatureOptions {
  store: HooksStore
  /** 工作区 ID → 绝对路径；不存在返回 undefined。 */
  workspacePath: (workspaceId: string) => string | undefined
}

/**
 * 功能：创建 hooks feature 服务。
 * @param options store 与工作区路径解析。
 * @returns list/save/trust/revoke/removeEntry/setEnabled 六个方法。
 */
export function createHooksFeature(options: HooksFeatureOptions) {
  const { store, workspacePath } = options

  /** 解析项目级工作区路径；缺失抛中文错误。 */
  const requireProjectPath = (workspaceId: string | undefined): string => {
    if (workspaceId === undefined) throw new Error('项目级钩子需要指定工作区')
    const path = workspacePath(workspaceId)
    if (path === undefined) throw new Error(`工作区不存在：${workspaceId}`)
    return path
  }

  /** 投影一个来源的视图；project 来源附带 trust 状态。 */
  const sourceView = async (
    loaded: Awaited<ReturnType<HooksStore['load']>>,
    project: { workspaceId: string } | undefined,
  ): Promise<HookSourceView> => {
    const defaults = configDefaults(loaded.config)
    const view: HookSourceView = {
      path: loaded.path,
      enabled: loaded.config?.enabled !== false,
      timeoutMs: defaults.timeoutMs,
      maxOutputBytes: defaults.maxOutputBytes,
      ...(loaded.error !== undefined ? { error: loaded.error } : {}),
      entries: [],
    }
    if (loaded.config === undefined) return view
    const trusted = project !== undefined ? await store.trustedDigests(project.workspaceId) : undefined
    for (const event of HOOK_EVENTS) {
      for (const flat of flattenEventEntries(loaded.config, event)) {
        const digest = hookDigest(event, flat.matcher, flat.entry, defaults)
        const trust: HookEntryView['trust'] = project === undefined
          ? 'not_required'
          : trusted === undefined ? 'blocked' : trusted.has(digest) ? 'trusted' : 'pending'
        view.entries.push({ event, matcher: flat.matcher, index: flat.index, entry: flat.entry, digest, trust })
      }
    }
    return view
  }

  /** 读取来源配置用于写操作；损坏的配置拒绝写（避免覆盖用户可修复的文件）。 */
  const loadForWrite = async (scope: 'user' | 'project', workspaceId: string | undefined): Promise<{ config: HooksConfig; path: string }> => {
    const path = scope === 'user' ? store.userConfigPath() : store.projectConfigPath(requireProjectPath(workspaceId))
    const loaded = await store.load(path)
    if (loaded.error !== undefined) throw new Error(loaded.error)
    return { config: loaded.config ?? {}, path }
  }

  /** 双来源清单（含 trust 状态与来源级默认值）。 */
  const list = async (workspaceId?: string): Promise<HooksListView> => {
    const user = await sourceView(await store.loadUser(), undefined)
    if (workspaceId === undefined) return { user }
    const path = workspacePath(workspaceId)
    if (path === undefined) return { user }
    return { user, project: await sourceView(await store.loadProject(path), { workspaceId }) }
  }

  return {
    list,

    /** 整体替换来源配置；项目级编辑不自动批准（新 digest 回落 pending）。 */
    save: async (input: HooksSaveInput): Promise<HooksListView> => {
      if (input.scope === 'user') await store.saveUser(input.config)
      else await store.saveProject(requireProjectPath(input.workspaceId), input.config)
      return await list(input.workspaceId)
    },

    /** 批准一条项目级 hook。 */
    trust: async (input: HooksTrustInput): Promise<void> => {
      await store.admit(input.workspaceId, input.digest)
    },

    /** 撤销一条项目级 hook 的信任。 */
    revoke: async (input: HooksTrustInput): Promise<void> => {
      await store.revoke(input.workspaceId, input.digest)
    },

    /** 删除条目（空组清理）；项目级同时撤销对应 digest。 */
    removeEntry: async (input: HooksEntryInput): Promise<HooksListView> => {
      const { config } = await loadForWrite(input.scope, input.workspaceId)
      const located = locateEntry(config, input.event, input.index)
      if (located === undefined) throw new Error(`钩子条目不存在：${input.event} #${String(input.index)}`)
      const groups = config.events?.[input.event]
      if (groups === undefined) throw new Error(`钩子条目不存在：${input.event}`)
      const group = groups[located.groupIndex]
      const entry = group.hooks[located.hookIndex]
      if (input.scope === 'project' && input.workspaceId !== undefined) {
        const defaults = configDefaults(config)
        await store.revoke(input.workspaceId, hookDigest(input.event, group.matcher, entry, defaults)).catch(() => undefined)
      }
      group.hooks.splice(located.hookIndex, 1)
      if (group.hooks.length === 0) groups.splice(located.groupIndex, 1)
      if (groups.length === 0 && config.events !== undefined) delete config.events[input.event]
      if (input.scope === 'user') await store.saveUser(config)
      else await store.saveProject(requireProjectPath(input.workspaceId), config)
      return await list(input.workspaceId)
    },

    /** 启停单条 hook（enabled 不参与 digest，启停不改变信任状态）。 */
    setEnabled: async (input: HooksEntryInput & { enabled: boolean }): Promise<HooksListView> => {
      const { config } = await loadForWrite(input.scope, input.workspaceId)
      const located = locateEntry(config, input.event, input.index)
      if (located === undefined) throw new Error(`钩子条目不存在：${input.event} #${String(input.index)}`)
      const groups = config.events?.[input.event]
      if (groups === undefined) throw new Error(`钩子条目不存在：${input.event}`)
      groups[located.groupIndex].hooks[located.hookIndex].enabled = input.enabled
      if (input.scope === 'user') await store.saveUser(config)
      else await store.saveProject(requireProjectPath(input.workspaceId), config)
      return await list(input.workspaceId)
    },
  }
}

export type HooksFeature = ReturnType<typeof createHooksFeature>