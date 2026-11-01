/**
 * Built-in delegation profiles (ZCode parity, Chinese adaptation) and the child-model
 * resolution both delegation tools share. `general-purpose` keeps the parent's tool set;
 * `Explore` narrows it to read-only search. The profiles replace the child conversation's
 * copied instructions, so a delegation runs as the profile, not as a copy of the parent.
 */
import type { ThinkingLevel } from '../../shared/types.ts'
import { clampThinkingLevel } from '../model/catalog.ts'
import { modelWithinAllowlist } from '../model/allowlist.ts'
import { RuntimeError } from '../runtime-errors.ts'
import type { SubagentProfile } from '../tools/subagent.ts'

/** One built-in profile as the delegation tools and the delegation section read it. */
export type BuiltinProfile = {
  name: SubagentProfile
  /** Directory-facing description (Chinese). */
  description: string
  /** One-line summary the delegation-policy section renders. */
  summary: string
  /** Replaces the child's copied instructions. */
  systemPrompt: string
  /** Tool-name whitelist; undefined keeps the parent's tool set. */
  readonlyTools?: string[]
}

export const BUILTIN_PROFILES: BuiltinProfile[] = [
  {
    name: 'general-purpose',
    description: '通用子智能体，用于调研复杂问题、检索代码和执行多步任务。当你要找一个关键词或文件且不确定几次内能命中时，把搜索交给它。',
    summary: '调研复杂问题、检索代码、执行多步任务；不确定几次搜索能否命中时，把搜索交给它。',
    systemPrompt: [
      '你是 pi-web 的子智能体，用可用工具完成被委派的任务。',
      '',
      '完整交付：把任务做完做对，不镀金，也不留半成品。完成时给一份简明汇报（做了什么、关键发现），调用方会把你的汇报转述给用户，只要要点。',
      '',
      '强项：跨大代码库搜索代码/配置/模式、多文件架构分析、多步调研。',
      '',
      '指南：',
      '- 不知道目标在哪就宽搜（按名称、按模式），知道路径就直接读取',
      '- 分析从宽到窄，第一个策略不中就换下一个',
      '- 彻底：检查多个位置、多种命名习惯和关联文件，不要第一处命中就停',
      '- 除非任务必要不创建新文件，优先修改现有文件，绝不主动创建 md/README 类文档文件',
    ].join('\n'),
  },
  {
    name: 'Explore',
    description: '只读检索子智能体，适合大范围扇出搜索——答案需要扫很多文件/目录/命名习惯、只要结论不要过程转储时用它。它读片段而非整文件，定位代码但不做审查。在任务 prompt 里写明检索广度：\'medium\'（一般摸底）或 \'very thorough\'（多位置+命名习惯）。',
    summary: '只读检索，大范围扇出搜索，只要结论不要过程转储；在任务里写明检索广度 medium 或 very thorough。',
    systemPrompt: [
      '你是 pi-web 的只读检索专家，用并行搜索快速定位代码，只返回结论。',
      '',
      '只读红线（任何情况下不得违反）：',
      '- 不创建、修改、删除、移动任何文件',
      '- 不创建临时文件',
      '- 不用重定向或管道写文件',
      '- 不运行任何改变系统状态的命令',
      '你的角色仅限搜索与分析既有代码。',
      '',
      '检索广度由调用方在任务里写明：medium 是一般摸底，覆盖主要位置；very thorough 要查多位置、多种命名习惯和关联文件。',
      '',
      '效率要求：',
      '- 用聪明的搜索方式，尽量在同一条回复里并行发起多个搜索调用',
      '- 结论直接写在最终回复里，不要写报告/总结类 md 文件',
      '- 引用绝对路径',
      '- 只在确凿处贴代码（bug 原文、被问到的函数签名），不要重述你读过的代码',
    ].join('\n'),
    readonlyTools: ['read', 'glob', 'grep', 'list_files', 'search_files'],
  },
]

/** The profile one delegation selected; the default `general-purpose` always resolves. */
export function profileByName(name: string | undefined): BuiltinProfile {
  return BUILTIN_PROFILES.find(profile => profile.name === name) ?? BUILTIN_PROFILES[0]!
}

/** A child model as the delegation tools accept it. */
export type ChildModelRef = { provider: string; modelId: string }

/** A validated child model pick: the model plus the thinking level the child should run at. */
export type ChildModelResolution = { model: ChildModelRef; thinkingLevel?: ThinkingLevel }

/**
 * Validate one child model pick against the catalog and the allowlist, then clamp the parent's
 * thinking level to what the selected model supports. Assembled by the runtime (where the model
 * runtime and app state live); the tools depend only on this signature.
 */
export type ChildModelResolver = (
  ref: ChildModelRef,
  parent: { thinkingLevel: ThinkingLevel },
) => ChildModelResolution

/** Build the runtime's `resolveChildModel` from the model catalog, the allowlist, and the level support. */
export function createChildModelResolver(deps: {
  models: { getModel(provider: string, modelId: string): unknown }
  allowlist: () => readonly string[] | undefined
  supportedThinkingLevels(provider: string, modelId: string): ThinkingLevel[] | undefined
}): ChildModelResolver {
  return (ref, parent) => {
    if (deps.models.getModel(ref.provider, ref.modelId) === undefined) {
      throw new RuntimeError('MODEL_UNAVAILABLE', '所选模型未出现在 Pi 模型目录中')
    }
    if (!modelWithinAllowlist(deps.allowlist(), ref)) {
      throw new RuntimeError('MODEL_UNAVAILABLE', '所选模型不在模型白名单内')
    }
    const supported = deps.supportedThinkingLevels(ref.provider, ref.modelId)
    const thinkingLevel = supported === undefined ? parent.thinkingLevel : clampThinkingLevel(parent.thinkingLevel, supported)
    return { model: { provider: ref.provider, modelId: ref.modelId }, thinkingLevel }
  }
}
