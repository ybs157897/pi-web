import { Children, Component, createContext, isValidElement, memo, useContext, useEffect, useMemo, useState } from 'react'
import type { ComponentProps, ReactNode } from 'react'
import type { MarkdownFileMentions, MarkdownLabels, MarkdownPathImages } from '@deepseek-ai/dsh-client-ui-primitives'
import { Streamdown, defaultRehypePlugins, defaultRemarkPlugins } from 'streamdown'
import type { Components } from 'streamdown'
import { cjk } from '@streamdown/cjk'
import { createMathPlugin } from '@streamdown/math'
import type { Pluggable, PluggableList } from 'unified'
import { parseAnswerFileLink, safeAnswerUrl, resolvedImageSource, normalizeImageParagraphs } from './answer-markdown-model.ts'
import type { Translate } from './render-labels.ts'
import { MessageCodeBlock } from './message-rendering/CodeBlock.tsx'
import { MarkdownTable } from './message-rendering/MarkdownTable.tsx'
import { MessageDiagram } from './message-rendering/Diagram.tsx'
import { ImagePreview, type PreviewImage } from './message-rendering/ImagePreview.tsx'
import { ImageOff, Image as ImageIcon } from 'lucide-react'
import { MessageFileIcon } from './message-rendering/FileIcon.tsx'
import './message-rendering/theme.css'
import 'katex/dist/katex.min.css'
import css from './AnswerMarkdown.module.css'

/** AnswerMarkdown 的属性定义：正文文本、流式标志、文件提及/路径图片解析与打开文件回调。 */
export interface AnswerMarkdownProps {
  text: string
  streaming?: boolean
  labels?: MarkdownLabels
  t: Translate
  fileMentions?: MarkdownFileMentions
  pathImages?: MarkdownPathImages
  onOpenFile?: (path: string, line?: number) => void
}
/** 渲染器可读取的宿主能力（除 text/labels 外的 props，streaming 必有布尔值）。 */
type Capabilities = Omit<AnswerMarkdownProps, 'text' | 'labels'> & { streaming: boolean }
/** 向各渲染子组件下发宿主能力的 Context。 */
const Rendering = createContext<Capabilities>({ streaming: false, t: text => text })
/** 标记当前渲染是否位于链接内部：链接里的图片直接显示、不带预览按钮。 */
const InLink = createContext(false)

const math = createMathPlugin({ singleDollarTextMath: true })
/** 给 remark 插件追加 `singleTilde: false` 选项：单个 ~ 不再触发删除线，保留中文语境的普通波浪号。 */
function noSingleTilde(plugin: Pluggable): Pluggable {
  if (Array.isArray(plugin)) return [plugin[0], { ...(typeof plugin[1] === 'object' && plugin[1] !== null ? plugin[1] : {}), singleTilde: false }]
  return typeof plugin === 'function' ? [plugin, { singleTilde: false }] : plugin
}
const cjkPlugin = { ...cjk, remarkPluginsAfter: cjk.remarkPluginsAfter.map(noSingleTilde) }
const plugins = { cjk: cjkPlugin, math }
/** 本地文件链接的内部协议前缀；模型输出的 Windows/file:// 路径被改写到此前缀下。 */
const localLinkPrefix = '/__pi_answer_file__/'
/** remark 阶段遍历用的最小 Markdown AST 节点形状。 */
type MarkdownNode = { type?: string; url?: string; value?: string; title?: string | null; position?: { start?: { offset?: number }; end?: { offset?: number } }; children?: MarkdownNode[] }
/** 构建内容安全策略插件：把模型编写的 HTML 降级为纯文本，并把本地文件地址改写为内部链接。 */
function authoredContentPolicy() {
  return (tree: MarkdownNode, file: unknown) => {
    const source = String(file ?? '')
    const visit = (node: MarkdownNode) => {
      // 模型编写的 HTML 只保留为可读文本，绝不生成可执行的 DOM 节点。
      if (node.type === 'html') node.type = 'text'
      if (['link', 'definition', 'image'].includes(node.type ?? '') && node.url) {
        let destination = node.url
        if (/^[a-z]:[\\/]/iu.test(destination) && node.title == null) {
          const start = node.position?.start?.offset, end = node.position?.end?.offset
          if (start !== undefined && end !== undefined) {
            const original = source.slice(start, end)
            const separator = node.type === 'definition' ? original.indexOf(']:') : original.lastIndexOf('](')
            const raw = separator < 0 ? '' : (node.type === 'definition' ? original.slice(separator + 2) : original.slice(separator + 2, -1)).trim()
            if (raw && !raw.startsWith('<') && raw.replace(/\\([!-/:-@[-`{-~])/gu, '$1') === destination) destination = raw
          }
        }
        if (/^[a-z]:[\\/]/iu.test(destination) || /^file:\/\//iu.test(destination)) node.url = localLinkPrefix + encodeURIComponent(destination)
      }
      node.children?.forEach(visit)
    }
    visit(tree)
  }
}
/** remark 插件链：默认插件（gfm 关闭单波浪号）+ 内容安全策略。 */
const remarkPlugins: PluggableList = [...Object.entries(defaultRemarkPlugins).map(([name, plugin]) => name === 'gfm' ? noSingleTilde(plugin) : plugin), authoredContentPolicy]
/** rehype 插件链：sanitize 防 XSS。 */
const rehypePlugins: PluggableList = [defaultRehypePlugins.sanitize]
/** 把以 localLinkPrefix 开头的内部链接还原为原始的本地文件地址；非法编码返回空串。 */
function restoreFileDestination(value: string): string {
  if (!value.startsWith(localLinkPrefix)) return value
  try {
    const decoded = decodeURIComponent(value.slice(localLinkPrefix.length))
    return /^[a-z]:[\\/]|^file:\/\//iu.test(decoded) ? decoded : value
  } catch { return '' }
}
/** 递归提取 ReactNode 中的纯文本（仅字符串/数字/数组），用于代码块文本比较。 */
export function extractCodeText(node: ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(extractCodeText).join('')
  return ''
}

/** Markdown 代码渲染：无 data-block 的按行内代码处理（非流式时解析文件提及卡片），否则按块级渲染 Mermaid 图或代码块。 */
function MarkdownCode({ children, className, ...props }: ComponentProps<'code'> & { 'data-block'?: boolean }) {
  const { streaming, fileMentions, t } = useContext(Rendering)
  const insideLink = useContext(InLink)
  const text = extractCodeText(children)
  if (!('data-block' in props)) {
    const mention = !streaming && !insideLink ? fileMentions?.resolve(text) : undefined
    if (mention) return <button type="button" className={css.fileLink} title={mention.title} aria-label={mention.label} onClick={mention.open}><MessageFileIcon path={mention.title} />{text}</button>
    return <code className={css.inlineCode}>{children}</code>
  }
  const language = /(?:^|\s)language-([^\s]+)/u.exec(className ?? '')?.[1] ?? 'text'
  const code = text.replace(/\n+$/u, '')
  return /^(mermaid|mmd)$/iu.test(language) ? <MessageDiagram source={code} streaming={streaming} t={t} />
    : <MessageCodeBlock code={code} language={language} streaming={streaming} t={t} />
}
/** Markdown 链接渲染：http(s) 新窗口打开、锚点就地跳转、内部文件链接转打开文件按钮，其余仅渲染文本。 */
function MarkdownLink({ href, children }: ComponentProps<'a'>) {
  const { streaming, onOpenFile } = useContext(Rendering)
  const target = restoreFileDestination(href ?? '')
  const content = <InLink.Provider value>{children}</InLink.Provider>
  if (safeAnswerUrl(target)) return <a className={css.link} href={target} target={/^https?:/iu.test(target) ? '_blank' : undefined} rel="noopener noreferrer">{content}</a>
  if (/^#[\w-]+$/u.test(target)) return <a className={css.link} href={target}>{content}</a>
  const file = streaming ? undefined : parseAnswerFileLink(target)
  return file && onOpenFile ? <button type="button" className={css.fileLink} title={file.path} onClick={() => onOpenFile(file.path, file.line)}><MessageFileIcon path={file.path} />{content}</button> : <>{content}</>
}
/** Markdown 图片渲染：解析实际图片源，加载失败显示占位；点击缩略图在画廊内打开大图预览。 */
function MarkdownImage({ src, alt }: ComponentProps<'img'>) {
  const { pathImages, streaming, t } = useContext(Rendering)
  const insideLink = useContext(InLink)
  const [open, setOpen] = useState(false)
  const [failedSource, setFailedSource] = useState<string>()
  const [loadedSource, setLoadedSource] = useState<string>()
  const [images, setImages] = useState<PreviewImage[]>([])
  const [initial, setInitial] = useState(0)
  const authored = restoreFileDestination(src ?? '')
  const target = resolvedImageSource(authored, streaming ? undefined : pathImages?.resolve)
  useEffect(() => { setOpen(false) }, [target])
  if (!target || failedSource === target) return <span className={css.imageFallback} role="img" aria-label={alt ? t(`图片不可用：${alt}`, `Image unavailable: ${alt}`) : t('图片不可用', 'Image unavailable')} title={authored}><ImageOff size={24} aria-hidden="true" /></span>
  const image = <img key={target} className={css.image} src={target} alt={alt ?? ''} loading="lazy" draggable={false} onLoad={() => setLoadedSource(target)} onError={() => setFailedSource(target)} />
  if (insideLink) return image
  return <>
    <button type="button" className={css.imageButton} data-image-thumbnail-trigger data-loading={loadedSource !== target || undefined} onClick={event => {
      const gallery = event.currentTarget.closest('[data-markdown-image-gallery]')
      const buttons = gallery ? [...gallery.querySelectorAll<HTMLButtonElement>('button[data-image-thumbnail-trigger]')] : [event.currentTarget]
      const items = buttons.map(button => { const image = button.querySelector('img')!; return { src: image.src, alt: image.alt } })
      setImages(items); setInitial(Math.max(0, buttons.indexOf(event.currentTarget))); setOpen(true)
    }} aria-label={alt ? t(`预览图片：${alt}`, `Preview image: ${alt}`) : t('预览图片', 'Preview image')}>{loadedSource !== target && <span className={css.imageLoading} role="status" aria-label={t('正在加载图片', 'Loading image')}><ImageIcon size={24} aria-hidden="true" /></span>}{image}</button>
    <ImagePreview open={open} onClose={() => setOpen(false)} images={images} initial={initial} t={t} />
  </>
}
/** 段落渲染：若段内全是图片（多张）则改为并排画廊容器，交给图片预览联动。 */
function Paragraph({ children, node: _node, ...props }: ComponentProps<'p'> & { node?: unknown }) {
  const meaningful = Children.toArray(children).filter(child => typeof child !== 'string' || child.trim() !== '')
  const gallery = meaningful.length >= 2 && meaningful.every(child => isValidElement(child) && (child.props as { node?: { tagName?: string } }).node?.tagName === 'img')
  return gallery ? <div className={css.gallery} data-markdown-image-gallery>{meaningful}</div> : <p className={css.paragraph} {...props}>{children}</p>
}
/** 表格渲染：转交 MarkdownTable 统一样式与翻译。 */
function Table({ children }: ComponentProps<'table'>) {
  const { t } = useContext(Rendering)
  return <MarkdownTable t={t}>{children}</MarkdownTable>
}
/** 各类 Markdown 元素到本地样式的组件映射（标题/列表/引用/分隔线等）。 */
const components = {
  p: Paragraph, code: MarkdownCode, a: MarkdownLink, img: MarkdownImage, table: Table,
  h1: ({ children }: ComponentProps<'h1'>) => <h1 className={css.h1}>{children}</h1>,
  h2: ({ children }: ComponentProps<'h2'>) => <h2 className={css.h2}>{children}</h2>,
  h3: ({ children }: ComponentProps<'h3'>) => <h3 className={css.h3}>{children}</h3>,
  h4: ({ children }: ComponentProps<'h4'>) => <h4 className={css.h4}>{children}</h4>,
  h5: ({ children }: ComponentProps<'h5'>) => <h5 className={css.h5}>{children}</h5>,
  h6: ({ children }: ComponentProps<'h6'>) => <h6 className={css.h6}>{children}</h6>,
  strong: ({ children }: ComponentProps<'strong'>) => <strong className={css.strong}>{children}</strong>,
  ul: ({ children }: ComponentProps<'ul'>) => <ul className={css.unordered}>{children}</ul>,
  ol: ({ children, start }: ComponentProps<'ol'>) => <ol className={css.ordered} start={start}>{children}</ol>,
  li: ({ children }: ComponentProps<'li'>) => <li className={css.item}>{children}</li>,
  blockquote: ({ children }: ComponentProps<'blockquote'>) => <blockquote className={css.quote}>{children}</blockquote>,
  hr: () => <hr className={css.rule} />,
} as Components
/** 渲染错误边界：Markdown 解析异常时回退显示原始文本，text 变化后自动恢复渲染。 */
class MarkdownBoundary extends Component<{ children: ReactNode; text: string }, { failed: boolean }> {
  state = { failed: false }
  static getDerivedStateFromError() { return { failed: true } }
  componentDidCatch(error: Error) { console.warn('Answer markdown failed', error) }
  componentDidUpdate(previous: Readonly<{ children: ReactNode; text: string }>) {
    if (this.state.failed && previous.text !== this.props.text) this.setState({ failed: false })
  }
  render() { return this.state.failed ? <div className={css.fallback}>{this.props.text}</div> : this.props.children }
}

/**
 * 功能：会话回复的 Markdown 渲染器——以 Streamdown 渲染模型输出（标题/列表/表格/
 * 代码块/Mermaid 图/数学公式/图片画廊/文件链接），流式时解析未完成的语法。
 * @param props text 正文；streaming 是否流式输出中；t 翻译函数；fileMentions/pathImages
 *              宿主侧的文件提及与图片路径解析器；onOpenFile 打开文件回调。
 * 内部逻辑：渲染函数集稳定不变，宿主能力（streaming、解析器、回调）经 Rendering
 * Context 传入，避免流式期间每个块重挂载；text 先经 normalizeImageParagraphs 归一，
 * remark 阶段做 HTML 降级与本地文件改写，rehype sanitize 防 XSS；异常由
 * MarkdownBoundary 兜底为原始文本。memo 化减少重渲染。
 */
export const AnswerMarkdown = memo(function AnswerMarkdown({ text, streaming = false, t, fileMentions, pathImages, onOpenFile }: AnswerMarkdownProps) {
  const normalizedText = useMemo(() => normalizeImageParagraphs(text), [text])
  const capabilities = useMemo(() => ({ streaming, t, fileMentions, pathImages, onOpenFile }), [streaming, t, fileMentions, pathImages, onOpenFile])
  return <Rendering.Provider value={capabilities}><MarkdownBoundary text={text}>
    <Streamdown className={css.markdown} mode={streaming ? 'streaming' : 'static'} parseIncompleteMarkdown={streaming}
      components={components} plugins={plugins} remarkPlugins={remarkPlugins} rehypePlugins={rehypePlugins}
      linkSafety={{ enabled: false }} animated={false} isAnimating={false} controls={false}>{normalizedText}</Streamdown>
  </MarkdownBoundary></Rendering.Provider>
})
