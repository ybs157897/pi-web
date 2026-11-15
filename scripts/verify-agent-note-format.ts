/**
 * Agent note 格式门：校验 .agents/notes/<lifecycle>/ 下全部 note 的结构一致性。
 * 每个文件要求：文件名 {yyyy-mm-dd}-{topic-slug}.md、首行「# Agent Note: <标题>」、
 * 前 10 行内有与所在目录一致的 Status 行、具备该生命周期要求的二级标题；
 * implemented 的 Decision 节额外禁 spec-speak（应该/should/计划将开头）。
 * 空骨架目录视为通过；任一文件违规则逐条报错并以非零码退出。
 */
import { readdir, readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const notesRoot = join(dirname(fileURLToPath(import.meta.url)), '../.agents/notes')
// 生命周期即子目录名；每个生命周期要求的最小标题集见 requiredHeadings。
const lifecycles = ['proposed', 'implemented', 'rejected', 'archived'] as const
type Lifecycle = (typeof lifecycles)[number]

// 各生命周期必须出现的二级标题；archived 无要求。
const requiredHeadings: Record<Lifecycle, string[]> = {
  proposed: ['Proposal', 'Acceptance criteria', 'Risks'],
  implemented: ['Decision', 'Consequences'],
  rejected: ['Decision', 'Alternatives considered'],
  archived: [],
}

// 三类格式正则：文件名、Status 行、二级标题；README.md 不参与收集（见收集循环的排除）。
const fileNamePattern = /^\d{4}-\d{2}-\d{2}-[a-z0-9-]+\.md$/
const statusLinePattern = /^Status:\s*(\S+)\s*$/
const headingPattern = /^##\s+(.+?)\s*$/
// implemented 的 Decision 节写现状：spec-speak（应该 / should / 计划将开头的句子）按行首匹配报错。
const specSpeakPatterns = [/^应该/, /^should/i, /^计划将/]

const failures: string[] = []
const noteFiles: { lifecycle: Lifecycle; relative: string }[] = []

// 收集阶段：递归读取每个生命周期目录下的 .md（排除 README.md）；目录不存在视为空。
for (const lifecycle of lifecycles) {
  let entries: string[]
  try {
    entries = await readdir(join(notesRoot, lifecycle), { recursive: true })
  } catch {
    continue // 目录不存在视作该生命周期暂无 note
  }
  for (const raw of entries.sort()) {
    // Windows 的 recursive readdir 返回反斜杠分隔路径，统一成正斜杠再比较。
    const entry = raw.replaceAll('\\', '/')
    if (entry.endsWith('.md') && !entry.endsWith('README.md')) noteFiles.push({ lifecycle, relative: `${lifecycle}/${entry}` })
  }
}

// 校验阶段：逐文件检查文件名、首行、Status 一致性、必需标题与 Decision 节的 spec-speak。
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

  // implemented 专属：Decision 节内逐行检查 spec-speak（节边界 = 下一个二级标题）。
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

// 汇总：任一失败即以非零码退出；否则打印通过统计。
if (failures.length > 0) {
  for (const failure of failures) console.error(`[agent-note-format] ${failure}`)
  process.exitCode = 1
} else {
  console.log(`agent-note-format: ${noteFiles.length} 个 note 通过（空骨架视为通过）`)
}
