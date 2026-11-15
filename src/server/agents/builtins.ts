/**
 * 内置委派档案（对齐 ZCode、中文适配）与两个委派工具共用的子模型解析。
 * `general-purpose` 保留父会话的工具集；`Explore` 收窄为只读检索。
 * 档案会替换子会话复制来的指令，因此委派运行的是档案身份，而非父会话的副本。
 */
import type { ThinkingLevel } from '../../shared/types.ts'
import { clampThinkingLevel } from '../model/catalog.ts'
import { modelWithinAllowlist } from '../model/allowlist.ts'
import { RuntimeError } from '../runtime-errors.ts'
import { EXPLORE_TOOLS } from '../conversation/subagent-policy.ts'
import type { SubagentProfile } from '../tools/subagent.ts'

/** 一个内置档案，供委派工具与委派政策 section 读取。 */
export type BuiltinProfile = {
  name: SubagentProfile
  /** 面向目录（子智能体列表）的中文描述。 */
  description: string
  /** 委派政策 section 渲染的单行摘要。 */
  summary: string
  /** 替换子会话复制来的指令。 */
  systemPrompt: string
  /** 工具名白名单；undefined 表示保留父会话工具集。 */
  readonlyTools?: string[]
}

/** 两个内置委派档案：通用执行档与只读检索档；systemPrompt 为完整中文人设，委派时整体替换子会话指令。 */
export const BUILTIN_PROFILES: BuiltinProfile[] = [
  {
    name: 'general-purpose',
    description: '通用子智能体，用于实现、修复和复杂多步调研；只读代码检索优先交给 Explore。',
    summary: '执行实现、修复和复杂多步调研；只读代码检索优先交给 Explore。',
    systemPrompt: [
      '你是 pi-web 的子智能体，用可用工具完成被委派的任务。',
      '',
      '完整交付：把任务做完做对，不镀金，也不留半成品。完成时简明汇报做了什么、关键发现；涉及写入时，附实际执行的验证及结果，未运行的检查明确标注未运行。调用方会把你的汇报转述给用户，只要要点。',
      '',
      '强项：跨大代码库搜索代码/配置/模式、多文件架构分析、多步调研。',
      '',
      '指南：',
      '- 不知道目标在哪就宽搜（按名称、按模式），知道路径就直接读取',
      '- 分析从宽到窄，第一个策略不中就换下一个',
      '- 彻底：检查多个位置、多种命名习惯和关联文件，不要第一处命中就停',
      '- 除非任务必要不创建新文件，优先修改现有文件，绝不主动创建 md/README 类文档文件',
      '',
      '你在被委派的子会话中工作，结果交给委派方。需要用户决定或超出当前权限时，说明阻塞与建议，交由委派方处理；遵守适用的权限和模式约束。',
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
      '- 引用相关文件和具体位置，便于委派方核对',
      '- 只在确凿处贴代码（bug 原文、被问到的函数签名），不要重述你读过的代码',
      '',
      '你在被委派的子会话中工作，结果交给委派方。需要用户决定或超出当前权限时，说明阻塞与建议，交由委派方处理；遵守适用的权限和模式约束。',
    ].join('\n'),
    readonlyTools: [...EXPLORE_TOOLS],
  },
]

/**
 * 功能：按名字解析一次委派选中的档案；默认档案 `general-purpose` 永远可解析。
 * @param name 档案名；undefined 或未知名字时回落到 BUILTIN_PROFILES[0]。
 * @returns 对应的 BuiltinProfile。
 */
export function profileByName(name: string | undefined): BuiltinProfile {
  return BUILTIN_PROFILES.find(profile => profile.name === name) ?? BUILTIN_PROFILES[0]!
}

/** 委派工具接受的子模型引用：provider 与 modelId。 */
export type ChildModelRef = { provider: string; modelId: string }

/** 校验通过的子模型选择：模型本身加上子会话应运行的思考级别。 */
export type ChildModelResolution = { model: ChildModelRef; thinkingLevel?: ThinkingLevel }

/**
 * 子模型解析器签名：对照模型目录与白名单校验一次子模型选择，并把父会话的思考级别
 * 收敛到所选模型支持的范围内。由 runtime 装配（模型运行时与应用状态都在那里）；
 * 委派工具只依赖此签名。
 */
export type ChildModelResolver = (
  ref: ChildModelRef,
  parent: { thinkingLevel: ThinkingLevel },
) => ChildModelResolution

/**
 * 功能：由模型目录、白名单与思考级别支持集，装配运行时的 `resolveChildModel`。
 * @param deps.models 模型目录（getModel 返回 undefined 即目录中不存在）。
 * @param deps.allowlist 惰性读取的模型白名单；undefined 表示不限制。
 * @param deps.supportedThinkingLevels 查询模型支持的思考级别集合；undefined 表示不做收敛。
 * @returns ChildModelResolver 闭包；校验失败抛 MODEL_UNAVAILABLE 的 RuntimeError。
 * 内部逻辑：先查目录存在性，再过白名单；思考级别——模型未声明支持集时继承父级别，否则 clamp。
 */
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
