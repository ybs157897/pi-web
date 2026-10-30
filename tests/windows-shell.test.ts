import iconv from 'iconv-lite'
import { describe, expect, it } from 'vitest'
import { isNoMatchCommand, withNoMatchSuccess } from '../src/server/tools/shell/common.ts'
import { LegacyAwareDecoder } from '../src/server/tools/shared/text-decode.ts'
import { buildPowerShellScript, isBlockedRecursiveSearch } from '../src/server/tools/shell/windows.ts'

describe('Windows recursive search guard', () => {
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
  it('recognizes the search commands whose exit 1 means no matches', () => {
    expect(isNoMatchCommand('rg foo')).toBe(true)
    expect(isNoMatchCommand('grep -r foo .')).toBe(true)
    expect(isNoMatchCommand('git grep foo')).toBe(true)
    expect(isNoMatchCommand('findstr /s foo *.*')).toBe(true)
    expect(isNoMatchCommand('echo hi | rg foo')).toBe(true)
    expect(isNoMatchCommand('Get-ChildItem | Select-String foo')).toBe(false)
    expect(isNoMatchCommand('find . -name foo')).toBe(false)
  })

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
  it('keeps a UTF-8 character split across chunks', () => {
    const decoder = new LegacyAwareDecoder(null)
    const bytes = Buffer.from('你好', 'utf8')
    const text = decoder.write(bytes.subarray(0, 1)) + decoder.write(bytes.subarray(1)) + decoder.end()
    expect(text).toBe('你好')
  })

  it('switches to the console code page when bytes are not UTF-8', () => {
    const decoder = new LegacyAwareDecoder('gb18030')
    const text = decoder.write(Buffer.from('prefix ', 'utf8'))
      + decoder.write(iconv.encode('中文', 'gb18030'))
      + decoder.end()
    expect(text).toBe('prefix 中文')
  })
})

describe('PowerShell wrapper script', () => {
  it('sets UTF-8 output and propagates a native command exit code', () => {
    const script = buildPowerShellScript('rg foo')
    expect(script).toContain('[Console]::OutputEncoding')
    expect(script).toContain('$global:LASTEXITCODE = 0')
    expect(script).toContain('rg foo')
    expect(script).toContain('exit $__pi_code')
  })
})
