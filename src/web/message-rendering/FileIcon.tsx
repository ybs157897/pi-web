import { FileText } from 'lucide-react'
import { useState } from 'react'
const iconUrls = import.meta.glob<string>('./icons/*.svg', { eager: true, query: '?url', import: 'default' })
const languageIcons: Record<string, string> = {
  py: 'python', python: 'python', ts: 'typescript', typescript: 'typescript', js: 'javascript', javascript: 'javascript',
  jsx: 'react', tsx: 'react', json: 'json', css: 'css', html: 'html', md: 'markdown', markdown: 'markdown',
  sh: 'console', bash: 'console', zsh: 'console', shell: 'console', go: 'go', rs: 'rust', rust: 'rust', yaml: 'yaml', yml: 'yaml', toml: 'toml', mermaid: 'mermaid', mmd: 'mermaid',
}
/**
 * 功能：按语言或文件扩展名显示对应的小图标（构建期打包 ./icons/*.svg）。
 * @param language 语言名（代码块标题栏用）
 * @param path 文件路径（缺 language 时取扩展名推断）
 * @param folder 直接显示目录图标
 * @returns 16px SVG 图标；映射未收录的回落 document 图标，SVG 加载失败回落 lucide 的通用文件图标
 */
export function MessageFileIcon({ language, path, folder = false }: { language?: string; path?: string; folder?: boolean }) {
  const [failed, setFailed] = useState(false)
  const hint = language?.toLowerCase() ?? path?.split('.').at(-1)?.toLowerCase() ?? ''
  const name = folder ? 'folder' : languageIcons[hint] ?? 'document'
  return failed ? <FileText size={16} aria-hidden="true" /> : <img src={iconUrls[`./icons/${name}.svg`]} width={16} height={16} alt="" aria-hidden="true" onError={() => setFailed(true)} style={{ flexShrink: 0 }} />
}
