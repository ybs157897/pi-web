// knowledge-core 纯函数单测：临时 git 仓 fixture，覆盖变更检测、补丁、有界读取与文档体检。
// 提交用 GIT_AUTHOR_DATE/GIT_COMMITTER_DATE 钉死日期，让 `git log --since` 窗口可确定断言。
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import {
  KNOWLEDGE_BODY_CHAR_LIMIT, KNOWLEDGE_MAX_DIFF_BYTES, KNOWLEDGE_MAX_FILE_BYTES, KNOWLEDGE_MAX_FILES,
  detectChanges, gitDiff, inspectDoc, knowledgeHash, readCodeFiles, writeKnowledgeFile,
} from '../src/server/knowledge/core.ts'

const execFileAsync = promisify(execFile)

const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

/** root/repo 是 git 仓，root/outside.txt 在仓外，用于路径越界断言。 */
async function fixture(): Promise<{ root: string; repo: string }> {
  const root = await mkdtemp(join(tmpdir(), 'pi-knowledge-core-'))
  roots.push(root)
  const repo = join(root, 'repo')
  await mkdir(repo, { recursive: true })
  await writeFile(join(root, 'outside.txt'), 'outside secret\n')
  return { root, repo }
}

function git(repo: string, args: string[], env?: Record<string, string>) {
  return execFileAsync('git', ['-C', repo, ...args], env === undefined ? {} : { env: { ...process.env, ...env } })
}

async function initRepo(repo: string): Promise<void> {
  await git(repo, ['init'])
  await git(repo, ['config', 'user.email', 'knowledge@test.local'])
  await git(repo, ['config', 'user.name', 'Knowledge Test'])
}

async function commit(repo: string, message: string, date?: string): Promise<void> {
  await git(repo, ['add', '.'])
  const stamp: Record<string, string> = date === undefined ? {} : { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date }
  await git(repo, ['commit', '-m', message], stamp)
}

async function write(repo: string, rel: string, content: string): Promise<void> {
  await mkdir(join(repo, rel, '..'), { recursive: true })
  await writeFile(join(repo, rel), content)
}

function docContent(fields: { botId?: string; module?: string; globs?: string; updatedStamp?: string }, body: string): string {
  return [
    '---',
    ...(fields.botId === undefined ? [] : [`botId: ${fields.botId}`]),
    ...(fields.module === undefined ? [] : [`module: ${fields.module}`]),
    `globs: ${fields.globs ?? '["src/**"]'}`,
    ...(fields.updatedStamp === undefined ? [] : [`updatedStamp: ${fields.updatedStamp}`]),
    '---',
    '',
  ].join('\n') + body
}

describe('detectChanges', () => {
  it('空 globs 直接返回零变更（git 视为可用）', async () => {
    const { repo } = await fixture()
    const report = await detectChanges(repo, [])
    expect(report).toEqual({ count: 0, commits: [], changedFiles: [], gitAvailable: true })
  })

  it('非 git 目录报告 gitAvailable=false', async () => {
    const { repo } = await fixture()
    const report = await detectChanges(repo, ['src/**'])
    expect(report.gitAvailable).toBe(false)
    expect(report.count).toBe(0)
  })

  it('统计关注路径的提交与变更文件（去重）', async () => {
    const { repo } = await fixture()
    await initRepo(repo)
    await write(repo, 'src/a.ts', 'export const a = 1\n')
    await write(repo, 'other/c.ts', 'export const c = 1\n')
    await commit(repo, 'init')
    await write(repo, 'src/a.ts', 'export const a = 2\n')
    await commit(repo, 'touch a again')
    const report = await detectChanges(repo, ['src/**'])
    expect(report.gitAvailable).toBe(true)
    expect(report.count).toBe(2)
    expect(report.commits[0]).toContain('touch a again')
    expect(report.changedFiles).toEqual(['src/a.ts'])
  })

  it('globs 只圈定关注路径：其他目录的提交不计入', async () => {
    const { repo } = await fixture()
    await initRepo(repo)
    await write(repo, 'src/a.ts', 'export const a = 1\n')
    await commit(repo, 'src change')
    await write(repo, 'other/c.ts', 'export const c = 1\n')
    await commit(repo, 'other change')
    const report = await detectChanges(repo, ['src/**'])
    expect(report.count).toBe(1)
    expect(report.commits[0]).toContain('src change')
    expect(report.changedFiles).toEqual(['src/a.ts'])
  })

  it('since 窗口按提交日期过滤（ISO 日期兼容）', async () => {
    const { repo } = await fixture()
    await initRepo(repo)
    await write(repo, 'src/a.ts', 'v1\n')
    await commit(repo, 'january', '2026-01-01T00:00:00+00:00')
    await write(repo, 'src/a.ts', 'v2\n')
    await commit(repo, 'february', '2026-02-01T00:00:00+00:00')
    const mid = await detectChanges(repo, ['src/**'], '2026-01-15T00:00:00.000Z')
    expect(mid.count).toBe(1)
    expect(mid.commits[0]).toContain('february')
    // 注意：git approxidate 不解析 ≥2100 的年份（--since 会被静默忽略），未来 stamp 用 2027。
    const future = await detectChanges(repo, ['src/**'], '2027-01-01T00:00:00.000Z')
    expect(future.count).toBe(0)
    expect(future.changedFiles).toEqual([])
    const all = await detectChanges(repo, ['src/**'], '')
    expect(all.count).toBe(2)
  })
})

describe('gitDiff', () => {
  it('空 globs 与非 git 目录返回空串', async () => {
    const { repo } = await fixture()
    expect(await gitDiff(repo, [])).toBe('')
    expect(await gitDiff(repo, ['src/**'])).toBe('')
  })

  it('返回关注路径的补丁并尊重 since 窗口', async () => {
    const { repo } = await fixture()
    await initRepo(repo)
    await write(repo, 'src/a.ts', 'v1\n')
    await commit(repo, 'january', '2026-01-01T00:00:00+00:00')
    await write(repo, 'src/a.ts', 'v2\n')
    await commit(repo, 'february', '2026-02-01T00:00:00+00:00')
    const full = await gitDiff(repo, ['src/**'])
    expect(full).toContain('diff --git')
    expect(full).toContain('+v2')
    const window = await gitDiff(repo, ['src/**'], '2026-01-15T00:00:00.000Z')
    expect(window).toContain('february')
    expect(window).not.toContain('january')
  })

  it('超过字节上限的补丁被截断并标注', async () => {
    const { repo } = await fixture()
    await initRepo(repo)
    await write(repo, 'src/big.ts', `${'x'.repeat(KNOWLEDGE_MAX_DIFF_BYTES + 4096)}\n`)
    await commit(repo, 'big file')
    const diff = await gitDiff(repo, ['src/**'])
    expect(diff.length).toBeLessThanOrEqual(KNOWLEDGE_MAX_DIFF_BYTES + 128)
    expect(diff).toContain('已截断')
  })
})

describe('readCodeFiles', () => {
  it('读取仓内文件；缺失文件返回错误条目', async () => {
    const { repo } = await fixture()
    await write(repo, 'src/a.ts', 'export const a = 1\n')
    const files = await readCodeFiles(repo, ['src/a.ts', 'src/missing.ts'])
    expect(files[0]).toEqual({ path: 'src/a.ts', content: 'export const a = 1\n' })
    expect(files[1]?.path).toBe('src/missing.ts')
    expect(files[1]?.error).toBeTruthy()
    expect(files[1]?.content).toBeUndefined()
  })

  it('拒绝相对与绝对路径越出仓库根', async () => {
    const { root, repo } = await fixture()
    const files = await readCodeFiles(repo, ['../outside.txt', join(root, 'outside.txt')])
    for (const file of files) {
      expect(file.error).toBe('路径越出仓库根目录，已拒绝')
      expect(file.content).toBeUndefined()
    }
  })

  it('允许指向仓内的绝对路径', async () => {
    const { repo } = await fixture()
    await write(repo, 'src/a.ts', 'absolute ok\n')
    const files = await readCodeFiles(repo, [join(repo, 'src/a.ts')])
    expect(files[0]?.content).toBe('absolute ok\n')
  })

  it('单文件超过字节上限被截断', async () => {
    const { repo } = await fixture()
    await write(repo, 'src/big.ts', 'y'.repeat(KNOWLEDGE_MAX_FILE_BYTES + 1024))
    const files = await readCodeFiles(repo, ['src/big.ts'])
    expect(files[0]?.content).toContain('文件已截断')
    expect(files[0]?.content?.length).toBeLessThanOrEqual(KNOWLEDGE_MAX_FILE_BYTES + 64)
  })

  it('累计读取达到上限后跳过后续文件', async () => {
    const { repo } = await fixture()
    const paths: string[] = []
    for (let index = 0; index < 6; index += 1) {
      const rel = `src/f${index}.ts`
      // 每个 60KB（低于单文件上限）：前 5 个共 300KB 超过 256KB 累计上限，第 6 个被跳过。
      await write(repo, rel, 'z'.repeat(60 * 1024))
      paths.push(rel)
    }
    const files = await readCodeFiles(repo, paths)
    expect(files).toHaveLength(6)
    expect(files[5]?.error).toBe('累计读取已达上限，跳过')
    expect(files.slice(0, 5).every(file => file.content !== undefined)).toBe(true)
  })

  it('文件数超过上限只处理前 KNOWLEDGE_MAX_FILES 个', async () => {
    const { repo } = await fixture()
    const paths = Array.from({ length: KNOWLEDGE_MAX_FILES + 3 }, (_, index) => `src/f${index}.ts`)
    const files = await readCodeFiles(repo, paths)
    expect(files).toHaveLength(KNOWLEDGE_MAX_FILES)
  })
})

describe('inspectDoc', () => {
  const target = { knowledgePath: 'docs/bots/atlas.md', globs: ['src/**'] }

  it('文档缺失 → unknown 并建议初始化', async () => {
    const { repo } = await fixture()
    const inspection = await inspectDoc(repo, target)
    expect(inspection.health).toBe('unknown')
    expect(inspection.detail).toContain('缺失')
    expect(inspection.suggestion).toBeTruthy()
  })

  it('缺少 frontmatter → unknown', async () => {
    const { repo } = await fixture()
    await write(repo, target.knowledgePath, '# 没有 frontmatter\n')
    const inspection = await inspectDoc(repo, target)
    expect(inspection.health).toBe('unknown')
    expect(inspection.detail).toContain('frontmatter')
  })

  it('frontmatter 缺必需字段 → drift', async () => {
    const { repo } = await fixture()
    await write(repo, target.knowledgePath, docContent({ module: 'server' }, '正文\n'))
    const inspection = await inspectDoc(repo, target)
    expect(inspection.health).toBe('drift')
  })

  it('正文超过字符上限 → over-limit', async () => {
    const { repo } = await fixture()
    await write(repo, target.knowledgePath, docContent(
      { botId: 'atlas', module: 'server', updatedStamp: '2027-01-01T00:00:00.000Z' },
      'x'.repeat(KNOWLEDGE_BODY_CHAR_LIMIT + 1),
    ))
    const inspection = await inspectDoc(repo, target)
    expect(inspection.health).toBe('over-limit')
    expect(inspection.detail).toContain(String(KNOWLEDGE_BODY_CHAR_LIMIT))
  })

  it('缺少 updatedStamp → fresh 且提示补 stamp', async () => {
    const { repo } = await fixture()
    await initRepo(repo)
    await write(repo, 'src/a.ts', 'v1\n')
    await commit(repo, 'init')
    await write(repo, target.knowledgePath, docContent({ botId: 'atlas', module: 'server' }, '正文\n'))
    const inspection = await inspectDoc(repo, target)
    expect(inspection.health).toBe('fresh')
    expect(inspection.suggestion).toContain('updatedStamp')
  })

  it('stamp 之后无提交 → fresh；有提交 → stale 并给出提交数', async () => {
    const { repo } = await fixture()
    await initRepo(repo)
    await write(repo, 'src/a.ts', 'v1\n')
    await commit(repo, 'init', '2026-01-01T00:00:00+00:00')
    await write(repo, target.knowledgePath, docContent(
      { botId: 'atlas', module: 'server', updatedStamp: '2026-06-01T00:00:00.000Z' },
      '正文\n',
    ))
    const fresh = await inspectDoc(repo, target)
    expect(fresh.health).toBe('fresh')
    expect(fresh.frontmatter).toEqual({ botId: 'atlas', module: 'server', globs: ['src/**'], updatedStamp: '2026-06-01T00:00:00.000Z' })
    expect(fresh.body).toBe('正文\n')

    await write(repo, 'src/a.ts', 'v2\n')
    await commit(repo, 'later change', '2026-07-01T00:00:00+00:00')
    const stale = await inspectDoc(repo, target)
    expect(stale.health).toBe('stale')
    expect(stale.detail).toContain('1 条新提交')
    expect(stale.detail).toContain('later change')
  })

  it('非 git 工作区：结构检查通过即 fresh', async () => {
    const { repo } = await fixture()
    await write(repo, target.knowledgePath, docContent(
      { botId: 'atlas', module: 'server', updatedStamp: '2026-01-01T00:00:00.000Z' },
      '正文\n',
    ))
    const inspection = await inspectDoc(repo, target)
    expect(inspection.health).toBe('fresh')
    expect(inspection.detail).toContain('git')
  })

  it('writeKnowledgeFile 写回后立即体检为 fresh（协议闭环）', async () => {
    const { repo } = await fixture()
    await initRepo(repo)
    await write(repo, 'src/a.ts', 'v1\n')
    // init 钉在过去：git --since 按秒含同秒提交，stamp=now 时同秒提交会被误判 stale。
    await commit(repo, 'init', '2026-01-01T00:00:00+00:00')
    const absolute = join(repo, target.knowledgePath)
    const stamp = new Date().toISOString()
    const hash = await writeKnowledgeFile(absolute, { id: 'atlas', name: 'atlas', module: 'server', globs: ['src/**'] }, '## 职责\n\n正文\n', stamp)
    expect(hash).toBe(knowledgeHash(await readFile(absolute, 'utf8')))
    const inspection = await inspectDoc(repo, target)
    expect(inspection.health).toBe('fresh')
    expect(inspection.frontmatter?.updatedStamp).toBe(stamp)
  })
})
