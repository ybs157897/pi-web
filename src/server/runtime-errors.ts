/**
 * 运行时错误的稳定判别码（machine-readable），HTTP 层（app.ts）据此映射状态码；
 * 与 UI 展示文案解耦，前后端可安全分支判断。
 */
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
  | 'ACCESS_DENIED'
  | 'PLAN_BLOCKED'

/**
 * 运行时失败错误：携带 HTTP 安全的判别码。
 * 功能：让服务端各层抛出可被 app.ts 统一转成 HTTP 响应的结构化错误，而非裸 Error。
 * @param code RuntimeErrorCode 判别码，决定 HTTP 状态码与前端错误分支。
 * @param message 面向用户的错误描述；可含中英文，HTTP 层会做脱敏。
 * 内部逻辑：仅设置 name 便于日志识别；code 通过构造器参数属性直接成为只读公开字段。
 */
export class RuntimeError extends Error {
  constructor(readonly code: RuntimeErrorCode, message: string) {
    super(message)
    this.name = 'RuntimeError'
  }
}
