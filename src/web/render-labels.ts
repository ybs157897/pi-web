import type {
  DiffBlockLabels, MarkdownLabels, ReadBlockLabels, SearchBlockLabels, TerminalBlockLabels, WebBlockLabels,
} from '@deepseek-ai/dsh-client-ui-primitives'

export type Translate = (chinese: string, english: string) => string

export function markdownLabels(t: Translate): MarkdownLabels {
  return {
    code: {
      copyLabel: t('复制代码', 'Copy code'),
      copiedLabel: t('已复制', 'Copied'),
      toolbarLabels: {
        codeLabel: t('代码', 'Code'),
        wrapLabel: t('自动换行', 'Wrap lines'),
        unwrapLabel: t('关闭自动换行', 'Disable wrapping'),
      },
    },
    footnotes: t('脚注', 'Footnotes'),
  }
}

export function terminalLabels(t: Translate): TerminalBlockLabels {
  return {
    commandLine: line => t(`命令行 ${line}`, `Command line ${line}`),
    signal: signal => t(`信号 ${signal}`, `Signal ${signal}`),
    exitCode: code => t(`退出码 ${code}`, `Exit code ${code}`),
    noExitCode: t('没有退出码', 'No exit code'),
    running: t('正在运行', 'Running'),
    failed: t('命令未成功', 'Command failed'),
    done: t('命令已完成', 'Command completed'),
    copy: t('复制输出', 'Copy output'),
    copied: t('已复制', 'Copied'),
    noOutput: t('没有输出', 'No output'),
    collapseAria: t('收起命令输出', 'Collapse command output'),
    collapse: t('收起', 'Collapse'),
    expandAria: hidden => t(`展开另 ${hidden} 行`, `Show ${hidden} more lines`),
    expand: hidden => t(`展开另 ${hidden} 行`, `Show ${hidden} more lines`),
  }
}

export function readLabels(t: Translate): ReadBlockLabels {
  return {
    codeLabel: t('代码', 'Code'),
    wrapLabel: t('自动换行', 'Wrap lines'),
    unwrapLabel: t('关闭自动换行', 'Disable wrapping'),
    window: (shown, total) => t(`显示 ${shown} / ${total} 行`, `Showing ${shown} of ${total} lines`),
    copy: t('复制内容', 'Copy content'),
    copied: t('已复制', 'Copied'),
    collapseAria: t('收起文件内容', 'Collapse file content'),
    expandAria: hidden => t(`展开另 ${hidden} 行`, `Show ${hidden} more lines`),
    collapse: t('收起', 'Collapse'),
    expand: hidden => t(`展开另 ${hidden} 行`, `Show ${hidden} more lines`),
  }
}

export function diffLabels(t: Translate): DiffBlockLabels {
  return {
    codeLabel: t('代码', 'Code'),
    wrapLabel: t('自动换行', 'Wrap lines'),
    unwrapLabel: t('关闭自动换行', 'Disable wrapping'),
    copy: t('复制差异', 'Copy diff'),
    copied: t('已复制', 'Copied'),
    collapseAria: t('收起差异', 'Collapse diff'),
    expandAria: hidden => t(`展开另 ${hidden} 行`, `Show ${hidden} more lines`),
    collapse: t('收起', 'Collapse'),
    expand: hidden => t(`展开另 ${hidden} 行`, `Show ${hidden} more lines`),
  }
}

export function searchLabels(t: Translate): SearchBlockLabels {
  return {
    pathsSummary: (shown, total, truncated) => truncated
      ? t(`显示 ${shown} / 共 ${total} 个路径`, `Showing ${shown} of ${total} paths`)
      : t(`${total} 个路径`, `${total} paths`),
    matchesSummary: (shown, total, files, truncated) => truncated
      ? t(`显示 ${shown} / 共 ${total} 个匹配，涉及 ${files} 个文件`, `Showing ${shown} of ${total} matches in ${files} files`)
      : t(`${total} 个匹配，涉及 ${files} 个文件`, `${total} matches in ${files} files`),
    copy: t('复制结果', 'Copy results'),
    copied: t('已复制', 'Copied'),
    noResults: t('没有匹配结果', 'No matches'),
    collapseAria: t('收起搜索结果', 'Collapse search results'),
    expandAria: hidden => t(`展开另 ${hidden} 项`, `Show ${hidden} more results`),
    collapse: t('收起', 'Collapse'),
    expand: hidden => t(`展开另 ${hidden} 项`, `Show ${hidden} more results`),
  }
}

export function webLabels(t: Translate): WebBlockLabels {
  return {
    noResults: t('没有网页结果', 'No web results'),
    sourcesTruncated: t('来源过多，已截断显示', 'Some sources were omitted'),
    http: t('HTTP 状态', 'HTTP status'),
    contentTruncated: t('网页内容已截断', 'Page content was truncated'),
    markdown: markdownLabels(t),
  }
}
