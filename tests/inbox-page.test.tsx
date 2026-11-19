// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { DecisionMail } from '../src/shared/decision-inbox.ts'
import InboxPage from '../src/web/InboxPage.tsx'
import { setupRenderingDom } from './rendering/setup.ts'

beforeEach(setupRenderingDom)
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

const mail: DecisionMail = {
  id: 'mail-1',
  kind: 'choice',
  reason: 'requirement_ambiguity',
  why: '两种排序规则都适用，需要你指定用户看到的顺序。',
  link: { conversationId: '21', parentConversationId: '19', workItemId: 'item-1', interactionId: 'call-42' },
  conversationTitle: '夏令时排序',
  groupId: '21',
  groupTitle: '夏令时排序',
  subject: '确认排序规则',
  snippet: '夏令时回拨时，按实际时间还是显示时间？',
  createdAt: Date.UTC(2026, 10, 18),
  folder: 'pending',
  actionable: true,
  evidence: [],
  questions: [{ id: 'sort', question: '夏令时回拨时，按实际时间还是显示时间？', options: [{ label: '实际时间' }, { label: '显示时间' }] }],
}

it('answers a real interaction through the mail view and opens its corresponding conversation', async () => {
  let current: DecisionMail = mail
  const fetch = vi.fn(async (path: string, init?: RequestInit) => {
    if (path === '/api/workbench/ws/inbox') return Response.json({ mails: [current], pendingCount: Number(current.actionable) })
    if (path === '/api/workbench/ws/inbox/mail-1') return Response.json(current)
    if (path === '/api/conversations/21/interactions/call-42/answer') {
      current = { ...mail, folder: 'archived', actionable: false, resolution: 'answered', answers: [{ id: 'sort', selected: ['实际时间'] }] }
      return Response.json({ interactions: [] })
    }
    return Response.json({ path, method: init?.method }, { status: 500 })
  })
  vi.stubGlobal('fetch', fetch)
  const open = vi.fn()
  render(<InboxPage workspaceId="ws" onOpenConversation={open} />)
  fireEvent.click(await screen.findByRole('button', { name: /确认排序规则/ }))
  expect(await screen.findByRole('heading', { name: '为什么找你' })).toBeTruthy()
  expect(screen.getByRole('heading', { name: '确认排序规则' })).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: '在智能体会话中查看' }))
  expect(open).toHaveBeenCalledWith(mail.link, mail.id)
  fireEvent.click(screen.getByRole('radio', { name: '实际时间' }))
  fireEvent.click(screen.getByRole('button', { name: '发送' }))
  expect(await screen.findByText('已答复')).toBeTruthy()
  const answer = fetch.mock.calls.find(([url]) => url === '/api/conversations/21/interactions/call-42/answer')?.[1]
  expect(answer?.method).toBe('POST')
  expect(JSON.parse(String(answer?.body))).toEqual({ answers: [{ id: 'sort', selected: ['实际时间'] }] })

  fireEvent.click(screen.getByRole('button', { name: '返回' }))
  expect(await screen.findByText('暂无待你决定的事项')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: /已处理/ }))
  expect(screen.getByRole('button', { name: /确认排序规则/ })).toBeTruthy()
})

it('lets users explicitly skip one question and submits an empty answer for it', async () => {
  const withNotes: DecisionMail = {
    ...mail, questions: [...mail.questions!, { id: 'notes', question: '还有什么补充要求？（可跳过）' }],
  }
  let current = withNotes
  const answerPath = '/api/conversations/21/interactions/call-42/answer'
  const fetch = vi.fn(async (path: string, init?: RequestInit) => {
    if (path === '/api/workbench/ws/inbox') return Response.json({ mails: [current], pendingCount: Number(current.actionable) })
    if (path === '/api/workbench/ws/inbox/mail-1') return Response.json(current)
    if (path === answerPath) {
      current = { ...withNotes, folder: 'archived', actionable: false, resolution: 'answered', ...JSON.parse(String(init?.body)) }
      return Response.json({ interactions: [] })
    }
    return Response.json({}, { status: 500 })
  })
  vi.stubGlobal('fetch', fetch)
  render(<InboxPage workspaceId="ws" initialMailId={mail.id} />)
  fireEvent.click(await screen.findByRole('radio', { name: '实际时间' }))
  const send = screen.getByRole<HTMLButtonElement>('button', { name: '发送' })
  const notes = screen.getByRole('group', { name: '还有什么补充要求？（可跳过）' })
  expect(send.disabled).toBe(true)
  fireEvent.click(within(notes).getByRole('button', { name: '跳过此题' }))
  expect(send.disabled).toBe(false)
  fireEvent.click(send)
  expect(await within(notes).findByText('已跳过')).toBeTruthy()
  const call = fetch.mock.calls.find(([path]) => path === answerPath)
  expect(JSON.parse(String(call?.[1]?.body))).toEqual({
    answers: [{ id: 'sort', selected: ['实际时间'] }, { id: 'notes', selected: [] }],
  })
})

it('returns an externally opened result to its own folder and resets filters when changing folders', async () => {
  const result: DecisionMail = {
    ...mail, id: 'mail-2', kind: 'result', reason: 'accept_result', subject: '排序待验收', questions: undefined,
  }
  vi.stubGlobal('fetch', vi.fn(async (path: string) => {
    if (path === '/api/workbench/ws/inbox') return Response.json({ mails: [mail, result], pendingCount: 2 })
    if (path === '/api/workbench/ws/inbox/mail-2') return Response.json(result)
    return Response.json({}, { status: 500 })
  }))
  render(<InboxPage workspaceId="ws" initialMailId={result.id} />)
  expect(await screen.findByRole('heading', { name: result.subject })).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: '返回' }))
  const folders = within(screen.getByRole('navigation', { name: '收件箱分类' }))
  const resultFolder = folders.getByRole('button', { name: /结果/ })
  expect(resultFolder.getAttribute('aria-current')).toBe('page')
  fireEvent.click(folders.getByRole('button', { name: /待你决定/ }))
  fireEvent.click(screen.getByRole('button', { name: '筛选' }))
  fireEvent.click(screen.getByRole('button', { name: '需求有歧义' }))
  fireEvent.click(resultFolder)
  expect(screen.getByRole('button', { name: /排序待验收/ })).toBeTruthy()
  expect(screen.getByRole('button', { name: '筛选' })).toBeTruthy()
})

it('opens the latest actionable mail for a work item once and offers its folder on return', async () => {
  const completed: DecisionMail = {
    ...mail, id: 'completed', folder: 'archived', actionable: false, subject: '旧答复',
  }
  const result: DecisionMail = {
    ...mail, id: 'ready', kind: 'result', reason: 'accept_result', subject: '该任务待验收', questions: undefined,
  }
  vi.stubGlobal('fetch', vi.fn(async (path: string) => {
    if (path === '/api/workbench/ws/inbox') return Response.json({ mails: [completed, result], pendingCount: 1 })
    if (path === '/api/workbench/ws/inbox/ready') return Response.json(result)
    return Response.json({}, { status: 500 })
  }))
  render(<InboxPage workspaceId="ws" initialWorkItemId={result.link.workItemId} />)
  expect(await screen.findByRole('heading', { name: result.subject })).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: '返回' }))
  expect(await screen.findByRole('button', { name: new RegExp(result.subject) })).toBeTruthy()
  expect(screen.queryByRole('heading', { name: result.subject })).toBeNull()
})

it('delivers the result verdict and archives the accepted letter', async () => {
  const { questions: _questions, ...base } = mail
  const result: DecisionMail = {
    ...base,
    kind: 'result',
    reason: 'accept_result',
    link: { conversationId: '21', parentConversationId: '19', workItemId: 'item-1' },
    evidence: [
      { kind: 'validation', label: '没有独立校验记录', status: 'insufficient' },
      { kind: 'artifact', label: '排序代码', path: 'calendar/sort.ts', status: 'recorded' },
    ],
    body: '交付排序分析。',
  }
  let current = result
  const fetch = vi.fn(async (path: string, init?: RequestInit) => {
    if (path === '/api/workbench/ws/inbox') return Response.json({ mails: [current], pendingCount: Number(current.actionable) })
    if (path === '/api/workbench/ws/inbox/mail-1') return Response.json(current)
    if (path.endsWith('/verdict') && init?.method === 'POST') {
      current = { ...result, folder: 'archived', actionable: false, resolution: 'accepted' }
      return Response.json(current)
    }
    return Response.json({}, { status: 500 })
  })
  vi.stubGlobal('fetch', fetch)
  const openFile = vi.fn()
  render(<InboxPage workspaceId="ws" initialMailId={result.id} onOpenFile={openFile} />)
  expect(await screen.findByText('证据不足')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: '排序代码' }))
  expect(openFile).toHaveBeenCalledWith('calendar/sort.ts')
  fireEvent.change(screen.getByRole('textbox', { name: '回复内容' }), { target: { value: '人工核实通过' } })
  fireEvent.click(screen.getByRole('button', { name: '验收通过' }))
  expect(await screen.findByText('验收通过')).toBeTruthy()
  expect(document.activeElement).toBe(screen.getByRole('heading', { name: result.subject }))
  expect(fetch.mock.calls.find(([url]) => url.endsWith('/verdict'))?.[1]?.body)
    .toBe(JSON.stringify({ action: 'accept', feedback: '人工核实通过' }))
  expect(screen.queryByRole('button', { name: '验收通过' })).toBeNull()
})

it('takes users to recovery when an exception needs model settings', async () => {
  const failure: DecisionMail = {
    ...mail, kind: 'exception', reason: 'cannot_verify', questions: undefined,
    failure: { code: 'MODEL_AUTH_FAILED', message: '请检查模型权限后继续。', retryable: false, action: 'check_model' },
  }
  vi.stubGlobal('fetch', vi.fn(async (path: string) => {
    if (path === '/api/workbench/ws/inbox') return Response.json({ mails: [failure], pendingCount: 1 })
    if (path === '/api/workbench/ws/inbox/mail-1') return Response.json(failure)
    return Response.json({}, { status: 500 })
  }))
  const open = vi.fn()
  render(<InboxPage workspaceId="ws" initialMailId={failure.id} onOpenConversation={open} />)
  expect(await screen.findByText('MODEL_AUTH_FAILED')).toBeTruthy()
  expect(screen.queryByRole('textbox', { name: '回复内容' })).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: '去处理异常' }))
  expect(open).toHaveBeenCalledWith(failure.link, failure.id)
})

it('filters the live list by decision reason and archives selected records without answering them', async () => {
  const second: DecisionMail = {
    ...mail, id: 'mail-2', reason: 'scope_conflict', kind: 'confirmation', subject: '确认范围',
  }
  let items = [mail, second]
  const endpoint = '/api/workbench/ws/inbox'
  const fetch = vi.fn(async (path: string, init?: RequestInit) => {
    if (path !== endpoint) return Response.json({ error: 'unexpected route' }, { status: 500 })
    if (init?.method === 'PATCH') {
      const { ids, update } = JSON.parse(String(init.body))
      expect(ids).toEqual([second.id])
      expect(update).toEqual({ action: 'archive' })
      items = items.map(item => ids.includes(item.id) ? { ...item, folder: 'archived' } : item)
      return Response.json({ ok: true })
    }
    return Response.json({ mails: items, pendingCount: items.filter(item => item.folder === 'pending').length })
  })
  vi.stubGlobal('fetch', fetch)
  render(<InboxPage workspaceId="ws" />)
  expect(await screen.findByText('处理情况')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: '筛选' }))
  fireEvent.click(screen.getByRole('button', { name: '范围冲突' }))
  expect(screen.queryByRole('button', { name: /确认排序规则/ })).toBeNull()
  fireEvent.click(screen.getByRole('checkbox', { name: '全选' }))
  fireEvent.click(screen.getByRole('button', { name: '归档' }))
  expect(await screen.findByText('没有符合筛选条件的邮件')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: /已处理/ }))
  expect(screen.getByText('仍待处理')).toBeTruthy()
  expect(fetch.mock.calls.map(([path]) => path)).toEqual(expect.arrayContaining([endpoint]))
  expect(fetch.mock.calls.some(([path]) => path.includes('/answer'))).toBe(false)
})
