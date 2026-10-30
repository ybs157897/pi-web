/**
 * The conversation engine: creation, configuration, submission, queue-adjacent controls,
 * goals, plans, forks and the live transcription subscription.
 *
 * Everything that only *reads* app state or projects a conversation lives in the
 * composition root (`index.ts`); this module is the state-changing surface.
 */
import { randomUUID } from 'node:crypto'
import type { Draft } from '@earendil-works/chord'
import type { UserMessage } from '@earendil-works/pi-ai'
import type {
  AgentChange, Conversation, ConversationId, ConversationRecord, ConversationView, Cursor, Harness, Submission, TaskId,
} from '@earendil-works/pi-durable'
import type {
  AccessMode, AgentPreset, AskUserQuestionAnswerItem, ConversationDetail, ConversationSummary,
  CreateConversationInput, GoalUpdateRequest, ModelRef as UiModelRef, SubmitInput, ThinkingLevel,
  UpdateConversationInput, WorkspaceSummary,
} from '../../shared/types.ts'
import type { AppStateStore } from '../state/app-state.ts'
import type { RuntimeModels } from '../model/catalog.ts'
import type { AttachmentReference, WorkspaceFiles } from '../workspace/files.ts'
import { workspaceWriteSupported } from '../conversation/execution-env.ts'
import { fallbackSessionTitle, frameTitleMessages, normalizeSessionTitle, titleSystemPrompt, TITLE_POLICY } from '../conversation/session-title.ts'
import { Goals, applyGoalCreate, applyGoalUpdate } from '../tools/goal.ts'
import { Plans } from '../tools/plan.ts'
import { Todos } from '../tools/todo.ts'
import { Interactions } from '../tools/interaction.ts'
import { RuntimeError } from '../runtime-errors.ts'
import {
  CTX, DEFAULT_TITLE, META, SUPPORTED_THINKING, assertSubmit, attachmentReferences, fingerprintSubmit,
  liveRunTaskId, objectValue, parseConversationId, parseEntryId, safeTitle, submissionContent,
  type ConversationMetadata,
} from './helpers.ts'

export interface ConversationsDeps {
  appState: AppStateStore
  harness: () => Harness
  modelRuntime: RuntimeModels
  workspaceFiles: WorkspaceFiles
  memoryExtraction: { scheduleAfterSubmission(conversation: Conversation, request: Submission): void }
  assertOpen(): void
  requireConversation(value: string): Promise<Conversation>
  ensureMetadata(id: ConversationId): Promise<Readonly<ConversationMetadata>>
  withMetadata(id: ConversationId, update: (metadata: Draft<ConversationMetadata>) => void): Promise<void>
  markConversationSeen(id: ConversationId, seenAt: number): Promise<void>
  detailFromView(
    id: ConversationId,
    view: ConversationView,
    metadata?: Readonly<ConversationMetadata>,
    options?: { subagents?: boolean; team?: boolean },
  ): Promise<ConversationDetail>
  currentDetail(id: ConversationId): Promise<ConversationDetail>
  selectedWorkspace(id: string | undefined): WorkspaceSummary
  defaultWorkspace(): WorkspaceSummary | undefined
  selectedPreset(id: string | null | undefined): AgentPreset | undefined
  assertModelAllowed(model: UiModelRef | undefined, label: string): void
  assertConversationModelAllowed(conversation: Conversation): Promise<void>
  buildAgentChange(
    workspaceId: string,
    accessMode: AccessMode,
    preset?: AgentPreset,
    overrides?: { model?: UiModelRef; thinkingLevel?: ThinkingLevel },
  ): Promise<AgentChange>
}

export function createConversations(deps: ConversationsDeps) {
  const {
    appState, modelRuntime, workspaceFiles, memoryExtraction, assertOpen, requireConversation,
    ensureMetadata, withMetadata, markConversationSeen, detailFromView, currentDetail,
    selectedWorkspace, selectedPreset, assertModelAllowed, assertConversationModelAllowed, buildAgentChange,
    defaultWorkspace,
  } = deps
  const harness = (): Harness => deps.harness()
  const activeWatchStops = new Set<() => Promise<void>>()

  const list = async (): Promise<ConversationSummary[]> => {
    assertOpen()
    const records: ConversationRecord[] = []
    let cursor: Cursor | undefined
    do {
      const page = await harness().commit((tx) => tx.scanConversations({ order: 'descending' }, 250, cursor), CTX)
      records.push(...page.items.filter((record) => record.owner === undefined))
      cursor = page.next
    } while (cursor)
    const summaries = await Promise.all(records.map(async (record) => {
      const conversation = await harness().conversation(record.id, CTX)
      if (!conversation) return undefined
      const metadata = await ensureMetadata(record.id)
      const view = await conversation.watch(CTX)
      try {
        return (await detailFromView(record.id, view.value, metadata)).conversation
      } finally {
        await view.stop()
      }
    }))
    return summaries.filter((item): item is ConversationSummary => item !== undefined)
      .sort((a, b) => b.updatedAt - a.updatedAt || b.createdAt - a.createdAt)
  }

  const create = async (input: CreateConversationInput): Promise<ConversationDetail> => {
    assertOpen()
    const title = safeTitle(input.title)
    const settings = appState.snapshot().settings
    if (input.workspaceId === undefined && settings.defaultWorkspaceId === undefined && appState.snapshot().workspaces.length === 0) {
      throw new RuntimeError('INVALID_INPUT', '还没有工作区，请先添加一个工作区再创建会话')
    }
    const workspace = selectedWorkspace(input.workspaceId ?? settings.defaultWorkspaceId)
    const presetId = input.presetId ?? settings.defaultPresetId ?? null
    const preset = selectedPreset(presetId)
    const accessMode = input.accessMode ?? preset?.accessMode ?? settings.defaultAccessMode
    if (accessMode === 'workspaceWrite' && !await workspaceWriteSupported(workspace.path)) {
      throw new RuntimeError('UNSUPPORTED', '当前系统无法启用工作区写入沙盒')
    }
    const agent = await buildAgentChange(workspace.id, accessMode, preset, {
      ...(input.model ? { model: input.model } : {}),
      ...(input.thinkingLevel ? { thinkingLevel: input.thinkingLevel } : {}),
    })
    const conversation = await harness().createConversation({ ownership: { kind: 'ownerless' }, agent }, CTX)
    await withMetadata(conversation.id, (metadata) => {
      metadata.workspaceId = workspace.id
      metadata.presetId = presetId
      metadata.accessMode = accessMode
      if (title) {
        metadata.title = title
        metadata.titleSource = 'user'
      }
    })
    return currentDetail(conversation.id)
  }

  const update = async (value: string, input: UpdateConversationInput): Promise<ConversationDetail> => {
    const conversation = await requireConversation(value)
    const id = conversation.id
    const title = safeTitle(input.title)
    const currentMetadata = await ensureMetadata(id)
    const settings = appState.snapshot().settings
    const workspace = selectedWorkspace(input.workspaceId ?? currentMetadata.workspaceId ?? undefined)
    const presetId = input.presetId === undefined ? currentMetadata.presetId : input.presetId
    const preset = selectedPreset(presetId ?? settings.defaultPresetId)
    const presetChanged = input.presetId !== undefined
    const accessMode = input.accessMode ?? (presetChanged ? preset?.accessMode ?? currentMetadata.accessMode : currentMetadata.accessMode)
    const configurationChanged = input.workspaceId !== undefined || input.presetId !== undefined || input.accessMode !== undefined || input.model !== undefined || input.thinkingLevel !== undefined
    if (accessMode === 'workspaceWrite' && !await workspaceWriteSupported(workspace.path)) {
      throw new RuntimeError('UNSUPPORTED', '当前系统无法启用工作区写入沙盒')
    }
    if (configurationChanged) {
      const currentAgent = await conversation.agent(CTX)
      // Only an explicitly picked model is passed on; a preset without its own
      // model and the inherited model keep today's resolution through the
      // default chain, where a stale default falls back inside the allowlist.
      const explicitModel = input.model ?? (presetChanged ? preset?.model : currentAgent.model)
      const thinkingLevel = input.thinkingLevel ?? (presetChanged ? preset?.thinkingLevel ?? settings.defaultThinkingLevel : currentAgent.thinkingLevel)
      if (input.model && !modelRuntime.models.getModel(input.model.provider, input.model.modelId)) throw new RuntimeError('MODEL_UNAVAILABLE', '所选模型不在 Pi 模型目录中')
      assertModelAllowed(input.model, '所选模型')
      if (presetChanged) assertModelAllowed(preset?.model, 'Preset 模型')
      if (!presetChanged && !input.model) assertModelAllowed(currentAgent.model, '会话模型')
      if (thinkingLevel && !SUPPORTED_THINKING.has(thinkingLevel)) throw new RuntimeError('INVALID_INPUT', '思考等级无效')
      const change = await buildAgentChange(workspace.id, accessMode, preset, {
        ...(explicitModel ? { model: explicitModel } : {}),
        ...(thinkingLevel ? { thinkingLevel } : {}),
      })
      await conversation.configure(change, CTX)
    }
    if (title !== undefined || input.archived !== undefined || input.pinned !== undefined || configurationChanged) {
      await withMetadata(id, (metadata) => {
        if (configurationChanged) {
          metadata.workspaceId = workspace.id
          metadata.presetId = presetId
          metadata.accessMode = accessMode
        }
        if (title !== undefined) {
          metadata.title = title
          metadata.titleSource = 'user'
        }
        if (input.archived !== undefined) metadata.archived = input.archived
        if (input.pinned !== undefined) metadata.pinned = input.pinned
      })
    }
    return currentDetail(id)
  }

  const submitWithReferences = async (
    conversation: Awaited<ReturnType<typeof requireConversation>>,
    input: SubmitInput,
    files: readonly AttachmentReference[],
    actualRequestId = input.requestId,
    fingerprint = fingerprintSubmit(input),
  ): Promise<{ submissionId: string }> => {
    await assertConversationModelAllowed(conversation)
    const existing = await harness().commit(async (tx) => {
      const metadata = await tx.doc(META, conversation.id)
      const receipt = metadata.requestReceipts[actualRequestId]
      if (receipt && receipt.fingerprint !== fingerprint) {
        throw new RuntimeError('CONFLICT', '同一个 requestId 不能用于不同内容')
      }
      if (receipt?.submissionId !== null && receipt?.submissionId !== undefined) return String(receipt.submissionId)
      metadata.requestReceipts[actualRequestId] = { fingerprint, status: 'pending', submissionId: null }
      return undefined
    }, CTX)
    if (existing) return { submissionId: existing }

    const request = await conversation.submit({
      type: 'input',
      content: submissionContent(input, files),
      requestId: actualRequestId,
      entry: { kind: 'pi-web.user', data: { requestId: input.requestId, ...(files.length ? { files: files.map(file => ({ ...file })) } : {}) } },
      whenBusy: input.whenBusy ?? 'followUp',
    }, CTX)
    const status = await request.status(CTX)
    await harness().commit(async (tx) => {
      const metadata = await tx.doc(META, conversation.id)
      metadata.requestReceipts[actualRequestId] = { fingerprint, status: 'accepted', submissionId: Number(request.id) }
      if (status.status === 'queued') metadata.queueCreatedAt[String(request.id)] = Date.now()
      if (metadata.titleSource === 'auto' && metadata.title === DEFAULT_TITLE && input.text.trim()) {
        metadata.title = fallbackSessionTitle(input.text) || DEFAULT_TITLE
      }
      metadata.updatedAt = Date.now()
      // A placed input starts a new turn, and DSH starts a turn without a task list. Queued inputs
      // are placed later, so their turn keeps the list this commit leaves behind.
      if (status.status !== 'queued') {
        const todos = await tx.doc(Todos, conversation.id)
        todos.items = null
        todos.updatedAt = Date.now()
      }
    }, CTX)
    if (input.text.trim()) scheduleTitleRevision(conversation.id, input.text)
    memoryExtraction.scheduleAfterSubmission(conversation, request)
    return { submissionId: String(request.id) }
  }

  /**
   * DSH's title provider cadence over pi-web's own run loop: one revision per
   * submitted prompt, generated off the session's own route so titles cost the
   * same account, never delaying the response, and a newer revision supersedes
   * the older one. A user rename flips the source to `user` and pins the title,
   * so this writes only while the title is still auto.
   *
   * DSH hands its title call a `session-title` purpose that its adapter maps to
   * thinking-disabled. pi-ai has no such marker, and models declaring
   * `thinkingLevelMap.off === null` (deepseek) cannot disable thinking, so this
   * budgets past the reasoning preamble and still accepts only a clean stop with
   * visible text; anything else keeps the deterministic fallback title.
   */
  const titleRevisions = new Map<string, AbortController>()
  const scheduleTitleRevision = (id: ConversationId, text: string): void => {
    const key = String(id)
    titleRevisions.get(key)?.abort()
    const controller = new AbortController()
    titleRevisions.set(key, controller)
    void (async () => {
      try {
        const conversation = await harness().conversation(id, CTX)
        if (conversation === undefined) return
        const agent = await conversation.agent(CTX)
        const route = agent.model ?? modelRuntime.defaultModel
        if (route === undefined) return
        const model = modelRuntime.models.getModel(route.provider, route.modelId)
        if (model === undefined) return
        const framed = frameTitleMessages([{ seq: 0, text }])
        if (Buffer.byteLength(framed, 'utf8') > TITLE_POLICY.maxInputBytes) return
        const result = await modelRuntime.models.completeSimple(model, {
          systemPrompt: titleSystemPrompt(),
          messages: [{ role: 'user', content: framed, timestamp: Date.now() }],
        }, {
          maxTokens: TITLE_POLICY.titleMaxOutputTokens,
          timeoutMs: TITLE_POLICY.timeoutMs,
          sessionId: `title-${randomUUID()}`,
          signal: controller.signal,
        })
        if (controller.signal.aborted || result.stopReason !== 'stop') return
        const title = normalizeSessionTitle(result.content.flatMap(part => part.type === 'text' ? [part.text] : []).join('\n'))
        if (title === '') return
        await withMetadata(id, draft => {
          if (draft.titleSource === 'auto') draft.title = title
        })
      } catch {
        // An automatic title failure is a warning: the fallback title stays.
      } finally {
        if (titleRevisions.get(key) === controller) titleRevisions.delete(key)
      }
    })()
  }

  const submit = async (value: string, input: SubmitInput): Promise<{ submissionId: string }> => {
    assertSubmit(input)
    const conversation = await requireConversation(value)
    const metadata = await ensureMetadata(conversation.id)
    const files: AttachmentReference[] = []
    if (input.files?.length) {
      const attachmentWorkspaceId = metadata.workspaceId ?? defaultWorkspace()?.id
      if (attachmentWorkspaceId === undefined) throw new RuntimeError('INVALID_INPUT', '此会话没有可用的工作区，无法保存附件')
      files.push(...await workspaceFiles.saveAttachments(attachmentWorkspaceId, String(conversation.id), input.requestId, input.files))
    }
    return submitWithReferences(conversation, input, files)
  }

  const stop = async (value: string): Promise<void> => {
    const conversation = await requireConversation(value)
    const view = await conversation.watch(CTX)
    let taskId: TaskId | undefined
    try { taskId = liveRunTaskId(view.value) } finally { await view.stop() }
    if (taskId !== undefined) await harness().abortTask(taskId, CTX)
  }

  const goal = async (value: string, input: GoalUpdateRequest): Promise<ConversationDetail> => {
    const conversation = await requireConversation(value)
    const id = conversation.id
    await harness().commit(async (tx) => {
      const doc = await tx.doc(Goals, id)
      if (input.action === 'create') {
        const outcome = applyGoalCreate(doc.goal, {
          id: randomUUID(),
          objective: input.objective ?? '',
          ...(input.maxGoalRounds === undefined ? {} : { maxGoalRounds: input.maxGoalRounds }),
        }, Date.now())
        if (!outcome.ok) throw new RuntimeError('CONFLICT', outcome.error)
        doc.goal = outcome.goal
        return
      }
      const current = doc.goal
      if (current === null) throw new RuntimeError('NOT_FOUND', '当前会话没有目标')
      const outcome = applyGoalUpdate(current, {
        goalId: current.id,
        revision: current.revision,
        action: input.action,
        ...(input.objective === undefined ? {} : { objective: input.objective }),
        ...(input.blockedReason === undefined ? {} : { blockedReason: input.blockedReason }),
        ...(input.maxGoalRounds === undefined ? {} : { maxGoalRounds: input.maxGoalRounds }),
      }, { actor: 'human', now: Date.now() })
      if (!outcome.ok) throw new RuntimeError('CONFLICT', outcome.error)
      doc.goal = outcome.goal
    }, CTX)
    return currentDetail(id)
  }

  /**
   * Turn plan mode on or off. The document write is what the `plan-policy` section reads before every
   * request, so a switch made while a run is going takes effect on the next request (DSH's pending
   * semantics); an idempotent request only refreshes `updatedAt`.
   */
  const setPlan = async (value: string, active: boolean): Promise<ConversationDetail> => {
    if (typeof active !== 'boolean') throw new RuntimeError('INVALID_INPUT', '计划模式开关无效')
    const conversation = await requireConversation(value)
    const id = conversation.id
    await harness().commit(async (tx) => {
      // Read the ownership tree before document writes; entering Plan must also constrain
      // already-created workers that can keep running or be resumed after a crash.
      const constrained = [id]
      if (active) {
        for (let index = 0; index < constrained.length; index += 1) {
          let cursor: Cursor | undefined
          do {
            const page = await tx.scanConversations({ ownerConversationId: constrained[index] }, 250, cursor)
            constrained.push(...page.items.map(record => record.id))
            cursor = page.next
          } while (cursor)
        }
      }
      const doc = await tx.doc(Plans, id)
      doc.active = active
      doc.updatedAt = Date.now()
      for (const childId of constrained.slice(1)) {
        const child = await tx.doc(Plans, childId)
        child.active = true
        child.updatedAt = doc.updatedAt
      }
    }, CTX)
    return currentDetail(id)
  }

  const compact = async (value: string): Promise<void> => {
    const conversation = await requireConversation(value)
    await assertConversationModelAllowed(conversation)
    await conversation.compact(undefined, CTX)
  }

  const fork = async (value: string, entryValue: string): Promise<ConversationDetail> => {
    const conversation = await requireConversation(value)
    const entryId = parseEntryId(entryValue)
    const cutoff = await conversation.entries({ order: 'descending', maxEntryId: entryId }, 1, undefined, CTX)
    if (cutoff.items[0]?.id !== entryId) throw new RuntimeError('NOT_FOUND', '分叉位置不属于该会话')
    const child = await conversation.fork(entryId, { ownership: { kind: 'ownerless' } }, CTX)
    return currentDetail(child.id)
  }

  const watch = async (value: string, listener: (value: ConversationDetail) => void): Promise<() => Promise<void>> => {
    const conversation = await requireConversation(value)
    const id = conversation.id
    await ensureMetadata(id)
    const viewWatch = await conversation.watch(CTX)
    const metadataWatch = await harness().watchDoc(META, id, CTX)
    if (!metadataWatch) {
      await viewWatch.stop()
      throw new RuntimeError('CONFLICT', '无法订阅会话元数据')
    }
    // Custom documents are not part of the conversation view, so a human action that writes only a
    // document (pause a goal, clear a list) would otherwise stay invisible until the next entry.
    const docWatches = [
      await harness().watchDoc(Todos, id, CTX),
      await harness().watchDoc(Goals, id, CTX),
      await harness().watchDoc(Interactions, id, CTX),
      await harness().watchDoc(Plans, id, CTX),
    ]
    let latestView = viewWatch.value
    let latestMetadata = metadataWatch.value ?? await ensureMetadata(id)
    let stopped = false
    let delivery = Promise.resolve()
    const refresh = () => {
      delivery = delivery.then(async () => {
        if (!stopped) listener(await detailFromView(id, latestView, latestMetadata, { subagents: true, team: true }))
      })
      return delivery
    }
    listener(await detailFromView(id, latestView, latestMetadata, { subagents: true, team: true }))
    viewWatch.start(async (view) => {
      latestView = view
      await refresh()
    })
    metadataWatch.start(async (metadata) => {
      if (metadata) latestMetadata = metadata
      await refresh()
    })
    for (const docWatch of docWatches) {
      docWatch?.start(async () => { await refresh() })
    }
    const unsubscribe = async () => {
      if (stopped) return
      stopped = true
      activeWatchStops.delete(unsubscribe)
      await Promise.all([viewWatch.stop(), metadataWatch.stop(), ...docWatches.map(docWatch => docWatch?.stop())])
      await delivery
    }
    activeWatchStops.add(unsubscribe)
    return unsubscribe
  }

  const feedback = async (value: string, entryValue: string, rating: 'up' | 'down' | null): Promise<void> => {
    const conversation = await requireConversation(value)
    const entryId = parseEntryId(entryValue)
    const page = await conversation.entries({ order: 'descending', maxEntryId: entryId }, 1, undefined, CTX)
    if (page.items[0]?.id !== entryId) throw new RuntimeError('NOT_FOUND', '反馈消息不属于该会话')
    await withMetadata(conversation.id, metadata => {
      if (rating === null) delete metadata.feedback[String(entryId)]
      else metadata.feedback[String(entryId)] = rating
    })
  }

  /** Append one operator feedback entry, capturing the client's user agent when present. */
  const retry = async (value: string, entryValue: string, requestId: string): Promise<{ conversationId: string; submissionId: string }> => {
    if (!requestId.trim() || requestId.length > 256) throw new RuntimeError('INVALID_INPUT', 'requestId 无效')
    const source = await requireConversation(value)
    const targetId = parseEntryId(entryValue)
    const history = await source.entries({ order: 'descending', maxEntryId: targetId }, 5_000, undefined, CTX)
    const targetIndex = history.items.findIndex(entry => entry.id === targetId)
    if (targetIndex < 0) throw new RuntimeError('NOT_FOUND', '重试位置不属于该会话')
    let userIndex = -1
    let userMessage: UserMessage | undefined
    for (let index = targetIndex; index < history.items.length; index += 1) {
      const messages = history.items[index]?.model ?? []
      const candidate = [...messages].reverse().find(message => message.role === 'user')
      if (candidate?.role === 'user') {
        userIndex = index
        userMessage = candidate
        break
      }
    }
    if (userIndex < 0 || userMessage?.role !== 'user') throw new RuntimeError('NOT_FOUND', '找不到可重试的用户输入')
    const userEntry = history.items[userIndex]
    if (!userEntry) throw new RuntimeError('NOT_FOUND', '用户输入已不在会话历史中')
    const content = userMessage.content
    const text = typeof content === 'string' ? content : content.flatMap(part => part.type === 'text' ? [part.text] : []).join('\n')
    const images = typeof content === 'string' ? [] : content.flatMap(part => part.type === 'image' ? [{ data: part.data, mimeType: part.mimeType }] : [])
    const data = objectValue(userEntry.data)
    const files = attachmentReferences(data?.files)
    const metadata = await ensureMetadata(source.id)
    const workspace = selectedWorkspace(metadata.workspaceId ?? undefined)
    let child: Awaited<ReturnType<typeof source.fork>>
    const previousEntry = history.items[userIndex + 1]
    if (previousEntry) {
      child = await source.fork(previousEntry.id, { ownership: { kind: 'ownerless' } }, CTX)
    } else {
      const agent = await source.agent(CTX)
      const change: AgentChange = {
        cwd: workspace.path,
        extensions: agent.extensions,
        tools: agent.tools,
        thinkingLevel: agent.thinkingLevel,
        ...(agent.model ? { model: agent.model } : {}),
        ...(agent.instructions ? { instructions: agent.instructions } : {}),
      }
      child = await harness().createConversation({ ownership: { kind: 'ownerless' }, agent: change }, CTX)
    }
    await withMetadata(child.id, draft => {
      draft.workspaceId = metadata.workspaceId ?? defaultWorkspace()?.id ?? null
      draft.presetId = metadata.presetId
      draft.accessMode = metadata.accessMode
      draft.title = metadata.title
      draft.titleSource = metadata.titleSource
    })
    if ((await harness().snapshot(Plans, source.id, CTX))?.active === true) {
      await harness().commit(async tx => {
        const plan = await tx.doc(Plans, child.id)
        plan.active = true
        plan.updatedAt = Date.now()
      }, CTX)
    }
    const submitInput: SubmitInput = { text, requestId, whenBusy: 'reject', ...(images.length ? { images } : {}) }
    const submitted = await submitWithReferences(child, submitInput, files)
    return { conversationId: String(child.id), submissionId: submitted.submissionId }
  }

  /**
   * The catalog every model surface reads: filtered to the allowlist, with a
   * default that fell outside it replaced by the first available allowed model
   * and written back, so a later start reads the same correction.
   */

  const detail = async (value: string): Promise<ConversationDetail> => {
    const id = parseConversationId(value)
    const current = await currentDetail(id)
    if (current.conversation.busy) return current
    await markConversationSeen(id, current.conversation.updatedAt)
    if (current.conversation.unread !== true) return current
    // The reader is looking at it right now, so the response itself is already read.
    const conversation = { ...current.conversation }
    delete conversation.unread
    return { ...current, conversation }
  }

  return {
    list,
    create,
    update,
    detail,
    submit,
    stop,
    compact,
    goal,
    setPlan,
    fork,
    retry,
    watch,
    feedback,
    submitWithReferences,
    closeWatches: async () => { await Promise.all([...activeWatchStops].map(stop => stop())) },
    revisionCount: () => titleRevisions.size,
  }
}
