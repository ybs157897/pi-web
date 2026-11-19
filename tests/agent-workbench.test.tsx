// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { useLayoutEffect, useState } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { ConversationDetail, WorkspaceSummary } from '../src/shared/types.ts'
import type { WorkbenchView } from '../src/shared/workbench.ts'
import AgentWorkbench, { AgentWorkbenchOnboarding } from '../src/web/AgentWorkbench.tsx'
import { AgentWorkbenchComposer } from '../src/web/AgentWorkbenchComposer.tsx'
import { WorkbenchChildConversation } from '../src/web/AgentWorkbenchConversation.tsx'
import { api } from '../src/web/api.ts'
import { workbenchApi } from '../src/web/workbench-api.ts'
import { setupRenderingDom } from './rendering/setup.ts'

const workspace: WorkspaceSummary = { id: 'space', name: '剧情引擎', path: '/workspace', createdAt: 1, updatedAt: 1 }
const now = 1_795_000_000_000

function detail(id: string): ConversationDetail {
  return {
    conversation: {
      id, title: id, createdAt: now, updatedAt: now, cwd: '/workspace', workspaceId: workspace.id,
      archived: false, pinned: false, busy: false, thinkingLevel: 'off',
    },
    messages: [],
    queue: [],
  }
}

function workbench(): WorkbenchView {
  return {
    main: detail('lead'),
    agents: [
      { id: 'lead', name: '主 Agent', role: 'lead', description: '拆解和排期', status: 'idle', skills: [] },
      { id: 'log', name: '日志智能体', role: '排查', description: '查日志定位问题', status: 'idle', skills: ['日志分析'] },
      { id: 'time', name: '时间智能体', role: '时间', description: '时间与排序', status: 'idle', skills: [] },
    ],
    messages: [{ text: '查一下日志', requestId: 'request-1', mention: 'log', at: now }],
    items: [{
      id: 'item-1', requestId: 'request-1', workspaceId: workspace.id, parentId: 'lead', childId: 'child',
      title: '日志排查', objective: '找到原因', constraints: [], acceptance: [], type: 'investigate', status: 'ended',
      waitingOn: { kind: 'none' }, assignee: 'log', dependencies: [], evidence: [], verification: 'recorded',
      attempt: 1, createdAt: now, updatedAt: now,
    }],
  }
}

beforeEach(setupRenderingDom)
afterEach(() => { cleanup(); localStorage.clear(); vi.restoreAllMocks() })

it('keeps a selected bot as a chip and preserves IME enter and plain-text input', async () => {
  const send = vi.fn(async () => {})
  render(<AgentWorkbenchComposer workspaceId={workspace.id} user="测试用户" agents={workbench().agents} placeholder="描述任务" onSend={send} />)
  const editor = screen.getByRole<HTMLTextAreaElement>('textbox', { name: '发消息给 Agent' })
  fireEvent.change(editor, { target: { value: '@' } })
  const menu = screen.getByRole('listbox')
  expect(within(menu).getByText('成员')).toBeTruthy()
  expect(within(menu).getByText('电脑')).toBeTruthy()
  expect(within(menu).getByText('Bot 与任务')).toBeTruthy()
  expect(within(menu).queryByRole('option', { name: /主 Agent/ })).toBeNull()
  fireEvent.keyDown(editor, { key: 'ArrowDown' })
  fireEvent.keyDown(editor, { key: 'Enter' })
  expect(screen.getByRole('button', { name: '移除提及 时间智能体' })).toBeTruthy()
  expect(editor.value).toBe('')

  fireEvent.compositionStart(editor)
  fireEvent.change(editor, { target: { value: '检查日历' } })
  fireEvent.keyDown(editor, { key: 'Enter', isComposing: true })
  expect(send).not.toHaveBeenCalled()
  fireEvent.compositionEnd(editor)
  const pasted = '检查日历\n下一行 <b>保留为文本</b>'
  // The browser applies native textarea paste. Simulate the resulting input event.
  fireEvent.paste(editor, { clipboardData: { getData: () => pasted } })
  fireEvent.change(editor, { target: { value: pasted } })
  expect(editor.value).toBe(pasted)
  expect(screen.queryByText('保留为文本')).toBeNull()
  fireEvent.keyDown(editor, { key: 'Enter', shiftKey: true })
  expect(send).not.toHaveBeenCalled()
  fireEvent.keyDown(editor, { key: 'Enter' })
  expect(send).toHaveBeenCalledWith({ text: pasted, mention: 'time', requestId: expect.any(String) })
  await waitFor(() => expect(editor.value).toBe(''))
})

it('allows deliberate removal and sends a replacement Bot chosen from the mention button', () => {
  const agents = workbench().agents
  const send = vi.fn(async () => {})
  const example = { text: '', mention: 'log', key: 1 }
  const props = { workspaceId: workspace.id, placeholder: '描述任务', example, onSend: send }
  const { rerender } = render(<AgentWorkbenchComposer {...props} agents={agents} />)
  const editor = screen.getByRole<HTMLTextAreaElement>('textbox', { name: '发消息给 Agent' })
  expect(screen.getByRole('button', { name: '移除提及 日志智能体' })).toBeTruthy()
  fireEvent.keyDown(editor, { key: 'Backspace' })
  expect(screen.queryByRole('button', { name: '移除提及 日志智能体' })).toBeNull()

  fireEvent.click(screen.getByRole('button', { name: '提及智能体' }))
  fireEvent.click(screen.getByRole('option', { name: /时间智能体/ }))
  expect(screen.getByRole('button', { name: '移除提及 时间智能体' })).toBeTruthy()
  rerender(<AgentWorkbenchComposer {...props} agents={[]} />)
  expect(screen.getByRole('button', { name: '移除提及 time' })).toBeTruthy()
  fireEvent.change(editor, { target: { value: '核对顺序' } })
  fireEvent.keyDown(editor, { key: 'Enter' })

  expect(send).toHaveBeenCalledWith({ text: '核对顺序', mention: 'time', requestId: expect.any(String) })
})

it('retries the same draft with the original request ID after a network error', async () => {
  const send = vi.fn().mockRejectedValueOnce(new Error('网络中断')).mockResolvedValueOnce(undefined)
  render(<AgentWorkbenchComposer workspaceId={workspace.id} placeholder="继续聊" onSend={send} />)
  const editor = screen.getByRole<HTMLTextAreaElement>('textbox', { name: '继续对话' })
  fireEvent.change(editor, { target: { value: '请补上测试结果' } })
  fireEvent.click(screen.getByRole('button', { name: '发送' }))
  await screen.findByRole('alert', { name: '' })
  expect(editor.value).toBe('请补上测试结果')
  fireEvent.click(screen.getByRole('button', { name: '发送' }))
  await waitFor(() => expect(editor.value).toBe(''))
  expect(send.mock.calls[0]?.[0].requestId).toBe(send.mock.calls[1]?.[0].requestId)
})

it('can choose or name a workspace directly on the opening screen', async () => {
  const onSelect = vi.fn().mockRejectedValueOnce(new Error('工作空间暂不可用'))
  const onCreate = vi.fn(async () => {})
  render(<AgentWorkbenchOnboarding workspaces={[workspace]} onSelect={onSelect} onCreate={onCreate} />)
  fireEvent.click(screen.getByRole('button', { name: /剧情引擎/ }))
  expect(onSelect).toHaveBeenCalledWith(workspace.id)
  await screen.findByText('工作空间暂不可用')
  fireEvent.change(screen.getByRole('textbox', { name: '或新建' }), { target: { value: ' 测试项目 ' } })
  fireEvent.click(screen.getByRole('button', { name: '创建并打开' }))
  await waitFor(() => expect(onCreate).toHaveBeenCalledWith('测试项目'))
})

it('keeps a stopped task and its resume action in the original request group', async () => {
  const view = workbench()
  const original = view.items[0]!
  const failure = {
    code: 'CONVERSATION_INTERRUPTED', message: '这次排查已停止。', retryable: true, action: 'retry',
  } as const
  view.items = [
    { ...original, attempt: 2, status: 'needs_human', waitingOn: { kind: 'human' }, error: failure.message, failure },
    { ...original, id: 'item-2', requestId: 'request-2', childId: 'child-2', title: '整理告警规则', status: 'running', waitingOn: { kind: 'agent' } },
  ]
  view.messages.push({ text: '整理这周的告警规则', requestId: 'request-2', at: now + 1000 })
  vi.spyOn(workbenchApi, 'get').mockResolvedValue(view)
  const retry = vi.spyOn(workbenchApi, 'retry').mockResolvedValue({ ok: true })
  render(<AgentWorkbench workspace={workspace} page="agent" onInbox={vi.fn()} />)

  const stopped = await screen.findByRole('group', { name: '日志排查' })
  const running = screen.getByRole('group', { name: '整理告警规则' })
  expect(within(stopped.closest('article')!).getByText('查一下日志')).toBeTruthy()
  expect(within(running.closest('article')!).getByText('整理这周的告警规则')).toBeTruthy()
  expect(stopped.closest('article')).not.toBe(running.closest('article'))
  expect(within(stopped).getByText('已停止')).toBeTruthy()
  expect(within(running).getByText('进行中')).toBeTruthy()
  expect(within(running).queryByRole('button', { name: '继续本轮' })).toBeNull()

  fireEvent.click(within(stopped).getByRole('button', { name: '继续本轮' }))
  await waitFor(() => expect(retry).toHaveBeenCalledWith(workspace.id, { itemId: 'item-1', attempt: 2 }))
})

it('opens the source worker conversation directly from a mail and returns to that mail', async () => {
  const view = workbench()
  const data = detail('child')
  data.messages = [
    {
      id: 'internal', role: 'user', requestId: 'workbench-start:item-1', runId: 'run-1', timestamp: now,
      blocks: [{ type: 'text', text: '内部派发指令' }],
    },
    {
      id: 'answer', role: 'assistant', runId: 'run-1', timestamp: now + 10,
      blocks: [{ type: 'text', text: '请求重试缺少去重。' }],
    },
  ]
  vi.spyOn(workbenchApi, 'get').mockResolvedValue(view)
  const followUp = vi.spyOn(workbenchApi, 'reply').mockResolvedValue({ requestId: 'request-2' })
  const getConversation = vi.spyOn(api, 'getConversation').mockResolvedValue(data)
  vi.spyOn(api, 'watch').mockReturnValue({ close: vi.fn() } as unknown as EventSource)

  const inbox = vi.fn()
  const originalMail = vi.fn()
  render(<AgentWorkbench workspace={workspace} page="agent" focus={{ taskId: 'item-1', nonce: 1, fromInbox: true }}
    onInbox={inbox} onReturnFromInbox={originalMail} />)
  await screen.findByRole('heading', { name: '日志智能体' })
  expect(screen.queryByRole('button', { name: '打开会话：日志排查' })).toBeNull()
  await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('heading', { name: '日志智能体' })))
  expect(getConversation).toHaveBeenCalledWith('child')
  expect(await screen.findByText('请求重试缺少去重。')).toBeTruthy()
  expect(screen.queryByText('内部派发指令')).toBeNull()
  expect(screen.getByText(/已接收任务「日志排查」/)).toBeTruthy()
  const editor = screen.getByRole('textbox', { name: '发送消息' })
  fireEvent.change(editor, { target: { value: '补一下原因' } })
  fireEvent.click(screen.getByRole('button', { name: '发送消息' }))
  await waitFor(() => expect(followUp).toHaveBeenCalledWith('space', 'item-1', {
    text: '补一下原因', requestId: expect.any(String), whenBusy: 'followUp',
  }))
  fireEvent.click(screen.getByRole('button', { name: '回到收件箱' }))
  expect(originalMail).toHaveBeenCalledOnce()
  expect(inbox).not.toHaveBeenCalled()
})

it('keeps selected member and host context with the message without changing Bot routing', async () => {
  const view = workbench()
  vi.spyOn(workbenchApi, 'get').mockImplementation(async () => structuredClone(view))
  const send = vi.spyOn(workbenchApi, 'submit').mockImplementation(async (_workspace, input) => {
    view.messages.push({ requestId: input.requestId, text: input.text, mention: input.mention, at: now })
    return { requestId: input.requestId }
  })
  render(<AgentWorkbench workspace={workspace} page="agent" user="梅" onInbox={vi.fn()} />)
  const editor = await screen.findByRole<HTMLTextAreaElement>('textbox', { name: '发消息给 Agent' })
  fireEvent.change(editor, { target: { value: '请＠梅' } })
  fireEvent.keyDown(editor, { key: 'Enter' })
  expect(editor.value).toBe('请')
  expect(screen.getByRole('button', { name: '移除提及 梅' })).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: '提及智能体' }))
  fireEvent.click(screen.getByRole('option', { name: /本机/ }))
  expect(screen.getByRole('button', { name: '移除提及 本机' })).toBeTruthy()
  expect(editor.value).toBe('请')
  fireEvent.change(editor, { target: { value: '请检查日志' } })
  fireEvent.keyDown(editor, { key: 'Enter' })
  await waitFor(() => expect(send).toHaveBeenCalledWith(workspace.id, {
    text: '上下文引用\n成员 @梅\n电脑 @本机\n\n请检查日志',
    requestId: expect.any(String), whenBusy: 'followUp',
  }))
  expect(await screen.findByText('@梅')).toBeTruthy()
  expect(screen.getByText('@本机')).toBeTruthy()
  expect(screen.getByText('请检查日志')).toBeTruthy()
  expect(screen.queryByText('上下文引用')).toBeNull()
})

it('keeps an unmatched inline mention from sending and closes the picker at a focus boundary', () => {
  const send = vi.fn(async () => {})
  render(<>
    <AgentWorkbenchComposer workspaceId={workspace.id} agents={workbench().agents} placeholder="描述任务" onSend={send} />
    <button type="button">另一个控件</button>
  </>)
  const editor = screen.getByRole<HTMLTextAreaElement>('textbox', { name: '发消息给 Agent' })
  fireEvent.change(editor, { target: { value: '请检查 x@y.example' } })
  expect(screen.queryByRole('listbox')).toBeNull()
  fireEvent.change(editor, { target: { value: '请检查＠无匹配' } })
  expect(screen.getByRole('listbox')).toBeTruthy()
  expect(screen.getByText('没有匹配的提及对象')).toBeTruthy()
  fireEvent.keyDown(editor, { key: 'Enter' })
  expect(send).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: '保留文字并关闭' }))
  expect(screen.queryByRole('listbox')).toBeNull()
  expect(editor.value).toBe('请检查＠无匹配')
  expect(screen.getByRole<HTMLButtonElement>('button', { name: '发送' }).disabled).toBe(false)
  fireEvent.change(editor, { target: { value: '请检查＠第三次' } })
  fireEvent.keyDown(editor, { key: 'Tab' })
  expect(screen.queryByRole('listbox')).toBeNull()
  fireEvent.change(editor, { target: { value: '请检查＠再次输入' } })
  expect(screen.getByRole('listbox')).toBeTruthy()
  fireEvent.blur(editor, { relatedTarget: screen.getByRole('button', { name: '另一个控件' }) })
  expect(screen.queryByRole('listbox')).toBeNull()
})

it('keeps the skill picker reachable from its button and restores focus on Escape', async () => {
  vi.spyOn(api, 'getSkills').mockResolvedValue({
    diagnostics: [],
    skills: [{ id: 'builtin:review', source: 'builtin', name: 'review', description: '检查交付', writable: false, version: '1', path: '/review' }],
  })
  render(<AgentWorkbenchComposer workspaceId={workspace.id} agents={workbench().agents} placeholder="描述任务" onSend={vi.fn()} />)
  const editor = screen.getByRole<HTMLTextAreaElement>('textbox', { name: '发消息给 Agent' })
  const toggle = screen.getByRole('button', { name: '技能' })
  fireEvent.click(toggle)
  const skill = await screen.findByRole('button', { name: 'review 检查交付' })
  expect(toggle.compareDocumentPosition(skill) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  skill.focus()
  fireEvent.keyDown(skill, { key: 'Escape' })
  expect(screen.queryByRole('group', { name: '工作区技能' })).toBeNull()
  expect(document.activeElement).toBe(toggle)
  fireEvent.change(editor, { target: { value: '请按规范' } })
  fireEvent.click(toggle)
  fireEvent.click(screen.getByRole('button', { name: 'review 检查交付' }))
  expect(editor.value).toBe('请按规范 $review ')
})

it('keeps a follow-up draft while the worker awaits a decision', async () => {
  const view = workbench()
  view.items[0]!.status = 'needs_human'
  view.items[0]!.waitingOn = { kind: 'human' }
  vi.spyOn(workbenchApi, 'get').mockResolvedValue(view)
  vi.spyOn(api, 'getConversation').mockResolvedValue(detail('child'))
  vi.spyOn(api, 'watch').mockReturnValue({ close: vi.fn() } as unknown as EventSource)
  const reply = vi.spyOn(workbenchApi, 'reply')
  render(<AgentWorkbench workspace={workspace} page="agent" onInbox={vi.fn()} />)
  fireEvent.click(await screen.findByRole('button', { name: '打开会话：日志排查' }))
  const editor = await screen.findByRole<HTMLTextAreaElement>('textbox', { name: '发送消息' })
  fireEvent.change(editor, { target: { value: '请补充影响范围' } })
  fireEvent.keyDown(editor, { key: 'Enter' })
  expect(reply).not.toHaveBeenCalled()
  expect(editor.value).toBe('请补充影响范围')
  expect(screen.getByText('先答复当前裁决，再继续对话。')).toBeTruthy()
  expect(screen.getByRole<HTMLButtonElement>('button', { name: '发送消息' }).disabled).toBe(true)
})

it('uses the native composer for an attachment and the original workbench child for sending and stopping', async () => {
  const view = workbench()
  const data = detail('child')
  data.conversation.busy = true
  let notify!: (snapshot: ConversationDetail) => void
  vi.spyOn(api, 'getConversation').mockResolvedValue(data)
  vi.spyOn(api, 'watch').mockImplementation((_id, listener) => {
    notify = listener
    return { close: vi.fn() } as unknown as EventSource
  })
  const stop = vi.spyOn(api, 'stop').mockResolvedValue({ ok: true })
  const followUp = vi.spyOn(workbenchApi, 'reply').mockResolvedValue({ requestId: 'request-2' })
  const { container } = render(<WorkbenchChildConversation workspaceId={workspace.id} workspacePath={workspace.path}
    item={view.items[0]!} agent={view.agents[1]} onChange={vi.fn()} embedded />)

  const editor = await screen.findByRole<HTMLTextAreaElement>('textbox', { name: '发送消息' })
  expect(editor.closest('[data-composer-mode]')?.getAttribute('data-composer-mode')).toBe('docked')
  fireEvent.change(editor, { target: { value: '读取附件' } })
  fireEvent.keyDown(editor, { key: 'Enter' })
  expect(followUp).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: '停止当前回答' }))
  expect(stop).toHaveBeenCalledWith('child')
  act(() => notify({ ...data, conversation: { ...data.conversation, busy: false } }))
  const input = container.querySelector('input[type="file"]')
  expect(input).not.toBeNull()
  fireEvent.change(input!, { target: { files: [new File(['ready'], 'evidence.txt', { type: 'text/plain' })] } })
  await waitFor(() => expect(screen.getByRole<HTMLButtonElement>('button', { name: '发送消息' }).disabled).toBe(false))
  fireEvent.click(screen.getByRole('button', { name: '发送消息' }))
  await waitFor(() => expect(followUp).toHaveBeenCalledWith(workspace.id, 'item-1', {
    text: '读取附件', requestId: expect.any(String), whenBusy: 'followUp',
    files: [{ name: 'evidence.txt', mimeType: 'text/plain', data: 'cmVhZHk=' }],
  }))
})

it('offers a model switch and a retry for the same work item even before its child conversation is created', async () => {
  const view = workbench()
  const item = view.items[0]!
  delete item.childId
  item.status = 'needs_human'
  item.error = '模型不可用'
  item.failure = { code: 'MODEL_UNAVAILABLE', message: '模型不可用，请检查模型配置。', retryable: true, action: 'check_model' }
  const recover = vi.spyOn(workbenchApi, 'retry').mockResolvedValue({ ok: true })
  const onOpenModels = vi.fn()
  render(<WorkbenchChildConversation workspaceId={workspace.id} item={item} agent={view.agents[1]}
    onChange={vi.fn()} onOpenModels={onOpenModels} catalog={{
      providers: [], thinkingLevels: ['off'],
      models: [{ provider: 'alternative', modelId: 'available', name: '可用模型', reasoning: false, available: true }],
    }} />)
  expect(screen.getByText('MODEL_UNAVAILABLE')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: '模型设置' }))
  expect(onOpenModels).toHaveBeenCalledOnce()
  fireEvent.change(screen.getByRole('combobox', { name: '本次重试使用的模型' }), { target: { value: 'alternative/available' } })
  fireEvent.click(screen.getByRole('button', { name: '重试本轮' }))
  await waitFor(() => expect(recover).toHaveBeenCalledWith(workspace.id, {
    itemId: item.id, attempt: item.attempt, model: { provider: 'alternative', modelId: 'available' },
  }))
})

it('opens a fresh composer on a new-input request received before the workbench mounts', async () => {
  vi.spyOn(workbenchApi, 'get').mockResolvedValue(workbench())
  const handled = vi.fn()
  const props = { workspace, page: 'agent' as const, onInbox: vi.fn(), onComposeHandled: handled }
  const { rerender } = render(<AgentWorkbench {...props} composeNonce={1} />)
  await screen.findByRole('heading', { name: '有什么要做的？' })
  expect(handled).toHaveBeenCalledWith(1)
  rerender(<AgentWorkbench {...props} composeNonce={0} />)
  fireEvent.click(screen.getByRole('button', { name: '返回主线记录' }))
  expect(await screen.findByRole('button', { name: '打开会话：日志排查' })).toBeTruthy()
})

it.each([
  ['/managed/item-1', '/managed/item-1/output/evidence.txt'],
  [String.raw`D:\managed\item-1`, String.raw`D:\managed\item-1\output\evidence.txt`],
])('opens child artifacts relative to the actual worker cwd %s', async (cwd, expected) => {
  const view = workbench()
  view.items[0]!.evidence = [
    { kind: 'artifact', label: '任务证据', path: 'output/evidence.txt', status: 'recorded' },
    { kind: 'artifact', label: '原项目源文件', path: '/project/src/reference.ts', status: 'recorded' },
  ]
  const child = detail('child')
  child.conversation.cwd = cwd
  vi.spyOn(workbenchApi, 'get').mockResolvedValue(view)
  vi.spyOn(api, 'getConversation').mockResolvedValue(child)
  vi.spyOn(api, 'watch').mockReturnValue({ close: vi.fn() } as unknown as EventSource)
  const openFile = vi.fn()
  render(<AgentWorkbench workspace={workspace} page="agent" onInbox={vi.fn()} onFileOpen={openFile} />)
  fireEvent.click(await screen.findByRole('button', { name: '打开会话：日志排查' }))
  fireEvent.click(await screen.findByRole('button', { name: '任务证据' }))
  fireEvent.click(screen.getByRole('button', { name: '原项目源文件' }))
  expect(openFile).toHaveBeenCalledWith(expected, undefined)
  expect(openFile).toHaveBeenCalledWith('/project/src/reference.ts', undefined)
})

it('lists each delivered file once and distinguishes the original project from the worker directory', async () => {
  const view = workbench()
  const item = view.items[0]!
  const child = detail('child')
  child.conversation.cwd = '/managed/task'
  const projectFile = '/workspace/docs/result.md'
  const scratchFile = '/managed/task/docs/result.md'
  item.evidence = [projectFile, projectFile, './docs/result.md', scratchFile, '/workspace/docs/proof.md'].map(path => ({
    kind: 'artifact', label: path, path, status: 'recorded',
  }))
  item.evidence.push(
    { kind: 'artifact', label: '补充证据', path: '/workspace/docs/proof.md', status: 'recorded' },
    { kind: 'validation', label: 'npm run check', status: 'passed' },
  )
  vi.spyOn(api, 'getConversation').mockResolvedValue(child)
  vi.spyOn(api, 'watch').mockReturnValue({ close: vi.fn() } as unknown as EventSource)
  const openFile = vi.fn()
  render(<WorkbenchChildConversation workspaceId={workspace.id} workspacePath={workspace.path} item={item}
    agent={view.agents[1]} onFileOpen={openFile} onChange={vi.fn()} />)

  const section = within(await screen.findByRole('region', { name: '交付结果' }))
  expect(section.getAllByRole('listitem')).toHaveLength(4)
  const [project, scratch] = section.getAllByRole('button', { name: 'docs/result.md' })
  expect(project!.title).toBe(projectFile)
  expect(scratch!.title).toBe(scratchFile)
  expect(section.getByRole('button', { name: 'docs/result.md', description: '工作项目录' })).toBe(scratch)
  expect(section.getByRole('button', { name: '补充证据' }).title).toBe('/workspace/docs/proof.md')
  expect(section.getByText('npm run check')).toBeTruthy()
  fireEvent.click(project!)
  fireEvent.click(scratch!)
  expect(openFile.mock.calls).toEqual([[projectFile, undefined], [scratchFile, undefined]])
})

it('switches Bot roles and routes the lead back to the only dispatch entry', async () => {
  vi.spyOn(workbenchApi, 'get').mockResolvedValue(workbench())
  vi.spyOn(api, 'getConversation').mockResolvedValue(detail('child'))
  vi.spyOn(api, 'watch').mockReturnValue({ close: vi.fn() } as unknown as EventSource)
  const openAgent = vi.fn()
  render(<AgentWorkbench workspace={workspace} page="bots" onInbox={vi.fn()} onAgent={openAgent} />)
  const roster = await screen.findByRole('complementary', { name: 'Bot 名册' })
  const worker = within(roster).getByRole('button', { name: /时间智能体/, pressed: false })
  fireEvent.click(worker)
  expect(worker.getAttribute('aria-pressed')).toBe('true')
  expect(screen.getByText('这个 Bot 还没有收到任务。')).toBeTruthy()
  expect(screen.queryByRole('textbox', { name: '发消息给 Agent' })).toBeNull()
  const lead = within(roster).getByRole('button', { name: /主 Agent/ })
  fireEvent.click(lead)
  expect(lead.getAttribute('aria-pressed')).toBe('true')
  fireEvent.click(screen.getByRole('button', { name: '打开 Agent 对话' }))
  expect(openAgent).toHaveBeenCalledTimes(1)
})

it('opens an already addressed composer on the first commit when dispatching from a Bot', async () => {
  vi.spyOn(workbenchApi, 'get').mockResolvedValue(workbench())
  vi.spyOn(api, 'getConversation').mockResolvedValue(detail('child'))
  vi.spyOn(api, 'watch').mockReturnValue({ close: vi.fn() } as unknown as EventSource)
  const submit = vi.spyOn(workbenchApi, 'submit').mockResolvedValue({ requestId: 'routed-task' })
  const firstCommitHasTarget = vi.fn()
  function Navigation() {
    const [page, setPage] = useState<'agent' | 'bots'>('bots')
    useLayoutEffect(() => {
      if (page === 'agent') firstCommitHasTarget(screen.queryByRole('button', { name: '移除提及 时间智能体' }) !== null)
    }, [page])
    return <AgentWorkbench workspace={workspace} page={page} onInbox={vi.fn()} onAgent={() => setPage('agent')} />
  }
  render(<Navigation />)

  const roster = within(await screen.findByRole('complementary', { name: 'Bot 名册' }))
  fireEvent.click(roster.getByRole('button', { name: /时间智能体/, pressed: false }))
  fireEvent.click(screen.getByRole('button', { name: '给该 Bot 派发任务' }))

  expect(firstCommitHasTarget).toHaveBeenCalledExactlyOnceWith(true)
  const editor = screen.getByRole<HTMLTextAreaElement>('textbox', { name: '发消息给 Agent' })
  expect(document.activeElement).toBe(editor)
  fireEvent.change(editor, { target: { value: '检查只读权限' } })
  fireEvent.keyDown(editor, { key: 'Enter' })
  await waitFor(() => expect(submit).toHaveBeenCalledExactlyOnceWith(workspace.id, expect.objectContaining({
    text: '检查只读权限', mention: 'time', whenBusy: 'followUp',
  })))
})

it('edits an unselected Bot directly from the roster and preserves the open task', async () => {
  const view = workbench()
  view.items.push({ ...view.items[0]!, id: 'newer-task', childId: 'newer-child', title: '最近工作', updatedAt: now + 1 })
  const rosterRefresh = new Promise<WorkbenchView>(() => {})
  const get = vi.spyOn(workbenchApi, 'get').mockResolvedValueOnce(view).mockReturnValue(rosterRefresh)
  vi.spyOn(api, 'getConversation').mockImplementation(async id => detail(id))
  vi.spyOn(api, 'getSkills').mockResolvedValue({ skills: [], diagnostics: [] })
  vi.spyOn(api, 'watch').mockReturnValue({ close: vi.fn() } as unknown as EventSource)
  const updated = { ...view.agents[2]!, name: '顺序助手' }
  const save = vi.spyOn(workbenchApi, 'updateBot').mockResolvedValue(updated)
  render(<AgentWorkbench workspace={workspace} page="bots" onInbox={vi.fn()} />)

  const roster = within(await screen.findByRole('complementary', { name: 'Bot 名册' }))
  expect(within(screen.getByRole('region', { name: '选中的 Bot 会话' })).getByRole('button', { name: '编辑 Bot：日志智能体' })).toBeTruthy()
  expect(within(screen.getByRole('complementary', { name: 'Bot 详情' })).getByRole('button', { name: '编辑 Bot：日志智能体' })).toBeTruthy()
  const selectedTask = screen.getByRole<HTMLSelectElement>('combobox', { name: '任务' })
  fireEvent.change(selectedTask, { target: { value: 'item-1' } })
  const edit = roster.getByRole('button', { name: '编辑 Bot：时间智能体' })
  expect(roster.queryByRole('button', { name: '编辑 Bot：主 Agent' })).toBeNull()
  edit.focus()
  fireEvent.click(edit)
  const dialog = within(screen.getByRole('dialog', { name: '编辑 Bot', description: '时间智能体' }))
  fireEvent.change(dialog.getByLabelText('名称'), { target: { value: updated.name } })
  fireEvent.click(dialog.getByRole('button', { name: '保存修改' }))

  const renamedEdit = await roster.findByRole('button', { name: '编辑 Bot：顺序助手' })
  expect(save).toHaveBeenCalledWith(workspace.id, updated.id, expect.objectContaining({ name: updated.name }))
  expect(selectedTask.value).toBe('item-1')
  expect(screen.getByText(/已接收任务「日志排查」/)).toBeTruthy()
  expect(document.activeElement).toBe(renamedEdit)
  expect(get).toHaveBeenCalledTimes(2)
})

it('edits a Bot from the work item header and keeps the child conversation open after saving', async () => {
  const view = workbench()
  const child = detail('child')
  child.messages = [{ id: 'answer', role: 'assistant', runId: 'run-1', timestamp: now,
    blocks: [{ type: 'text', text: '待保留的会话内容。' }] }]
  const rosterRefresh = new Promise<WorkbenchView>(() => {})
  vi.spyOn(workbenchApi, 'get').mockResolvedValueOnce(view).mockReturnValue(rosterRefresh)
  vi.spyOn(api, 'getConversation').mockResolvedValue(child)
  vi.spyOn(api, 'getSkills').mockResolvedValue({ skills: [], diagnostics: [] })
  vi.spyOn(api, 'watch').mockReturnValue({ close: vi.fn() } as unknown as EventSource)
  const updated = { ...view.agents[1]!, name: '日志专家' }
  vi.spyOn(workbenchApi, 'updateBot').mockResolvedValue(updated)
  render(<AgentWorkbench workspace={workspace} page="agent" onInbox={vi.fn()} />)

  fireEvent.click(await screen.findByRole('button', { name: '打开会话：日志排查' }))
  await screen.findByText('待保留的会话内容。')
  fireEvent.click(screen.getByRole('button', { name: '编辑 Bot：日志智能体' }))
  const dialog = within(screen.getByRole('dialog', { name: '编辑 Bot' }))
  fireEvent.change(dialog.getByLabelText('名称'), { target: { value: updated.name } })
  fireEvent.click(dialog.getByRole('button', { name: '保存修改' }))

  expect(await screen.findByRole('heading', { name: updated.name })).toBeTruthy()
  expect(screen.getByText('待保留的会话内容。')).toBeTruthy()
  expect(screen.getByRole('button', { name: '主对话' })).toBeTruthy()
})

it('shows a delivered item awaiting review consistently in the main conversation and status drawer', async () => {
  const view = workbench()
  const item = view.items[0]!
  item.status = 'pending_review'
  item.waitingOn = { kind: 'human', detail: 'internal-interaction-id' }
  vi.spyOn(workbenchApi, 'get').mockResolvedValue(view)
  render(<AgentWorkbench workspace={workspace} page="agent" onInbox={vi.fn()} />)
  const card = await screen.findByRole('button', { name: '打开会话：日志排查' })
  expect(within(card).getByText('结果待验收')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: '内部状态' }))
  const drawer = within(screen.getByRole('dialog'))
  expect(drawer.getByText('日志智能体')).toBeTruthy()
  expect(drawer.getByText('结果待验收')).toBeTruthy()
  expect(drawer.queryByText('internal-interaction-id')).toBeNull()
})

it('opens a relative Markdown delivery link at its recorded project path while preserving its line', async () => {
  const view = workbench()
  const item = view.items[0]!
  const data = detail('child')
  data.conversation.cwd = '/managed/task'
  data.messages = [{ id: 'write-tool', role: 'tool', timestamp: now, blocks: [],
    artifacts: [{ kind: 'write', path: '/workspace/docs/result.md' }] },
  { id: 'answer', role: 'assistant', runId: 'run-1', timestamp: now + 1,
    blocks: [{ type: 'text', text: '[阅读本次交付](./docs/result.md#L2)' }] }]
  vi.spyOn(api, 'getConversation').mockResolvedValue(data)
  vi.spyOn(api, 'watch').mockReturnValue({ close: vi.fn() } as unknown as EventSource)
  const openFile = vi.fn()
  render(<WorkbenchChildConversation workspaceId={workspace.id} workspacePath="/workspace" item={item} agent={view.agents[1]}
    onFileOpen={openFile} onChange={vi.fn()} />)
  fireEvent.click(await screen.findByRole('button', { name: '阅读本次交付' }))
  expect(openFile).toHaveBeenCalledWith('/workspace/docs/result.md', 2)
})

it.each([
  { toolName: 'read', details: { resolvedPath: '/workspace/docs/result.md' }, isError: false },
  { toolName: 'codemode', details: { workbenchFiles: [{ kind: 'read', path: '/workspace/docs/result.md' }] }, isError: true },
])('uses $toolName file evidence in the matching child turn', async projectOperation => {
  const view = workbench()
  view.items[0]!.evidence = [
    { kind: 'artifact', label: '报告附件', path: '/workspace/docs/proof.md', status: 'recorded' },
    { kind: 'response', label: '打开交付回合', status: 'recorded', entryId: 'result-entry' },
  ]
  const data = detail('child')
  data.conversation.cwd = '/managed/task'
  data.messages = [
    { id: 'legacy-write', runId: 'old', role: 'tool', toolName: 'write', timestamp: now, blocks: [],
      artifacts: [{ kind: 'write', path: 'docs/result.md' }] },
    { id: 'legacy-answer', runId: 'old', role: 'assistant', timestamp: now + 1,
      blocks: [{ type: 'text', text: '[查看早期交付](./docs/result.md#L2) · [查看早期附件](docs/proof.md)' }] },
    { id: 'scratch-write', runId: 'current', role: 'tool', toolName: 'write', timestamp: now + 2, blocks: [],
      details: { resolvedPath: '/managed/task/docs/result.md' }, artifacts: [{ kind: 'write', path: '/managed/task/docs/result.md' }] },
    { id: 'project-operation', runId: 'current', role: 'tool', timestamp: now + 3, blocks: [], ...projectOperation },
    { id: 'scratch-only', runId: 'current', role: 'tool', toolName: 'write', timestamp: now + 4, blocks: [],
      details: { resolvedPath: '/managed/task/docs/temporary.md' } },
    { id: 'failed-read', runId: 'current', role: 'tool', toolName: 'read', timestamp: now + 5, blocks: [], isError: true,
      details: { resolvedPath: '/workspace/docs/temporary.md' }, artifacts: [{ kind: 'read', path: '/workspace/docs/temporary.md' }] },
    { id: 'current-answer', entryId: 'result-entry', runId: 'current', role: 'assistant', timestamp: now + 6, blocks: [{ type: 'text',
      text: '[查看本轮交付](./docs/result.md#L4) · [查看临时成品](docs/temporary.md#L6) · [查看完整路径](/managed/task/docs/result.md#L8) · [查看本轮附件](docs/proof.md)' }] },
  ]
  vi.spyOn(api, 'getConversation').mockResolvedValue(data)
  vi.spyOn(api, 'watch').mockReturnValue({ close: vi.fn() } as unknown as EventSource)
  const openFile = vi.fn()
  render(<WorkbenchChildConversation workspaceId={workspace.id} workspacePath={workspace.path} item={view.items[0]!}
    agent={view.agents[1]} onFileOpen={openFile} onChange={vi.fn()} />)

  fireEvent.click(await screen.findByRole('button', { name: '查看早期交付' }))
  fireEvent.click(screen.getByRole('button', { name: '查看早期附件' }))
  fireEvent.click(screen.getByRole('button', { name: '查看本轮交付' }))
  fireEvent.click(screen.getByRole('button', { name: '查看临时成品' }))
  fireEvent.click(screen.getByRole('button', { name: '查看完整路径' }))
  fireEvent.click(screen.getByRole('button', { name: '查看本轮附件' }))

  expect(openFile.mock.calls).toEqual([
    ['/managed/task/docs/result.md', 2],
    ['/managed/task/docs/proof.md', undefined],
    ['/workspace/docs/result.md', 4],
    ['/managed/task/docs/temporary.md', 6],
    ['/managed/task/docs/result.md', 8],
    ['/workspace/docs/proof.md', undefined],
  ])
})

it('accepts a delivery from its own conversation using the displayed attempt', async () => {
  const view = workbench()
  const item = { ...view.items[0]!, status: 'pending_review' as const, attempt: 2, acceptance: ['核对生成的文件'] }
  const child = detail('child')
  vi.spyOn(api, 'getConversation').mockResolvedValue(child)
  vi.spyOn(api, 'watch').mockReturnValue({ close: vi.fn() } as unknown as EventSource)
  const verdict = vi.spyOn(workbenchApi, 'verdict').mockResolvedValue({ ok: true })
  const refresh = vi.fn()
  render(<WorkbenchChildConversation workspaceId={workspace.id} item={item} agent={view.agents[1]} onChange={refresh} />)
  fireEvent.click(await screen.findByRole('button', { name: '验收通过' }))
  await waitFor(() => expect(verdict).toHaveBeenCalledWith('space', 'item-1', { action: 'accept', attempt: 2 }))
  await waitFor(() => expect(refresh).toHaveBeenCalledOnce())
  expect(screen.queryByRole('button', { name: '去收件箱处理' })).toBeNull()
})

it('retains revision feedback on a failed in-conversation submission', async () => {
  const view = workbench()
  const item = { ...view.items[0]!, status: 'pending_review' as const, attempt: 3 }
  vi.spyOn(api, 'getConversation').mockResolvedValue(detail('child'))
  vi.spyOn(api, 'watch').mockReturnValue({ close: vi.fn() } as unknown as EventSource)
  const verdict = vi.spyOn(workbenchApi, 'verdict').mockRejectedValueOnce(new Error('服务连接中断')).mockResolvedValue({ ok: true })
  render(<WorkbenchChildConversation workspaceId={workspace.id} item={item} agent={view.agents[1]} onChange={vi.fn()} />)
  fireEvent.click(await screen.findByRole('button', { name: '退回修改' }))
  const feedback = screen.getByLabelText('修改意见（选填）') as HTMLTextAreaElement
  fireEvent.change(feedback, { target: { value: '补上核对依据' } })
  fireEvent.click(screen.getByRole('button', { name: '提交返修' }))
  expect((await screen.findByRole('alert')).textContent).toContain('服务连接中断')
  expect(feedback.value).toBe('补上核对依据')
  fireEvent.click(screen.getByRole('button', { name: '提交返修' }))
  await screen.findByText('已退回修改')
  expect(verdict).toHaveBeenLastCalledWith('space', 'item-1', { action: 'revise', attempt: 3, feedback: '补上核对依据' })
})

it('recovers the terminal child snapshot when the work item has completed before the stream settles', async () => {
  const item = { ...workbench().items[0]!, status: 'pending_review' as const, outcome: { summary: '已经完成。', at: now } }
  const settled = detail('child')
  const working = { ...settled, conversation: { ...settled.conversation, busy: true } }
  vi.spyOn(api, 'watch').mockImplementation((_id, receive) => {
    receive(working)
    return { close: vi.fn() } as unknown as EventSource
  })
  const get = vi.spyOn(api, 'getConversation').mockResolvedValue(settled)
  render(<WorkbenchChildConversation workspaceId={workspace.id} item={item} agent={workbench().agents[1]} onChange={vi.fn()} />)
  expect(await screen.findByRole('button', { name: '验收通过' })).toBeTruthy()
  expect(get.mock.calls.length).toBeGreaterThan(1)
  expect(screen.queryByRole('button', { name: '停止当前回答' })).toBeNull()
})

it('shows the saved Bot permission for the next message and the granted permission during an active run', async () => {
  const view = workbench()
  const item = view.items[0]!
  const agent = { ...view.agents[1]!, accessMode: 'readOnly' as const }
  const child = detail('child')
  child.conversation.accessMode = 'readOnly'
  vi.spyOn(api, 'getConversation').mockResolvedValue(child)
  vi.spyOn(api, 'watch').mockReturnValue({ close: vi.fn() } as unknown as EventSource)
  const props = { workspaceId: workspace.id, item, agent, onChange: vi.fn() }
  const { rerender } = render(<WorkbenchChildConversation {...props} />)
  expect(await screen.findByTitle('仅可查看')).toBeTruthy()
  const updated = { ...agent, accessMode: 'fullAccess' as const }
  rerender(<WorkbenchChildConversation {...props} agent={updated} />)
  expect(screen.getByTitle('完全权限')).toBeTruthy()
  rerender(<WorkbenchChildConversation {...props} agent={updated} item={{ ...item, status: 'running', accessMode: 'workspaceWrite' }} />)
  expect(screen.getByTitle('工作区内修改')).toBeTruthy()
  expect(screen.getByText(/下次发消息时使用「完全权限」/)).toBeTruthy()
})
