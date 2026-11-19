import { asRecord, toolActivity } from './render-model.ts'
import type { Translate } from './render-labels.ts'

/** Use the attempted action in failure rows, including failures without diagnostic text. */
export function failedToolTitle(name: string, t: Translate): string {
  if (name === 'list_files') return t('列出目录失败', 'Could not list the directory')
  if (name === 'skill_load' || name === 'skill') return t('加载技能失败', 'Could not load the skill')
  switch (toolActivity(name)) {
    case 'read': return t('读取文件失败', 'Could not read the file')
    case 'readImage': return t('读取图片失败', 'Could not read the image')
    case 'search': return t('搜索失败', 'Search failed')
    case 'write': return t('写入文件失败', 'Could not write the file')
    case 'edit': return t('修改文件失败', 'Could not change the file')
    case 'commands': return t('命令未成功完成', 'Command did not complete successfully')
    case 'code': return t('脚本执行失败', 'Script failed')
    case 'webSearch': return t('网页搜索失败', 'Web search failed')
    case 'webFetch': return t('打开网页失败', 'Could not fetch the page')
    case 'questions': return t('提问未能送达', 'Could not send the question')
    case 'subagents': return t('子智能体任务未完成', 'The delegated task did not complete')
    case 'plan': return t('更新计划失败', 'Could not update the plan')
    default: return t('工具未成功完成', 'Tool did not complete successfully')
  }
}

/** The persisted Pi result ends in a harness block. An in-flight result can carry diagnostics separately. */
function reportedError(details: Record<string, unknown> | undefined, output: string, name: string): string {
  const structured = asRecord(details?.structuredOutput)
  const liveResult = asRecord(details?.result)
  const nestedSummary = asRecord(details?.summary)
  for (const record of [details, structured, liveResult, nestedSummary]) {
    const diagnostics = record?.diagnostics
    if (Array.isArray(diagnostics)) {
      for (const item of diagnostics) {
        const diagnostic = asRecord(item)
        if (diagnostic?.severity === 'error' && typeof diagnostic.message === 'string' && diagnostic.message.trim()) return diagnostic.message
      }
    }
    const error = record?.error
    if (typeof error === 'string' && error.trim()) return error
    const message = asRecord(error)?.message
    if (typeof message === 'string' && message.trim()) return message
  }
  const wrapperStart = output.lastIndexOf('<harness>')
  if (wrapperStart >= 0) {
    const diagnostics = /^<harness>\r?\n([\s\S]*?)^<\/harness>[\t ]*\s*$/mu.exec(output.slice(wrapperStart))?.[1]
    const harnessError = diagnostics === undefined ? undefined : /^\[error\][\t ]*([^\r\n]+)/mu.exec(diagnostics)?.[1]
    if (harnessError) return harnessError
  }
  if (name === 'codemode') {
    const scriptError = /(?:^|\r?\n)Script error:\r?\n([^\r\n]+)/u.exec(output)
    if (scriptError) return scriptError[1]!
  }
  // Shell output can mention errors unrelated to the command's exit. Use a diagnostic or the exit code.
  if (toolActivity(name) === 'commands') return ''
  return output.trimStart().split(/\r?\n/u, 1)[0] ?? ''
}

/** Only translate recognizable diagnostics. Arbitrary tool output stays in the detail view. */
export function toolFailureReason(name: string, details: Record<string, unknown> | undefined, output: string, exitCode: number | null | undefined, t: Translate): string | undefined {
  const error = reportedError(details, output, name)
  const kind = toolActivity(name)
  if (/workspace paths must be relative/iu.test(error)) {
    const pathLimit = /no longer than (\d+) characters/iu.exec(error)?.[1]
    return pathLimit
      ? t(`工作区路径需为相对路径，且至多 ${pathLimit} 个字符`, `Use a relative workspace path of at most ${pathLimit} characters`)
      : t('请使用工作区内的相对路径', 'Use a relative path inside the workspace')
  }
  if (/paths outside the current workspace|workdir must stay inside the workspace/iu.test(error)) {
    return t('工具只能访问当前工作区', 'This tool can only access the current workspace')
  }
  if (/hidden and credential-related paths are excluded/iu.test(error)) {
    return t('工作区搜索跳过隐藏目录与凭据文件', 'Workspace search skips hidden paths and credential files')
  }
  if (/\bENOENT\b|no such file or directory|file not found|requested workspace path does not exist|找不到文件|文件不存在/iu.test(error)) {
    if (kind === 'read' || kind === 'readImage') return t('找不到文件', 'File not found')
    if (kind === 'commands') return t('找不到命令或文件', 'Command or file not found')
    return t('找不到指定的文件或目录', 'The file or directory was not found')
  }
  if (/\bEACCES\b|\bEPERM\b|permission denied|access is denied|权限不足/iu.test(error)) {
    return t('没有执行这项操作的权限', 'Permission denied for this operation')
  }
  if (/plan mode blocks/iu.test(error)) return t('计划模式暂时禁止此操作', 'Plan mode currently blocks this operation')
  if (/not a directory|requires a workspace directory|\bENOTDIR\b/iu.test(error)) {
    return t('指定的位置不是目录', 'The specified location is not a directory')
  }
  if (/\bEISDIR\b|illegal operation on a directory/iu.test(error)) {
    return t('指定的是目录，需要选择文件', 'The specified location is a directory. Select a file.')
  }
  if (/no (?:bound )?workspace directory/iu.test(error)) {
    return t('当前会话没有关联工作区', 'The conversation has no workspace')
  }
  if (/not a valid regular expression|invalid glob pattern/iu.test(error)) {
    return t('搜索表达式格式不正确', 'The search expression is invalid')
  }
  if (/timed? out|timeout exceeded|执行超时/iu.test(error)) return t('执行超时', 'The operation timed out')
  if (name === 'codemode') {
    if (/\bSyntaxError\b/u.test(error)) return t('脚本语法有误', 'The script contains a syntax error')
    if (/\bReferenceError\b/u.test(error)) return t('脚本引用了无法访问的变量', 'The script referenced an unavailable variable')
    if (/\bTypeError\b/u.test(error)) return t('脚本遇到了不兼容的值或参数', 'The script encountered an incompatible value or argument')
    if (/script sandbox failed/iu.test(error)) return t('脚本运行环境出错', 'The script environment encountered an error')
  }
  if (typeof exitCode === 'number' && exitCode !== 0) {
    return t(`命令返回退出码 ${exitCode}`, `The command returned exit code ${exitCode}`)
  }
  return undefined
}

/** Strip the Pi wrapper around machine diagnostics in an expanded row while preserving the messages. */
export function readableToolOutput(output: string): string {
  return output.replace(/^<harness>\r?\n([\s\S]*?)^<\/harness>[\t ]*$/gmu, (_block, message: string) =>
    message.trimEnd().replace(/^\[error\]\s*/gmu, ''))
}
