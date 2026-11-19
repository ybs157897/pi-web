export type ConversationFailureCode =
  | 'MODEL_UNAVAILABLE'
  | 'MODEL_AUTH_FAILED'
  | 'MODEL_RATE_LIMITED'
  | 'MODEL_QUOTA_EXCEEDED'
  | 'MODEL_TIMEOUT'
  | 'MODEL_CONNECTION_FAILED'
  | 'MODEL_CONTEXT_LIMIT'
  | 'MODEL_PROVIDER_FAILED'
  | 'WORKBENCH_TIMEOUT'
  | 'CONVERSATION_INTERRUPTED'
  | 'CONVERSATION_FAILED'

export type ConversationFailure = {
  code: ConversationFailureCode
  message: string
  /** The same configuration can be retried without a model or context repair. */
  retryable: boolean
  action: 'retry' | 'check_model' | 'compact'
  providerStatus?: number
  /** Count of observed automatic retries of this request. */
  retryAttempts?: number
}

export type ConversationRetry = {
  attempt: number
  nextAt: number
  failure: ConversationFailure
}
