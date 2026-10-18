import { useMemo, useState } from 'react'
import {
  DiffBlock, DisclosureRow, IconBrowseOutlineRegular, IconCodeOutlineRegular, IconGlobeOutlineRegular,
  IconInspectOutlineRegular, IconSearchOutlineRegular, IconSparkleRegular, ImageLightbox, JsonBlock,
  ReadBlock, SearchBlock, StateDot, TerminalBlock, TextShimmer, WebBlock,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { ContentBlock } from '../shared/types.ts'
import type { InspectorDiff } from './Inspector.tsx'
import type { ToolItem } from './render-model.ts'
import { diffLabels, readLabels, searchLabels, terminalLabels, webLabels, type Translate } from './render-labels.ts'
import { buildToolRenderModel } from './tool-render-model.ts'
import { useUiPreferences } from './ui-preferences.tsx'
import css from './ToolCard.module.css'

interface ToolCardProps {
  item: ToolItem
  runRunning: boolean
  processDisplay: 'detailed' | 'compact'
  t: Translate
  onOpenFile?: (path: string, line?: number) => void
  onInspectDiff?: (diff: InspectorDiff) => void
  onOpenTool?: (messageId: string, toolCallId?: string) => void
}

/** Render a Pi tool call and its durable result using the matching DSH output card. */
export default function ToolCard({ item, runRunning, processDisplay, t, onOpenFile, onInspectDiff, onOpenTool }: ToolCardProps) {
  const [open, setOpen] = useState(false)
  const model = useMemo(() => buildToolRenderModel(item, t, runRunning), [item, runRunning, t])
  const hasArgs = Object.keys(model.args).length > 0
  const hasResult = item.result !== undefined
  const hasDetails = model.details !== undefined && model.details !== null
  const hasChildren = item.children.length > 0
  const expandable = hasResult || hasArgs || hasDetails || hasChildren || model.artifacts.length > 0
  const icon = model.running ? <StateDot state="ongoing" size={14} />
    : model.failed ? <StateDot state="error" size={14} />
      : model.cancelled ? <StateDot state="warning" size={14} />
        : toolIcon(model.name)
  const summary = model.running
    ? processDisplay === 'detailed' ? model.summary : t('进行中', 'In progress')
    : model.summary
  const diagnostics = model.failed && model.errorText !== undefined
    ? <span className={css.failedSummary}>{model.errorText}</span>
    : model.cancelled ? <span className={css.stoppedSummary}>{t('已停止', 'Stopped')}</span>
      : <TextShimmer active={model.running}>{summary}</TextShimmer>
  const outputCard = model.command !== undefined ? (
    <TerminalBlock command={model.command} cwd={model.cwd} output={model.output}
      {...model.exitCode === undefined ? {} : { exitCode: model.exitCode }}
      {...model.signal === undefined ? {} : { signal: model.signal }}
      running={model.running} runStateDot={false} labels={terminalLabels(t)} />
  ) : model.read !== undefined ? (
    <ReadBlock label={model.path} lines={model.read.lines} totalLines={model.read.totalLines}
      lang={model.language} labels={readLabels(t)} />
  ) : model.diffs !== undefined ? (
    <DiffBlock diffs={[...model.diffs]} labels={diffLabels(t)} />
  ) : model.search !== undefined ? (
    <SearchBlock {...model.search} labels={searchLabels(t)} />
  ) : model.web !== undefined ? (
    <WebBlock {...model.web} labels={webLabels(t)} />
  ) : null
  const hasOutputCard = outputCard !== null
  const unknownPayload = !model.knownPresentation && !hasOutputCard
  const resultText = !hasOutputCard && model.output !== '' ? model.output : ''
  const sourceMessage = item.call === undefined ? item.result ?? item.message : item.message
  const toolImages = item.result?.blocks.filter((block): block is Extract<ContentBlock, { type: 'image' }> => block.type === 'image') ?? []
  const toolFiles = item.result?.blocks.filter((block): block is Extract<ContentBlock, { type: 'file' }> => block.type === 'file') ?? []
  const inspect = onOpenTool === undefined ? undefined : () => { onOpenTool(sourceMessage.id, item.call?.id) }
  const argsPayload = hasArgs && unknownPayload ? model.args : undefined

  return (
    <div className={css.root} data-error={model.failed || undefined} data-stopped={model.cancelled || undefined}
      data-tool-name={model.name} data-parent-tool-call-id={item.parentToolCallId}>
      <DisclosureRow
        icon={icon}
        title={model.title}
        open={open}
        expandable={expandable}
        expandOnRowClick
        running={model.running}
        onToggle={() => { setOpen(value => !value) }}
        collapsedContent={<span className={css.summary}><span className={css.sep} aria-hidden="true" />{diagnostics}</span>}
      >
        <div className={css.body}>
          {model.path !== undefined && onOpenFile !== undefined && !model.failed && !model.cancelled && (
            <button type="button" className={css.pathLink} onClick={() => { onOpenFile(model.path ?? '') }}>{model.path}</button>
          )}
          {outputCard}
          {resultText !== '' && <pre className={css.output}>{resultText}</pre>}
          {toolImages.map((block, index) => <ToolImage key={`${item.key}:image:${index}`} block={block} />)}
          {toolFiles.map((block, index) => (
            <button key={`${item.key}:file:${index}`} type="button" className={css.pathLink}
              onClick={() => { onOpenFile?.(block.path) }} disabled={onOpenFile === undefined}>{block.name}</button>
          ))}
          {!hasResult && model.running && <div className={css.inProgress}><StateDot state="ongoing" size={10} />{t('等待工具结果', 'Waiting for tool result')}</div>}
          {!hasResult && !model.running && <div className={css.empty}>{t('没有可显示的工具结果', 'No tool result was recorded')}</div>}
          {hasResult && model.output === '' && !hasOutputCard && toolImages.length === 0 && toolFiles.length === 0
            && <div className={css.empty}>{t('工具没有返回可显示的内容', 'The tool returned no displayable content')}</div>}
          {argsPayload !== undefined && <JsonBlock label={t('调用参数', 'Call arguments')} payload={argsPayload}
            truncatedLabel={count => t(`内容过长，原始长度 ${count} 字符`, `Content too long (${count} characters)`)} />}
          {hasDetails && !hasOutputCard && <JsonBlock label={t('工具详情', 'Tool details')} payload={model.details}
            truncatedLabel={count => t(`内容过长，原始长度 ${count} 字符`, `Content too long (${count} characters)`)} />}
          {model.failed && <div className={css.errorLabel} role="alert">{t('工具执行失败', 'Tool failed')}</div>}
          {model.cancelled && <div className={css.stoppedLabel} role="status">{t('工具已停止', 'Tool stopped')}</div>}
          {hasChildren && <div className={css.nestedTools}>
            {item.children.map(child => <ToolCard key={child.key} item={child} runRunning={runRunning}
              processDisplay={processDisplay} t={t} onOpenFile={onOpenFile} onInspectDiff={onInspectDiff} onOpenTool={onOpenTool} />)}
          </div>}
          {onInspectDiff !== undefined && model.diffs !== undefined && model.diffs.map((diff, index) => (
            <button key={`${item.key}:inspect:${index}`} type="button" className={css.inspectButton}
              onClick={() => { onInspectDiff(toInspectorDiff(diff)) }}>
              <IconInspectOutlineRegular size={13} />{t('在侧栏查看差异', 'Inspect diff in side panel')}
            </button>
          ))}
          {inspect !== undefined && <button type="button" className={css.inspectButton} onClick={inspect}>
            <IconInspectOutlineRegular size={13} />{t('在轨迹中查看', 'Inspect in trajectory')}
          </button>}
        </div>
      </DisclosureRow>
    </div>
  )
}

function toolIcon(name: string) {
  const normalized = name.toLocaleLowerCase()
  if (/^(bash|shell|exec|terminal|run_command)$/u.test(normalized)) return <IconCodeOutlineRegular size={14} />
  if (/^(read|read_file|readfile|cat)$/u.test(normalized)) return <IconBrowseOutlineRegular size={14} />
  if (/web|fetch/u.test(normalized)) return <IconGlobeOutlineRegular size={14} />
  if (/search|grep|glob|find/u.test(normalized)) return <IconSearchOutlineRegular size={14} />
  return <IconSparkleRegular size={14} />
}

function ToolImage({ block }: { block: Extract<ContentBlock, { type: 'image' }> }) {
  const [open, setOpen] = useState(false)
  const { t } = useUiPreferences()
  return (
    <>
      <button type="button" className={css.imageButton} onClick={() => { setOpen(true) }} aria-label={t('打开图片预览', 'Open image preview')}>
        <img src={block.url} alt={t('工具返回的图片', 'Image returned by tool')} loading="lazy" />
      </button>
      {open && <ImageLightbox src={block.url} alt={t('工具返回的图片', 'Image returned by tool')}
        labels={{ dialog: t('图片预览', 'Image preview'), close: t('关闭图片预览', 'Close image preview') }} onClose={() => { setOpen(false) }} />}
    </>
  )
}

function toInspectorDiff(diff: { path: string; oldText: string | null; newText: string }): InspectorDiff {
  return { path: diff.path, oldText: diff.oldText, newText: diff.newText }
}

