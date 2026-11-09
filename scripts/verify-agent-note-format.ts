import { readdir, readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const notesRoot = join(dirname(fileURLToPath(import.meta.url)), '../.agents/notes')
const lifecycles = ['proposed', 'implemented', 'rejected', 'archived'] as const
type Lifecycle = (typeof lifecycles)[number]

const requiredHeadings: Record<Lifecycle, string[]> = {
  proposed: ['Proposal', 'Acceptance criteria', 'Risks'],
  implemented: ['Decision', 'Consequences'],
  rejected: ['Decision', 'Alternatives considered'],
  archived: [],
}

const fileNamePattern = /^\d{4}-\d{2}-\d{2}-[a-z0-9-]+\.md$/
const statusLinePattern = /^Status:\s*(\S+)\s*$/
const headingPattern = /^##\s+(.+?)\s*$/
// implemented 的 Decision 节写现状：spec-speak（应该 / should / 计划将开头的句子）按行首匹配报错。
const specSpeakPatterns = [/^应该/, /^should/i, /^计划将/]

const failures: string[] = []
const noteFiles: { lifecycle: Lifecycle; relative: string }[] = []

for (const lifecycle of lifecycles) {
  let entries: string[]
  try {
    entries = await readdir(join(notesRoot, lifecycle), { recursive: true })
  } catch {
    continue // 目录不存在视作该生命周期暂无 note
  }
  for (const entry of entries.sort()) {
    if (entry.endsWith('.md') && !entry.endsWith('README.md')) noteFiles.push({ lifecycle, relative: `${lifecycle}/${entry}` })
  }
}

for (const { lifecycle, relative } of noteFiles) {
  const name = relative.split('/').pop()!
  if (!fileNamePattern.test(name)) failures.push(`${relative}: 命名不符 {yyyy-mm-dd}-{topic-slug}.md`)

  const lines = (await readFile(join(notesRoot, relative), 'utf8')).split('\n')

  if (!/^# Agent Note: \S/.test(lines[0] ?? '')) failures.push(`${relative}: 第一行必须是「# Agent Note: <标题>」`)

  const statusLine = lines.slice(0, 10).find(line => statusLinePattern.test(line))
  if (statusLine === undefined) failures.push(`${relative}: 顶部缺少「Status: ${lifecycle}」行`)
  else if (statusLinePattern.exec(statusLine)![1] !== lifecycle) {
    failures.push(`${relative}: Status「${statusLinePattern.exec(statusLine)![1]}」与所在目录 ${lifecycle} 不一致`)
  }

  const headings = lines.map(line => headingPattern.exec(line)?.[1]).filter((text): text is string => text !== undefined)
  for (const required of requiredHeadings[lifecycle]) {
    if (!headings.includes(required)) failures.push(`${relative}: 缺少「## ${required}」标题`)
  }

  if (lifecycle === 'implemented') {
    const start = lines.findIndex(line => headingPattern.exec(line)?.[1] === 'Decision')
    if (start !== -1) {
      const end = lines.slice(start + 1).findIndex(line => /^##\s/.test(line))
      const body = end === -1 ? lines.slice(start + 1) : lines.slice(start + 1, start + 1 + end)
      for (const line of body) {
        if (specSpeakPatterns.some(pattern => pattern.test(line))) {
          failures.push(`${relative}: Decision 节含 spec-speak（应该/should/计划将开头），已实施决策用现在时描述现状：${line.trim()}`)
        }
      }
    }
  }
}

if (failures.length > 0) {
  for (const failure of failures) console.error(`[agent-note-format] ${failure}`)
  process.exitCode = 1
} else {
  console.log(`agent-note-format: ${noteFiles.length} 个 note 通过（空骨架视为通过）`)
}
