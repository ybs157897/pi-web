export type RuntimeErrorCode =
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'MODEL_UNAVAILABLE'
  | 'INVALID_INPUT'
  | 'FORBIDDEN'
  | 'UNSUPPORTED'
  | 'PROVIDER_ERROR'
  | 'MARKETPLACE_NOT_FOUND'
  | 'PLUGIN_NOT_FOUND'
  | 'PLUGIN_ALREADY_INSTALLED'
  | 'PLUGIN_SOURCE_INVALID'
  | 'PLUGIN_CHECKSUM_MISMATCH'
  | 'PLUGIN_UNSUPPORTED_SOURCE'
  | 'PLUGIN_DEPENDENCY_MISSING'
  | 'PLUGIN_UI_UNAVAILABLE'

/** Runtime failure with an HTTP-safe discriminant. */
export class RuntimeError extends Error {
  constructor(readonly code: RuntimeErrorCode, message: string) {
    super(message)
    this.name = 'RuntimeError'
  }
}
