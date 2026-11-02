import type { JsonValue } from '@earendil-works/chord'
import { defineExtension, defineTool, section, type Extension } from '@earendil-works/pi-durable'
import { Type } from '@earendil-works/pi-ai'
import type { WetrackAnalysisRecord, WetrackAnalysisStatus } from '../../shared/types.ts'
import {
  MAX_ANALYSIS_MARKDOWN,
  isDefectNumber,
  readWetrackAnalysis,
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
      '问题清单页点开一个缺陷，展示的是 `wetrack_analysis_save` 写入的正文，而不是本次对话。因此分析完成后必须写入一次，否则页面里那个缺陷永远是「尚未分析」。',
      '',
      '写入时机（只有这三种）：',
      '1. 用户明确要求分析某个缺陷，且你已得出有证据支撑的结论；',
      '2. 定时任务（automation）按预设要求分析缺陷时，同一时机；',
      '3. 用户在对话里认可了结论、并同意按该结论修复之后——此时用同一次调用把 `status` 更新为 `fixed`，并把修复要点补进正文。',
      '',
      '不要写：只读了详情还没定位根因、结论靠猜、或只是转述工具输出时。宁可不写，也不要写空话。',
      '',
      '正文要求：',
      '- `markdown` 就是你会直接回答用户的那段正文（标题、结论、根因、证据 `path:line`、修复建议），页面原样渲染 Markdown。不要写「工具调用过程」「我调用了哪些命令」。',
      '- 同一缺陷再写一次即整体覆盖；后续分析结论变了就直接重写，不要追加时间线。',
      '- `status`：`analyzing` 结论待验证；`analyzed` 结论完成但未修复；`fixed` 用户已同意并完成修复；`blocked` 命中硬阻塞（无代码、需改契约、权限不足）。',
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
  readDefects?: () => Promise<unknown>
}): Extension {
  const saveTool = defineTool({
    name: 'wetrack_analysis_save',
    description: [
      'Persist the analysis of one WeTrack defect so the issues page can show it after the conversation is gone.',
      'Pass the answer body you would send to the user as `markdown`; the page renders it verbatim.',
      'Call it once per analysis, and again with status "fixed" after the user approves the conclusion and the fix is done.',
      'Overwrites any earlier record for the same defect.',
    ].join(' '),
    parameters: Type.Object({
      defectNumber: Type.String({ minLength: 4, maxLength: 32, description: 'DTS 编号，例如 DTS006761203' }),
      markdown: Type.String({ minLength: 1, maxLength: MAX_ANALYSIS_MARKDOWN, description: '分析正文（Markdown）' }),
      status: Type.Optional(STATUS),
      title: Type.Optional(Type.String({ maxLength: 200 })),
      summary: Type.Optional(Type.String({ maxLength: 1_000, description: '一行摘要，≤100 字' })),
    }),
    execute: async (args, api, context) => {
      context.abortSignal?.throwIfAborted()
      const defectNumber = args.defectNumber.trim()
      if (!isDefectNumber(defectNumber)) throw new Error('defectNumber 必须是 DTS + 数字，例如 DTS006761203')
      const record = await writeWetrackAnalysis(options.dataDir, {
        defectNumber,
        markdown: args.markdown,
        ...(args.status === undefined ? {} : { status: args.status as WetrackAnalysisStatus }),
        ...(args.title === undefined ? {} : { title: args.title }),
        ...(args.summary === undefined ? {} : { summary: args.summary }),
      }, { conversationId: String(api.conversationId) })
      const details = { analysis: { ...record } }
      return {
        output: output(receipt(record)),
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
      const record = await readWetrackAnalysis(options.dataDir, defectNumber)
      if (record === undefined) {
        return { output: output(`${defectNumber} 还没有分析记录。`), details: { analysis: null } as unknown as JsonValue }
      }
      return {
        output: output(`${receipt(record)}\n\n---\n\n${record.markdown}`),
        details: { analysis: { ...record } } as unknown as JsonValue,
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
      'List the WeTrack defects that are still waiting to be analysed.',
      'A coordinator reads this list once and then delegates each defect to a subagent;',
      'do not read the code yourself.',
    ].join(' '),
    parameters: Type.Object({
      /** Cap the returned rows; the list can hold dozens of pending defects. */
      maxResults: Type.Optional(Type.Number({ minimum: 1, maximum: 200 })),
    }),
    execute: async (args, _api, context) => {
      context.abortSignal?.throwIfAborted()
      const list = await options.readDefects!()
      const rows = Array.isArray(list) ? list : []
      const limit = args.maxResults ?? 50
      const items = rows.slice(0, limit).map(item => {
        const record = (item ?? {}) as Record<string, unknown>
        return {
          defectNumber: record.defectNumber,
          title: record.simpleDesc ?? record.title,
          defectStatusName: record.defectStatusName,
          severityName: record.severityName,
        }
      })
      const text = items.length === 0
        ? '问题清单里没有待分析的缺陷。'
        : items.map(item => `${String(item.defectNumber)} ${String(item.title ?? '')}`.trim()).join('\n')
      return { output: output(text), details: { items } as unknown as JsonValue }
    },
  })

  return defineExtension({
    name: WETRACK_ANALYSIS_EXTENSION_NAME,
    tools: [saveTool, getTool, ...(detailTool === undefined ? [] : [detailTool]), ...(listTool === undefined ? [] : [listTool])],
    sections: [analysisSection()],
  })
}
