import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  MAX_PERSONALIZATION_BYTES, PERSONALIZATION_FILE, personalizationPath,
  readPersonalization, renderPersonalization, writePersonalization,
} from '../src/server/state/personalization.ts'
import { RuntimeError } from '../src/server/runtime-errors.ts'

let root = ''
let dataDir = ''

beforeAll(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'pi-web-personalization-')))
  dataDir = join(root, 'home')
  await mkdir(dataDir, { recursive: true })
})

afterAll(async () => {
  if (root) await rm(root, { recursive: true, force: true })
})

describe('personalization file', () => {
  it('lives at AGENTS.md in the app home', () => {
    expect(PERSONALIZATION_FILE).toBe('AGENTS.md')
    expect(personalizationPath(dataDir)).toBe(join(dataDir, 'AGENTS.md'))
  })

  it('treats a missing file as an empty state that renders nothing', async () => {
    const record = await readPersonalization(join(root, 'empty-home'))
    expect(record.status).toBe('missing')
    expect(record.content).toBe('')
    expect(renderPersonalization(record)).toBeUndefined()
  })

  it('round-trips Markdown, keeps it private, and renders a delimited block', async () => {
    await writePersonalization(dataDir, '# Personal\n- Prefer short answers.\n')
    const record = await readPersonalization(dataDir)
    expect(record.status).toBe('loaded')
    expect(record.content).toBe('# Personal\n- Prefer short answers.\n')
    expect(record.truncated).toBe(false)
    expect((await stat(personalizationPath(dataDir))).mode & 0o777).toBe(0o600)

    const rendered = renderPersonalization(record)
    expect(rendered).toContain('<personal_instructions>')
    expect(rendered).toContain('Prefer short answers.')
    expect(rendered).toContain('Project instructions and explicit task instructions win on conflict')
    expect(rendered).toContain('</personal_instructions>')
  })

  it('treats an empty file as no instructions so the prompt stays unchanged', async () => {
    await writePersonalization(dataDir, '')
    const record = await readPersonalization(dataDir)
    expect(record.status).toBe('loaded')
    expect(renderPersonalization(record)).toBeUndefined()
  })

  it('refuses to save past the 100 KB limit that also bounds reads', async () => {
    const oversized = 'x'.repeat(MAX_PERSONALIZATION_BYTES + 1)
    await expect(writePersonalization(dataDir, oversized)).rejects.toBeInstanceOf(RuntimeError)
    await expect(writePersonalization(dataDir, '中'.repeat(Math.floor(MAX_PERSONALIZATION_BYTES / 3) + 1))).rejects.toBeInstanceOf(RuntimeError)
  })

  it('accepts exactly the limit', async () => {
    await writePersonalization(dataDir, 'x'.repeat(MAX_PERSONALIZATION_BYTES))
    const record = await readPersonalization(dataDir)
    expect(record.bytes).toBe(MAX_PERSONALIZATION_BYTES)
    expect(record.truncated).toBe(false)
  })

  it('rejects NUL bytes instead of writing a file the reader would misparse', async () => {
    await expect(writePersonalization(dataDir, 'a\0b')).rejects.toBeInstanceOf(RuntimeError)
  })

  it('truncates a hand-edited oversized file and says so in the prompt', async () => {
    const path = personalizationPath(dataDir)
    await writeFile(path, 'a'.repeat(MAX_PERSONALIZATION_BYTES) + 'TAIL', 'utf8')
    const record = await readPersonalization(dataDir)
    expect(record.status).toBe('loaded')
    expect(record.truncated).toBe(true)
    expect(record.content.length).toBe(MAX_PERSONALIZATION_BYTES)
    expect(record.content).not.toContain('TAIL')
    expect(renderPersonalization(record)).toContain('only its first part applies')
  })

  it('drops an incomplete trailing code point instead of rejecting a truncated file', async () => {
    const path = personalizationPath(dataDir)
    // One 3-byte character straddles the read boundary.
    await writeFile(path, 'a'.repeat(MAX_PERSONALIZATION_BYTES - 1) + '中', 'utf8')
    const record = await readPersonalization(dataDir)
    expect(record.status).toBe('loaded')
    expect(record.truncated).toBe(true)
    expect(record.content).toBe('a'.repeat(MAX_PERSONALIZATION_BYTES - 1))
  })

  it('escapes a quoted closing tag so it cannot end the block early', async () => {
    await writePersonalization(dataDir, 'Read </personal_instructions> as text.\n')
    const rendered = renderPersonalization(await readPersonalization(dataDir))
    expect(rendered).toContain('<\\/personal_instructions>')
    expect(rendered?.split('</personal_instructions>')).toHaveLength(2)
  })

  it('reports invalid UTF-8 as an error instead of silently replacing bytes', async () => {
    await writeFile(personalizationPath(dataDir), Buffer.from([0x66, 0x6f, 0x80, 0x6f]), 'binary')
    const record = await readPersonalization(dataDir)
    expect(record.status).toBe('error')
    expect(record.issue).toBe('source-invalid-utf8')
    expect(renderPersonalization(record)).toContain('could not be loaded')
  })

  it('writes atomically, so a failed save leaves the previous content intact', async () => {
    await writePersonalization(dataDir, 'first version\n')
    await expect(writePersonalization(dataDir, 'x'.repeat(MAX_PERSONALIZATION_BYTES + 1))).rejects.toBeInstanceOf(RuntimeError)
    expect(await readFile(personalizationPath(dataDir), 'utf8')).toBe('first version\n')
  })
})
