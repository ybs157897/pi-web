import type { AssistantMessage } from '@earendil-works/pi-ai'
import { normalizeProviderError } from '@earendil-works/pi-ai/utils/error-body'
import type { ConversationFailure, ConversationFailureCode } from '../../shared/conversation-failure.ts'
import { RuntimeError } from '../runtime-errors.ts'

const failureMessages: Record<ConversationFailureCode, [
  message: string, action: ConversationFailure['action'],
]> = {
  MODEL_UNAVAILABLE: ['当前模型不可用，请选择可用的模型后继续。', 'check_model'],
  MODEL_AUTH_FAILED: ['模型服务拒绝了请求，请检查服务商凭据、账户权限或切换模型后继续。', 'check_model'],
  MODEL_RATE_LIMITED: ['模型服务限流（429），本轮已停止。请稍后重试，或切换模型后继续。', 'retry'],
  MODEL_QUOTA_EXCEEDED: ['当前账户的模型额度不足，请检查额度或切换模型后继续。', 'check_model'],
  MODEL_TIMEOUT: ['模型请求超时，请稍后重试，或切换模型后继续。', 'retry'],
  MODEL_CONNECTION_FAILED: ['无法连接模型服务，请检查服务地址和网络，或切换模型后继续。', 'check_model'],
  MODEL_CONTEXT_LIMIT: ['会话内容超出模型上下文限制，请压缩会话或切换支持更长上下文的模型。', 'compact'],
  MODEL_PROVIDER_FAILED: ['模型服务未能完成本轮请求，请重试，或检查模型配置后继续。', 'retry'],
  WORKBENCH_TIMEOUT: ['此工作项已达到 15 分钟执行上限。你可以从已保存的进度继续。', 'retry'],
  CONVERSATION_INTERRUPTED: ['本轮执行已经停止，可以从已保存的会话继续。', 'retry'],
  CONVERSATION_FAILED: ['本轮执行未完成，可以根据已保存的工作进度继续。', 'retry'],
}

export function conversationFailure(code: ConversationFailureCode, providerStatus?: number): ConversationFailure {
  const [message, action] = failureMessages[code]
  return { code, message, retryable: action === 'retry', action, ...(providerStatus === undefined ? {} : { providerStatus }) }
}

export function withRetryHistory(failure: ConversationFailure, attempts: number): ConversationFailure {
  if (attempts <= 0) return failure
  return {
    ...failure, retryAttempts: attempts,
    ...(failure.code === 'MODEL_RATE_LIMITED'
      ? { message: '模型自动重试后仍被限流（429），本轮已停止。请稍后重试，或切换模型后继续。' }
      : {}),
  }
}

/** This is the error boundary for public HTTP responses and persisted workbench failures. */
export class ConversationFailureError extends Error {
  constructor(readonly failure: ConversationFailure) {
    super(failure.message)
    this.name = 'ConversationFailureError'
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : undefined
}

const STATUS_PATTERN = /^(?:(?:Error(?: \w+)?|HTTP(?: status)?|status(?:Code)?)\s*[:=(]?\s*)?([45]\d\d)(?=\D|$)|\(([45]\d\d)\):|\bHTTP(?: status)?\s+([45]\d\d)\b/iu

function classifyProviderFailure(message: string, knownStatus?: number, diagnosticCode?: string): ConversationFailure {
  // pi-ai retains formatted status prefixes on older adapters and a diagnostic code on newer ones.
  const statusMatch = STATUS_PATTERN.exec(message)
  const candidate = knownStatus ?? (statusMatch ? Number(statusMatch[1] ?? statusMatch[2] ?? statusMatch[3]) : undefined)
  const status = candidate !== undefined && candidate >= 400 && candidate < 600 ? candidate : undefined
  const clue = `${diagnosticCode ?? ''} ${message.slice(0, 4_000)}`
  const failure = (code: ConversationFailureCode) => conversationFailure(code, status)

  if (status === 401 || status === 403 || /\b(?:invalid[_ ]api[_ ]key|incorrect api key|no api key|auth(?:entication|orization)? failed|unauthenticated|unauthorized|permission_denied|provider is not configured)\b/iu.test(clue)) return failure('MODEL_AUTH_FAILED')
  if (status === 402 || /\b(?:insufficient_quota|quota[_ ]exceeded|usage_limit_reached|usage_not_included|billing_hard_limit_reached|GoUsageLimitError|FreeUsageLimitError|monthly usage limit reached|payment required)\b/iu.test(clue)) return failure('MODEL_QUOTA_EXCEEDED')
  if (status === 429 || /\b(?:rate[_ -]limit(?:ed|[_ -]exceeded)?|too many requests|resource_exhausted|throttl\w*)\b/iu.test(clue)) return failure('MODEL_RATE_LIMITED')
  if (status === 408 || status === 504 || /\b(?:e?timed?out|timeout|deadline[_ ]exceeded|request (?:was )?aborted)\b/iu.test(clue)) return failure('MODEL_TIMEOUT')
  if (/\b(?:context[_ ]length[_ ]exceeded|context overflow|maximum context (?:length|window)|input is too long|too many tokens)\b/iu.test(clue)) return failure('MODEL_CONTEXT_LIMIT')
  if (/\b(?:model[_ ]not[_ ]found|no model(?: is)? configured|unknown provider|model .* (?:does not exist|is (?:unavailable|not available)))\b/iu.test(clue)) return failure('MODEL_UNAVAILABLE')
  if (/\b(?:econnrefused|econnreset|enotfound|enetunreach|eai_again|ehostunreach|failed to fetch|fetch failed|connection (?:error|refused|reset|closed)|network[_ ]error|socket hang up|certificate(?: has expired)?|api connection error)\b/iu.test(clue)) return failure('MODEL_CONNECTION_FAILED')
  return failure('MODEL_PROVIDER_FAILED')
}

export function providerFailure(error: unknown): ConversationFailure {
  if (error instanceof ConversationFailureError) return error.failure
  if (typeof error === 'string') return classifyProviderFailure(error.trim())
  const normalized = normalizeProviderError(error)
  const fields = record(error)
  const cause = record(fields?.cause)
  const code = fields?.code ?? cause?.code
  const status = fields?.status ?? fields?.statusCode ?? cause?.status
  return classifyProviderFailure(
    [normalized.message, normalized.body, cause?.message].filter(value => typeof value === 'string').join(' '),
    normalized.status ?? (typeof status === 'number' ? status : undefined), typeof code === 'string' ? code : undefined,
  )
}

export function assistantFailure(message: Pick<AssistantMessage, 'stopReason' | 'errorMessage' | 'diagnostics'>): ConversationFailure {
  if (message.stopReason === 'aborted' && !message.errorMessage) return conversationFailure('CONVERSATION_INTERRUPTED')
  const diagnostic = Array.isArray(message.diagnostics) ? message.diagnostics.findLast(item => item?.error !== undefined) : undefined
  const numericStatus = diagnostic?.details?.status ?? diagnostic?.details?.statusCode ?? diagnostic?.error?.code
  return classifyProviderFailure(
    message.errorMessage ?? diagnostic?.error?.message ?? '',
    typeof numericStatus === 'number' ? numericStatus : undefined,
    typeof diagnostic?.error?.code === 'string' ? diagnostic.error.code : undefined,
  )
}

export function runFailure(error: unknown): ConversationFailure {
  if (error instanceof ConversationFailureError) return error.failure
  if (error instanceof RuntimeError) {
    if (error.code === 'MODEL_UNAVAILABLE') return conversationFailure('MODEL_UNAVAILABLE')
    if (error.code === 'PROVIDER_ERROR') return providerFailure(error)
  }
  return conversationFailure('CONVERSATION_FAILED')
}

export function submissionFailure(reason: string, detail: unknown): ConversationFailure {
  if (reason === 'no_model') return conversationFailure('MODEL_UNAVAILABLE')
  if (reason === 'model_error') return providerFailure(detail)
  if (reason === 'aborted' || reason === 'withdrawn') return conversationFailure('CONVERSATION_INTERRUPTED')
  return conversationFailure('CONVERSATION_FAILED')
}

export function conversationFailureStatus(failure: ConversationFailure): 422 | 429 | 502 | 504 | 500 {
  switch (failure.code) {
    case 'MODEL_UNAVAILABLE':
    case 'MODEL_CONTEXT_LIMIT': return 422
    case 'MODEL_RATE_LIMITED': return 429
    case 'MODEL_TIMEOUT':
    case 'WORKBENCH_TIMEOUT': return 504
    case 'CONVERSATION_FAILED': return 500
    default: return 502
  }
}
