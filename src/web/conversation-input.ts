import type { ThinkingLevel } from '../shared/types.ts'
import type { DraftImage } from './Composer.tsx'

/** 限额视角下的一个附件：是否图片 + 字节大小。 */
interface AttachmentSize { image: boolean; size: number }
type AttachmentLimit = 'images' | 'files' | 'empty' | 'imageBytes' | 'fileBytes' | 'total'

/** 受支持的图片附件 MIME 类型集合。 */
const IMAGE_MIME_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/avif'])
/** 拖放的文件可能没有 MIME 类型，此时以扩展名代替判断。 */
const IMAGE_EXTENSIONS: Readonly<Record<string, string>> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', avif: 'image/avif',
}

/** 附件限额：单条消息图片数、文件数、单图/单文件与总大小上限。 */
const MAX_IMAGE_COUNT = 4
const MAX_FILE_COUNT = 8
const MAX_IMAGE_BYTES = 4 * 1024 * 1024
const MAX_FILE_BYTES = 8 * 1024 * 1024
const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024

/** 思考档位的全局递进顺序（clampThinkingLevel 的折算依据）。 */
const THINKING_ORDER: readonly ThinkingLevel[] = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']

/**
 * 折算运行时会真正存储的思考等级：先向上找最近的支持档位，再向下回退。
 * @param level 请求的档位；supported 运行时支持的档位列表。
 * @returns 支持的档位；无列表或请求档位不受支持时按 THINKING_ORDER 就近折算。
 */
export function clampThinkingLevel(level: ThinkingLevel, supported: readonly ThinkingLevel[] | undefined): ThinkingLevel {
  if (supported === undefined || supported.length === 0 || supported.includes(level)) return level
  const requested = THINKING_ORDER.indexOf(level)
  if (requested === -1) return supported[0]!
  for (let index = requested; index < THINKING_ORDER.length; index += 1) {
    if (supported.includes(THINKING_ORDER[index]!)) return THINKING_ORDER[index]!
  }
  for (let index = requested - 1; index >= 0; index -= 1) {
    if (supported.includes(THINKING_ORDER[index]!)) return THINKING_ORDER[index]!
  }
  return supported[0]!
}

/**
 * 计算本批附件最先触犯的限额，全部合规时返回 null。
 * 仍在读取中的批次也计入批次，因此同一 tick 内排队的两次添加不会
 * 针对同一份过期快照通过两次检查。
 * 导出以便脱离浏览器验证限额逻辑。
 * @param committed 已入库的附件；reading 读取中的批次；selected 新选中的批次。
 */
export function attachmentLimitError(committed: readonly DraftImage[], reading: readonly AttachmentSize[], selected: readonly AttachmentSize[]): AttachmentLimit | null {
  const all: AttachmentSize[] = [
    ...committed.map(image => ({ image: isImageType(image.mimeType), size: image.file.size })),
    ...reading,
    ...selected,
  ]
  const images = all.filter(item => item.image)
  const files = all.filter(item => !item.image)
  if (images.length > MAX_IMAGE_COUNT) return 'images'
  if (files.length > MAX_FILE_COUNT) return 'files'
  if (all.some(item => item.size === 0)) return 'empty'
  if (images.some(item => item.size > MAX_IMAGE_BYTES)) return 'imageBytes'
  if (files.some(item => item.size > MAX_FILE_BYTES)) return 'fileBytes'
  if (all.reduce((sum, item) => sum + item.size, 0) > MAX_ATTACHMENT_BYTES) return 'total'
  return null
}

/** 某一附件限额被触犯时的本地化提示文案。 */
export function attachmentLimitText(limit: AttachmentLimit, t: (chinese: string, english: string) => string): string {
  switch (limit) {
    case 'images': return t('一条消息最多添加 4 张图片', 'A message can include up to 4 images')
    case 'files': return t('一条消息最多添加 8 个文件', 'A message can include up to 8 files')
    case 'empty': return t('不能添加空文件', 'Empty files cannot be attached')
    case 'imageBytes': return t('每张图片不能超过 4 MiB', 'Each image must be 4 MiB or smaller')
    case 'fileBytes': return t('单个文件不能超过 8 MiB', 'Each file must be 8 MiB or smaller')
    case 'total': return t('一条消息的附件总大小不能超过 8 MiB', 'Attachments in one message cannot exceed 8 MiB total')
  }
}

/**
 * 一次提交尝试的身份：目标会话、精确文本与附件 id 组合。
 * 与之匹配的重试属于同一次逻辑提交，保留服务端用于去重的 requestId。
 */
export function submissionFingerprint(conversationId: string, text: string, images: readonly DraftImage[]): string {
  return `${conversationId}\u0000${text}\u0000${images.map(image => image.id).join('\u0000')}`
}

/** 判断 MIME 类型是否为受支持的图片类型。 */
export function isImageType(mimeType: string): boolean {
  return IMAGE_MIME_TYPES.has(mimeType.toLocaleLowerCase())
}

/** 附件的图片 MIME 类型：浏览器未报告时从文件名扩展名推断。 */
export function imageFileType(file: File): string {
  const declared = file.type.toLocaleLowerCase()
  if (declared !== '') return isImageType(declared) ? declared : ''
  const extension = file.name.toLocaleLowerCase().split('.').pop() ?? ''
  return IMAGE_EXTENSIONS[extension] ?? ''
}

/** 把附件文件读取为 base64 数据（data URL 去掉前缀）；失败以本地化错误拒绝。 */
export function fileData(file: File, t: (chinese: string, english: string) => string): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => { reject(reader.error ?? new Error(t('附件读取失败', 'Could not read attachment'))) }
    reader.onload = () => {
      if (typeof reader.result !== 'string') {
        reject(new Error(t('附件数据不可读取', 'Attachment data is unavailable')))
        return
      }
      const comma = reader.result.indexOf(',')
      resolve(comma < 0 ? reader.result : reader.result.slice(comma + 1))
    }
    reader.readAsDataURL(file)
  })
}
