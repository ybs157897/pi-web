/**
 * 工作区注册，以及挂在工作区上的文件、搜索与 Git 能力面。
 *
 * 删除工作区时会把它的会话改绑到兜底工作区，因此本 feature 通过依赖注入接收
 * 会话列表与元数据写入回调，而不是直接触碰会话引擎。
 */
import { randomUUID } from 'node:crypto'
import { mkdir, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import type {
  AddWorkspaceInput, Automation, ConversationSummary, CreateGitBranchInput, GitBranchMutation, GitBranchSnapshot,
  GitChangeSourceId, GitCommitInput, GitCommitMessageInput, GitCommitMessageResult, GitCommitResult, GitPushResult,
  GitWorktreeDiff, GitWorktreeStatus, RenameWorkspaceInput, SwitchGitBranchInput, WorkspaceSummary,
} from '../../shared/types.ts'
import type { ConversationId } from '@earendil-works/pi-durable'
import type { AppStateStore } from '../state/app-state.ts'
import type { RuntimeModels } from '../model/catalog.ts'
import type { WorkspaceFiles } from '../workspace/files.ts'
import { GitBranches } from '../workspace/git/branches.ts'
import { GitWorktree } from '../workspace/git/worktree.ts'
import { commitMessageSystemPrompt, frameCommitContext, normalizeCommitMessage } from '../workspace/git/commit-message.ts'
import { captureSideCall } from '../conversation/trajectory.ts'
import { createDirectory as createHostDirectory, listDirectories as listHostDirectories, pickNativeDirectory } from '../workspace/directory-picker.ts'
import { RuntimeError } from '../runtime-errors.ts'

/** 工作区 feature 的依赖注入契约：应用状态、模型运行时、文件服务与会话侧回调。 */
export interface WorkspacesDeps {
  dataDir: string
  appState: AppStateStore
  modelRuntime: RuntimeModels
  workspaceFiles: WorkspaceFiles
  /** 所有无主会话，用于工作区被删除时改绑会话。 */
  list(): Promise<ConversationSummary[]>
  withMetadata(id: ConversationId, update: (metadata: { workspaceId: string | null }) => void): Promise<void>
  parseConversationId(value: string): ConversationId
  assertNoAutomationReferences(items: readonly Automation[], id: string): void
  /** 某个会话绑定的模型，用于提交信息建议。 */
  conversationModel(value: string): Promise<{ provider: string; modelId: string } | undefined>
}

/**
 * 功能：创建工作区 feature 服务，覆盖工作区增删改名、目录选择、文件列表/搜索/读取
 * 以及分支、变基状态、提交与推送等 Git 能力面。
 * @param deps 依赖注入契约见 WorkspacesDeps；会话改绑通过注入回调完成，不触碰会话引擎
 * 职责边界：只管理工作区域；自动化任务对工作区的引用检查由注入的
 * assertNoAutomationReferences 提供。
 */
export function createWorkspaces(deps: WorkspacesDeps) {
  const { appState, modelRuntime, workspaceFiles, list, withMetadata, parseConversationId, assertNoAutomationReferences, conversationModel } = deps
  const gitBranches = new GitBranches(() => appState.snapshot().workspaces)
  const gitWorktree = new GitWorktree(() => appState.snapshot().workspaces)

  /** 读取当前工作区列表快照。 */
  const workspaces = (): WorkspaceSummary[] => appState.snapshot().workspaces

  /** 添加一个目录为工作区；重复路径在事务里判冲突。 */
  const addWorkspace = async (input: AddWorkspaceInput): Promise<WorkspaceSummary> => {
    const candidate = await workspaceFiles.addWorkspace(input.path, input.name)
    return appState.update(state => {
      if (state.workspaces.some(item => item.path === candidate.path)) throw new RuntimeError('CONFLICT', '这个目录已经添加为工作区')
      state.workspaces.push(candidate)
      return structuredClone(candidate)
    })
  }

  /** 用户输入仅作显示名称；重试同一请求沿用同一托管目录。 */
  const createNamedWorkspace = async (name: string, requestId: string): Promise<WorkspaceSummary> => {
    const label = name.trim()
    if (!label || label.length > 120 || !/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/iu.test(requestId)) {
      throw new RuntimeError('INVALID_INPUT', '工作空间名称或请求标识无效')
    }
    const root = join(deps.dataDir, 'workspaces')
    await mkdir(root, { recursive: true, mode: 0o700 })
    const path = join(await realpath(root), requestId.toLowerCase())
    await mkdir(path, { recursive: true, mode: 0o700 })
    if (await realpath(path) !== path) throw new RuntimeError('INVALID_INPUT', '托管工作空间目录无效')
    return appState.update(state => {
      const existing = state.workspaces.find(space => space.path === path)
      if (existing && existing.name !== label) throw new RuntimeError('CONFLICT', '这个请求已用于另一工作空间名称')
      if (existing) return structuredClone(existing)
      const now = Date.now()
      const candidate = { id: randomUUID(), name: label, path, createdAt: now, updatedAt: now }
      state.workspaces.push(candidate)
      return structuredClone(candidate)
    })
  }

  /** 重命名工作区；名称须为 1-120 字符，事务内找不到即 NOT_FOUND。 */
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

  /** 唤起系统原生目录选择器。 */
  const pickDirectory = (signal?: AbortSignal): Promise<string | null> => pickNativeDirectory(signal)
  /** 列出某个目录下的子目录，供「新建工作区」树形选择。 */
  const listDirectories = (path?: string) => listHostDirectories(path)
  /** 在指定父目录下创建子目录。 */
  const createDirectory = (parent: string, name: string) => createHostDirectory(parent, name)

  /** 列出工作区内文件，可带过滤词。 */
  const workspaceFileList = (id: string, path: string, query?: string) => workspaceFiles.list(id, path, query)

  /**
   * 功能：注销一个工作区，行为对齐 DSH 的行内删除操作。
   * @param id 待删除的工作区 ID
   * @returns 无返回；删除后受影响会话已改绑到兜底工作区
   * 内部逻辑：先检查存在性与自动化引用，再在事务里把该工作区的会话改绑到
   * 兜底（默认或剩余第一个）工作区，最后从列表移除并修正默认工作区设置；
   * 允许删除最后一个工作区，此时会话保持未绑定状态。磁盘目录不删除。
   */
  const deleteWorkspace = async (id: string): Promise<void> => {
    const state = appState.snapshot()
    if (!state.workspaces.some(workspace => workspace.id === id)) throw new RuntimeError('NOT_FOUND', '工作区不存在')
    assertNoAutomationReferences(state.automations, id)
    await appState.update(async current => {
      if (!current.workspaces.some(workspace => workspace.id === id)) throw new RuntimeError('NOT_FOUND', '工作区不存在')
      assertNoAutomationReferences(current.automations, id)
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

  /** 全工作区内容搜索。 */
  const searchWorkspace = (id: string, query: string) => workspaceFiles.list(id, '', query)
  /** 读取工作区内的文本文件。 */
  const workspaceFile = (id: string, path: string, line?: number) => workspaceFiles.read(id, path, line)
  /** 读取工作区内的二进制资源。 */
  const workspaceAsset = (id: string, path: string) => workspaceFiles.asset(id, path)

  /** 分支快照：当前分支、本地/远程分支列表。 */
  const gitBranchSnapshot = (id: string): Promise<GitBranchSnapshot> => gitBranches.snapshot(id)
  /** 切换分支。 */
  const switchGitBranch = (id: string, input: SwitchGitBranchInput): Promise<GitBranchMutation> => gitBranches.switch(id, input)
  /** 新建分支。 */
  const createGitBranch = (id: string, input: CreateGitBranchInput): Promise<GitBranchMutation> => gitBranches.create(id, input)
  /** 变基状态：改动文件清单与暂存状态。 */
  const gitWorktreeStatus = (id: string): Promise<GitWorktreeStatus> => gitWorktree.status(id)
  /** 单文件差异，可指定对比来源（HEAD/暂存区等）。 */
  const gitWorktreeDiff = (id: string, path: string, sourceId?: GitChangeSourceId): Promise<GitWorktreeDiff> => gitWorktree.diff(id, path, sourceId)
  /** 按暂存内容提交。 */
  const gitCommit = (id: string, input: GitCommitInput): Promise<GitCommitResult> => gitWorktree.commit(id, input)
  /** 推送当前分支。 */
  const gitPush = (id: string): Promise<GitPushResult> => gitWorktree.push(id)
  /**
   * 功能：用模型生成一条提交信息建议。
   * @param id 工作区 ID
   * @param input 是否包含未暂存改动、可选的会话 ID
   * @returns 提交信息文本与实际使用的模型路由
   * 内部逻辑：先取提交上下文并校验（在仓库内、有可提交/已暂存改动），路由优先取
   * 会话绑定模型否则用默认模型，随后以 512 token、30s 上限的旁路调用生成，仅接受
   * 干净 stop 且归一化非空的结果，否则报 PROVIDER_ERROR。
   */
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
    const commitInput = {
      systemPrompt: commitMessageSystemPrompt(locale),
      messages: [{ role: 'user' as const, content: frameCommitContext({ branchName: status.branchName, files: status.files, diff, locale }), timestamp: Date.now() }],
    }
    const result = await captureSideCall(
      { conversationId: input.conversationId, purpose: 'commit-message' },
      route,
      commitInput,
      () => modelRuntime.models.completeSimple(model, commitInput, { maxTokens: 512, timeoutMs: 30_000, sessionId: `git-commit-${randomUUID()}` }),
    )
    if (result.stopReason !== 'stop') throw new RuntimeError('PROVIDER_ERROR', '模型没有返回提交信息')
    const message = normalizeCommitMessage(result.content.flatMap(part => part.type === 'text' ? [part.text] : []).join('\n'))
    if (message === '') throw new RuntimeError('PROVIDER_ERROR', '模型没有返回提交信息')
    return { message, provider: route.provider, model: route.modelId }
  }


  return {
    list: workspaces,
    add: addWorkspace,
    createNamed: createNamedWorkspace,
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
