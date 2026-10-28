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

export interface AnswerMarkdownProps {
  text: string
  streaming?: boolean
  labels?: MarkdownLabels
  t: Translate
  fileMentions?: MarkdownFileMentions
  pathImages?: MarkdownPathImages
  onOpenFile?: (path: string, line?: number) => void
}
type Capabilities = Omit<AnswerMarkdownProps, 'text' | 'labels'> & { streaming: boolean }
const Rendering = createContext<Capabilities>({ streaming: false, t: text => text })
const InLink = createContext(false)

const math = createMathPlugin({ singleDollarTextMath: true })
function noSingleTilde(plugin: Pluggable): Pluggable {
  if (Array.isArray(plugin)) return [plugin[0], { ...(typeof plugin[1] === 'object' && plugin[1] !== null ? plugin[1] : {}), singleTilde: false }]
  return typeof plugin === 'function' ? [plugin, { singleTilde: false }] : plugin
}
const cjkPlugin = { ...cjk, remarkPluginsAfter: cjk.remarkPluginsAfter.map(noSingleTilde) }
const plugins = { cjk: cjkPlugin, math }
const localLinkPrefix = '/__pi_answer_file__/'
type MarkdownNode = { type?: string; url?: string; value?: string; title?: string | null; position?: { start?: { offset?: number }; end?: { offset?: number } }; children?: MarkdownNode[] }
function authoredContentPolicy() {
  return (tree: MarkdownNode, file: unknown) => {
    const source = String(file ?? '')
    const visit = (node: MarkdownNode) => {
      // HTML authored by the model remains readable text, never an executable DOM node.
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
const remarkPlugins: PluggableList = [...Object.entries(defaultRemarkPlugins).map(([name, plugin]) => name === 'gfm' ? noSingleTilde(plugin) : plugin), authoredContentPolicy]
const rehypePlugins: PluggableList = [defaultRehypePlugins.sanitize]
function restoreFileDestination(value: string): string {
  if (!value.startsWith(localLinkPrefix)) return value
  try {
    const decoded = decodeURIComponent(value.slice(localLinkPrefix.length))
    return /^[a-z]:[\\/]|^file:\/\//iu.test(decoded) ? decoded : value
  } catch { return '' }
}
export function extractCodeText(node: ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(extractCodeText).join('')
  return ''
}

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
function MarkdownLink({ href, children }: ComponentProps<'a'>) {
  const { streaming, onOpenFile } = useContext(Rendering)
  const target = restoreFileDestination(href ?? '')
  const content = <InLink.Provider value>{children}</InLink.Provider>
  if (safeAnswerUrl(target)) return <a className={css.link} href={target} target={/^https?:/iu.test(target) ? '_blank' : undefined} rel="noopener noreferrer">{content}</a>
  if (/^#[\w-]+$/u.test(target)) return <a className={css.link} href={target}>{content}</a>
  const file = streaming ? undefined : parseAnswerFileLink(target)
  return file && onOpenFile ? <button type="button" className={css.fileLink} title={file.path} onClick={() => onOpenFile(file.path, file.line)}><MessageFileIcon path={file.path} />{content}</button> : <>{content}</>
}
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
function Paragraph({ children, node: _node, ...props }: ComponentProps<'p'> & { node?: unknown }) {
  const meaningful = Children.toArray(children).filter(child => typeof child !== 'string' || child.trim() !== '')
  const gallery = meaningful.length >= 2 && meaningful.every(child => isValidElement(child) && (child.props as { node?: { tagName?: string } }).node?.tagName === 'img')
  return gallery ? <div className={css.gallery} data-markdown-image-gallery>{meaningful}</div> : <p className={css.paragraph} {...props}>{children}</p>
}
function Table({ children }: ComponentProps<'table'>) {
  const { t } = useContext(Rendering)
  return <MarkdownTable t={t}>{children}</MarkdownTable>
}
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
class MarkdownBoundary extends Component<{ children: ReactNode; text: string }, { failed: boolean }> {
  state = { failed: false }
  static getDerivedStateFromError() { return { failed: true } }
  componentDidCatch(error: Error) { console.warn('Answer markdown failed', error) }
  componentDidUpdate(previous: Readonly<{ children: ReactNode; text: string }>) {
    if (this.state.failed && previous.text !== this.props.text) this.setState({ failed: false })
  }
  render() { return this.state.failed ? <div className={css.fallback}>{this.props.text}</div> : this.props.children }
}

/** Stable renderer functions read changing host capabilities through context, without remounting every stream block. */
export const AnswerMarkdown = memo(function AnswerMarkdown({ text, streaming = false, t, fileMentions, pathImages, onOpenFile }: AnswerMarkdownProps) {
  const normalizedText = useMemo(() => normalizeImageParagraphs(text), [text])
  const capabilities = useMemo(() => ({ streaming, t, fileMentions, pathImages, onOpenFile }), [streaming, t, fileMentions, pathImages, onOpenFile])
  return <Rendering.Provider value={capabilities}><MarkdownBoundary text={text}>
    <Streamdown className={css.markdown} mode={streaming ? 'streaming' : 'static'} parseIncompleteMarkdown={streaming}
      components={components} plugins={plugins} remarkPlugins={remarkPlugins} rehypePlugins={rehypePlugins}
      linkSafety={{ enabled: false }} animated={false} isAnimating={false} controls={false}>{normalizedText}</Streamdown>
  </MarkdownBoundary></Rendering.Provider>
})
