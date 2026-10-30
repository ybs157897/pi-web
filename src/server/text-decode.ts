import iconv from 'iconv-lite'

/**
 * Decode a byte stream as UTF-8 while it is valid, and switch to the platform's legacy
 * encoding once invalid bytes appear. A UTF-8 character split across chunks stays buffered
 * by TextDecoder; Windows console code pages and POSIX non-UTF-8 locales both use this.
 */
export class LegacyAwareDecoder {
  private readonly utf8 = new TextDecoder('utf-8', { fatal: true })
  private readonly legacy: ReturnType<typeof iconv.getDecoder> | null
  private legacyMode = false

  constructor(legacyEncoding: string | null) {
    this.legacy = legacyEncoding === null ? null : iconv.getDecoder(legacyEncoding)
  }

  write(chunk: Buffer): string {
    if (this.legacy === null) return this.utf8.decode(chunk, { stream: true })
    if (this.legacyMode) return this.legacy.write(chunk)
    try {
      return this.utf8.decode(chunk, { stream: true })
    } catch {
      this.legacyMode = true
      return this.legacy.write(chunk)
    }
  }

  end(): string {
    if (this.legacy === null) {
      try {
        return this.utf8.decode()
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
