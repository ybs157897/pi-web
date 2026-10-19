import { Buffer } from 'node:buffer'

/**
 * DSH's shipped title policy, mirrored 1:1 so pi-web titles read the same:
 * `fallbackMaxWords`/`fallbackMaxBytes`/`maxTitleBytes` come from the
 * session-title service limits, the generation knobs from the first-prompt
 * LLM provider config.
 */
export const TITLE_POLICY = {
  fallbackMaxWords: 8,
  fallbackMaxBytes: 96,
  maxTitleBytes: 120,
  targetWords: 5,
  targetCjkCharacters: 10,
  maxInputBytes: 4096,
  /**
   * DSH caps this at 32 because its adapter disables thinking for the title call.
   * pi-ai exposes no purpose marker, and models that declare `off: null` cannot
   * turn thinking off, so the budget covers the reasoning preamble too.
   */
  titleMaxOutputTokens: 1_024,
  timeoutMs: 15_000,
} as const

/** Operating-system-command escape sequences, including unterminated tails. */
const OSC_SEQUENCE = /(?:\u001B\]|\u009D)(?:(?!\u0007|\u001B\\)[\s\S])*(?:\u0007|\u001B\\|$)/gu
/** Control-sequence-introducer escapes such as SGR color codes. */
const CSI_SEQUENCE = /(?:\u001B\[|\u009B)[0-?]*[ -/]*[@-~]/gu
/** Remaining two-byte ESC control sequences. */
const ESC_SEQUENCE = /\u001B[@-_]/gu
/** Non-whitespace C0/C1 control characters. */
const CONTROL_CHARACTER = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/gu
/** Directional and invisible controls that can make a displayed title deceptive. */
const DIRECTIONAL_CONTROL = /[\u200B\u200E\u200F\u202A-\u202E\u2060-\u2064\u2066-\u206F\uFEFF]/gu

/** Remove controls and produce one trimmed, whitespace-normalized line. */
export function cleanTitleText(input: string): string {
  return input
    .replace(OSC_SEQUENCE, '')
    .replace(CSI_SEQUENCE, '')
    .replace(ESC_SEQUENCE, '')
    .replace(CONTROL_CHARACTER, '')
    .replace(DIRECTIONAL_CONTROL, '')
    .replace(/\s+/gu, ' ')
    .trim()
}

/** Truncate to a UTF-8 byte budget without splitting a Unicode code point. */
export function truncateTitleUtf8(input: string, maxBytes: number): string {
  if (Buffer.byteLength(input, 'utf8') <= maxBytes) return input
  let used = 0
  let output = ''
  for (const character of input) {
    const bytes = Buffer.byteLength(character, 'utf8')
    if (used + bytes > maxBytes) break
    output += character
    used += bytes
  }
  return output
}

/** Normalize one accepted title: one terminal-safe line inside the byte budget. */
export function normalizeSessionTitle(input: string, maxBytes: number = TITLE_POLICY.maxTitleBytes): string {
  return truncateTitleUtf8(cleanTitleText(input), maxBytes).trimEnd()
}

/**
 * Deterministic fallback title: the first eligible human message's leading words
 * inside the word and byte caps, used before (or instead of) a generated title.
 */
export function fallbackSessionTitle(
  text: string,
  maxWords: number = TITLE_POLICY.fallbackMaxWords,
  maxBytes: number = TITLE_POLICY.fallbackMaxBytes,
): string {
  const cleaned = cleanTitleText(text)
  if (cleaned === '') return ''
  const words = cleaned.split(' ')
  return truncateTitleUtf8(words.slice(0, maxWords).join(' '), maxBytes).trimEnd()
}

/** Stable language-aware system instruction shared with DSH's title provider. */
export function titleSystemPrompt(policy: typeof TITLE_POLICY = TITLE_POLICY): string {
  return [
    'Create a concise title for an AI coding-assistant session from the supplied human messages.',
    'Return only the title on one line, **in plain text of natural language**, with no quotes, prefix, explanation, Markdown, XML, or terminal control codes. No code is allowed.',
    'Use the language of the messages.',
    `Aim for about ${policy.targetWords} words in non-CJK languages or ${policy.targetCjkCharacters} CJK characters.`,
  ].join('\n')
}

/** Frame exact messages as JSON so user text cannot break structural delimiters. */
export function frameTitleMessages(messages: readonly { seq: number; text: string }[]): string {
  return `Generate the session title from this JSON array of human messages:\n${JSON.stringify(messages)}`
}
