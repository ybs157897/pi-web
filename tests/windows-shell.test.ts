import iconv from 'iconv-lite'
import { describe, expect, it } from 'vitest'
import { isNoMatchCommand, withNoMatchSuccess } from '../src/server/tools/shell/common.ts'
import { LegacyAwareDecoder } from '../src/server/tools/shared/text-decode.ts'
import { buildPowerShellScript, isBlockedRecursiveSearch } from '../src/server/tools/shell/windows.ts'

/**
 * Windows shell 支撑逻辑测试：递归搜索防护、无匹配退出码的语义转换、
 * 输出解码（legacy 编码回退）与 PowerShell 包装脚本的形状。
 */
describe('Windows recursive search guard', () => {
  // 防护目的：递归 Get-ChildItem 接 Select-String 在大仓库上极慢且等价于 grep，
  // 各种别名（gci/sls/ls/dir）与中间 Where-Object 的写法都要被拦下。
  it('blocks recursive Get-ChildItem piped into Select-String', () => {
    for (const command of [
      'Get-ChildItem -Path . -Recurse -Include *.java | Select-String -Pattern canTransferSite',
      'gci -r | sls canTransferSite',
      'ls -r | Select-String foo',
      'dir -Recurse | sls foo',
      'Get-ChildItem -Recurse | Where-Object { $_.Name -like "*.ts" } | Select-String foo',
    ]) {
      expect(isBlockedRecursiveSearch(command)).toBe(true)
    }
  })

  // 非递归枚举、递归但不接 Select-String、以及不相干命令都不受影响。
  it('allows non-recursive enumeration and unrelated commands', () => {
    for (const command of [
      'Get-ChildItem',
      'Get-ChildItem -Recurse',
      'Get-ChildItem | Select-String foo',
      'Select-String -Path file.txt -Pattern foo',
      'Get-ChildItem -Recurse -File | Measure-Object',
    ]) {
      expect(isBlockedRecursiveSearch(command)).toBe(false)
    }
  })
})

describe('no-match exit codes', () => {
  // 只有搜索类命令（rg/grep/git grep/findstr 及管道 Select-String 形态）的
  // exit 1 语义是「无匹配」；find 不在其中（其 exit 1 另有含义）。
  it('recognizes the search commands whose exit 1 means no matches', () => {
    expect(isNoMatchCommand('rg foo')).toBe(true)
    expect(isNoMatchCommand('grep -r foo .')).toBe(true)
    expect(isNoMatchCommand('git grep foo')).toBe(true)
    expect(isNoMatchCommand('findstr /s foo *.*')).toBe(true)
    expect(isNoMatchCommand('echo hi | rg foo')).toBe(true)
    expect(isNoMatchCommand('Get-ChildItem | Select-String foo')).toBe(false)
    expect(isNoMatchCommand('find . -name foo')).toBe(false)
  })

  // 转换契约：搜索命令 exit 1 改写为成功结果，诊断码换成 no_matches。
  it('turns exit 1 from a search command into a successful no-match result', () => {
    const failure = {
      structuredOutput: { exitCode: 1, output: '', truncated: false },
      isError: true,
      diagnostics: [{ severity: 'error' as const, code: 'exit_code', message: 'Command exited with code 1' }],
    }
    const converted = withNoMatchSuccess(failure, 'rg foo')
    expect(converted.isError).toBe(false)
    expect(converted.diagnostics?.map(diagnostic => diagnostic.code)).toEqual(['no_matches'])
  })

  // 对照边界：真实失败（exit 2）与非搜索命令（exit 1）都保持原样不转换。
  it('leaves a real failure and a non-search exit 1 alone', () => {
    const realFailure = {
      structuredOutput: { exitCode: 2, output: '', truncated: false },
      isError: true,
      diagnostics: [{ severity: 'error' as const, code: 'exit_code', message: 'Command exited with code 2' }],
    }
    expect(withNoMatchSuccess(realFailure, 'rg foo').isError).toBe(true)

    const nonSearch = {
      structuredOutput: { exitCode: 1, output: '', truncated: false },
      isError: true,
      diagnostics: [{ severity: 'error' as const, code: 'exit_code', message: 'Command exited with code 1' }],
    }
    expect(withNoMatchSuccess(nonSearch, 'exit 1').isError).toBe(true)
  })
})

describe('Windows output decoding', () => {
  // 分块边界：UTF-8 多字节字符被分块截断时，解码器必须缓存半个字符等待补全。
  it('keeps a UTF-8 character split across chunks', () => {
    const decoder = new LegacyAwareDecoder(null)
    const bytes = Buffer.from('你好', 'utf8')
    const text = decoder.write(bytes.subarray(0, 1)) + decoder.write(bytes.subarray(1)) + decoder.end()
    expect(text).toBe('你好')
  })

  it('replaces invalid bytes instead of throwing when no legacy encoding is available', () => {
    const decoder = new LegacyAwareDecoder(null)
    // 孤立高位字节在 fatal 解码器上会抛 ERR_ENCODING_INVALID_ENCODED_DATA；
    // 这里应替换为 U+FFFD 而不是让整个命令报错。
    const text = decoder.write(Buffer.from([0x70, 0x72, 0x65, 0x66, 0x69, 0x78, 0x20, 0xff]))
      + decoder.write(Buffer.from(' tail', 'utf8')) + decoder.end()
    expect(text).toBe('prefix \uFFFD tail')
  })

  // legacy 回退：配置了控制台代码页（gb18030）时，非 UTF-8 字节流按代码页解码。
  it('switches to the console code page when bytes are not UTF-8', () => {
    const decoder = new LegacyAwareDecoder('gb18030')
    const text = decoder.write(Buffer.from('prefix ', 'utf8'))
      + decoder.write(iconv.encode('中文', 'gb18030'))
      + decoder.end()
    expect(text).toBe('prefix 中文')
  })
})

describe('PowerShell wrapper script', () => {
  // 包装脚本契约：显式设 UTF-8 输出编码、预置 LASTEXITCODE=0、内嵌原命令、
  // 以 $__pi_code 透传原生命令退出码。
  it('sets UTF-8 output and propagates a native command exit code', () => {
    const script = buildPowerShellScript('rg foo')
    expect(script).toContain('[Console]::OutputEncoding')
    expect(script).toContain('$global:LASTEXITCODE = 0')
    expect(script).toContain('rg foo')
    expect(script).toContain('exit $__pi_code')
  })
})
