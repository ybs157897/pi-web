/**
 * doc-keeper service: runs one knowledge-document maintenance task as a dedicated agent
 * conversation. The bot roster is not involved — this is the standalone capability the A2A
 * server (and, later, the bot watchdog) consumes. check mode is model-free; refresh mode drives
 * a doc-keeper conversation that uses the five knowledge tools to incrementally rewrite the doc.
 */
import { randomUUID } from 'node:crypto'
import type { AgentChange, Harness } from '@earendil-works/pi-durable'
import type { AccessMode } from '../../shared/types.ts'
import { workspaceWriteSupported } from '../conversation/execution-env.ts'
import { RuntimeError } from '../runtime-errors.ts'
import { CONVERSATION_KIND, CTX, META, parseConversationId } from '../runtime/helpers.ts'
import { parseFrontmatter } from '../bots/docs.ts'
import { detectChanges, inspectDoc, knowledgeAbsolutePath, knowledgeHash, readKnowledgeFile } from './core.ts'
import { createDocKeeperExtension, DocKeeperTask } from './extension.ts'
import { docKeeperSubmission, docKeeperSystemPrompt, type DocKeeperMode } from './prompt.ts'

export interface DocKeeperServiceDeps {
  harness: () => Harness
  assertOpen(): void
  buildAgentChange(workspaceId: string, accessMode: AccessMode, overrides?: {
    model?: { provider: string; modelId: string }
    thinkingLevel?: string
  }): Promise<AgentChange>
  selectedWorkspace(id: string | undefined): { id: string; name: string; path: string }
  /** Late-bound: the conversation's error, if any (conversations service assembles later). */
  conversationError(conversationId: string): Promise<string | undefined>
}

export interface DocKeeperRunInput {
  /** Repo absolute path; defaults to the selected workspace. */
  repo?: string
  globs: readonly string[]
  knowledgePath: string
  mode: DocKeeperMode
  model?: { provider: string; modelId: string }
}

export type DocKeeperRunResult = {
  mode: DocKeeperMode
  health: string
  detail: string
  changedFiles: string[]
  commitCount: number
  updated: boolean
  knowledgePath: string
  hash?: string
  report?: string
  error?: string
}

function normalizeGlob(value: string): string {
  const normalized = value.trim().replaceAll('\\', '/')
  if (normalized === '' || normalized.length > 200 || normalized.startsWith('/') || /^[a-z]:/iu.test(normalized)
    || normalized.split('/').some(segment => segment === '..')) {
    throw new RuntimeError('INVALID_INPUT', `glob 无效：${JSON.stringify(value)}`)
  }
  return normalized
}

/** The last assistant text from a descending entry page, for the maintenance report. */
function lastAssistantText(items: ReadonlyArray<{ model?: ReadonlyArray<{ role: string; content: unknown }> }>): string | undefined {
  for (const entry of items) {
    const messages = entry.model ?? []
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index]
      if (message?.role !== 'assistant') continue
      const content = message.content
      const text = typeof content === 'string'
        ? content
        : Array.isArray(content)
          ? content.flatMap(part => (part as { type?: string; text?: string }).type === 'text' ? [(part as { text?: string }).text ?? ''] : []).join('\n')
          : ''
      if (text.trim() !== '') return text
    }
  }
  return undefined
}

export function createDocKeeperService(deps: DocKeeperServiceDeps) {
  const extension = createDocKeeperExtension()

  const runMaintenance = async (input: DocKeeperRunInput): Promise<DocKeeperRunResult> => {
    deps.assertOpen()
    const globs = [...new Set((input.globs ?? []).map(normalizeGlob))]
    if (globs.length === 0) throw new RuntimeError('INVALID_INPUT', 'globs 不能为空')
    const knowledgePath = input.knowledgePath.trim()
    if (knowledgePath === '' || knowledgePath.startsWith('/') || knowledgePath.split('/').some(segment => segment === '..')) {
      throw new RuntimeError('INVALID_INPUT', `knowledgePath 无效：${JSON.stringify(input.knowledgePath)}`)
    }
    const workspace = deps.selectedWorkspace(undefined)
    const repo = input.repo ?? workspace.path
    const target = { knowledgePath, globs }

    // check mode is model-free: inspect + detect, never rewrite.
    if (input.mode === 'check') {
      const inspection = await inspectDoc(repo, target)
      const changes = await detectChanges(repo, globs, inspection.frontmatter?.updatedStamp)
      return {
        mode: 'check', health: inspection.health, detail: inspection.detail,
        changedFiles: changes.changedFiles, commitCount: changes.count, updated: false, knowledgePath,
      }
    }

    const absolute = knowledgeAbsolutePath(repo, target)
    const before = await readKnowledgeFile(absolute)
    const hashBefore = before === undefined ? undefined : knowledgeHash(before)
    const frontmatter = before === undefined ? undefined : parseFrontmatter(before)
    const botId = frontmatter?.botId ?? knowledgePath.replace(/\.md$/u, '').split('/').pop() ?? 'module'
    const module = frontmatter?.module ?? botId

    const accessMode: AccessMode = await workspaceWriteSupported(repo) ? 'workspaceWrite' : 'fullAccess'
    const base = await deps.buildAgentChange(workspace.id, accessMode, input.model ? { model: input.model } : {})
    const baseExtensions = Array.isArray(base.extensions) ? [...base.extensions] : []
    const baseTools = Array.isArray(base.tools) ? [...base.tools] : []
    const agent: AgentChange = {
      ...base,
      extensions: [...baseExtensions, extension],
      tools: [...baseTools, ...(extension.tools ?? [])],
      instructions: docKeeperSystemPrompt(),
    }
    const conversation = await deps.harness().createConversation({ ownership: { kind: 'ownerless' }, agent }, CTX)
    const conversationId = String(conversation.id)
    await deps.harness().commit(async tx => {
      const metadata = await tx.doc(META, conversation.id)
      metadata.title = `doc-keeper:${knowledgePath}`
      metadata.titleSource = 'user'
      metadata.workspaceId = workspace.id
      metadata.accessMode = accessMode
      const kind = await tx.doc(CONVERSATION_KIND, conversation.id)
      kind.kind = 'docKeeper'
      const task = await tx.doc(DocKeeperTask, conversation.id)
      task.repo = repo
      task.knowledgePath = knowledgePath
      task.globs = globs
      task.mode = input.mode
      task.botId = botId
      task.module = module
    }, CTX)

    const startedAt = Date.now()
    await conversation.submit({
      type: 'input',
      content: docKeeperSubmission({ repo, globs, knowledgePath, mode: input.mode }),
      requestId: `doc-keeper:${startedAt}:${randomUUID()}`,
      whenBusy: 'followUp',
    }, CTX)
    await conversation.waitForIdle(CTX)

    const error = await deps.conversationError(conversationId)
    const after = await readKnowledgeFile(absolute)
    const hashAfter = after === undefined ? undefined : knowledgeHash(after)
    const inspection = await inspectDoc(repo, target)
    const changes = await detectChanges(repo, globs, inspection.frontmatter?.updatedStamp)
    const reportPage = await conversation.entries({ order: 'descending' }, 40, undefined, CTX)
    const report = lastAssistantText(reportPage.items)
    return {
      mode: input.mode, health: inspection.health, detail: inspection.detail,
      changedFiles: changes.changedFiles, commitCount: changes.count,
      updated: hashBefore !== hashAfter, knowledgePath,
      ...(hashAfter === undefined ? {} : { hash: hashAfter }),
      ...(report === undefined ? {} : { report }),
      ...(error === undefined || error === '' ? {} : { error }),
    }
  }

  return { runMaintenance, extension }
}