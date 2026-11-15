import iconv from 'iconv-lite'

/**
 * 功能：兼容旧编码的字节流解码器。数据有效时按 UTF-8 解码，一旦出现非法字节就切换到
 * 平台遗留编码（如 Windows 代码页、POSIX 非 UTF-8 locale）继续解码。
 * 内部逻辑：跨 chunk 拆开的 UTF-8 字符由 TextDecoder 的流式模式自行缓冲；
 * 无遗留编码可用时退化为宽松 UTF-8（非法字节替换），保证流式处理不中断。
 */
export class LegacyAwareDecoder {
  private readonly utf8 = new TextDecoder('utf-8', { fatal: true })
  private readonly lenient = new TextDecoder('utf-8')
  private readonly legacy: ReturnType<typeof iconv.getDecoder> | null
  private legacyMode = false
  private lenientMode = false

  /**
   * 功能：创建解码器。
   * @param legacyEncoding 平台遗留编码名（iconv-lite 支持的名称）；传 null 表示不启用旧编码回退。
   */
  constructor(legacyEncoding: string | null) {
    this.legacy = legacyEncoding === null ? null : iconv.getDecoder(legacyEncoding)
  }

  /**
   * 功能：写入一个字节块，返回解码后的文本。
   * 内部逻辑：无遗留编码时先尝试严格 UTF-8，首次失败后永久切到宽松模式（非法字节替换，
   * 避免异常冲出流处理导致整轮运行失败）；有遗留编码时在 UTF-8 解码失败的那一刻切换，
   * 之后所有块都按遗留编码解码。
   * @param chunk 待解码的原始字节块。
   * @returns 该块解码出的文本（流式解码，可能含跨块字符的暂缓部分）。
   */
  write(chunk: Buffer): string {
    if (this.legacy === null) {
      if (!this.lenientMode) {
        try {
          return this.utf8.decode(chunk, { stream: true })
        } catch {
          // 无遗留编码可回退的非法字节（二进制输出、损坏字节）：改用替换模式，
          // 而不是从流处理函数抛异常并中断整轮运行。
          this.lenientMode = true
        }
      }
      return this.lenient.decode(chunk, { stream: true })
    }
    if (this.legacyMode) return this.legacy.write(chunk)
    try {
      return this.utf8.decode(chunk, { stream: true })
    } catch {
      this.legacyMode = true
      return this.legacy.write(chunk)
    }
  }

  /**
   * 功能：结束流式解码，冲刷并返回 TextDecoder/遗留解码器内部残留的缓冲字节。
   * @returns 残留字节解码出的文本；解码失败时返回空字符串。
   */
  end(): string {
    if (this.legacy === null) {
      try {
        return this.lenientMode ? this.lenient.decode() : this.utf8.decode()
      } catch {
        return ''
      }
    }
    if (this.legacyMode) return this.legacy.end() ?? ''
    try {
      return this.utf8.decode()
    } catch {
      return ''
    }
  }
}
