import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  MEMORY_GOVERNANCE_FILENAME,
  applySupersedes,
  fileNeedsGovernanceStamp,
  gateWrite,
  injectTextHash,
  memoryTextHash,
  readGovernanceLedger,
  recordDelete,
  recordSupersede,
  replayEdits,
  scanActiveMemoryFiles,
  stampFileWithGovernance,
} from '../src/server/memory/governance.ts'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'pi-web-memory-governance-'))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  return root
}

const FACT = '---\nname: fact\ndescription: a fact\nmetadata:\n  type: project\n---\nThe body.\n'

describe('memoryTextHash', () => {
  it('normalizes whitespace and case and ignores frontmatter', () => {
    const hash = memoryTextHash(FACT)
    expect(hash).toHaveLength(32)
    expect(memoryTextHash(FACT.replace('The body.', 'the   BODY.'))).toBe(hash)
    expect(memoryTextHash(FACT.replace('The body.', 'The\nbody.'))).toBe(hash)
    expect(memoryTextHash(FACT.replace('name: fact', 'name: other'))).toBe(hash)
    expect(memoryTextHash('---\nname: x\n---\nDifferent.\n')).not.toBe(hash)
  })

  it('hashes a body without frontmatter as-is', () => {
    expect(memoryTextHash('The body.\n')).toBe(memoryTextHash(FACT))
  })
})

describe('injectTextHash', () => {
  it('injects, updates, and stays idempotent', () => {
    const hash = memoryTextHash(FACT)
    const injected = injectTextHash(FACT, hash)
    expect(injected).toContain(`textHash: ${hash}`)
    expect(injectTextHash(injected, hash)).toBe(injected)
    expect(injectTextHash(injected, 'f'.repeat(32))).toContain(`textHash: ${'f'.repeat(32)}`)
  })

  it('creates metadata when absent and preserves CRLF', () => {
    const injected = injectTextHash('---\nname: x\n---\nBody\n', 'a'.repeat(32))
    expect(injected).toContain(`metadata:\n  textHash: ${'a'.repeat(32)}`)

    const crlf = '\uFEFF---\r\nname: x\r\n---\r\nBody\r\n'
    const stamped = injectTextHash(crlf, 'b'.repeat(32))
    expect(stamped.startsWith('\uFEFF---\r\n')).toBe(true)
    expect(stamped).toContain('\r\n  textHash: ')
    expect(stamped.endsWith('---\r\nBody\r\n')).toBe(true)
  })

  it('leaves malformed or unrecognized content untouched', () => {
    expect(injectTextHash('Just body.\n', 'a'.repeat(32))).toBe('Just body.\n')
    const yamlError = '---\nname: [unclosed\n---\nBody\n'
    expect(injectTextHash(yamlError, 'a'.repeat(32))).toBe(yamlError)
    const metadataNotMap = '---\nname: x\nmetadata: memory\n---\nBody\n'
    expect(injectTextHash(metadataNotMap, 'a'.repeat(32))).toBe(metadataNotMap)
  })
})

describe('governance ledger', () => {
  it('reads missing and corrupt ledgers as empty (fail-open)', async () => {
    const root = await tempRoot()
    expect(await readGovernanceLedger(root)).toEqual({ tombstones: [], superseded: [] })

    await writeFile(join(root, MEMORY_GOVERNANCE_FILENAME), '{corrupt', 'utf8')
    expect(await readGovernanceLedger(root)).toEqual({ tombstones: [], superseded: [] })

    await writeFile(join(root, MEMORY_GOVERNANCE_FILENAME), JSON.stringify({ tombstones: 'nope', superseded: [42] }), 'utf8')
    expect(await readGovernanceLedger(root)).toEqual({ tombstones: [], superseded: [] })
  })

  it('keeps valid entries and drops malformed ones', async () => {
    const root = await tempRoot()
    const tombstone = { hash: 'a'.repeat(32), file: 'fact.md', disabledBy: 's1', disabledReason: '用户/提取删除', disabledAt: '2026-11-12T00:00:00.000Z' }
    await writeFile(join(root, MEMORY_GOVERNANCE_FILENAME), JSON.stringify({
      tombstones: [tombstone, { hash: 'incomplete' }],
      superseded: [{ file: 'old.md', supersededBy: 'new.md' }, { file: 'bad' }],
    }), 'utf8')
    expect(await readGovernanceLedger(root)).toEqual({ tombstones: [tombstone], superseded: [{ file: 'old.md', supersededBy: 'new.md' }] })
  })

  it('is written atomically as a non-.md sidecar the model cannot reach', async () => {
    const root = await tempRoot()
    const source = join(root, 'fact.md')
    await writeFile(source, FACT, 'utf8')
    await recordDelete(root, source, 's1')
    const raw = await readFile(join(root, MEMORY_GOVERNANCE_FILENAME), 'utf8')
    expect(JSON.parse(raw).tombstones).toHaveLength(1)
    expect(MEMORY_GOVERNANCE_FILENAME.endsWith('.md')).toBe(false)
  })
})

describe('gateWrite', () => {
  it('rejects a tombstoned body with who and why', async () => {
    const root = await tempRoot()
    const source = join(root, 'fact.md')
    await writeFile(source, FACT, 'utf8')
    await recordDelete(root, source, 'session-42', '用户要求遗忘')
    await rm(source)

    const gate = await gateWrite(root, join(root, 'relearned.md'), FACT)
    expect(gate.action).toBe('reject')
    if (gate.action !== 'reject') return
    expect(gate.reason).toContain('session-42')
    expect(gate.reason).toContain('用户要求遗忘')
  })

  it('dedups against an active file with the same textHash but exempts the target itself', async () => {
    const root = await tempRoot()
    const existing = join(root, 'fact.md')
    await writeFile(existing, injectTextHash(FACT, memoryTextHash(FACT)), 'utf8')

    const duplicate = await gateWrite(root, join(root, 'copy.md'), FACT)
    expect(duplicate).toEqual({ action: 'dedup', file: 'fact.md' })

    const self = await gateWrite(root, existing, FACT)
    expect(self.action).toBe('allow')
  })

  it('allows new content with textHash injected and passes MEMORY.md through untouched', async () => {
    const root = await tempRoot()
    const gate = await gateWrite(root, join(root, 'fact.md'), FACT)
    expect(gate.action).toBe('allow')
    if (gate.action !== 'allow') return
    expect(gate.content).toContain(`textHash: ${memoryTextHash(FACT)}`)

    const index = '- [Fact](fact.md) — hook\n'
    expect(await gateWrite(root, join(root, 'MEMORY.md'), index)).toEqual({ action: 'allow', content: index })
  })

  it('does not dedup against superseded or tombstoned files', async () => {
    const root = await tempRoot()
    const old = join(root, 'old.md')
    await writeFile(old, injectTextHash(FACT, memoryTextHash(FACT)), 'utf8')
    await recordSupersede(root, 'old.md', 'new.md')
    expect((await gateWrite(root, join(root, 'fresh.md'), FACT)).action).toBe('allow')
  })
})

describe('recordDelete and recordSupersede', () => {
  it('tombstones once per hash and skips missing files and MEMORY.md', async () => {
    const root = await tempRoot()
    const source = join(root, 'fact.md')
    await writeFile(source, FACT, 'utf8')
    await recordDelete(root, source, 's1')
    await recordDelete(root, source, 's2')
    expect((await readGovernanceLedger(root)).tombstones).toHaveLength(1)

    await recordDelete(root, join(root, 'absent.md'), 's1')
    const index = join(root, 'MEMORY.md')
    await writeFile(index, '- [Fact](fact.md) — hook\n', 'utf8')
    await recordDelete(root, index, 's1')
    expect((await readGovernanceLedger(root)).tombstones).toHaveLength(1)
  })

  it('records and updates a supersede entry, never self-superseding', async () => {
    const root = await tempRoot()
    await recordSupersede(root, 'old.md', 'new.md')
    await recordSupersede(root, 'old.md', 'newer.md')
    await recordSupersede(root, 'same.md', 'same.md')
    expect((await readGovernanceLedger(root)).superseded).toEqual([{ file: 'old.md', supersededBy: 'newer.md' }])
  })

  it('applySupersedes resolves the old name against active files and ignores dangling names', async () => {
    const root = await tempRoot()
    await mkdir(join(root, 'nested'), { recursive: true })
    await writeFile(join(root, 'nested', 'old.md'), FACT, 'utf8')
    const corrected = '---\nname: fact-v2\nmetadata:\n  supersedes: fact\n---\nCorrected.\n'
    await applySupersedes(root, join(root, 'new.md'), corrected)
    expect((await readGovernanceLedger(root)).superseded).toEqual([{ file: 'nested/old.md', supersededBy: 'new.md' }])

    await applySupersedes(root, join(root, 'other.md'), '---\nname: other\nmetadata:\n  supersedes: nowhere\n---\nBody.\n')
    expect((await readGovernanceLedger(root)).superseded).toHaveLength(1)
  })
})

describe('scanActiveMemoryFiles', () => {
  it('excludes superseded files, tombstoned files, and tombstoned hashes', async () => {
    const root = await tempRoot()
    const hash = memoryTextHash(FACT)
    await writeFile(join(root, 'active.md'), injectTextHash(FACT.replace('The body.', 'Active.'), memoryTextHash('Active.')), 'utf8')
    await writeFile(join(root, 'superseded.md'), injectTextHash(FACT, hash), 'utf8')
    await writeFile(join(root, 'resurrected.md'), injectTextHash(FACT, hash), 'utf8')
    await recordSupersede(root, 'superseded.md', 'active.md')
    const ledger = await readGovernanceLedger(root)
    ledger.tombstones.push({ hash, file: 'gone.md', disabledBy: 's1', disabledReason: '用户/提取删除', disabledAt: '2026-11-12T00:00:00.000Z' })

    const active = await scanActiveMemoryFiles(root, ledger)
    expect(active.map(entry => entry.file)).toEqual(['active.md'])
  })
})

describe('replayEdits', () => {
  it('replays unique replacements and refuses ambiguous or missing ones', () => {
    expect(replayEdits('a b c', [{ oldText: 'b', newText: 'x' }])).toBe('a x c')
    expect(replayEdits('a b c', [{ oldText: 'b', newText: 'x' }, { oldText: 'x', newText: 'y' }])).toBe('a y c')
    expect(replayEdits('repeat repeat', [{ oldText: 'repeat', newText: 'x' }])).toBeUndefined()
    expect(replayEdits('a b c', [{ oldText: 'z', newText: 'x' }])).toBeUndefined()
    expect(replayEdits('a b c', [])).toBeUndefined()
    expect(replayEdits('a b c', [{ oldText: '', newText: 'x' }])).toBeUndefined()
    expect(replayEdits('a b c', 'nope')).toBeUndefined()
  })
})

describe('governance post-stamp', () => {
  it('detects missing origin or stale textHash and stamps both in one write-back', async () => {
    const root = await tempRoot()
    const source = join(root, 'fact.md')
    await writeFile(source, FACT, 'utf8')
    expect(await fileNeedsGovernanceStamp(source)).toBe(true)

    const final = await stampFileWithGovernance(source, root, '11')
    expect(final).toContain('originSessionId: "11"')
    expect(final).toContain(`textHash: ${memoryTextHash(FACT)}`)
    expect(await fileNeedsGovernanceStamp(source)).toBe(false)
    expect(await stampFileWithGovernance(source, root, '12')).toBe(final)

    await writeFile(source, final!.replace('The body.', 'Changed body.'), 'utf8')
    expect(await fileNeedsGovernanceStamp(source)).toBe(true)
    const restamped = await stampFileWithGovernance(source, root, '12')
    expect(restamped).toContain(`textHash: ${memoryTextHash('Changed body.')}`)
    expect(restamped).toContain('originSessionId: "11"')
  })

  it('skips MEMORY.md and unreadable files', async () => {
    const root = await tempRoot()
    const index = join(root, 'MEMORY.md')
    await writeFile(index, '- [Fact](fact.md) — hook\n', 'utf8')
    expect(await fileNeedsGovernanceStamp(index)).toBe(false)
    expect(await stampFileWithGovernance(index, root, '11')).toBeUndefined()
    expect(await stampFileWithGovernance(join(root, 'absent.md'), root, '11')).toBeUndefined()
  })
})
