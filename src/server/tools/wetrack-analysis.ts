import type { JsonValue } from '@earendil-works/chord'
import { defineExtension, defineTool, section, type Extension } from '@earendil-works/pi-durable'
import { Type } from '@earendil-works/pi-ai'
import type { WetrackAnalysisInput, WetrackAnalysisRecord, WetrackAnalysisStatus, WetrackDefectList } from '../../shared/types.ts'
import {
  MAX_ANALYSIS_MARKDOWN,
  isDefectNumber,
  readWetrackAnalysisStrict,
  writeWetrackAnalysis,
} from '../automation/wetrack-analysis.ts'

export const WETRACK_ANALYSIS_EXTENSION_NAME = 'wetrack-analysis'

const STATUS = Type.Union([
  Type.Literal('analyzing'),
  Type.Literal('analyzed'),
  Type.Literal('fixed'),
  Type.Literal('blocked'),
])

function output(text: string) {
  return [{ type: 'text' as const, text }]
}

function receipt(record: WetrackAnalysisRecord): string {
  const head = `已写入 ${record.defectNumber} 的分析（${record.status}）：${record.title}`
  const summary = record.summary === '' ? '' : `\n摘要：${record.summary}`
  return `${head}${summary}\n正文 ${record.markdown.length} 字符，问题清单页点击该缺陷即可看到。`
}

/**
 * The policy section teaches when a record is written. It is a section rather than tool
 * description text because the rules apply to every analysis, including scheduled runs whose
 * prompt the user did not write.
 */
function analysisSection() {
  return section('wetrack-analysis', async (input) => {
    const direct = input.agent.tools.some(tool => tool.name === 'wetrack_analysis_save')
    const callable = input.agent.callable.some(tool => tool.name === 'wetrack_analysis_save')
    if (!direct && !callable) return undefined
    return [
      '# WeTrack 分析记录',
      '',
      '问题清单页展示的是保存的分析记录。明确要求分析缺陷或按预设执行自动分析时，先读取既有记录并在分析结束后保存结果。',
      '',
      '写入时机（只有这三种）：',
      '1. 用户明确要求分析某个缺陷，且分析已结束；',
      '2. 定时任务（automation）按预设要求分析缺陷时，同一时机；',
      '3. 用户认可结论、同意修复并且修复完成后，把 `status` 更新为 `fixed`，并把修复要点补进正文。',
      '',
      '不要编造结论或只转述工具输出。预算用尽或遇到阻碍仍无法定论时，保存 blocked 尝试，写明已核对范围、缺口和原因；已有可靠结论会保留。',
      '',
      '正文要求：',
      '- `markdown` 是分析正文；证据引用使用 Markdown 链接 `[文件名:行号](完整仓库相对路径#L起-L止)`。区分已证实结论与假设，路径不要省略。',
      '- 保存前先用 `wetrack_analysis_get` 读取版本，并传入 `expectedRevision`；若版本已变化则重新读取、评估，不盲目覆盖。',
      '- `status`：`analyzing` 结论待验证；`analyzed` 结论完成但未修复；`fixed` 用户已同意并完成修复；`blocked` 本次分析未能定论，需填写原因。',
      '- `summary` 一行不超过 100 字，给列表徽标用。',
    ].join('\n')
  })
}

function cleanContext(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(cleanContext)
  if (typeof value !== 'object' || value === null) return value
  const record = value as Record<string, unknown>
  return Object.fromEntries(Object.entries(record).flatMap(([key, item]): Array<[string, unknown]> => {
    if (/password|passwd|secret|credential|token|api[-_]?key|downloadurl|authorization/iu.test(key)) return []
    if (key === 'description' && typeof item === 'string') {
      const text = item
        .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/giu, '')
        .replace(/<img\b[^>]*>/giu, ' [图片] ')
        .replace(/<br\s*\/?>|<\/(?:p|div|li|tr|h[1-6]|blockquote)>/giu, '\n')
        .replace(/<[^>]*>/gu, '')
        .replace(/&nbsp;/giu, ' ').replace(/&lt;/giu, '<').replace(/&gt;/giu, '>')
        .replace(/&quot;/giu, '"').replace(/&#(?:39|x27);/giu, "'").replace(/&amp;/giu, '&')
        .replace(/[ \t\u00a0]+/gu, ' ').replace(/ *\n */gu, '\n').replace(/\n{3,}/gu, '\n\n').trim()
      return [[key, text]]
    }
    if (typeof item === 'string' && /^(?:[A-Za-z0-9+/]{80,}={0,2}|data:image\/)/u.test(item)) return [[key, '[base64 图片已省略]']]
    return [[key, cleanContext(item)]]
  }))
}

export function createWetrackAnalysisExtension(options: {
  dataDir: string
  readDefect?: (defectNumber: string) => Promise<unknown>
  /** Reads the pending issue list; a coordinator uses it to hand work to subagents. */
  readDefects?: () => Promise<WetrackDefectList>
}): Extension {
  const saveTool = defineTool({
    name: 'wetrack_analysis_save',
    description: [
      'Persist the analysis of one WeTrack defect so the issues page can show it after the conversation is gone.',
      'Pass the answer body you would send to the user as `markdown`; the page renders it verbatim.',
      'Read wetrack_analysis_get first and provide the returned revision as expectedRevision. A stale revision is rejected.',
      'A blocked attempt preserves any previous analyzed or fixed conclusion. Call again with status "fixed" only after the user approves and the fix is done.',
    ].join(' '),
    parameters: Type.Object({
      defectNumber: Type.String({ minLength: 4, maxLength: 32, description: 'DTS 编号，例如 DTS006761203' }),
      markdown: Type.String({ minLength: 1, maxLength: MAX_ANALYSIS_MARKDOWN, description: '分析正文（Markdown）' }),
      expectedRevision: Type.Integer({ minimum: 0, description: 'Version from wetrack_analysis_get; 0 when no record exists.' }),
      status: Type.Optional(STATUS),
      blockedReason: Type.Optional(Type.Union([Type.Literal('budget-exhausted'), Type.Literal('access'), Type.Literal('missing-code'), Type.Literal('contract'), Type.Literal('other')])),
      title: Type.Optional(Type.String({ maxLength: 200 })),
      summary: Type.Optional(Type.String({ maxLength: 1_000, description: '一行摘要，≤100 字' })),
    }),
    execute: async (args, api, context) => {
      context.abortSignal?.throwIfAborted()
      const defectNumber = args.defectNumber.trim()
      if (!isDefectNumber(defectNumber)) throw new Error('defectNumber 必须是 DTS + 数字，例如 DTS006761203')
      if (args.status === 'blocked' && args.blockedReason === undefined) throw new Error('blocked 必须填写 blockedReason，说明是预算、权限或其他原因')
      const record = await writeWetrackAnalysis(options.dataDir, {
        defectNumber,
        markdown: args.markdown,
        ...(args.status === undefined ? {} : { status: args.status as WetrackAnalysisStatus }),
        ...(args.title === undefined ? {} : { title: args.title }),
        ...(args.summary === undefined ? {} : { summary: args.summary }),
        ...(args.blockedReason === undefined ? {} : { blockedReason: args.blockedReason as WetrackAnalysisInput['blockedReason'] }),
      }, { conversationId: String(api.conversationId), expectedRevision: args.expectedRevision })
      const details = { analysis: { ...record } }
      return {
        output: output(`已保存 ${defectNumber} 本次 ${args.status ?? 'analyzed'} 尝试（版本 ${record.revision}）。${record.latestAttempt?.status === 'blocked' && record.status !== 'blocked' ? '此前的可靠结论已保留。' : ''}`),
        details: details as unknown as JsonValue,
      }
    },
  })

  const getTool = defineTool({
    name: 'wetrack_analysis_get',
    description: 'Read the stored analysis of one WeTrack defect. Use it before re-analyzing so you can tell whether the conclusion changed.',
    parameters: Type.Object({
      defectNumber: Type.String({ minLength: 4, maxLength: 32 }),
    }),
    execute: async (args, _api, context) => {
      context.abortSignal?.throwIfAborted()
      const defectNumber = args.defectNumber.trim()
      if (!isDefectNumber(defectNumber)) throw new Error('defectNumber 必须是 DTS + 数字，例如 DTS006761203')
      const record = await readWetrackAnalysisStrict(options.dataDir, defectNumber)
      if (record === undefined) {
        return { output: output(`${defectNumber} 还没有分析记录。revision: 0`), details: { analysis: null, revision: 0 } as unknown as JsonValue }
      }
      return {
        output: output(`当前 revision: ${record.revision ?? 0}。\n${receipt(record)}\n\n---\n\n${record.markdown}`),
        details: { analysis: { ...record }, revision: record.revision ?? 0 } as unknown as JsonValue,
      }
    },
  })

  const detailTool = options.readDefect === undefined ? undefined : defineTool({
    name: 'wetrack_analysis_detail',
    description: 'Read one WeTrack defect for a read-only analysis. Use this instead of rd-cli to retrieve its current details on demand.',
    parameters: Type.Object({
      defectNumber: Type.String({ minLength: 4, maxLength: 32 }),
    }),
    execute: async (args, _api, context) => {
      context.abortSignal?.throwIfAborted()
      const defectNumber = args.defectNumber.trim()
      if (!isDefectNumber(defectNumber)) throw new Error('defectNumber 必须是 DTS + 数字，例如 DTS006761203')
      const defect = await options.readDefect!(defectNumber)
      if (defect === undefined) throw new Error(`${defectNumber} 没有读取到缺陷详情`)
      const details = { defect: cleanContext(defect) }
      return {
        output: output(JSON.stringify(details)),
        details: details as JsonValue,
      }
    },
  })

  const listTool = options.readDefects === undefined ? undefined : defineTool({
    name: 'wetrack_analysis_list',
    description: [
      'List the current user’s pending WeTrack defects. Use offset and maxResults to page through the list;',
      'the output includes total and next offset. Pending does not imply the defect has no stored analysis.',
    ].join(' '),
    parameters: Type.Object({
      /** Cap the returned rows; the list can hold dozens of pending defects. */
      maxResults: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })),
      offset: Type.Optional(Type.Integer({ minimum: 0 })),
    }),
    execute: async (args, _api, context) => {
      context.abortSignal?.throwIfAborted()
      const list = await options.readDefects!()
      if (!list.configured) throw new Error(list.notice ?? 'WeTrack 未连接，无法读取待处理缺陷。')
      const rows = list.items
      const limit = args.maxResults ?? 50
      const offset = args.offset ?? 0
      const items = rows.slice(offset, offset + limit).map(item => {
        const record = (item ?? {}) as Record<string, unknown>
        return {
          defectNumber: record.defectNumber,
          title: record.simpleDesc ?? record.title,
          defectStatusName: record.defectStatusName,
          severityName: record.severityName,
        }
      })
      const nextOffset = offset + items.length < rows.length ? offset + items.length : null
      const text = items.length === 0
        ? `没有更多待处理缺陷（总计 ${rows.length}）。`
        : `${items.map(item => `${String(item.defectNumber)} ${String(item.title ?? '')}`.trim()).join('\n')}\n总计 ${rows.length}；${nextOffset === null ? '已到末页' : `下一页 offset: ${nextOffset}`}`
      return { output: output(text), details: { items, total: rows.length, nextOffset } as unknown as JsonValue }
    },
  })

  return defineExtension({
    name: WETRACK_ANALYSIS_EXTENSION_NAME,
    tools: [saveTool, getTool, ...(detailTool === undefined ? [] : [detailTool]), ...(listTool === undefined ? [] : [listTool])],
    sections: [analysisSection()],
  })
}
