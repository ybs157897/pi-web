import type { ModelRef } from './types.ts'

/** Serialize a model as `provider/modelId`. */
export function formatModelRef(model: ModelRef): string {
  return `${model.provider}/${model.modelId}`
}

/**
 * Parse `provider/modelId`. The first slash separates the provider; the rest is
 * the model id, which may itself contain slashes.
 */
export function parseModelRef(value: string | undefined | null): ModelRef | undefined {
  if (value === undefined || value === null) return undefined
  const trimmed = value.trim()
  if (trimmed === '') return undefined
  const slash = trimmed.indexOf('/')
  if (slash <= 0 || slash === trimmed.length - 1) return undefined
  return { provider: trimmed.slice(0, slash), modelId: trimmed.slice(slash + 1) }
}
