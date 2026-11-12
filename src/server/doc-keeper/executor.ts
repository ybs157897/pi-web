/**
 * DocKeeperExecutor: the A2A AgentExecutor that drives one knowledge-maintenance task. It parses
 * the incoming message into a maintenance target, runs the doc-keeper service, and translates the
 * outcome into A2A task lifecycle events + a result artifact. The service is injected so this layer
 * stays independent of the pi-web runtime internals.
 */
import { randomUUID } from 'node:crypto'
import {
  type Artifact, type Message, type Task, type TaskArtifactUpdateEvent, type TaskStatusUpdateEvent,
  Role, TaskState,
} from '@a2a-js/sdk'
import { AgentEvent, type AgentExecutor, type ExecutionEventBus, type RequestContext } from '@a2a-js/sdk/server'
import type { DocKeeperRunInput, DocKeeperRunResult } from '../knowledge/service.ts'

export type RunMaintenance = (input: DocKeeperRunInput) => Promise<DocKeeperRunResult>

function textPart(value: string) {
  return { content: { $case: 'text' as const, value }, metadata: undefined, filename: '', mediaType: 'text/plain' }
}

function agentMessage(taskId: string, contextId: string, text: string): Message {
  return {
    role: Role.ROLE_AGENT, messageId: randomUUID(), parts: [textPart(text)],
    taskId, contextId, extensions: [], metadata: {}, referenceTaskIds: [],
  }
}

function statusUpdate(taskId: string, contextId: string, state: TaskState, text?: string): TaskStatusUpdateEvent {
  return {
    taskId, contextId,
    status: { state, timestamp: new Date().toISOString(), message: text === undefined ? undefined : agentMessage(taskId, contextId, text) },
    metadata: {},
  }
}

/** Extract the maintenance target from a data part, or a JSON text part. */
function parseInput(message: Message): DocKeeperRunInput {
  let raw: unknown
  const dataPart = message.parts.find(part => part.content?.$case === 'data')
  if (dataPart?.content?.$case === 'data') {
    raw = dataPart.content.value
  } else {
    const textPartFound = message.parts.find(part => part.content?.$case === 'text')
    const text = textPartFound?.content?.$case === 'text' ? textPartFound.content.value.trim() : ''
    try { raw = JSON.parse(text) } catch { throw new Error('需要 data part 或 JSON 文本：{globs[], knowledgePath, mode:"check"|"refresh", repo?, model?}') }
  }
  if (typeof raw !== 'object' || raw === null) throw new Error('维护任务参数必须是对象')
  const value = raw as Record<string, unknown>
  const globs = Array.isArray(value.globs) ? value.globs.filter((item): item is string => typeof item === 'string') : []
  const knowledgePath = typeof value.knowledgePath === 'string' ? value.knowledgePath : ''
  if (globs.length === 0 || knowledgePath === '') throw new Error('缺少必填字段 globs[] 或 knowledgePath')
  const mode = value.mode === 'refresh' ? 'refresh' : 'check'
  const model = typeof value.model === 'object' && value.model !== null
    && typeof (value.model as Record<string, unknown>).provider === 'string'
    && typeof (value.model as Record<string, unknown>).modelId === 'string'
    ? { provider: (value.model as Record<string, string>).provider, modelId: (value.model as Record<string, string>).modelId }
    : undefined
  return {
    ...(typeof value.repo === 'string' ? { repo: value.repo } : {}),
    globs, knowledgePath, mode,
    ...(model === undefined ? {} : { model }),
  }
}

export class DocKeeperExecutor implements AgentExecutor {
  private readonly cancelledTasks = new Set<string>()

  constructor(private readonly runMaintenance: RunMaintenance) {}

  cancelTask = async (taskId: string, eventBus: ExecutionEventBus): Promise<void> => {
    this.cancelledTasks.add(taskId)
    eventBus.publish(AgentEvent.statusUpdate(statusUpdate(taskId, '', TaskState.TASK_STATE_CANCELED)))
  }

  async execute(requestContext: RequestContext, eventBus: ExecutionEventBus): Promise<void> {
    const { taskId, contextId, userMessage, task: existingTask } = requestContext
    try {
      const taskSnapshot: Task = existingTask ?? {
        id: taskId, contextId,
        status: { state: TaskState.TASK_STATE_SUBMITTED, timestamp: new Date().toISOString(), message: undefined },
        artifacts: [], history: [userMessage], metadata: userMessage.metadata,
      }
      eventBus.publish(AgentEvent.task(taskSnapshot))

      let input: DocKeeperRunInput
      try {
        input = parseInput(userMessage)
      } catch (error) {
        eventBus.publish(AgentEvent.statusUpdate(statusUpdate(taskId, contextId, TaskState.TASK_STATE_FAILED, error instanceof Error ? error.message : String(error))))
        return
      }

      eventBus.publish(AgentEvent.statusUpdate(statusUpdate(taskId, contextId, TaskState.TASK_STATE_WORKING, `开始维护 ${input.knowledgePath}（${input.mode}）…`)))
      const result = await this.runMaintenance(input)
      if (this.cancelledTasks.has(taskId)) {
        eventBus.publish(AgentEvent.statusUpdate(statusUpdate(taskId, contextId, TaskState.TASK_STATE_CANCELED)))
        return
      }

      const artifact: Artifact = {
        artifactId: randomUUID(), name: 'maintenance-result', description: '知识文档维护结果',
        parts: [textPart(JSON.stringify(result, null, 2))], metadata: undefined, extensions: [],
      }
      const artifactUpdate: TaskArtifactUpdateEvent = { taskId, contextId, artifact, lastChunk: true, append: false, metadata: undefined }
      eventBus.publish(AgentEvent.artifactUpdate(artifactUpdate))

      const failed = result.error !== undefined && result.error !== ''
      eventBus.publish(AgentEvent.statusUpdate(statusUpdate(
        taskId, contextId,
        failed ? TaskState.TASK_STATE_FAILED : TaskState.TASK_STATE_COMPLETED,
        failed ? result.error : `完成：health=${result.health}，updated=${result.updated}`,
      )))
    } finally {
      this.cancelledTasks.delete(taskId)
    }
  }
}