/**
 * 损坏会话的识别与隔离。
 *
 * 会话视图由「检查点 base + 增量 delta」重放得到。若某条 delta 的路径在当前重放上下文里
 * 无法解析（`PathError: unresolvable path`），物化就会抛错。这个错误一旦发生在**会话视图
 * 挂载**的过程中，内核会按存储故障处理并把整个 Session 标记为失败——此后所有会话的列表、
 * 详情与对话都不可用。
 *
 * 因此隔离必须发生在挂载之前：先用存储层直接物化该会话的挂载文档，失败的会话永不进入
 * `conversation.watch()`，只以元数据构造的占位摘要出现在列表里。
 */
import type { Context } from '@earendil-works/chord/context'
import type { ConversationId, Storage } from '@earendil-works/pi-durable'

/** 会话视图挂载的文档种类（与内核 `MOUNTED` 一致）。 */
const MOUNTED_KINDS = ['pi.agent', 'pi.live', 'pi.inbox', 'pi.provider', 'pi.usage'] as const

/** 会话存档无法重放。`corrupt` 表示存档本身坏了，而不是暂时性故障。 */
export class CorruptConversationError extends Error {
  readonly conversationId: string
  constructor(conversationId: string, cause: unknown) {
    super(`会话 ${conversationId} 的历史无法重放：${cause instanceof Error ? cause.message : String(cause)}`)
    this.name = 'CorruptConversationError'
    this.conversationId = conversationId
    this.cause = cause
  }
}

/**
 * 功能：判断错误是否表示「会话存档无法重放」。
 * @param error 待判断的错误。
 * @returns true 表示可归为损坏会话。
 * 内部逻辑：内核在重放期用 `PathError` / `UnsafePathError` 报告不可解析路径；重放失败若被
 * 内核按存储故障处理，会包成 `SessionFailed` 并保留原始 `cause`。因此沿 cause 链逐层匹配，
 * 并显式排除已识别的 `CorruptConversationError`。
 */
export function isCorruptConversationError(error: unknown): boolean {
  for (let current: unknown = error, depth = 0; current !== undefined && current !== null && depth < 6; depth += 1) {
    if (current instanceof CorruptConversationError) return true
    if (current instanceof Error) {
      if (current.name === 'PathError' || current.name === 'UnsafePathError') return true
      if (/unresolvable path/iu.test(current.message)) return true
      current = current.cause
      continue
    }
    break
  }
  return false
}

/**
 * 功能：在会话被 `watch()` 挂载前，探测它的视图能否重放。
 * @param storage 底层存储。
 * @param id 会话 ID。
 * @param context 执行上下文。
 * @returns 无法重放时返回造成失败的原始错误，可以重放时返回 undefined。
 * 内部逻辑：会话视图会挂载 `pi.agent`/`pi.live`/`pi.inbox`/`pi.provider`/`pi.usage`。这些文档在
 * `Storage.document()` 里已经物化，因此逐个读取即可判定——异常在这一层抛出不会经过 Session，
 * 也就不会把它标记为失败。任何读取异常都视为损坏：宁可让单个会话降级，也不要冒全站不可用的风险。
 */
export async function probeConversationView(
  storage: Storage,
  id: ConversationId,
  context: Context,
): Promise<unknown | undefined> {
  const scope = { kind: 'conversation', conversationId: id } as const
  try {
    for (const kind of MOUNTED_KINDS) {
      const page = await storage.scanDocuments({ scope, at: 'current', kind }, 8, undefined, context)
      for (const record of page.items) await storage.document(record.id, 'current', context)
    }
    return undefined
  } catch (error) {
    return error
  }
}
