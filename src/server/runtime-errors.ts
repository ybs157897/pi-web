export type RuntimeErrorCode = 'NOT_FOUND' | 'CONFLICT' | 'MODEL_UNAVAILABLE' | 'INVALID_INPUT' | 'FORBIDDEN' | 'UNSUPPORTED' | 'PROVIDER_ERROR'

/** Runtime failure with an HTTP-safe discriminant. */
export class RuntimeError extends Error {
  constructor(readonly code: RuntimeErrorCode, message: string) {
    super(message)
    this.name = 'RuntimeError'
  }
}
