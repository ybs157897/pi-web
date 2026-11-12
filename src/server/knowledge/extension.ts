/**
 * doc-keeper 工具扩展：五个只读/受限写工具（detect_changes / read_knowledge / git_diff /
 * read_code / write_knowledge）、任务目标文档、仅维护会话可见的 policy section，以及把
 * write/edit 钉死在知识文档上的 wrap。
 *
 * 范围纪律与 bots 扩展一致：扩展注册进 registry 但被 `AGENT_EXCLUDED_EXTENSIONS` 排除，
 * 普通会话看不到它的工具与 section，提示词快照因此零 diff；doc-keeper 会话通过显式
 * `extensions add` opt-in。每个工具在执行边界重新校验会话 kind 与任务目标文档，越界即拒绝。
 * 工具后端全部调用 knowledge/core.ts 的纯函数，不依赖 bot 名册或 harness。
 */
import { isAbsolute, resolve } from 'node:path'
import type { Context } from '@earendil-works/chord/context'
import {
  defineDoc,
  defineExtension,
  defineTool,
  section,
  type Extension,
  type ToolExecutionApi,
  type ToolExecutionResult,
  type ToolRegistration,
} from '@earendil-works/pi-durable'
import { Type } from '@earendil-works/pi-ai'
import { CONVERSATION_KIND } from '../runtime/helpers.ts'
import { RuntimeError } from '../runtime-errors.ts'
import { argumentPath } from '../memory/store.ts'
import {
  KNOWLEDGE_BODY_CHAR_LIMIT, knowledgeAbsolutePath, parseFrontmatter, readKnowledgeFile, writeKnowledgeFile,
} from '../bots/docs.ts'
import { detectChanges, gitDiff, inspectDoc, readCodeFiles } from './core.ts'
import type { DocKeeperMode } from './prompt.ts'

export const DOC_KEEPER_EXTENSION_NAME = 'pi-web-doc-keeper'

export const DOC_KEEPER_TOOL_NAMES = ['detect_changes', 'read_knowledge', 'git_diff', 'read_code', 'write_knowledge'] as const

/**
 * 一次维护任务的目标参数，由服务在建会话时盖章。工具从这里取 repo/globs/docPath，
 * 模型无法把维护指向别的仓库或文档；botId/module 取自原文档 frontmatter，写回时原样保留。
 */
export const DocKeeperTask = defineDoc<{
  repo: string
  knowledgePath: string
  globs: string[]
  mode: DocKeeperMode
  botId: string
  module: string
}>({
  kind: 'pi-web.doc-keeper-task',
  version: 1,
  scope: 'conversation',
  history: 'latest',
  fork: 'initial',
  checkpointWhen: () => false,
  initial: () => ({ repo: '', knowledgePath: '', globs: [], mode: 'check', botId: '', module: '' }),
})

export type DocKeeperTaskShape = {
  repo: string
  knowledgePath: string
  globs: string[]
  mode: DocKeeperMode
  botId: string
  module: string
}

/** 校验调用方是 doc-keeper 维护会话并取出任务目标；其他会话一律拒绝。 */
async function requireTask(api: ToolExecutionApi, context: Context): Promise<DocKeeperTaskShape> {
  const kind = await api.snapshot(CONVERSATION_KIND, api.conversationId, context)
  if (kind?.kind !== 'docKeeper') throw new RuntimeError('FORBIDDEN', '该工具只能在 doc-keeper 维护会话中调用')
  const task = await api.snapshot(DocKeeperTask, api.conversationId, context)
  if (task === undefined || task.repo === '' || task.knowledgePath === '') {
    throw new RuntimeError('FORBIDDEN', '当前会话没有 doc-keeper 任务目标')
  }
  return task
}

/** 读取知识文档 frontmatter 的 updatedStamp，作为 git 变更窗口的起点。 */
async function updatedStampOf(task: DocKeeperTaskShape): Promise<string | undefined> {
  const content = await readKnowledgeFile(knowledgeAbsolutePath(task.repo, { knowledgePath: task.knowledgePath }))
  if (content === undefined) return undefined
  return parseFrontmatter(content)?.updatedStamp
}

function jsonText(value: unknown): Array<{ type: 'text'; text: string }> {
  return [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }]
}

export function createDocKeeperExtension(): Extension {
  /** 知识文档钉死：doc-keeper 会话的 write/edit 只允许改任务目标这一个文件。 */
  const knowledgeWraps: NonNullable<Extension['wraps']> = (['write', 'edit'] as const).map(toolName => ({
    tool: toolName,
    wrap: (tool: ToolRegistration): ToolRegistration => ({
      ...tool,
      execute: async (args: never, api: ToolExecutionApi, context: Context) => {
        const kind = await api.snapshot(CONVERSATION_KIND, api.conversationId, context)
        if (kind?.kind !== 'docKeeper') return tool.execute(args, api, context)
        const task = await api.snapshot(DocKeeperTask, api.conversationId, context)
        if (task === undefined || task.repo === '' || task.knowledgePath === '') return tool.execute(args, api, context)
        const target = argumentPath(args)
        if (target === undefined) return tool.execute(args, api, context)
        const cwd = api.env?.cwd ?? process.cwd()
        const allowed = resolve(task.repo, task.knowledgePath)
        const absoluteTarget = isAbsolute(target) ? resolve(target) : resolve(cwd, target)
        if (absoluteTarget === allowed) return tool.execute(args, api, context)
        throw new RuntimeError(
          'ACCESS_DENIED',
          `doc-keeper 的 write/edit 只允许修改知识文档 ${task.knowledgePath}；${target} 已被任务目标限制拒绝`,
        )
      },
    }),
  }))

  const detectChangesTool = defineTool({
    name: 'detect_changes',
    description: '检测关注路径 globs 自知识文档 updatedStamp 以来的 git 变更（提交数、提交摘要、变更文件）。只读，仅在 doc-keeper 维护会话可用。',
    parameters: Type.Object({}),
    execute: async (_args, api, context): Promise<ToolExecutionResult<Awaited<ReturnType<typeof detectChanges>>>> => {
      const task = await requireTask(api, context)
      const since = await updatedStampOf(task)
      const report = await detectChanges(task.repo, task.globs, since)
      return { output: jsonText(report), details: report }
    },
  })

  const readKnowledgeTool = defineTool({
    name: 'read_knowledge',
    description: '读取知识文档全文与体检结果（health：fresh/stale/drift/over-limit/unknown，detail，frontmatter，body）。只读，仅在 doc-keeper 维护会话可用。',
    parameters: Type.Object({}),
    execute: async (_args, api, context): Promise<ToolExecutionResult<Awaited<ReturnType<typeof inspectDoc>>>> => {
      const task = await requireTask(api, context)
      const inspection = await inspectDoc(task.repo, { knowledgePath: task.knowledgePath, globs: task.globs })
      return { output: jsonText(inspection), details: inspection }
    },
  })

  const gitDiffTool = defineTool({
    name: 'git_diff',
    description: '返回关注路径自 updatedStamp（或指定 since）以来的提交补丁（有字节上限）。只读，仅在 doc-keeper 维护会话可用。',
    parameters: Type.Object({
      since: Type.Optional(Type.String({ description: 'ISO 日期起点；缺省用文档 frontmatter 的 updatedStamp' })),
    }),
    execute: async (args, api, context): Promise<ToolExecutionResult<{ diff: string }>> => {
      const task = await requireTask(api, context)
      const since = args.since ?? await updatedStampOf(task)
      const diff = await gitDiff(task.repo, task.globs, since)
      return { output: [{ type: 'text' as const, text: diff === '' ? '（无补丁：无变更或 git 不可用）' : diff }], details: { diff } }
    },
  })

  const readCodeTool = defineTool({
    name: 'read_code',
    description: '有界读取仓库内指定代码文件（路径限制在 repo 根内，单文件与累计字节有上限）。只读，仅在 doc-keeper 维护会话可用。',
    parameters: Type.Object({
      paths: Type.Array(Type.String(), { minItems: 1, description: '相对 repo 根的文件路径列表' }),
    }),
    execute: async (args, api, context): Promise<ToolExecutionResult<{ files: Awaited<ReturnType<typeof readCodeFiles>> }>> => {
      const task = await requireTask(api, context)
      const files = await readCodeFiles(task.repo, args.paths)
      return { output: jsonText({ files }), details: { files } }
    },
  })

  const writeKnowledgeTool = defineTool({
    name: 'write_knowledge',
    description: '把新的正文写回知识文档（保留 frontmatter 与章节结构，原子写，更新 updatedStamp）。正文不得超过 8000 字符。仅在 doc-keeper 维护会话可用，且只能写任务目标文档。',
    parameters: Type.Object({
      body: Type.String({ description: '知识文档新正文（不含 frontmatter；保留 职责/关键文件/已知坑/changelog 章节）' }),
    }),
    execute: async (args, api, context): Promise<ToolExecutionResult<{ hash: string; knowledgePath: string }>> => {
      const task = await requireTask(api, context)
      if (args.body.length > KNOWLEDGE_BODY_CHAR_LIMIT) {
        throw new RuntimeError('INVALID_INPUT', `正文超过 ${KNOWLEDGE_BODY_CHAR_LIMIT} 字符（当前 ${args.body.length}），请精简到结论与索引后重试`)
      }
      const absolute = knowledgeAbsolutePath(task.repo, { knowledgePath: task.knowledgePath })
      const hash = await writeKnowledgeFile(
        absolute,
        { id: task.botId, name: task.botId, module: task.module, globs: [...task.globs] },
        args.body,
        new Date().toISOString(),
      )
      return {
        output: [{ type: 'text' as const, text: `已写回 ${task.knowledgePath}（hash ${hash.slice(0, 12)}…）。` }],
        details: { hash, knowledgePath: task.knowledgePath },
      }
    },
  })

  /** 维护会话专属 policy：每次请求重申任务目标与硬约束。普通会话不注入。 */
  const docKeeperPolicySection = section('doc-keeper-policy', async (input, context) => {
    const kind = await input.read.snapshot(CONVERSATION_KIND, input.conversationId, context)
    if (kind?.kind !== 'docKeeper') return undefined
    const task = await input.read.snapshot(DocKeeperTask, input.conversationId, context)
    if (task === undefined || task.repo === '') return undefined
    return [
      '# doc-keeper 维护任务',
      '',
      `- repo：${task.repo}`,
      `- globs：${task.globs.join('、')}`,
      `- docPath：${task.knowledgePath}`,
      `- mode：${task.mode}`,
      '',
      '# 硬约束',
      '',
      '- 只允许修改 docPath 这一个文件；用 write_knowledge 写回，不要用 write/edit 改其他文件。',
      '- 保留 frontmatter（botId/module/globs/updatedStamp）与章节结构（职责/关键文件/已知坑/changelog）。',
      `- 正文≤${KNOWLEDGE_BODY_CHAR_LIMIT}字符，只留结论与索引；含 <!-- manual --> 的段落保留不改并在报告提示需人工复核。`,
      '- 结论必须对照代码核实，不臆造；不确定标注「待核实」。',
      '- changelog 追加一条：日期 + 要点 + 提交数。',
    ].join('\n')
  })

  return defineExtension({
    name: DOC_KEEPER_EXTENSION_NAME,
    tools: [detectChangesTool, readKnowledgeTool, gitDiffTool, readCodeTool, writeKnowledgeTool],
    sections: [docKeeperPolicySection],
    wraps: knowledgeWraps,
  })
}