/**
 * 过程展示（process-presentation）纯函数测试。
 *
 * 覆盖：
 * - latestReasoningLine：取流式文本最后一个非空行（不等段落结束），空白归一化；
 * - workGroupTitle：按状态与时长生成组标题（"已工作 X"、"工作中"、"处理失败"、"已停止"）；
 * - defaultProcessOpen / processGroupBoundary / processGroupAutoOpen：工作组展开状态机——
 *   边界事件（live-start/live-end/demote）才移动状态，噪声帧不动；矩阵全枚举验证 + 帧序列仿真；
 * - foldedProsePreview：折叠组的正文预览——取最长文本块、剥离代码块/Markdown/链接、字符预算截断。
 */
import { describe, expect, it } from 'vitest'
import type { ChatMessage } from '../src/shared/types.ts'
import { buildRenderModel } from '../src/web/render-model.ts'
import {
  defaultProcessOpen, foldedProsePreview, latestReasoningLine, processGroupAutoOpen, processGroupBoundary, workGroupTitle,
} from '../src/web/process-presentation.ts'
import { presentationPolicyFor } from '../src/web/presentation-policy.ts'

/** 文案函数直通：原样返回。 */
const zh = (s: string) => s

/** 标题、思考行与展开默认值的单元测试。 */
describe('work and thought presentation', () => {
  // 验证最新思考行提取：取最后一个非空行（缩进容忍）、尾部空行被忽略、全空白返回空串。
  it('follows the latest nonempty streamed line without waiting for a paragraph', () => {
    expect(latestReasoningLine('前一句\n\n  正在处理')).toBe('正在处理')
    expect(latestReasoningLine('前一句\r\n\r\n')).toBe('前一句')
    expect(latestReasoningLine('  ')).toBe('')
  })
  // 验证组标题：完成态格式化时长（63.1s → "已工作 1 分 3 秒"）、运行中为"工作中"、
  // 流式进行中的完成组仍显示"工作中"、无时长为"已工作"、错误/取消各保留专属标题。
  it('shows recorded duration and retains error and stop states', () => {
    expect(workGroupTitle({ status: 'completed', durationMs: 63_100 }, zh)).toBe('已工作 1 分 3 秒')
    expect(workGroupTitle({ status: 'running' }, zh)).toBe('工作中')
    expect(workGroupTitle({ status: 'completed', durationMs: 63_100 }, zh, true)).toBe('工作中')
    expect(workGroupTitle({ status: 'completed' }, zh)).toBe('已工作')
    expect(workGroupTitle({ status: 'error', durationMs: 1000 }, zh)).toBe('处理失败')
    expect(workGroupTitle({ status: 'cancelled' }, zh)).toBe('已停止')
  })
  // 回归：毫秒级 run 的 durationMs=0 与未知同义，不得渲染「已工作 0 秒」。
  it('treats a zero duration as unknown instead of showing 0 sec', () => {
    expect(workGroupTitle({ status: 'completed', durationMs: 0 }, zh)).toBe('已工作')
    expect(workGroupTitle({ status: 'completed', durationMs: -5 }, zh)).toBe('已工作')
  })
  // 验证展开默认值（defaultProcessOpen）：compact 下活组默认开、非最新回合收起（有排队输入则保持开）、
  // detailed 下最新回合开/历史回合收；standard+next-input 下保持开。
  it('preserves live work, interleaved user input, and detailed or deferred collapse', () => {
    const compact = presentationPolicyFor('compact')
    expect(defaultProcessOpen(compact, true, true, false)).toBe(true)
    expect(defaultProcessOpen(compact, true, false, false)).toBe(false)
    expect(defaultProcessOpen(compact, true, false, true)).toBe(true)
    expect(defaultProcessOpen(presentationPolicyFor('detailed'), true, false, false)).toBe(true)
    expect(defaultProcessOpen(presentationPolicyFor('detailed'), false, false, false)).toBe(false)
    expect(defaultProcessOpen(presentationPolicyFor('standard', 'next-input'), true, false, false)).toBe(true)
  })
})

/** 工作组展开/收起状态机（边界驱动、粘滞状态）的穷举与仿真测试。 */
describe('work group open state machine', () => {
  /** processGroupAutoOpen 的 previous × boundary × defaultOpen 全枚举矩阵。 */
  const autoOpenMatrix = [
    { previous: true, boundary: 'live-start', defaultOpen: true, open: true },
    { previous: true, boundary: 'live-start', defaultOpen: false, open: true },
    { previous: false, boundary: 'live-start', defaultOpen: true, open: true },
    { previous: false, boundary: 'live-start', defaultOpen: false, open: true },
    { previous: true, boundary: 'live-end', defaultOpen: true, open: true },
    { previous: true, boundary: 'live-end', defaultOpen: false, open: false },
    { previous: false, boundary: 'live-end', defaultOpen: true, open: true },
    { previous: false, boundary: 'live-end', defaultOpen: false, open: false },
    { previous: true, boundary: 'demote', defaultOpen: true, open: true },
    { previous: true, boundary: 'demote', defaultOpen: false, open: false },
    { previous: false, boundary: 'demote', defaultOpen: true, open: true },
    { previous: false, boundary: 'demote', defaultOpen: false, open: false },
    { previous: true, boundary: 'none', defaultOpen: true, open: true },
    { previous: true, boundary: 'none', defaultOpen: false, open: true },
    { previous: false, boundary: 'none', defaultOpen: true, open: false },
    { previous: false, boundary: 'none', defaultOpen: false, open: false },
  ] as const

  // 穷举验证：仅边界事件移动自动状态——live-start 恒开；live-end/demote 时
  // previous=false 或 defaultOpen=true 保持开，否则收起；none（非边界）时维持 previous。
  it('moves the auto state only on a boundary, exhaustively', () => {
    for (const cell of autoOpenMatrix) {
      expect(processGroupAutoOpen(cell.previous, cell.boundary, cell.defaultOpen), `${cell.previous}/${cell.boundary}/${cell.defaultOpen}`)
        .toBe(cell.open)
    }
  })

  /** processGroupBoundary 的 was × now 帧全枚举矩阵。 */
  const boundaryMatrix = [
    { was: { live: false, latest: false }, now: { live: false, latest: false }, boundary: 'none' },
    { was: { live: false, latest: false }, now: { live: false, latest: true }, boundary: 'none' },
    { was: { live: false, latest: false }, now: { live: true, latest: false }, boundary: 'live-start' },
    { was: { live: false, latest: false }, now: { live: true, latest: true }, boundary: 'live-start' },
    { was: { live: false, latest: true }, now: { live: false, latest: false }, boundary: 'demote' },
    { was: { live: false, latest: true }, now: { live: false, latest: true }, boundary: 'none' },
    { was: { live: false, latest: true }, now: { live: true, latest: false }, boundary: 'live-start' },
    { was: { live: false, latest: true }, now: { live: true, latest: true }, boundary: 'live-start' },
    { was: { live: true, latest: false }, now: { live: false, latest: false }, boundary: 'live-end' },
    { was: { live: true, latest: false }, now: { live: false, latest: true }, boundary: 'live-end' },
    { was: { live: true, latest: false }, now: { live: true, latest: false }, boundary: 'none' },
    { was: { live: true, latest: false }, now: { live: true, latest: true }, boundary: 'none' },
    { was: { live: true, latest: true }, now: { live: false, latest: false }, boundary: 'live-end' },
    { was: { live: true, latest: true }, now: { live: false, latest: true }, boundary: 'live-end' },
    { was: { live: true, latest: true }, now: { live: true, latest: false }, boundary: 'none' },
    { was: { live: true, latest: true }, now: { live: true, latest: true }, boundary: 'none' },
  ] as const

  // 穷举验证边界推导：进入 live → live-start；离开 live → live-end；
  // 从"最新"降级为非最新 → demote；其余组合均为 none。
  it('derives the boundary from frame facts, exhaustively', () => {
    for (const cell of boundaryMatrix) {
      expect(processGroupBoundary(cell.was, cell.now), `${JSON.stringify(cell.was)}→${JSON.stringify(cell.now)}`)
        .toBe(cell.boundary)
    }
  })

  /** 仿真的帧流：边界帧夹杂任意噪声帧。 */
  const frames = [
    { live: true, latest: true }, { live: true, latest: true }, { live: true, latest: true },
    { live: false, latest: true },
    { live: false, latest: true }, { live: false, latest: true }, { live: false, latest: true },
    { live: false, latest: false },
    { live: false, latest: false }, { live: false, latest: false },
  ]

  // detailed 模式仿真：live → settle（live-end）阶段最新回合保持开（历史策略），
  // 新 run 出现时 demote 恰好收起一次；边界之后的噪声帧不改变状态（trace 全程记录）。
  it('keeps a detailed-mode group open through settle and folds it exactly once on demote', () => {
    const policy = presentationPolicyFor('detailed')
    let open = defaultProcessOpen(policy, true, true, false)
    const trace = [open]
    let was = { live: true, latest: true }
    for (const frame of frames) {
      const boundary = processGroupBoundary(was, frame)
      was = frame
      open = processGroupAutoOpen(open, boundary, defaultProcessOpen(policy, frame.latest, false, false))
      trace.push(open)
    }
    // live → settle keeps the latest turn open (history policy), the newer run folds it once,
    // and the noise frames after each boundary change nothing.
    // live → settle 时最新回合按历史策略保持开；新回合 demote 时恰好收起一次；
    // 每个边界之后的噪声帧不改变状态。
    expect(trace).toEqual([true, true, true, true, true, true, true, true, false, false, false])
  })

  // compact 模式仿真：settle（live-end）即收起一次，最终状态为收起。
  it('folds a compact-mode group exactly once at settle', () => {
    const policy = presentationPolicyFor('compact')
    let open = defaultProcessOpen(policy, true, true, false)
    let was = { live: true, latest: true }
    for (const frame of frames) {
      const boundary = processGroupBoundary(was, frame)
      was = frame
      open = processGroupAutoOpen(open, boundary, defaultProcessOpen(policy, frame.latest, false, false))
    }
    expect(open).toBe(false)
  })

  it('never flaps on alternating stale frames that recompute the default', () => {
    // 修复前的隐患：已落定组的逐帧 default 反复翻转会导致抖动。
    // 粘滞状态忽略所有这些帧，因为它们都不是边界。
    let open = false
    for (let index = 0; index < 20; index += 1) {
      open = processGroupAutoOpen(open, 'none', index % 2 === 0)
    }
    expect(open).toBe(false)
  })
})

/** 折叠工作组正文预览（foldedProsePreview）的选取与净化测试。 */
describe('folded work group preview', () => {
  /**
   * 构造一个已完成的 run：问题 → 带给定 blocks 的工作消息 → "完成。"回复。
   * @param blocks 工作消息的内容块
   * @returns 渲染模型中的 run
   */
  function runOf(blocks: ChatMessage['blocks']) {
    const run = buildRenderModel([
      { id: 'user', role: 'user', requestId: 'req', timestamp: 1, blocks: [{ type: 'text', text: '问题' }] },
      { id: 'work', role: 'assistant', runId: 'run', timestamp: 2, status: 'completed', blocks },
      { id: 'answer', role: 'assistant', runId: 'run', timestamp: 3, status: 'completed', blocks: [{ type: 'text', text: '完成。' }] },
    ]).runs[0]
    if (run === undefined) throw new Error('render model dropped the run')
    return run
  }
  /** 公用的 read 工具调用块（让 run 里存在非文本块）。 */
  const read = { type: 'toolCall' as const, id: 'read', name: 'read', arguments: { path: 'a.ts' } }

  // 验证选取策略：取最长文本块而非最短的过场叙述（"我先看一眼代码"被跳过）。
  it('names the longest folded block instead of the shortest narration', () => {
    const run = runOf([
      { type: 'text', text: '我先看一眼代码。' },
      read,
      { type: 'text', text: '我倾向方案 A：改动面最小，且语义最准。' },
    ])
    expect(foldedProsePreview(run)).toBe('我倾向方案 A：改动面最小，且语义最准。')
  })

  // 验证净化：代码围栏整段跳过，Markdown 标题与粗体剥成纯文本（"结论：方案 A"）。
  it('keeps the preview a plain line, skipping fences and reading headings as prose', () => {
    const run = runOf([
      { type: 'text', text: '```ts\nconst hidden = 1\n```\n## 结论：**方案 A**' },
      read,
    ])
    expect(foldedProsePreview(run)).toBe('结论：方案 A')
  })

  // 验证链接解包：[label](url) 只保留 label 文本，URL 不进入预览。
  it('unwraps a markdown link target into its label', () => {
    const run = runOf([
      { type: 'text', text: '详见 [设计文档](https://example.test/design.md)，其余不变。' },
      read,
    ])
    expect(foldedProsePreview(run)).toBe('详见 设计文档，其余不变。')
  })

  // 验证字符预算：超预算截断并补省略号（30 字按 10 字预算 → 10 字 + …）。
  it('truncates to the character budget with an ellipsis', () => {
    const run = runOf([{ type: 'text', text: '一二三四五六七八九十'.repeat(3) }, read])
    expect(foldedProsePreview(run, 10)).toBe('一二三四五六七八九十…')
  })

  // 验证空预览：纯工具调用 run 或只有空白文本块的 run 没有可预览正文（返回 undefined）。
  it('has nothing to preview for a run that only used tools or a blank block', () => {
    expect(foldedProsePreview(runOf([read]))).toBeUndefined()
    expect(foldedProsePreview(runOf([{ type: 'text', text: '   \n  ' }, read]))).toBeUndefined()
  })
})
