import type { DecisionMail, DecisionMailSummary, ResultVerdict, UpdateDecisionMail } from '../shared/decision-inbox.ts'
import { request } from './api.ts'

export const DECISION_INBOX_CHANGED = 'workbench-inbox-change'

function path(workspaceId: string, id?: string): string {
  const root = `/api/workbench/${encodeURIComponent(workspaceId)}/inbox`
  return id === undefined ? root : `${root}/${encodeURIComponent(id)}`
}

export const decisionInboxApi = {
  list(workspaceId: string, signal?: AbortSignal): Promise<{ mails: DecisionMailSummary[]; pendingCount: number }> {
    return request(path(workspaceId), signal ? { signal } : undefined)
  },
  detail(workspaceId: string, id: string, signal?: AbortSignal): Promise<DecisionMail> {
    return request(path(workspaceId, id), signal ? { signal } : undefined)
  },
  opened(workspaceId: string, id: string): Promise<{ ok: boolean }> {
    return request(`${path(workspaceId, id)}/opened`, { method: 'POST' })
  },
  update(workspaceId: string, id: string, input: UpdateDecisionMail): Promise<DecisionMail> {
    return request(path(workspaceId, id), { method: 'PATCH', body: JSON.stringify(input) })
  },
  updateMany(workspaceId: string, ids: string[], update: UpdateDecisionMail): Promise<{ ok: boolean }> {
    return request(path(workspaceId), { method: 'PATCH', body: JSON.stringify({ ids, update }) })
  },
  verdict(workspaceId: string, id: string, input: ResultVerdict): Promise<DecisionMail> {
    return request(`${path(workspaceId, id)}/verdict`, { method: 'POST', body: JSON.stringify(input) })
  },
}
