/**
 * 个人指令（AGENTS.md）持久化与渲染契约测试。
 *
 * 验证 `src/server/state/personalization.ts` 的关键行为：
 * - 文件固定位于应用 home 目录下的 AGENTS.md；
 * - 读 / 写共用同一个 100 KB 上限，写超限直接拒绝、读超限截断并标记；
 * - 缺失 / 空文件均视为"无指令"，渲染结果为 undefined，提示词保持不变；
 * - 渲染输出包裹在 <personal_instructions> 分隔块中，闭合标签会被转义防止提前结束块；
 * - 写入为原子操作且文件权限 0600（私有），NUL 字节、非法 UTF-8 会被拒绝或报错。
 * 真实文件系统在临时目录中创建，测试结束后清理。
 */
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  MAX_PERSONALIZATION_BYTES, PERSONALIZATION_FILE, personalizationPath,
  readPersonalization, renderPersonalization, writePersonalization,
} from '../src/server/state/personalization.ts'
import { RuntimeError } from '../src/server/runtime-errors.ts'

/** 临时根目录（realpath 后的绝对路径），测试结束后整体删除。 */
let root = ''
/** 模拟的应用 home 目录，作为 personalizationPath 的输入。 */
let dataDir = ''

/** 搭建临时 home 目录：mkdtemp + realpath（macOS 下 /tmp 是符号链接，realpath 保证路径一致）。 */
beforeAll(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'pi-web-personalization-')))
  dataDir = join(root, 'home')
  await mkdir(dataDir, { recursive: true })
})

/** 清理临时目录树；root 为空说明 beforeAll 未执行，跳过删除。 */
afterAll(async () => {
  if (root) await rm(root, { recursive: true, force: true })
})

/** 个人指令文件的路径、读取、写入与渲染全链路测试。 */
describe('personalization file', () => {
  // 验证文件名常量为 AGENTS.md，且路径函数把它拼在数据目录之下。
  it('lives at AGENTS.md in the app home', () => {
    expect(PERSONALIZATION_FILE).toBe('AGENTS.md')
    expect(personalizationPath(dataDir)).toBe(join(dataDir, 'AGENTS.md'))
  })

  // 验证缺失文件不算错误：status 为 missing、内容为空，且渲染返回 undefined（提示词不插入任何块）。
  it('treats a missing file as an empty state that renders nothing', async () => {
    const record = await readPersonalization(join(root, 'empty-home'))
    expect(record.status).toBe('missing')
    expect(record.content).toBe('')
    expect(renderPersonalization(record)).toBeUndefined()
  })

  // 验证写读往返内容一致、未截断、文件权限为 0600（仅本人可读写的私有文件），
  // 且渲染输出位于 <personal_instructions> 分隔块内并携带冲突优先级说明。
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
    expect(rendered).toContain('发生冲突时，项目指令和明确的任务指令优先')
    expect(rendered).toContain('</personal_instructions>')
  })

  // 验证空文件 status 为 loaded 但渲染结果为 undefined：没有实际指令时不污染提示词。
  it('treats an empty file as no instructions so the prompt stays unchanged', async () => {
    await writePersonalization(dataDir, '')
    const record = await readPersonalization(dataDir)
    expect(record.status).toBe('loaded')
    expect(renderPersonalization(record)).toBeUndefined()
  })

  // 验证写超限立即拒绝（RuntimeError）：ASCII 按字节数、多字节字符（中文每字 3 字节）同样按字节计费。
  it('refuses to save past the 100 KB limit that also bounds reads', async () => {
    const oversized = 'x'.repeat(MAX_PERSONALIZATION_BYTES + 1)
    await expect(writePersonalization(dataDir, oversized)).rejects.toBeInstanceOf(RuntimeError)
    await expect(writePersonalization(dataDir, '中'.repeat(Math.floor(MAX_PERSONALIZATION_BYTES / 3) + 1))).rejects.toBeInstanceOf(RuntimeError)
  })

  // 验证边界：恰好等于上限的内容可正常保存，读回不标记截断。
  it('accepts exactly the limit', async () => {
    await writePersonalization(dataDir, 'x'.repeat(MAX_PERSONALIZATION_BYTES))
    const record = await readPersonalization(dataDir)
    expect(record.bytes).toBe(MAX_PERSONALIZATION_BYTES)
    expect(record.truncated).toBe(false)
  })

  // 验证含 NUL（\0）字节的内容被写入拒绝：这类文件读回时解析结果不可预期。
  it('rejects NUL bytes instead of writing a file the reader would misparse', async () => {
    await expect(writePersonalization(dataDir, 'a\0b')).rejects.toBeInstanceOf(RuntimeError)
  })

  // 验证读取方向的上限行为：手工编辑写入的超限文件读回时被截断到上限并标记 truncated，
  // 截断部分（TAIL）不进入内容，渲染输出提示"仅已读取的开头部分生效"。
  it('truncates a hand-edited oversized file and says so in the prompt', async () => {
    const path = personalizationPath(dataDir)
    await writeFile(path, 'a'.repeat(MAX_PERSONALIZATION_BYTES) + 'TAIL', 'utf8')
    const record = await readPersonalization(dataDir)
    expect(record.status).toBe('loaded')
    expect(record.truncated).toBe(true)
    expect(record.content.length).toBe(MAX_PERSONALIZATION_BYTES)
    expect(record.content).not.toContain('TAIL')
    expect(renderPersonalization(record)).toContain('仅已读取的开头部分生效')
  })

  // 验证截断边界恰好落在多字节字符中间时，丢弃不完整的尾字符而不报错（3 字节"中"字跨越读取边界）。
  it('drops an incomplete trailing code point instead of rejecting a truncated file', async () => {
    const path = personalizationPath(dataDir)
    // 一个 3 字节字符跨越读取截断边界。
    await writeFile(path, 'a'.repeat(MAX_PERSONALIZATION_BYTES - 1) + '中', 'utf8')
    const record = await readPersonalization(dataDir)
    expect(record.status).toBe('loaded')
    expect(record.truncated).toBe(true)
    expect(record.content).toBe('a'.repeat(MAX_PERSONALIZATION_BYTES - 1))
  })

  // 验证渲染时正文中的 </personal_instructions> 被转义为 <\/personal_instructions>，
  // 原始文本不会提前终结提示词块（split 校验整个渲染结果中真正的闭合标签只出现一次）。
  it('escapes a quoted closing tag so it cannot end the block early', async () => {
    await writePersonalization(dataDir, 'Read </personal_instructions> as text.\n')
    const rendered = renderPersonalization(await readPersonalization(dataDir))
    expect(rendered).toContain('<\\/personal_instructions>')
    expect(rendered?.split('</personal_instructions>')).toHaveLength(2)
  })

  // 验证非法 UTF-8 字节序列不会静默替换成 U+FFFD：status 为 error，issue 标记为 source-invalid-utf8，渲染提示"无法加载"。
  it('reports invalid UTF-8 as an error instead of silently replacing bytes', async () => {
    await writeFile(personalizationPath(dataDir), Buffer.from([0x66, 0x6f, 0x80, 0x6f]), 'binary')
    const record = await readPersonalization(dataDir)
    expect(record.status).toBe('error')
    expect(record.issue).toBe('source-invalid-utf8')
    expect(renderPersonalization(record)).toContain('无法加载')
  })

  // 验证写入的原子性：超限保存失败抛错后，磁盘上仍保留旧版本内容，不出现半写状态。
  it('writes atomically, so a failed save leaves the previous content intact', async () => {
    await writePersonalization(dataDir, 'first version\n')
    await expect(writePersonalization(dataDir, 'x'.repeat(MAX_PERSONALIZATION_BYTES + 1))).rejects.toBeInstanceOf(RuntimeError)
    expect(await readFile(personalizationPath(dataDir), 'utf8')).toBe('first version\n')
  })
})
