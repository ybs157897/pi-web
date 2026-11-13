// doc-keeper 进程内 A2A 任务流集成测试：createDocKeeperAgent + 传输无关的 DefaultRequestHandler。
// doc-keeper 是内置智能体，经进程内 A2A（Message → Task → artifact）委派，不独立监听 HTTP 端口。
// 协议核心仍是 @a2a-js/sdk：sendMessage/getTask/sendMessageStream 直接在进程内驱动 executor。
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { type Message, type SendMessageRequest, type Task, Role, TaskState } from '@a2a-js/sdk'
import { ServerCallContext, UnauthenticatedUser } from '@a2a-js/sdk/server'
import type { DocKeeperRunInput, DocKeeperRunResult } from '../src/server/knowledge/service.ts'
import type { DocKeeperAgent } from '../src/server/doc-keeper/a2a.ts'
import {
  DOC_PATH, cleanupKeeperFixtures, keeperFixture, textTurn, toolTurn,
  type ProviderScript,
} from './keeper-fixtures.ts'

const { createDocKeeperAgent } = await import('../src/server/doc-keeper/a2a.ts')
const { DOC_KEEPER_SKILL_ID } = await import('../src/server/doc-keeper/agent-card.ts')

afterEach(cleanupKeeperFixtures)

const callContext = () => new ServerCallContext({ user: new UnauthenticatedUser(), requestedVersion: '1.0' })

function messageOf(payload: unknown, via: 'data' | 'text' = 'data'): Message {
  const part = via === 'data'
    ? { content: { $case: 'data' as const, value: payload }, metadata: undefined, filename: '', mediaType: 'application/json' }
    : { content: { $case: 'text' as const, value: JSON.stringify(payload) }, metadata: undefined, filename: '', mediaType: 'text/plain' }
  return { messageId: randomUUID(), contextId: '', taskId: '', role: Role.ROLE_USER, parts: [part], metadata: undefined, extensions: [], referenceTaskIds: [] }
}

const requestOf = (payload: unknown, via: 'data' | 'text' = 'data'): SendMessageRequest =>
  ({ tenant: '', message: messageOf(payload, via), configuration: undefined, metadata: undefined })

const stubResult: DocKeeperRunResult = {
  mode: 'check', health: 'fresh', detail: 'stub ok', changedFiles: [], commitCount: 0, updated: false, knowledgePath: DOC_PATH,
}

/** 起一个 stub runMaintenance 的进程内 A2A 端点，记录收到的输入。 */
function stubAgent(options: { result?: DocKeeperRunResult } = {}): { agent: DocKeeperAgent; calls: DocKeeperRunInput[] } {
  const calls: DocKeeperRunInput[] = []
  const agent = createDocKeeperAgent({
    runMaintenance: async input => {
      calls.push(input)
      return options.result ?? stubResult
    },
  })
  return { agent, calls }
}

function taskOf(result: Message | Task): Task {
  if (!('artifacts' in result)) throw new Error(`响应不是 task：${JSON.stringify(result)}`)
  return result
}

function artifactText(task: Task): string {
  const part = task.artifacts[0]?.parts.find(candidate => candidate.content?.$case === 'text')
  return part?.content?.$case === 'text' ? part.content.value : ''
}

describe('进程内 A2A 端点：Agent Card', () => {
  it('Agent Card 描述内置维护技能与进程内接口', async () => {
    const { agent } = stubAgent()
    const card = await agent.requestHandler.getAgentCard()
    expect(card.name).toBe('doc-keeper')
    expect(card.skills[0].id).toBe(DOC_KEEPER_SKILL_ID)
    expect(card.supportedInterfaces[0].url).toBe('in-process://doc-keeper')
    expect(agent.agentCard).toEqual(card)
  })
})

describe('进程内 A2A 任务流：sendMessage / getTask', () => {
  it('data part 输入被完整解析，任务完成并产出结果 artifact', async () => {
    const { agent, calls } = stubAgent()
    const payload = { repo: '/tmp/some-repo', globs: ['src/**', 'lib/**'], knowledgePath: DOC_PATH, mode: 'refresh', model: { provider: 'p', modelId: 'm' } }
    const task = taskOf(await agent.requestHandler.sendMessage(requestOf(payload), callContext()))
    expect(calls).toEqual([payload])
    expect(task.status?.state).toBe(TaskState.TASK_STATE_COMPLETED)
    expect(task.artifacts).toHaveLength(1)
    expect(task.artifacts[0].name).toBe('maintenance-result')
    expect(JSON.parse(artifactText(task))).toEqual(stubResult)
    expect(task.history[0].messageId).toBeTruthy()

    // getTask 能按 id 取回同一终态任务。
    const fetched = await agent.requestHandler.getTask({ tenant: '', id: task.id }, callContext())
    expect(fetched.id).toBe(task.id)
    expect(fetched.status?.state).toBe(TaskState.TASK_STATE_COMPLETED)
  })

  it('sendMaintenance 客户端等价于 data part sendMessage', async () => {
    const { agent, calls } = stubAgent()
    const payload: DocKeeperRunInput = { globs: ['src/**'], knowledgePath: DOC_PATH, mode: 'check' }
    expect(await agent.sendMaintenance(payload)).toEqual(stubResult)
    expect(calls).toEqual([payload])
  })

  it('JSON 文本 part 与 data part 等价', async () => {
    const { agent, calls } = stubAgent()
    const payload = { globs: ['src/**'], knowledgePath: DOC_PATH, mode: 'check' }
    const task = taskOf(await agent.requestHandler.sendMessage(requestOf(payload, 'text'), callContext()))
    expect(calls).toEqual([payload])
    expect(task.status?.state).toBe(TaskState.TASK_STATE_COMPLETED)
  })

  it('缺必填字段 → 任务 FAILED，sendMaintenance 抛错', async () => {
    const { agent, calls } = stubAgent()
    const task = taskOf(await agent.requestHandler.sendMessage(requestOf({ knowledgePath: DOC_PATH, mode: 'check' }), callContext()))
    expect(task.status?.state).toBe(TaskState.TASK_STATE_FAILED)
    expect(task.status?.message?.parts[0].content?.$case === 'text' && task.status.message.parts[0].content.value).toContain('globs')
    expect(calls).toEqual([])
    await expect(agent.sendMaintenance({ knowledgePath: DOC_PATH, mode: 'check' } as DocKeeperRunInput)).rejects.toThrow()
  })

  it('非 JSON 文本 → 任务 FAILED', async () => {
    const { agent } = stubAgent()
    const message: Message = { ...messageOf({}), parts: [{ content: { $case: 'text', value: '请维护一下文档' }, metadata: undefined, filename: '', mediaType: 'text/plain' }] }
    const task = taskOf(await agent.requestHandler.sendMessage({ tenant: '', message, configuration: undefined, metadata: undefined }, callContext()))
    expect(task.status?.state).toBe(TaskState.TASK_STATE_FAILED)
  })

  it('维护结果带 error → 任务 FAILED 但仍产出 artifact', async () => {
    const { agent } = stubAgent({ result: { ...stubResult, error: '模型不可用' } })
    const task = taskOf(await agent.requestHandler.sendMessage(requestOf({ globs: ['src/**'], knowledgePath: DOC_PATH, mode: 'refresh' }), callContext()))
    expect(task.status?.state).toBe(TaskState.TASK_STATE_FAILED)
    expect(task.artifacts).toHaveLength(1)
    expect(task.status?.message?.parts[0].content?.$case === 'text' && task.status.message.parts[0].content.value).toContain('模型不可用')
  })

  it('sendMessageStream 生命周期：task → working → artifact → completed', async () => {
    const { agent } = stubAgent()
    const kinds: string[] = []
    const states: TaskState[] = []
    for await (const response of agent.requestHandler.sendMessageStream(requestOf({ globs: ['src/**'], knowledgePath: DOC_PATH, mode: 'check' }), callContext())) {
      const payload = response.payload
      if (payload?.$case === 'task') kinds.push('task')
      else if (payload?.$case === 'statusUpdate') { kinds.push('statusUpdate'); if (payload.value.status !== undefined) states.push(payload.value.status.state) }
      else if (payload?.$case === 'artifactUpdate') kinds.push('artifactUpdate')
    }
    expect(kinds[0]).toBe('task')
    expect(kinds).toContain('artifactUpdate')
    expect(states).toEqual([TaskState.TASK_STATE_WORKING, TaskState.TASK_STATE_COMPLETED])
  })
})

describe('进程内 A2A 全链路：真实 runtime + 脚本模型驱动 refresh', () => {
  it('sendMaintenance refresh 经五工具写回知识文档', async () => {
    const newBody = '## 职责\n\n- 负责 server 模块。\n\n## 关键文件\n\n- `src/a.ts`：入口，导出 a=2。\n\n## 已知坑\n\n- 暂无。\n\n## changelog\n\n- 2026-11-12 进程内 A2A 增量刷新；1 条提交。\n'
    const script: ProviderScript = {
      turn: (_userText, toolCount) => {
        switch (toolCount) {
          case 0: return toolTurn('detect_changes', {})
          case 1: return toolTurn('read_knowledge', {})
          case 2: return toolTurn('git_diff', {})
          case 3: return toolTurn('read_code', { paths: ['src/a.ts'] })
          case 4: return toolTurn('write_knowledge', { body: newBody })
          default: return textTurn('A2A 刷新完成：a=2 已写入关键文件，1 条提交。')
        }
      },
    }
    const { runtime, workspace } = await keeperFixture(script)
    const agent = createDocKeeperAgent({ runMaintenance: runtime.runDocKeeperMaintenance })
    const result = await agent.sendMaintenance({
      globs: ['src/**'], knowledgePath: DOC_PATH, mode: 'refresh', model: { provider: 'repro', modelId: 'repro-model' },
    })
    expect(result.updated).toBe(true)
    expect(result.health).toBe('fresh')
    expect(result.report).toContain('A2A 刷新完成')

    const onDisk = await readFile(join(workspace, DOC_PATH), 'utf8')
    expect(onDisk).toContain('botId: atlas')
    expect(onDisk.endsWith(newBody)).toBe(true)
  }, 30_000)
})
