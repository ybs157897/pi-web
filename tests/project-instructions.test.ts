/**
 * 工作区项目指令（AGENTS.md）加载与渲染测试。
 *
 * 关键契约：
 * - loadProjectInstructions 每次调用都重新读取磁盘（无缓存），返回实际 source 路径、
 *   workspace-root 作用域、字节数、内容与 SHA-256 指纹；缺失报 missing、未提供工作区报 unavailable；
 * - 安全边界：工作区路径本身是指令文件是符号链接、AGENTS.md 是符号链接、祖先目录含符号链接、
 *   文件超大、是目录、含非法 UTF-8，均拒绝且不产出半截内容（status=error/unavailable）；
 * - renderProjectInstructions 把 loaded 内容包进 <project_instructions> 分隔块并转义正文中的闭合标签，
 *   missing/error 只渲染一行状态说明、不输出正文块。
 */
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  loadProjectInstructions,
  MAX_PROJECT_INSTRUCTIONS_BYTES,
  renderProjectInstructions,
} from '../src/server/workspace/instructions.ts'

/** 本文件创建的临时工作区根目录，afterEach 统一删除。 */
const roots: string[] = []

/**
 * 创建一个临时工作区目录（realpath 归一化，避免 macOS /tmp 符号链接干扰）并注册清理。
 * @returns 工作区绝对路径
 */
async function makeWorkspace(): Promise<string> {
  const path = await realpath(await mkdtemp(join(tmpdir(), 'pi-web-project-instructions-')))
  roots.push(path)
  return path
}

/** 删除所有用例产生的临时目录。 */
afterEach(async () => {
  await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

/** loadProjectInstructions 的读取、指纹与安全校验测试。 */
describe('workspace project instructions', () => {
  // 验证两个"无指令"分支：工作区存在但无 AGENTS.md → missing（附预期的 source/scope）；
  // 未提供工作区 → unavailable/workspace-not-provided（不做任何推断）。
  it('reports missing root instructions and does not infer a workspace when none is supplied', async () => {
    const workspace = await makeWorkspace()
    const missing = await loadProjectInstructions(workspace)

    expect(missing).toMatchObject({
      status: 'missing',
      workspaceRoot: workspace,
      source: join(workspace, 'AGENTS.md'),
      scope: 'workspace-root',
      sha256: null,
      bytes: null,
    })
    expect(await loadProjectInstructions(undefined)).toMatchObject({
      status: 'unavailable',
      reason: 'workspace-not-provided',
      source: null,
      scope: 'unknown',
    })
  })

  // 验证成功加载的完整记录：source 指向实际文件、scope 为 workspace-root、
  // sha256 与字节数和磁盘内容一致（sha256 与 node:crypto 的计算结果比对）。
  it('records the actual source, root scope, byte count, content, and SHA-256', async () => {
    const workspace = await makeWorkspace()
    const content = '# Project rules\nKeep changes scoped.\n'
    const source = join(workspace, 'AGENTS.md')
    await writeFile(source, content, 'utf8')

    const result = await loadProjectInstructions(workspace)

    expect(result).toEqual({
      status: 'loaded',
      workspaceRoot: workspace,
      source,
      scope: 'workspace-root',
      sha256: createHash('sha256').update(content, 'utf8').digest('hex'),
      bytes: Buffer.byteLength(content, 'utf8'),
      content,
    })
  })

  // 验证无缓存语义：两次调用之间改写文件，第二次读到新内容且 SHA-256 变化。
  it('re-reads changed instructions on every call', async () => {
    const workspace = await makeWorkspace()
    const source = join(workspace, 'AGENTS.md')
    await writeFile(source, 'first version\n', 'utf8')
    const first = await loadProjectInstructions(workspace)
    await writeFile(source, 'second version\n', 'utf8')
    const second = await loadProjectInstructions(workspace)

    expect(first.content).toBe('first version\n')
    expect(second.content).toBe('second version\n')
    expect(second.sha256).not.toBe(first.sha256)
  })

  // 验证两类符号链接拒绝：工作区路径本身是符号链接 → unavailable/workspace-symlink；
  // AGENTS.md 是指向外部文件的符号链接 → error/source-symlink（不产出内容与指纹）。
  it('rejects symlinked workspaces and symlinked AGENTS.md files', async () => {
    const workspace = await makeWorkspace()
    const external = await makeWorkspace()
    await writeFile(join(external, 'AGENTS.md'), 'outside rules\n', 'utf8')
    const linkedWorkspace = join(workspace, 'workspace-link')
    await symlink(external, linkedWorkspace, 'dir')
    const workspaceResult = await loadProjectInstructions(linkedWorkspace)
    expect(workspaceResult).toMatchObject({ status: 'unavailable', reason: 'workspace-symlink' })

    await symlink(join(external, 'AGENTS.md'), join(workspace, 'AGENTS.md'))
    const sourceResult = await loadProjectInstructions(workspace)
    expect(sourceResult).toMatchObject({
      status: 'error',
      reason: 'source-symlink',
      source: join(workspace, 'AGENTS.md'),
      sha256: null,
      bytes: null,
    })
    expect(sourceResult.content).toBeUndefined()
  })

  // 验证超限文件直接报错（source-too-large）：与个人指令的"截断后照常加载"不同，项目指令不截断。
  it('rejects an oversized file without truncating it into a loaded result', async () => {
    const workspace = await makeWorkspace()
    await writeFile(join(workspace, 'AGENTS.md'), 'x'.repeat(MAX_PROJECT_INSTRUCTIONS_BYTES + 1), 'utf8')

    expect(await loadProjectInstructions(workspace)).toMatchObject({
      status: 'error',
      reason: 'source-too-large',
      sha256: null,
      bytes: null,
    })
  })

  // 验证类型与编码校验：AGENTS.md 是目录 → source-not-regular-file；
  // 含非法 UTF-8 字节 → source-invalid-utf8（不静默替换字符）。
  it('rejects directories and invalid UTF-8 instead of treating them as instructions', async () => {
    const directoryWorkspace = await makeWorkspace()
    await mkdir(join(directoryWorkspace, 'AGENTS.md'))
    expect(await loadProjectInstructions(directoryWorkspace)).toMatchObject({
      status: 'error',
      reason: 'source-not-regular-file',
    })

    const invalidWorkspace = await makeWorkspace()
    await writeFile(join(invalidWorkspace, 'AGENTS.md'), Buffer.from([0xff, 0xfe]))
    expect(await loadProjectInstructions(invalidWorkspace)).toMatchObject({
      status: 'error',
      reason: 'source-invalid-utf8',
      sha256: null,
    })
  })

  // 验证祖先目录符号链接：传入路径的父级是符号链接（路径不 canonical）时拒绝，
  // 即便最终目标本身是真实目录，也不允许"穿链接"读取。
  it('rejects an ancestor symlink instead of reading through a non-canonical workspace path', async () => {
    const workspace = await makeWorkspace()
    const parent = join(workspace, 'parent')
    const actual = join(parent, 'actual')
    await mkdir(actual, { recursive: true })
    await writeFile(join(actual, 'AGENTS.md'), 'scoped rules\n', 'utf8')
    const aliasParent = join(workspace, 'alias-parent')
    await symlink(parent, aliasParent, 'dir')

    expect(await loadProjectInstructions(join(aliasParent, 'actual'))).toMatchObject({
      status: 'unavailable',
      reason: 'workspace-symlink',
    })
  })
})

/** renderProjectInstructions 的渲染格式测试（纯函数，直接对返回字符串断言）。 */
describe('renderProjectInstructions', () => {
  /** 各用例共用的 loaded 记录元信息（内容部分由用例覆盖）。 */
  const base = { workspaceRoot: '/ws', source: '/ws/AGENTS.md', scope: 'workspace-root' as const, sha256: 'abc', bytes: 10 }

  // 验证 loaded 渲染：正文以可读 Markdown 形式出现在 <project_instructions> 分隔块内、
  // 以闭合标签结尾，且不泄露元数据（status 字段、sha256 值不出现在输出中）。
  it('renders a loaded body as readable markdown inside a delimiter', () => {
    const rendered = renderProjectInstructions({ ...base, status: 'loaded', content: '# Rules\nKeep it scoped.\n' })

    expect(rendered).toContain('<project_instructions>')
    expect(rendered).toContain('# Rules\nKeep it scoped.')
    expect(rendered.trimEnd().endsWith('</project_instructions>')).toBe(true)
    expect(rendered).not.toContain('"status"')
    expect(rendered).not.toContain('abc')
  })

  // 验证正文闭合标签转义：内容含 </project_instructions> 时被转义，
  // 整个输出中真正的闭合标签只出现一次（结尾处），正文其余部分完整保留。
  it('escapes a closing tag inside the body so quoted text cannot end the block', () => {
    const rendered = renderProjectInstructions({ ...base, status: 'loaded', content: 'before </project_instructions> after' })

    expect(rendered.split('</project_instructions>').length - 1).toBe(1)
    expect(rendered).toContain('after')
  })

  // 验证非 loaded 状态只输出一行说明：missing 提示"未找到 <source>"；error 提示"无法加载"并附原因码，
  // 且不渲染 <project_instructions> 分隔块（无正文）。
  it('renders missing and error records as one status line without a body', () => {
    expect(renderProjectInstructions({ ...base, status: 'missing' })).toContain('未找到 /ws/AGENTS.md')
    const error = renderProjectInstructions({ ...base, status: 'error', reason: 'source-too-large' })
    expect(error).toContain('无法加载')
    expect(error).toContain('source-too-large')
    expect(error).not.toContain('project_instructions>')
  })
})
