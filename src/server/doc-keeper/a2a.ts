/**
 * doc-keeper 的进程内 A2A 端点。doc-keeper 是内置智能体：保留 A2A 协议核心
 * （Agent Card + DefaultRequestHandler + InMemoryTaskStore + DocKeeperExecutor），但传输是
 * 进程内函数调用，不是独立 HTTP 服务。其他内置智能体（bots watchdog）经 sendMaintenance
 * 以 A2A 语义（Message → Task → artifact）委派维护任务，不经过网络监听。
 *
 * DefaultRequestHandler 本身传输无关：sendMessage(params, context) 直接在进程内驱动 executor
 * 并返回终态 Task，无需 JSON-RPC/HTTP 壳；requestHandler 也暴露给需要原生 A2A 流式语义的调用方。
 */
import { randomUUID } from 'node:crypto'
import { type AgentCard, type Message, type SendMessageRequest, type Task, Role } from '@a2a-js/sdk'
import { DefaultRequestHandler, InMemoryTaskStore, ServerCallContext, UnauthenticatedUser } from '@a2a-js/sdk/server'
import { RuntimeError } from '../runtime-errors.ts'
import type { DocKeeperRunInput, DocKeeperRunResult } from '../knowledge/service.ts'
import { buildDocKeeperAgentCard } from './agent-card.ts'
import { DocKeeperExecutor, type RunMaintenance } from './executor.ts'

/** 进程内端点的象征性地址（无 HTTP 监听）；Agent Card 仍按 A2A 描述能力与接口。 */
export const DOC_KEEPER_IN_PROCESS_URL = 'in-process://doc-keeper'

export interface DocKeeperAgent {
  /** A2A 能力描述，供发现与协议语义保留。 */
  agentCard: AgentCard
  /** 传输无关的 A2A 请求处理器；进程内调用方可直接 sendMessage / sendMessageStream。 */
  requestHandler: DefaultRequestHandler
  /** 进程内 A2A 客户端：data part 消息 → sendMessage → 解析 maintenance-result artifact。 */
  sendMaintenance(input: DocKeeperRunInput): Promise<DocKeeperRunResult>
}

/** 从终态 Task 取 maintenance-result artifact 的 JSON 结果；无 artifact（如输入校验失败）则抛错。 */
function resultOf(task: Task): DocKeeperRunResult {
  const artifact = task.artifacts.find(candidate => candidate.name === 'maintenance-result')
  const part = artifact?.parts.find(candidate => candidate.content?.$case === 'text')
  if (part?.content?.$case === 'text') return JSON.parse(part.content.value) as DocKeeperRunResult
  const statusPart = task.status?.message?.parts.find(candidate => candidate.content?.$case === 'text')
  const detail = statusPart?.content?.$case === 'text' ? statusPart.content.value : '维护任务未产出结果'
  throw new RuntimeError('INVALID_INPUT', `doc-keeper 维护失败：${detail}`)
}

export function createDocKeeperAgent(deps: { runMaintenance: RunMaintenance }): DocKeeperAgent {
  const agentCard = buildDocKeeperAgentCard(DOC_KEEPER_IN_PROCESS_URL)
  const requestHandler = new DefaultRequestHandler(
    agentCard, new InMemoryTaskStore(), new DocKeeperExecutor(deps.runMaintenance),
  )

  const sendMaintenance = async (input: DocKeeperRunInput): Promise<DocKeeperRunResult> => {
    const message: Message = {
      messageId: randomUUID(), contextId: '', taskId: '', role: Role.ROLE_USER,
      parts: [{ content: { $case: 'data', value: input }, metadata: undefined, filename: '', mediaType: 'application/json' }],
      metadata: undefined, extensions: [], referenceTaskIds: [],
    }
    const request: SendMessageRequest = { tenant: '', message, configuration: undefined, metadata: undefined }
    const context = new ServerCallContext({ user: new UnauthenticatedUser(), requestedVersion: '1.0' })
    const result = await requestHandler.sendMessage(request, context)
    if (!('artifacts' in result)) throw new RuntimeError('INVALID_INPUT', 'doc-keeper 未返回任务')
    return resultOf(result)
  }

  return { agentCard, requestHandler, sendMaintenance }
}
