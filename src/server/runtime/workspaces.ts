/**
 * Workspace registration plus the file, search and Git surfaces that hang off one.
 *
 * Deleting a workspace rebinds its conversations to the fallback workspace, so the
 * feature receives the conversation list and metadata writer instead of reaching into
 * the conversation engine.
 */
import { randomUUID } from 'node:crypto'
import type {
  AddWorkspaceInput, Automation, ConversationSummary, CreateGitBranchInput, GitBranchMutation, GitBranchSnapshot,
  GitCommitInput, GitCommitMessageInput, GitCommitMessageResult, GitCommitResult, GitPushResult,
  GitWorktreeDiff, GitWorktreeStatus, RenameWorkspaceInput, SwitchGitBranchInput, WorkspaceSummary,
} from '../../shared/types.ts'
import type { ConversationId } from '@earendil-works/pi-durable'
import type { AppStateStore } from '../state/app-state.ts'
import type { RuntimeModels } from '../model/catalog.ts'
import type { WorkspaceFiles } from '../workspace/files.ts'
import { GitBranches } from '../workspace/git/branches.ts'
import { GitWorktree } from '../workspace/git/worktree.ts'
import { commitMessageSystemPrompt, frameCommitContext, normalizeCommitMessage } from '../workspace/git/commit-message.ts'
import { createDirectory as createHostDirectory, listDirectories as listHostDirectories, pickNativeDirectory } from '../workspace/directory-picker.ts'
import { RuntimeError } from '../runtime-errors.ts'

export interface WorkspacesDeps {
  appState: AppStateStore
  modelRuntime: RuntimeModels
  workspaceFiles: WorkspaceFiles
  /** Every ownerless conversation, used to rebind sessions when a workspace disappears. */
  list(): Promise<ConversationSummary[]>
  withMetadata(id: ConversationId, update: (metadata: { workspaceId: string | null }) => void): Promise<void>
  parseConversationId(value: string): ConversationId
  assertNoAutomationReferences(items: readonly Automation[], resource: 'workspace' | 'preset', id: string): void
  /** One conversation's bound model, for the commit-message suggestion. */
  conversationModel(value: string): Promise<{ provider: string; modelId: string } | undefined>
}

export function createWorkspaces(deps: WorkspacesDeps) {
  const { appState, modelRuntime, workspaceFiles, list, withMetadata, parseConversationId, assertNoAutomationReferences, conversationModel } = deps
  const gitBranches = new GitBranches(() => appState.snapshot().workspaces)
  const gitWorktree = new GitWorktree(() => appState.snapshot().workspaces)

  const workspaces = (): WorkspaceSummary[] => appState.snapshot().workspaces

  const addWorkspace = async (input: AddWorkspaceInput): Promise<WorkspaceSummary> => {
    const candidate = await workspaceFiles.addWorkspace(input.path, input.name)
    return appState.update(state => {
      if (state.workspaces.some(item => item.path === candidate.path)) throw new RuntimeError('CONFLICT', '这个目录已经添加为工作区')
      state.workspaces.push(candidate)
      return structuredClone(candidate)
    })
  }

  const renameWorkspace = async (id: string, input: RenameWorkspaceInput): Promise<WorkspaceSummary> => {
    const name = input.name.trim()
    if (!name || name.length > 120) throw new RuntimeError('INVALID_INPUT', '工作区名称长度必须在 1 到 120 个字符之间')
    return appState.update(state => {
      const item = state.workspaces.find(workspace => workspace.id === id)
      if (!item) throw new RuntimeError('NOT_FOUND', '工作区不存在')
      item.name = name
      item.updatedAt = Date.now()
      return structuredClone(item)
    })
  }

  const pickDirectory = (signal?: AbortSignal): Promise<string | null> => pickNativeDirectory(signal)
  const listDirectories = (path?: string) => listHostDirectories(path)
  const createDirectory = (parent: string, name: string) => createHostDirectory(parent, name)

  const workspaceFileList = (id: string, path: string, query?: string) => workspaceFiles.list(id, path, query)

  /**
   * Unregister a workspace, mirroring DSH's row action: its sessions rebind to a
   * remaining workspace so no conversation keeps a dangling binding, and the
   * directory on disk is left untouched. Deleting the last workspace is allowed;
   * its sessions stay unbound until the user adds another one.
   */
  const deleteWorkspace = async (id: string): Promise<void> => {
    const state = appState.snapshot()
    if (!state.workspaces.some(workspace => workspace.id === id)) throw new RuntimeError('NOT_FOUND', '工作区不存在')
    assertNoAutomationReferences(state.automations, 'workspace', id)
    await appState.update(async current => {
      if (!current.workspaces.some(workspace => workspace.id === id)) throw new RuntimeError('NOT_FOUND', '工作区不存在')
      assertNoAutomationReferences(current.automations, 'workspace', id)
      const currentRemaining = current.workspaces.filter(workspace => workspace.id !== id)
      const currentFallback = currentRemaining.find(workspace => workspace.id === current.settings.defaultWorkspaceId) ?? currentRemaining[0]
      for (const summary of await list()) {
        if (summary.workspaceId !== id) continue
        await withMetadata(parseConversationId(summary.id), draft => { draft.workspaceId = currentFallback?.id ?? null })
      }
      current.workspaces = current.workspaces.filter(workspace => workspace.id !== id)
      if (current.settings.defaultWorkspaceId === id) {
        if (currentFallback === undefined) delete current.settings.defaultWorkspaceId
        else current.settings.defaultWorkspaceId = currentFallback.id
      }
    })
  }

  const searchWorkspace = (id: string, query: string) => workspaceFiles.list(id, '', query)
  const workspaceFile = (id: string, path: string) => workspaceFiles.read(id, path)
  const workspaceAsset = (id: string, path: string) => workspaceFiles.asset(id, path)

  const gitBranchSnapshot = (id: string): Promise<GitBranchSnapshot> => gitBranches.snapshot(id)
  const switchGitBranch = (id: string, input: SwitchGitBranchInput): Promise<GitBranchMutation> => gitBranches.switch(id, input)
  const createGitBranch = (id: string, input: CreateGitBranchInput): Promise<GitBranchMutation> => gitBranches.create(id, input)
  const gitWorktreeStatus = (id: string): Promise<GitWorktreeStatus> => gitWorktree.status(id)
  const gitWorktreeDiff = (id: string, path: string): Promise<GitWorktreeDiff> => gitWorktree.diff(id, path)
  const gitCommit = (id: string, input: GitCommitInput): Promise<GitCommitResult> => gitWorktree.commit(id, input)
  const gitPush = (id: string): Promise<GitPushResult> => gitWorktree.push(id)
  const gitCommitMessage = async (id: string, input: GitCommitMessageInput): Promise<GitCommitMessageResult> => {
    const { status, diff } = await gitWorktree.commitContext(id, input.includeUnstaged)
    if (!status.isRepository) throw new RuntimeError('INVALID_INPUT', '工作区不在 Git 仓库中')
    if (status.files.length === 0) throw new RuntimeError('INVALID_INPUT', '没有可提交的改动')
    if (!input.includeUnstaged && diff.trim() === '') throw new RuntimeError('INVALID_INPUT', '没有已暂存的改动')
    const route = input.conversationId === undefined
      ? modelRuntime.defaultModel
      : await conversationModel(input.conversationId) ?? modelRuntime.defaultModel
    if (route === undefined) throw new RuntimeError('MODEL_UNAVAILABLE', '没有可用的模型')
    const model = modelRuntime.models.getModel(route.provider, route.modelId)
    if (model === undefined) throw new RuntimeError('MODEL_UNAVAILABLE', '会话模型不在 Pi 模型目录中')
    const locale = appState.snapshot().settings.locale
    const result = await modelRuntime.models.completeSimple(model, {
      systemPrompt: commitMessageSystemPrompt(locale),
      messages: [{ role: 'user', content: frameCommitContext({ branchName: status.branchName, files: status.files, diff, locale }), timestamp: Date.now() }],
    }, { maxTokens: 512, timeoutMs: 30_000, sessionId: `git-commit-${randomUUID()}` })
    if (result.stopReason !== 'stop') throw new RuntimeError('PROVIDER_ERROR', '模型没有返回提交信息')
    const message = normalizeCommitMessage(result.content.flatMap(part => part.type === 'text' ? [part.text] : []).join('\n'))
    if (message === '') throw new RuntimeError('PROVIDER_ERROR', '模型没有返回提交信息')
    return { message, provider: route.provider, model: route.modelId }
  }


  return {
    list: workspaces,
    add: addWorkspace,
    rename: renameWorkspace,
    remove: deleteWorkspace,
    pickDirectory,
    listDirectories,
    createDirectory,
    fileList: workspaceFileList,
    search: searchWorkspace,
    file: workspaceFile,
    asset: workspaceAsset,
    gitBranches: gitBranchSnapshot,
    switchGitBranch,
    createGitBranch,
    gitWorktreeStatus,
    gitWorktreeDiff,
    gitCommit,
    gitPush,
    gitCommitMessage,
  }
}
