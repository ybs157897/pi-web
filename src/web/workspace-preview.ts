import type { WorkspaceFile } from '../shared/types.ts'
import type { TabFile } from './inspector-tabs.ts'

export function workspacePreview(file: WorkspaceFile, workspaceId: string, line?: number, lineRequestId?: number): TabFile {
  const url = file.kind !== 'text' || file.textWindow !== undefined
    ? `/api/workspaces/${encodeURIComponent(workspaceId)}/asset?${new URLSearchParams({ path: file.path })}`
    : undefined
  return { path: file.path, content: file.content, textWindow: file.textWindow, mimeType: file.mimeType, size: file.size,
    workspaceId, line, lineRequestId: line === undefined ? undefined : lineRequestId, url }
}
