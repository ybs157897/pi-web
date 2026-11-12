/**
 * Knowledge-core: the bot-independent backend for module knowledge-document maintenance.
 *
 * Everything here is a pure-ish function over (repo, globs, docPath) with no dependency on the
 * bot roster, the harness or conversations. The bot watchdog and the doc-keeper A2A agent are
 * both consumers. The doc protocol (frontmatter / hash / atomic write) is reused from bots/docs.ts
 * so there is a single source of truth for the on-disk format.
 */
import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { isAbsolute, resolve } from 'node:path'
import { promisify } from 'node:util'
import type { BotKnowledgeHealth } from '../../shared/types.ts'
import {
  KNOWLEDGE_BODY_CHAR_LIMIT, hasFrontmatterBlock, knowledgeAbsolutePath, parseFrontmatter,
  readKnowledgeFile, stripFrontmatter,
} from '../bots/docs.ts'

const execFileAsync = promisify(execFile)

/** Upper bounds so a maintenance pass can never read or emit an unbounded amount of code. */
export const KNOWLEDGE_MAX_DIFF_BYTES = 64 * 1024
export const KNOWLEDGE_MAX_FILE_BYTES = 64 * 1024
export const KNOWLEDGE_MAX_TOTAL_READ_BYTES = 256 * 1024
export const KNOWLEDGE_MAX_FILES = 24

export type KnowledgeHealth = BotKnowledgeHealth

export type ChangeReport = {
  /** Number of commits touching the globs since the stamp; 0 when up to date. */
  count: number
  /** One-line commit summaries, newest first (bounded). */
  commits: string[]
  /** Files changed across those commits (bounded, deduplicated). */
  changedFiles: string[]
  /** False when the workspace is not a git repo or git is unavailable. */
  gitAvailable: boolean
}

export type DocInspection = {
  health: KnowledgeHealth
  detail: string
  suggestion?: string
  frontmatter?: { botId: string; module: string; globs: string[]; updatedStamp?: string }
  body?: string
}

export type KnowledgeTarget = {
  /** Workspace-relative knowledge document path, e.g. docs/bots/Atlas.md. */
  knowledgePath: string
  globs: readonly string[]
}

function pathspecs(globs: readonly string[]): string[] {
  // `:(glob)` magic is what makes a `src/**` pattern an actual git pathspec.
  return globs.map(glob => `:(glob)${glob}`)
}

/** Detect commits and changed files touching the globs since an ISO stamp. Read-only. */
export async function detectChanges(repoPath: string, globs: readonly string[], since?: string): Promise<ChangeReport> {
  const empty: ChangeReport = { count: 0, commits: [], changedFiles: [], gitAvailable: false }
  if (globs.length === 0) return { ...empty, gitAvailable: true }
  const specs = pathspecs(globs)
  try {
    const logArgs = ['-C', repoPath, 'log', '--oneline', '-n', '50', '--', ...specs]
    if (since !== undefined && since !== '') logArgs.splice(3, 0, `--since=${since}`)
    const { stdout } = await execFileAsync('git', logArgs, { timeout: 10_000, maxBuffer: 1 << 20 })
    const commits = stdout.split('\n').map(line => line.trim()).filter(line => line !== '')
    let changedFiles: string[] = []
    if (commits.length > 0) {
      // `git log --since` accepts an ISO date (a bare date is not a valid diff revision), so the
      // changed-file list comes from the same commit window rather than a `<date>..HEAD` diff.
      const nameArgs = ['-C', repoPath, 'log', '--name-only', '--pretty=format:', '-n', '50', '--', ...specs]
      if (since !== undefined && since !== '') nameArgs.splice(3, 0, `--since=${since}`)
      try {
        const { stdout: names } = await execFileAsync('git', nameArgs, { timeout: 10_000, maxBuffer: 1 << 20 })
        changedFiles = [...new Set(names.split('\n').map(line => line.trim()).filter(line => line !== ''))].slice(0, KNOWLEDGE_MAX_FILES)
      } catch {
        // A bad stamp still yields the commit list; files stay empty.
      }
    }
    return { count: commits.length, commits: commits.slice(0, 50), changedFiles, gitAvailable: true }
  } catch {
    return empty
  }
}

/** The scoped patch of commits since a stamp, bounded. Read-only. */
export async function gitDiff(repoPath: string, globs: readonly string[], since?: string): Promise<string> {
  if (globs.length === 0) return ''
  try {
    // Patches of the commit window (date-compatible), not a `<date>..HEAD` diff revision.
    const args = ['-C', repoPath, 'log', '-p', '-n', '20', '--', ...pathspecs(globs)]
    if (since !== undefined && since !== '') args.splice(3, 0, `--since=${since}`)
    const { stdout } = await execFileAsync('git', args, { timeout: 10_000, maxBuffer: KNOWLEDGE_MAX_DIFF_BYTES * 2 })
    return stdout.length > KNOWLEDGE_MAX_DIFF_BYTES
      ? `${stdout.slice(0, KNOWLEDGE_MAX_DIFF_BYTES)}\n…（diff 超过 ${KNOWLEDGE_MAX_DIFF_BYTES} 字节，已截断）`
      : stdout
  } catch {
    return ''
  }
}

/** Bounded read of specific code files inside the repo; paths are confined to the repo root. */
export async function readCodeFiles(repoPath: string, paths: readonly string[]): Promise<Array<{ path: string; content?: string; error?: string }>> {
  const root = resolve(repoPath)
  const results: Array<{ path: string; content?: string; error?: string }> = []
  let total = 0
  for (const rel of paths.slice(0, KNOWLEDGE_MAX_FILES)) {
    const absolute = isAbsolute(rel) ? resolve(rel) : resolve(root, rel)
    if (absolute !== root && !absolute.startsWith(`${root}/`)) {
      results.push({ path: rel, error: '路径越出仓库根目录，已拒绝' })
      continue
    }
    if (total >= KNOWLEDGE_MAX_TOTAL_READ_BYTES) {
      results.push({ path: rel, error: '累计读取已达上限，跳过' })
      continue
    }
    try {
      const content = await readFile(absolute, 'utf8')
      const bounded = content.length > KNOWLEDGE_MAX_FILE_BYTES ? `${content.slice(0, KNOWLEDGE_MAX_FILE_BYTES)}\n…（文件已截断）` : content
      total += bounded.length
      results.push({ path: rel, content: bounded })
    } catch (error) {
      results.push({ path: rel, error: error instanceof Error ? error.message : String(error) })
    }
  }
  return results
}

/**
 * Inspect one knowledge document: structure, size and git freshness. Generalized from the bot
 * watchdog's checkBot so it needs only a target + repo, not a BotRecord.
 */
export async function inspectDoc(repoPath: string, target: KnowledgeTarget): Promise<DocInspection> {
  const absolute = knowledgeAbsolutePath(repoPath, target)
  const content = await readKnowledgeFile(absolute)
  if (content === undefined) {
    return { health: 'unknown', detail: `知识文档缺失：${target.knowledgePath}`, suggestion: '初始化该模块知识文档骨架' }
  }
  if (!hasFrontmatterBlock(content)) {
    return { health: 'unknown', detail: '文档缺少 frontmatter（botId/module/globs/updatedStamp）', suggestion: '按骨架格式补回 frontmatter', body: stripFrontmatter(content) }
  }
  const frontmatter = parseFrontmatter(content)
  if (frontmatter === undefined) {
    return { health: 'drift', detail: 'frontmatter 结构损坏：缺少 botId/module 必需字段', suggestion: '按骨架格式修复 frontmatter', body: stripFrontmatter(content) }
  }
  const body = stripFrontmatter(content)
  if (body.length > KNOWLEDGE_BODY_CHAR_LIMIT) {
    return { health: 'over-limit', detail: `正文超过 ${KNOWLEDGE_BODY_CHAR_LIMIT} 字符（当前 ${body.length}）`, suggestion: '把细节拆到代码注释或其他文档，正文只保留结论与索引', frontmatter, body }
  }
  if (frontmatter.updatedStamp === undefined) {
    return { health: 'fresh', detail: '缺少 updatedStamp，跳过 git 新鲜度检查；结构检查通过', suggestion: '在 frontmatter 补上 updatedStamp 以启用 git 检查', frontmatter, body }
  }
  const changes = await detectChanges(repoPath, target.globs, frontmatter.updatedStamp)
  if (!changes.gitAvailable) {
    return { health: 'fresh', detail: '工作区不是 git 仓库或 git 不可用；结构检查通过', frontmatter, body }
  }
  if (changes.count >= 1) {
    return {
      health: 'stale',
      detail: `自 ${frontmatter.updatedStamp} 以来关注路径有 ${changes.count} 条新提交；最近一条：${changes.commits[0] ?? ''}`,
      suggestion: '用 git log/diff 增量刷新本文档',
      frontmatter, body,
    }
  }
  return { health: 'fresh', detail: `自 ${frontmatter.updatedStamp} 以来关注路径无新提交`, frontmatter, body }
}

export { knowledgeAbsolutePath, readKnowledgeFile, writeKnowledgeFile, knowledgeHash, KNOWLEDGE_BODY_CHAR_LIMIT } from '../bots/docs.ts'