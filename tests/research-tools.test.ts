/**
 * 调研工具（ResearchTools：list_files/search_files/glob/grep）与原生 ripgrep 集成测试。
 *
 * 关键契约：
 * - 工具集固定为四个只读工具；
 * - list_files：相对路径输出、跳过隐藏/生成目录（node_modules/.git/.data）与凭据类文件
 *   （credentials/.env/.private）、超限标记 TRUNCATED；
 * - search_files：字面搜索、1 起始行号与摘录、跳过超大/二进制文件并统计 skipped 数、
 *   二进制字节计入读取预算、skipped 截断与结果截断并存时都如实报告；
 * - glob：跨深度匹配、含隐藏路径（.cursor/.private 但不含凭据）、按修改时间新→旧排序；
 * - grep：正则匹配、include glob 过滤、大小写开关、非法正则 INVALID_INPUT、结果截断标记；
 * - 路径安全：绝对路径/父路径拒绝、符号链接不跟随（FORBIDDEN）；
 * - 尊重 abort 信号；ripgrep 可用时原生路径返回相对路径 + 1 起始行、跳过生成树与凭据、
 *   支持 rg 专属语法；JS 专属 lookahead 与 rg 不可用时回退 JS walker。
 */
import { mkdir, mkdtemp, rm, symlink, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@earendil-works/chord/context'
import { NOOP_TELEMETRY_CONTEXT } from '@earendil-works/pi-telemetry'
import type { ToolExecutionApi } from '@earendil-works/pi-durable'
import { afterEach, describe, expect, it } from 'vitest'
import {
  resetRipgrepResolverForTests,
  resolveRipgrep,
  searchWithRipgrep,
  setRipgrepForTests,
} from '../src/server/tools/search/native.ts'
import { ResearchTools, RESEARCH_TOOL_NAMES } from '../src/server/tools/research.ts'

/** 用例创建的临时目录，afterEach 统一删除。 */
const directories: string[] = []

afterEach(async () => {
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

/** 工具执行用的最小 Context（遥测空实现、无中止信号）。 */
const TEST_CONTEXT: Context = {
  telemetry: NOOP_TELEMETRY_CONTEXT,
  abortSignal: undefined,
  value: () => undefined,
  toString: () => 'pi-web-research-tools-test',
}

/**
 * 创建临时工作区目录并注册清理。
 * @returns 目录绝对路径
 */
async function workspace(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'pi-web-research-tools-'))
  directories.push(directory)
  return directory
}

/**
 * 创建工作区之外的临时目录（用于越界访问测试）并注册清理。
 * @returns 目录绝对路径
 */
async function outsideWorkspace(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'pi-web-research-outside-'))
  directories.push(directory)
  return directory
}

/**
 * 构造指向给定 cwd 的 ToolExecutionApi stub。
 * @param path 工作目录
 * @returns api 对象
 */
function apiFor(path: string): ToolExecutionApi {
  return { env: { cwd: path }, diagnostic: () => undefined } as unknown as ToolExecutionApi
}

/**
 * 按名称查找 ResearchTools 中已注册的工具。
 * @param name 工具名
 * @returns 工具定义
 */
function registered(name: string) {
  const tool = ResearchTools.tools?.find(candidate => candidate.name === name)
  if (!tool) throw new Error(`missing tool ${name}`)
  return tool
}

/**
 * 执行一个已注册工具。
 * @param name 工具名
 * @param args 参数
 * @param api 执行环境
 * @param context 执行上下文，默认 TEST_CONTEXT
 * @returns 工具执行结果
 */
async function callTool(name: string, args: Record<string, unknown>, api: ToolExecutionApi, context = TEST_CONTEXT) {
  return registered(name).execute(args as never, api, context)
}

/**
 * 拼接工具结果里全部 text 块。
 * @param result 工具执行结果
 * @returns 文本
 */
function toolText(result: { output?: readonly { type: string; text?: string }[] }): string {
  return (result.output ?? []).flatMap(item => item.type === 'text' ? [item.text ?? ''] : []).join('\n')
}

/** 调研工具行为测试。 */
describe('ResearchTools', () => {
  // 验证导出面：名称常量与工具注册表一致，恰好四个只读工具。
  it('exports the intended read-only tools', () => {
    expect(RESEARCH_TOOL_NAMES).toEqual(['list_files', 'search_files', 'glob', 'grep'])
    expect(ResearchTools.tools?.map(tool => tool.name)).toEqual(['list_files', 'search_files', 'glob', 'grep'])
  })

  // 验证 list_files：直接列出相对条目；递归列出含 src/tokens 源码子目录、
  // 但跳过 node_modules/.git/.data/.private 与凭据类文件（credentials.json/.env）；不误报截断。
  it('lists relative paths and omits hidden, generated, and credential-related entries', async () => {
    const root = await workspace()
    await mkdir(join(root, 'src', 'nested'), { recursive: true })
    await mkdir(join(root, 'src', 'tokens'), { recursive: true })
    await mkdir(join(root, 'node_modules', 'pkg'), { recursive: true })
    await mkdir(join(root, '.git', 'objects'), { recursive: true })
    await mkdir(join(root, '.data'), { recursive: true })
    await mkdir(join(root, '.private'), { recursive: true })
    await writeFile(join(root, 'README.md'), '# Project')
    await writeFile(join(root, 'credentials.json'), '{"token":"hidden"}')
    await writeFile(join(root, '.env'), 'SECRET=value')
    await writeFile(join(root, '.private', 'notes.md'), 'hidden')
    await writeFile(join(root, 'src', 'main.ts'), 'export const value = 1')
    await writeFile(join(root, 'src', 'nested', 'helper.ts'), 'export const helper = 1')
    await writeFile(join(root, 'src', 'tokens', 'secrets.ts'), 'export const secretType = "source code"')

    const direct = toolText(await callTool('list_files', {}, apiFor(root)))
    const recursive = toolText(await callTool('list_files', { recursive: true }, apiFor(root)))

    expect(direct).toContain('- file "README.md"')
    expect(direct).toContain('- directory "src"')
    expect(direct).not.toContain('TRUNCATED')
    for (const path of ['README.md', 'src', 'src/main.ts', 'src/nested', 'src/nested/helper.ts', 'src/tokens/secrets.ts']) {
      expect(recursive).toContain(JSON.stringify(path))
    }
    expect(recursive).not.toMatch(/node_modules|\.git|\.data|\.private|credentials|\.env/)
    expect(recursive).not.toContain('TRUNCATED')
  })

  // 验证截断标记：list_files 超 maxEntries、search_files 超 maxResults 时各只返回 1 条并带 TRUNCATED。
  it('marks directory and result limits as truncated', async () => {
    const root = await workspace()
    await writeFile(join(root, 'one.txt'), 'match')
    await writeFile(join(root, 'two.txt'), 'match')

    const listed = toolText(await callTool('list_files', { maxEntries: 1 }, apiFor(root)))
    const searched = toolText(await callTool('search_files', { query: 'match', maxResults: 1 }, apiFor(root)))

    expect(listed.match(/- file /g)).toHaveLength(1)
    expect(listed).toContain('TRUNCATED')
    expect(searched.match(/:1: match/g)).toHaveLength(1)
    expect(searched).toContain('TRUNCATED')
  })

  // 验证截断原因保留：先遇到超大文件（记入 skipped oversized）后达到结果上限时，
  // 两个事实（skipped 统计与 TRUNCATED）同时如实报告。
  it('preserves an earlier skipped-file truncation when the result limit is later reached', async () => {
    const root = await workspace()
    await mkdir(join(root, 'src'), { recursive: true })
    await writeFile(join(root, 'large.txt'), 'needle'.repeat(100_000))
    await writeFile(join(root, 'src', 'match.txt'), 'needle')

    const result = toolText(await callTool('search_files', { query: 'needle', maxResults: 1 }, apiFor(root)))

    expect(result).toContain('skipped 0 unreadable, 0 binary, and 1 oversized files')
    expect(result).toContain('- "src/match.txt":1: needle')
    expect(result).toContain('TRUNCATED')
  })

  // 验证字面搜索：1 起始行号 + 摘录原文；只搜文本文件（凭据/.env 跳过）；
  // 统计"searched 1 files"、无截断不误报。
  it('searches literal text and returns one-based line numbers with excerpts', async () => {
    const root = await workspace()
    await mkdir(join(root, 'src'), { recursive: true })
    await writeFile(join(root, 'src', 'app.ts'), 'const a = 1\nconst value = "Needle here"\nneedle again\n')
    await writeFile(join(root, 'src', 'credentials.json'), '{"value":"Needle"}')
    await writeFile(join(root, '.env'), 'Needle')

    const result = toolText(await callTool('search_files', { query: 'needle' }, apiFor(root)))

    expect(result).toContain('- "src/app.ts":2: const value = "Needle here"')
    expect(result).toContain('- "src/app.ts":3: needle again')
    expect(result).toContain('searched 1 files')
    expect(result).not.toContain('TRUNCATED')
  })

  // 验证 glob：跨深度匹配 .ts 且按修改时间新→旧排序（helper > app.test > app）；
  // 跳过 node_modules/.git/credentials；.json 匹配包含 .cursor 隐藏目录但排除凭据；
  // basename 模式（*.md）同时命中根目录与 .private 隐藏目录。
  it('globs files across depths, includes hidden paths, and sorts newest first', async () => {
    const root = await workspace()
    await mkdir(join(root, 'src', 'nested'), { recursive: true })
    await mkdir(join(root, '.cursor'), { recursive: true })
    await mkdir(join(root, '.private'), { recursive: true })
    await mkdir(join(root, 'node_modules', 'pkg'), { recursive: true })
    await mkdir(join(root, '.git', 'objects'), { recursive: true })
    await writeFile(join(root, 'README.md'), '# Project')
    await writeFile(join(root, 'src', 'app.ts'), 'export const app = 1')
    await writeFile(join(root, 'src', 'app.test.ts'), 'export const test = 1')
    await writeFile(join(root, 'src', 'nested', 'helper.ts'), 'export const helper = 1')
    await writeFile(join(root, '.cursor', 'pending.json'), '{}')
    await writeFile(join(root, '.private', 'notes.md'), 'hidden')
    await writeFile(join(root, 'node_modules', 'pkg', 'index.ts'), 'ignored')
    await writeFile(join(root, '.git', 'objects', 'blob.ts'), 'ignored')
    await writeFile(join(root, 'credentials.json'), '{"token":"hidden"}')
    await utimes(join(root, 'src', 'app.ts'), new Date('2026-01-01'), new Date('2026-01-01'))
    await utimes(join(root, 'src', 'app.test.ts'), new Date('2026-02-01'), new Date('2026-02-01'))
    await utimes(join(root, 'src', 'nested', 'helper.ts'), new Date('2026-03-01'), new Date('2026-03-01'))

    const code = toolText(await callTool('glob', { pattern: '**/*.ts' }, apiFor(root)))
    expect(code).toContain('"src/nested/helper.ts"')
    expect(code).toContain('"src/app.test.ts"')
    expect(code).toContain('"src/app.ts"')
    expect(code).not.toMatch(/node_modules|\.git|credentials/)
    expect(code.indexOf('"src/nested/helper.ts"')).toBeLessThan(code.indexOf('"src/app.test.ts"'))
    expect(code.indexOf('"src/app.test.ts"')).toBeLessThan(code.indexOf('"src/app.ts"'))

    const hidden = toolText(await callTool('glob', { pattern: '**/*.json' }, apiFor(root)))
    expect(hidden).toContain('".cursor/pending.json"')
    expect(hidden).not.toContain('credentials.json')

    const basename = toolText(await callTool('glob', { pattern: '*.md' }, apiFor(root)))
    expect(basename).toContain('"README.md"')
    expect(basename).toContain('".private/notes.md"')
  })

  // 验证 grep：正则交替模式匹配、include=*.ts 过滤掉 json/凭据/.env；
  // caseSensitive=true 时 0 匹配（区分大小写）；include=*.json 只命中 src 下文件；
  // 非法正则（未闭合括号）报 INVALID_INPUT。
  it('greps regex matches, filters by include glob, and respects case sensitivity', async () => {
    const root = await workspace()
    await mkdir(join(root, 'src'), { recursive: true })
    await writeFile(join(root, 'src', 'app.ts'), 'const value = 1\nconst label = "Needle here"\n')
    await writeFile(join(root, 'src', 'app.test.ts'), 'needle again\n')
    await writeFile(join(root, 'src', 'data.json'), '{"value":"Needle"}')
    await writeFile(join(root, 'credentials.json'), '{"value":"Needle"}')
    await writeFile(join(root, '.env'), 'Needle')

    const filtered = toolText(await callTool('grep', { pattern: 'needle|value', include: '*.ts' }, apiFor(root)))
    expect(filtered).toContain('- "src/app.ts":1: const value = 1')
    expect(filtered).toContain('- "src/app.ts":2: const label = "Needle here"')
    expect(filtered).toContain('- "src/app.test.ts":1: needle again')
    expect(filtered).not.toContain('data.json')
    expect(filtered).not.toContain('credentials')
    expect(filtered).not.toContain('.env')

    const exactCase = toolText(await callTool('grep', { pattern: 'NEEDLE', caseSensitive: true }, apiFor(root)))
    expect(exactCase).toContain('Found 0 regex matches')

    const json = toolText(await callTool('grep', { pattern: 'Needle', include: '*.json' }, apiFor(root)))
    expect(json).toContain('- "src/data.json":1: {"value":"Needle"}')
    expect(json).not.toContain('credentials')

    await expect(callTool('grep', { pattern: '(' }, apiFor(root)))
      .rejects.toMatchObject({ code: 'INVALID_INPUT' })
  })

  // 验证 glob/grep 的结果上限：各返回 1 条并带 TRUNCATED 标记。
  it('marks glob and grep result limits as truncated', async () => {
    const root = await workspace()
    await writeFile(join(root, 'one.txt'), 'match')
    await writeFile(join(root, 'two.txt'), 'match')

    const globbed = toolText(await callTool('glob', { pattern: '*.txt', maxResults: 1 }, apiFor(root)))
    const grepped = toolText(await callTool('grep', { pattern: 'match', maxResults: 1 }, apiFor(root)))

    expect(globbed.match(/^- "/gm)).toHaveLength(1)
    expect(globbed).toContain('TRUNCATED')
    expect(grepped.match(/:1: match/g)).toHaveLength(1)
    expect(grepped).toContain('TRUNCATED')
  })

  // 验证路径安全：父路径 ../ 拒绝（FORBIDDEN）；绝对路径越界拒绝（INVALID_INPUT）；
  // 工作区内的符号链接不跟随（FORBIDDEN）；默认搜索不泄露外部文件内容。
  it('rejects absolute and parent paths and does not follow symlinks', async () => {
    const root = await workspace()
    const outside = await outsideWorkspace()
    await writeFile(join(outside, 'outside.txt'), 'secret-value')
    await symlink(outside, join(root, 'external'))

    await expect(callTool('list_files', { path: '../outside' }, apiFor(root)))
      .rejects.toMatchObject({ code: 'FORBIDDEN' })
    await expect(callTool('search_files', { query: 'secret', path: join(outside, 'outside.txt') }, apiFor(root)))
      .rejects.toMatchObject({ code: 'INVALID_INPUT' })
    await expect(callTool('search_files', { query: 'secret', path: 'external/outside.txt' }, apiFor(root)))
      .rejects.toMatchObject({ code: 'FORBIDDEN' })

    const result = toolText(await callTool('search_files', { query: 'secret' }, apiFor(root)))
    expect(result).not.toContain('outside.txt')
    expect(result).not.toContain('secret-value')
    expect(result).not.toContain('TRUNCATED')
  })

  // 验证跳过统计：超大文件与二进制文件被跳过并计入 skipped 统计（0 unreadable / 1 binary / 1 oversized），
  // 正常文件照常命中，搜索不完整标记 TRUNCATED。
  it('skips oversized and binary files and reports the incomplete search', async () => {
    const root = await workspace()
    await writeFile(join(root, 'large.txt'), 'needle'.repeat(100_000))
    await writeFile(join(root, 'image.dat'), Buffer.from([0, 1, 2, 3]))
    await writeFile(join(root, 'small.txt'), 'needle')

    const result = toolText(await callTool('search_files', { query: 'needle' }, apiFor(root)))

    expect(result).toContain('- "small.txt":1: needle')
    expect(result).toContain('skipped 0 unreadable, 1 binary, and 1 oversized files')
    expect(result).toContain('TRUNCATED')
  })

  // 验证读取预算：二进制文件探测消耗的字节计入总预算，预算耗尽后排队的文本文件
  // 也被记为 oversized（不产出匹配），搜索标记不完整。
  it('counts binary bytes against the total read budget and marks later files incomplete', async () => {
    const root = await workspace()
    await mkdir(join(root, 'src'), { recursive: true })
    const binary = Buffer.alloc(512 * 1_024)
    await Promise.all(Array.from({ length: 8 }, (_, index) => writeFile(join(root, `binary-${index}.dat`), binary)))
    await writeFile(join(root, 'src', 'match.txt'), 'needle')

    const result = toolText(await callTool('search_files', { query: 'needle' }, apiFor(root)))

    expect(result).not.toContain('- "src/match.txt":1: needle')
    expect(result).toContain('skipped 0 unreadable, 8 binary, and 1 oversized files')
    expect(result).toContain('TRUNCATED')
  })

  // 验证取消传播：abort 信号已触发的 context 在读文件前即抛错。
  it('honors an aborted context before reading workspace files', async () => {
    const root = await workspace()
    const controller = new AbortController()
    controller.abort()
    const context = { ...TEST_CONTEXT, abortSignal: controller.signal } as Context

    await expect(callTool('list_files', {}, apiFor(root), context)).rejects.toThrow()
  })
})

/** 原生 ripgrep 集成（resolveRipgrep/searchWithRipgrep/grep 工具回退）测试。 */
describe('native ripgrep search', () => {
  // 验证原生路径：相对路径 + 1 起始行号的匹配、扫描文件数统计（rg 缺失时跳过）。
  it('finds matches with relative paths and one-based lines', async () => {
    if (await resolveRipgrep() === undefined) return
    const root = await workspace()
    await mkdir(join(root, 'src'), { recursive: true })
    await writeFile(join(root, 'src', 'app.ts'), 'const a = 1\nconst needle = 2\n')

    const outcome = await searchWithRipgrep({
      root,
      searchPath: root,
      pattern: 'needle',
      caseSensitive: false,
      maxResults: 10,
    })

    expect(outcome.kind).toBe('ok')
    if (outcome.kind !== 'ok') return
    expect(outcome.matches).toHaveLength(1)
    expect(outcome.matches[0]).toMatchObject({ path: 'src/app.ts', line: 2 })
    expect(outcome.scannedFiles).toBeGreaterThan(0)
  })

  // 验证零匹配：ok 结果、空 matches（不算失败）。
  it('reports no matches without failing', async () => {
    if (await resolveRipgrep() === undefined) return
    const root = await workspace()
    await writeFile(join(root, 'a.txt'), 'hello\n')

    const outcome = await searchWithRipgrep({
      root,
      searchPath: root,
      pattern: 'zzzz',
      caseSensitive: false,
      maxResults: 10,
    })

    expect(outcome.kind).toBe('ok')
    if (outcome.kind === 'ok') expect(outcome.matches).toHaveLength(0)
  })

  // 验证跳过规则与 JS walker 一致：node_modules 与凭据文件不出现在结果里，只剩 src.ts。
  it('skips generated trees and credential files', async () => {
    if (await resolveRipgrep() === undefined) return
    const root = await workspace()
    await mkdir(join(root, 'node_modules', 'pkg'), { recursive: true })
    await writeFile(join(root, 'node_modules', 'pkg', 'a.ts'), 'needle\n')
    await writeFile(join(root, '.env'), 'needle\n')
    await writeFile(join(root, 'credentials.json'), '{"needle":1}\n')
    await writeFile(join(root, 'src.ts'), 'needle\n')

    const outcome = await searchWithRipgrep({
      root,
      searchPath: root,
      pattern: 'needle',
      caseSensitive: false,
      maxResults: 10,
    })

    expect(outcome.kind).toBe('ok')
    if (outcome.kind !== 'ok') return
    expect(outcome.matches.map(match => match.path)).toEqual(['src.ts'])
  })

  // 验证 rg 专属语法直通：命名捕获组 (?P<word>...) 由原生引擎处理，不报正则错误。
  it('lets the native engine handle ripgrep-only syntax', async () => {
    if (await resolveRipgrep() === undefined) return
    const root = await workspace()
    await writeFile(join(root, 'a.txt'), 'needle\n')

    const result = toolText(await callTool('grep', { pattern: '(?P<word>needle)' }, apiFor(root)))

    expect(result).toContain('a.txt')
    expect(result).not.toContain('not a valid regular expression')
  })

  // 验证 lookahead 回退：JS 专属语法 need(?=le) 在 rg 不支持时回退 JS walker 并命中。
  it('falls back for a JavaScript-only lookahead', async () => {
    const root = await workspace()
    await writeFile(join(root, 'a.txt'), 'needle\n')

    const result = toolText(await callTool('grep', { pattern: 'need(?=le)' }, apiFor(root)))

    expect(result).toContain('a.txt')
  })

  // 验证 rg 不可用回退：解析器置空后 grep 工具仍能用 JS walker 出结果（结束恢复解析器）。
  it('falls back to the JavaScript walker when ripgrep is unavailable', async () => {
    const root = await workspace()
    await writeFile(join(root, 'a.txt'), 'needle\n')
    setRipgrepForTests(undefined)
    try {
      const result = toolText(await callTool('grep', { pattern: 'needle' }, apiFor(root)))
      expect(result).toContain('a.txt')
    } finally {
      resetRipgrepResolverForTests()
    }
  })
})
