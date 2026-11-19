import { ToolTask, defineDoc, hook, type ConversationId, type Harness } from '@earendil-works/pi-durable'
import type { Context } from '@earendil-works/chord/context'
import type { ConversationDetail } from '../../shared/types.ts'
import type { WorkItemEvidence } from '../../shared/workbench.ts'
import { CTX, objectValue } from './helpers.ts'

type FileTarget = { kind: 'read' | 'write' | 'edit'; path: string; callId?: string }

// Pi's Code mode summary retains call arguments, but omits nested tool result details.
// Keep only successful file targets on the owning tool task until its transcript entry is written.
const NestedFiles = defineDoc<{ files: FileTarget[] }>({
  kind: 'pi-web.workbench-file-targets', version: 1, scope: 'task',
  initial: () => ({ files: [] }), checkpointWhen: (_value, _ops, info) => info.deltasSinceBase >= 100,
})

const Checks = defineDoc<{ items: Array<{
  callId: string; attempt: number; command: string; status: 'passed' | 'failed' | 'insufficient'; sessionId?: string;
}> }>({
  kind: 'pi-web.workbench-checks', version: 1, scope: 'conversation', history: 'latest', fork: 'initial',
  initial: () => ({ items: [] }), checkpointWhen: (_value, _ops, info) => info.deltasSinceBase >= 100,
})

const NPM_VALIDATION = /^(?:npm|pnpm|yarn|bun)(?:\.cmd)?\s+(?:test|(?:run\s+)?(?:test(?::[\w-]+)?|build|check|typecheck|lint|verify(?::[\w-]+)?))(?:\s|$)/iu
const TOOL_VALIDATION = /^(?:(?:npx|pnpm exec|bunx)\s+)?(?:vitest\s+run|jest|pytest|tsc\s+--noEmit|ruff\s+check)(?:\s|$)/iu
const LANGUAGE_VALIDATION = /^(?:node\s+--test|python(?:3)?\s+-m\s+pytest|go\s+test|cargo\s+(?:test|check|build)|dotnet\s+(?:test|build))(?:\s|$)/iu

function validationCommand(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const command = value.trim()
  // Recognize one actual validation invocation. Compound expressions can hide its exit code.
  if (/[;&|<>$`\r\n]/u.test(command)) return undefined
  return [NPM_VALIDATION, TOOL_VALIDATION, LANGUAGE_VALIDATION].some(pattern => pattern.test(command))
    ? command.slice(0, 240)
    : undefined
}

/** Capture shell structured results while the engine still has them. This hook also runs on nested codemode tools. */
export function workbenchEvidenceHook(
  getHarness: () => Harness,
  resolveAttempt: (id: ConversationId, context: Context) => Promise<number | undefined>,
) {
  return hook(ToolTask, {
    afterTool: async (call, result, api, context) => {
      const { name, parent } = call
      const resolvedPath = objectValue(result.details)?.resolvedPath
      if (parent && (name === 'read' || name === 'write' || name === 'edit') && typeof resolvedPath === 'string' && !result.isError) {
        await getHarness().commit(async tx => {
          const record = await tx.doc(NestedFiles, parent.taskId)
          if (!record.files.some(file => file.callId === call.id)) {
            record.files.push({ kind: name, path: resolvedPath, callId: call.id })
          }
        }, context)
        return
      }
      if (name === 'codemode') {
        const record = await api.snapshot(NestedFiles, api.taskId, context)
        if (record?.files.length && result.details && typeof result.details === 'object' && !Array.isArray(result.details)) {
          return { ...result, details: { ...result.details, workbenchFiles: record.files } }
        }
        return
      }
      const polling = call.name === 'shell_session'
      const starting = call.name === 'bash' || call.name === 'pwsh'
      if (!starting && !polling) return undefined
      const command = starting ? validationCommand(call.arguments.command) : undefined
      const output = objectValue(result.structuredOutput)
      if (starting && command === undefined) return undefined
      if (polling && (output?.status !== 'exited' || typeof output.sessionId !== 'string')) return undefined
      const attempt = await resolveAttempt(api.conversationId, context)
      if (attempt === undefined) return undefined
      const trackedSession = typeof output?.sessionId === 'string' ? output.sessionId : undefined
      const failed = result.isError === true || result.diagnostics?.some(diagnostic => diagnostic.severity === 'error')
      const status = output?.status === 'running' ? 'insufficient'
        : failed ? 'failed'
          : typeof output?.exitCode !== 'number' ? 'insufficient'
            : output.exitCode === 0 ? 'passed' : 'failed'
      await getHarness().commit(async tx => {
        const checks = await tx.doc(Checks, api.conversationId)
        if (polling) {
          const recorded = checks.items.find(item => item.attempt === attempt && item.sessionId === trackedSession)
          if (recorded) {
            recorded.callId = call.id
            recorded.status = status
          }
          return
        }
        if (command === undefined || checks.items.some(item => item.callId === call.id && item.attempt === attempt)) return
        checks.items.push({ callId: call.id, attempt, command, status, ...(trackedSession ? { sessionId: trackedSession } : {}) })
        checks.items = checks.items.slice(-80)
      }, context)
      return undefined
    },
  })
}

export async function workbenchEvidence(
  harness: Harness,
  child: ConversationId,
  attempt: number,
  messages: ConversationDetail['messages'],
): Promise<WorkItemEvidence[]> {
  const projected = new Map(messages.filter(message => message.toolCallId).map(message => [message.toolCallId, message.entryId]))
  const saved = await harness.snapshot(Checks, child, CTX)
  const checks = saved?.items.filter(item => item.attempt === attempt) ?? []
  const validations: WorkItemEvidence[] = checks.map(item => {
    const entryId = projected.get(item.callId)
    return {
      kind: 'validation', label: item.command, status: item.status,
      ...(entryId === undefined ? {} : { entryId }),
    }
  })
  const artifacts = new Map<string, WorkItemEvidence>()
  for (const message of messages) {
    if (message.isError && message.toolName !== 'codemode') continue
    for (const artifact of message.artifacts ?? []) {
      if (artifact.kind === 'read') continue
      const { path } = artifact
      artifacts.delete(path)
      artifacts.set(path, {
        kind: 'artifact', label: path, path, status: 'recorded',
        ...(message.entryId === undefined ? {} : { entryId: message.entryId }),
      })
    }
  }
  if (!validations.length) validations.push({ kind: 'validation', label: '未记录程序校验结果', status: 'insufficient' })
  return [...validations.slice(-12), ...[...artifacts.values()].slice(-8)]
}
