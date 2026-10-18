import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxThinking,
  fauxToolCall,
  type FauxResponseFactory,
} from '@earendil-works/pi-ai'
import type { ModelRef } from '@earendil-works/pi-durable'
import type { ModelCatalog, ProviderConfigSummary, ProviderInput, ProviderTestResult, ThinkingLevel } from '../shared/types.ts'
import type { RuntimeModels } from './models.ts'
import { RuntimeError } from './runtime-errors.ts'

interface ResponseGate {
  started: Promise<void>
  resolveStarted(): void
  released: Promise<void>
  resolveReleased(): void
}

let nextGate: ResponseGate | undefined
const DEMO_MODEL: ModelRef = { provider: 'pi-web-demo', modelId: 'demo-model' }
const THINKING_LEVELS: ThinkingLevel[] = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']

/** Pause the next demo model response until released or the Pi request is aborted. */
export function holdNextDemoResponse(): { started: Promise<void>; release(): void } {
  if (nextGate) throw new Error('A demo response gate is already installed')
  let resolveStarted!: () => void
  let resolveReleased!: () => void
  const gate: ResponseGate = {
    started: new Promise<void>((resolve) => { resolveStarted = resolve }),
    resolveStarted: () => resolveStarted(),
    released: new Promise<void>((resolve) => { resolveReleased = resolve }),
    resolveReleased: () => resolveReleased(),
  }
  nextGate = gate
  return {
    started: gate.started,
    release() {
      if (nextGate === gate) nextGate = undefined
      gate.resolveReleased()
    },
  }
}

async function waitAtGate(signal: AbortSignal | undefined): Promise<void> {
  const gate = nextGate
  if (!gate) return
  nextGate = undefined
  gate.resolveStarted()
  if (signal?.aborted) return
  let onAbort: (() => void) | undefined
  const aborted = new Promise<void>((resolve) => {
    onAbort = () => resolve()
    signal?.addEventListener('abort', onAbort, { once: true })
  })
  try {
    await Promise.race([gate.released, aborted])
  } finally {
    if (onAbort) signal?.removeEventListener('abort', onAbort)
  }
}

function latestUserText(context: Parameters<FauxResponseFactory>[0]): string {
  const latest = [...context.messages].reverse().find((message) => message.role === 'user')
  if (!latest) return ''
  if (typeof latest.content === 'string') return latest.content
  return latest.content.filter((block) => block.type === 'text').map((block) => block.text).join('\n')
}

const scriptedResponse: FauxResponseFactory = async (context, options) => {
  await waitAtGate(options?.signal)
  let lastUserIndex = -1
  for (let index = context.messages.length - 1; index >= 0; index--) {
    if (context.messages[index].role === 'user') {
      lastUserIndex = index
      break
    }
  }
  const currentResults = context.messages.slice(lastUserIndex + 1).filter((message) => message.role === 'toolResult')
  const userText = latestUserText(context).trim()
  if (userText.includes('[render-fixture]')) {
    const runToken = String(context.messages.length)
    switch (currentResults.length) {
      case 0:
        return fauxAssistantMessage(fauxToolCall('write', {
          path: 'render-fixture.md',
          content: '# Before\n\nA fixture paragraph with **bold** text.\n',
        }, { id: `fixture-write-${runToken}` }), { stopReason: 'toolUse' })
      case 1:
        return fauxAssistantMessage(fauxToolCall('edit', {
          path: 'render-fixture.md',
          edits: [{ oldText: 'Before', newText: 'After' }],
        }, { id: `fixture-edit-${runToken}` }), { stopReason: 'toolUse' })
      case 2:
        return fauxAssistantMessage(fauxToolCall('read', { path: 'render-fixture.md' }, { id: `fixture-read-${runToken}` }), { stopReason: 'toolUse' })
      case 3:
        return fauxAssistantMessage(fauxToolCall('bash', {
          command: 'printf "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/z0sAAAAASUVORK5CYII=" | base64 -d > render-fixture.png',
        }, { id: `fixture-image-${runToken}` }), { stopReason: 'toolUse' })
      case 4:
        return fauxAssistantMessage(fauxToolCall('read', { path: 'render-fixture.png' }, { id: `fixture-image-read-${runToken}` }), { stopReason: 'toolUse' })
      default:
        return fauxAssistantMessage([
          fauxThinking('演示按固定步骤写入、编辑、读取并检查了一张图片。'),
          fauxText('# Render fixture\n\nA paragraph with **bold**, *italic*, `inline code`, and a [citation](https://example.test/source).\n\n## List\n\n- First item\n- Second item\n\n| Surface | Result |\n| --- | --- |\n| Markdown | rendered |\n| Table | aligned |\n\n```ts\nconst rendered = true\n```\n\n$$\nx^2 + y^2 = z^2\n$$\n\nThe image output appears in the successful `read` tool result above.'),
        ])
    }
  }
  const completedTools = new Set(currentResults.map((message) => message.toolName))
  const runToken = String(context.messages.length)
  if (!completedTools.has('write')) {
    return fauxAssistantMessage([
      fauxThinking('先写入目标文件，再用 read 和 bash 交叉核对。'),
      fauxToolCall('write', { path: 'hello.txt', content: 'Hello from Pi Durable Web.\n' }, { id: `demo-write-${runToken}` }),
    ], { stopReason: 'toolUse' })
  }
  if (!completedTools.has('read')) {
    return fauxAssistantMessage(fauxToolCall('read', { path: 'hello.txt' }, { id: `demo-read-${runToken}` }), { stopReason: 'toolUse' })
  }
  if (!completedTools.has('bash')) {
    return fauxAssistantMessage(fauxToolCall('bash', { command: 'cat hello.txt' }, { id: `demo-bash-${runToken}` }), { stopReason: 'toolUse' })
  }
  return fauxAssistantMessage([
    fauxThinking('文件已经通过 write、read 和 bash 三种工具操作核对。'),
    fauxText(`已完成“${userText || '演示任务'}”。\n\n| 检查方式 | 结果 |\n| --- | --- |\n| write | 文件已创建 |\n| read | 内容可读取 |\n| bash | 内容已在 shell 中核对 |\n\n文件内容：\n\n\`\`\`text\nHello from Pi Durable Web.\n\`\`\``),
  ])
}

/** Build an explicit deterministic demo catalog; production never falls back to it. */
export function createDemoModelRuntime(): RuntimeModels {
  const faux = fauxProvider({
    provider: DEMO_MODEL.provider,
    models: [{ id: DEMO_MODEL.modelId, name: '演示模型（不调用真实模型）', reasoning: true, input: ['text', 'image'] }],
    tokenSize: { min: 4, max: 8 },
  })
  faux.setResponses(Array.from({ length: 512 }, () => scriptedResponse))
  const models = createModels()
  models.setProvider(faux.provider)
  return {
    models,
    defaultModel: DEMO_MODEL,
    defaultThinkingLevel: 'medium',
    async saveProvider(_input: ProviderInput) {
      throw new Error('演示模式不保存 Provider 配置')
    },
    async provider(id): Promise<ProviderConfigSummary> {
      if (id !== DEMO_MODEL.provider) throw new RuntimeError('NOT_FOUND', 'Provider 不存在')
      return {
        id,
        name: '演示模型（不调用真实模型）',
        source: 'builtin',
        configured: true,
        credentialConfigured: true,
        custom: false,
        api: 'openai-completions',
        models: [{ id: DEMO_MODEL.modelId, name: '演示模型（不调用真实模型）', reasoning: true, contextWindow: 128_000, input: ['text', 'image'] }],
      }
    },
    async deleteProvider(id) {
      if (id !== DEMO_MODEL.provider) throw new RuntimeError('NOT_FOUND', 'Provider 不存在')
      throw new RuntimeError('UNSUPPORTED', '演示 Provider 不可删除')
    },
    async testProvider(id, modelId): Promise<ProviderTestResult> {
      if (id !== DEMO_MODEL.provider || (modelId !== undefined && modelId !== DEMO_MODEL.modelId)) throw new RuntimeError('NOT_FOUND', 'Provider 或模型不存在')
      return { providerId: id, modelId: DEMO_MODEL.modelId, status: 'failed', checkedAt: Date.now(), message: '演示模式不会发送真实 Provider 请求' }
    },
    async catalog(): Promise<ModelCatalog> {
      return {
        models: [{
          ...DEMO_MODEL,
          name: '演示模型（不调用真实模型）',
          reasoning: true,
          available: true,
          contextWindow: 128_000,
          thinkingLevels: [...THINKING_LEVELS],
        }],
        providers: [{ id: DEMO_MODEL.provider, name: '演示模型（不调用真实模型）', configured: true, custom: false, source: 'builtin' }],
        defaultModel: DEMO_MODEL,
        thinkingLevels: [...THINKING_LEVELS],
      }
    },
  }
}
