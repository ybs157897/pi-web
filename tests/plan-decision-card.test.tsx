// @vitest-environment jsdom
/**
 * 计划评审决策卡（QuestionComposer 中 kind=plan-review 的交互卡）测试。
 *
 * 关键契约（对齐 ZCode elicitation 交互）：
 * - 只读审阅卡片：提交"批准"只退出计划模式保留只读权限，不承诺实施、不请求提权；
 * - 摘要卡展示计划 excerpt 与权限决策区，旧版底部按钮（要求修改/同意执行）已移除；
 * - 空决策直接提交等价于显式批准（ZCode 的 continueOrSubmit 语义）；
 * - 仅输入文字提交作为"要求修改"（selected 为空 + custom 文本）；
 * - "忽略"走 cancelInteraction 取消链路；单已决/已回答的记录不再渲染交互区；
 * - 方向键可在"批准"选项与回答输入框之间移动焦点。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import QuestionComposer from '../src/web/QuestionComposer.tsx'
import { api } from '../src/web/api.ts'
import type { InteractionRequest } from '../src/shared/types.ts'
import { setupRenderingDom } from './rendering/setup.ts'

// 只 mock 网络层：answerInteraction / cancelInteraction 替换为 vi.fn，其余 api 成员保留原实现（含 ApiFailure 类）。
vi.mock('../src/web/api.ts', async importOriginal => {
  const original = await importOriginal<typeof import('../src/web/api.ts')>()
  return { ApiFailure: original.ApiFailure, api: { ...original.api, answerInteraction: vi.fn(), cancelInteraction: vi.fn() } }
})

const apiMock = vi.mocked(api, true)

/** 每个用例前重置 DOM 环境（表单容器）并重建 api mock，保证用例间互不污染。 */
beforeEach(() => {
  setupRenderingDom()
  apiMock.answerInteraction = vi.fn().mockResolvedValue({ conversation: { id: 'c1' } })
  apiMock.cancelInteraction = vi.fn().mockResolvedValue({ conversation: { id: 'c1' } })
})

/** 卸载所有渲染的组件，避免用例间 DOM 残留。 */
afterEach(cleanup)

/**
 * 构造一条待评审的 plan-review 交互请求 fixture。
 * @returns 含计划 Markdown 摘要、审批按钮文案"同意执行"的 pending 状态请求。
 */
function pendingReview(): InteractionRequest & { detail: string } {
  return {
    id: 'call-1',
    kind: 'plan-review',
    status: 'pending',
    detail: '# 演示计划\n\n把计划模式跑通。',
    approveLabel: '同意执行',
    createdAt: 1,
  }
}

/**
 * 渲染带有一条交互请求的 QuestionComposer。
 * @param review 交互请求，默认为 pendingReview() fixture
 * @param onAnswered 评审完成回调，默认为新的 vi.fn
 * @returns 传入的 onAnswered，供用例断言回调触发
 */
function renderCard(review: InteractionRequest = pendingReview(), onAnswered = vi.fn()) {
  render(<QuestionComposer conversationId="c1" interactions={[review]} onAnswered={onAnswered} onOpenPlan={vi.fn()} />)
  return onAnswered
}

/** 计划评审决策卡的交互行为测试（ZCode elicitation 风格）。 */
describe('plan review decision card (ZCode elicitation)', () => {
  // 只读审阅形态：验证只出现"只读审阅"标识与自定义按钮文案（如"确认方案"），
  // 不出现"实施计划"字样，批准提交的 payload 中不携带任何提权或实施承诺。
  it('confirms a read-only plan without promising implementation or elevated access', async () => {
    renderCard({ ...pendingReview(), approveLabel: '确认方案' })
    expect(screen.getByText('只读审阅')).toBeTruthy()
    expect(screen.getByText('确认方案')).toBeTruthy()
    expect(screen.queryByText('实施计划')).toBeNull()
    const approve = screen.getByRole('radio', { name: '批准 退出计划模式，保留只读权限；不会实施修改。' })
    fireEvent.click(approve)
    fireEvent.click(screen.getByRole('button', { name: '提交' }))
    await vi.waitFor(() => expect(apiMock.answerInteraction).toHaveBeenCalledWith('c1', 'call-1', [
      { id: 'plan-review', selected: ['批准'] },
    ]))
  })

  // 默认形态：验证摘要卡（"计划"标题 + "查看完整计划"入口）、权限决策区（"需要权限"、"批准"单选项）、
  // 回答输入框与"忽略"/"提交"按钮齐全。
  it('renders the plan excerpt card and the permission decision card', () => {
    renderCard()
    expect(screen.getByText('计划')).toBeTruthy()
    // "查看完整计划"标签嵌在可点击的计划卡内部，因此不作为独立 button role 暴露。
    expect(screen.getByText('查看完整计划')).toBeTruthy()
    expect(screen.getByText('需要权限')).toBeTruthy()
    expect(screen.getByText('实施计划')).toBeTruthy()
    expect(screen.getByRole('radio', { name: '批准 退出计划模式并开始实施。' })).toBeTruthy()
    expect(screen.getByPlaceholderText('输入你的回答…')).toBeTruthy()
    expect(screen.getByRole('button', { name: '忽略' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '提交' })).toBeTruthy()
    // 旧版摘要卡底部按钮（要求修改/同意执行）已移除，不再渲染。
    expect(screen.queryByRole('button', { name: '要求修改' })).toBeNull()
    expect(screen.queryByRole('button', { name: '同意执行' })).toBeNull()
  })

  // 验证空决策语义（ZCode continueOrSubmit）：不做任何选择直接提交，等价于显式"批准"，
  // payload 为 selected:['批准'] 且无 custom，并触发 onAnswered 回调。
  it("submits an empty decision as an explicit approval, ZCode's continueOrSubmit", async () => {
    const onAnswered = renderCard()
    fireEvent.click(screen.getByRole('button', { name: '提交' }))
    await vi.waitFor(() => expect(apiMock.answerInteraction).toHaveBeenCalledTimes(1))
    expect(apiMock.answerInteraction).toHaveBeenCalledWith('c1', 'call-1', [
      { id: 'plan-review', selected: ['批准'] },
    ])
    await vi.waitFor(() => expect(onAnswered).toHaveBeenCalled())
  })

  // 验证只输入文字不勾选任何选项时，提交作为"要求修改"：selected 为空数组，文字放入 custom 字段。
  it('submits typed text alone as the requested changes', async () => {
    renderCard()
    fireEvent.change(screen.getByPlaceholderText('输入你的回答…'), { target: { value: '补上回滚说明' } })
    fireEvent.click(screen.getByRole('button', { name: '提交' }))
    await vi.waitFor(() => expect(apiMock.answerInteraction).toHaveBeenCalledTimes(1))
    expect(apiMock.answerInteraction).toHaveBeenCalledWith('c1', 'call-1', [
      { id: 'plan-review', selected: [], custom: '补上回滚说明' },
    ])
  })

  // 验证勾选"批准"的单选交互：aria-checked 从 false 翻转为 true，提交 payload 携带 selected:['批准']
  // 且 custom 为 undefined（无文字时字段不出现在序列化结果中）。
  it('sends the approve selection when the option is chosen and submits', async () => {
    renderCard()
    const approve = screen.getByRole('radio', { name: '批准 退出计划模式并开始实施。' })
    expect(approve.getAttribute('aria-checked')).toBe('false')
    fireEvent.click(approve)
    expect(approve.getAttribute('aria-checked')).toBe('true')
    fireEvent.click(screen.getByRole('button', { name: '提交' }))
    await vi.waitFor(() => expect(apiMock.answerInteraction).toHaveBeenCalledTimes(1))
    expect(apiMock.answerInteraction).toHaveBeenCalledWith('c1', 'call-1', [
      { id: 'plan-review', selected: ['批准'], custom: undefined },
    ])
  })

  // 验证"忽略"路径：点击后调用 cancelInteraction（而非 answerInteraction），同样触发 onAnswered 回调。
  it('dismisses through the ignore button and reaches the cancel API', async () => {
    const onAnswered = renderCard()
    fireEvent.click(screen.getByRole('button', { name: '忽略' }))
    await vi.waitFor(() => expect(apiMock.cancelInteraction).toHaveBeenCalledTimes(1))
    expect(apiMock.cancelInteraction).toHaveBeenCalledWith('c1', 'call-1')
    await vi.waitFor(() => expect(onAnswered).toHaveBeenCalled())
  })

  // 验证键盘可达性：radiogroup 内按 ArrowDown 焦点移到回答输入框，按 ArrowUp 移回"批准"选项。
  it('moves focus between the approve option and the answer line with the arrow keys', () => {
    renderCard()
    const approve = screen.getByRole('radio', { name: '批准 退出计划模式并开始实施。' })
    const answer = screen.getByPlaceholderText('输入你的回答…')
    approve.focus()
    const group = approve.closest('[role="radiogroup"]')!
    fireEvent.keyDown(group, { key: 'ArrowDown' })
    expect(document.activeElement).toBe(answer)
    fireEvent.keyDown(group, { key: 'ArrowUp' })
    expect(document.activeElement).toBe(approve)
  })

  // 验证已回答（status=answered）的评审记录只作为历史留痕：权限决策区与"查看完整计划"入口均不渲染。
  it('leaves the transcript record alone once the review settles', () => {
    renderCard({ ...pendingReview(), status: 'answered', approved: true })
    expect(screen.queryByText('需要权限')).toBeNull()
    expect(screen.queryByText('查看完整计划')).toBeNull()
  })
})
