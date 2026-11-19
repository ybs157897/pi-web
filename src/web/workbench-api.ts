import type { ResultVerdict } from '../shared/decision-inbox.ts'
import type { CreateWorkbenchBotInput, UpdateWorkbenchBotInput, WorkbenchAgent, WorkbenchReplyInput, WorkbenchRetryInput, WorkbenchSubmitInput, WorkbenchView } from '../shared/workbench.ts'
import { request } from './api.ts'

const workbenchPath = (workspaceId: string) => `/api/workbench/${encodeURIComponent(workspaceId)}`

export const workbenchApi = {
  createBot(workspaceId: string, input: CreateWorkbenchBotInput): Promise<WorkbenchAgent> {
    return request(`${workbenchPath(workspaceId)}/bots`, { method: 'POST', body: JSON.stringify(input) })
  },
  updateBot(workspaceId: string, botId: string, input: UpdateWorkbenchBotInput): Promise<WorkbenchAgent> {
    return request(`${workbenchPath(workspaceId)}/bots/${encodeURIComponent(botId)}`, { method: 'PATCH', body: JSON.stringify(input) })
  },
  get(workspaceId: string, signal?: AbortSignal): Promise<WorkbenchView> {
    return request(workbenchPath(workspaceId), { signal })
  },
  submit(workspaceId: string, input: WorkbenchSubmitInput): Promise<{ requestId: string }> {
    return request(`${workbenchPath(workspaceId)}/messages`, {
      method: 'POST', body: JSON.stringify(input),
    })
  },
  verdict(workspaceId: string, itemId: string, input: ResultVerdict & { attempt: number }): Promise<{ ok: true }> {
    return request(`${workbenchPath(workspaceId)}/items/${encodeURIComponent(itemId)}/verdict`, {
      method: 'POST', body: JSON.stringify(input),
    })
  },
  retry(workspaceId: string, input: WorkbenchRetryInput): Promise<{ ok: true }> {
    return request(`${workbenchPath(workspaceId)}/retry`, {
      method: 'POST', body: JSON.stringify(input),
    })
  },
  reply(workspaceId: string, itemId: string, input: WorkbenchReplyInput): Promise<{ requestId: string }> {
    return request(`${workbenchPath(workspaceId)}/items/${encodeURIComponent(itemId)}/messages`, {
      method: 'POST', body: JSON.stringify(input),
    })
  },
}
