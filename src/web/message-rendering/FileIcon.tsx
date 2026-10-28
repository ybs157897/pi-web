import { FileText } from 'lucide-react'
import { useState } from 'react'
const iconUrls = import.meta.glob<string>('./icons/*.svg', { eager: true, query: '?url', import: 'default' })
const languageIcons: Record<string, string> = {
  py: 'python', python: 'python', ts: 'typescript', typescript: 'typescript', js: 'javascript', javascript: 'javascript',
  jsx: 'react', tsx: 'react', json: 'json', css: 'css', html: 'html', md: 'markdown', markdown: 'markdown',
  sh: 'console', bash: 'console', zsh: 'console', shell: 'console', go: 'go', rs: 'rust', rust: 'rust', yaml: 'yaml', yml: 'yaml', toml: 'toml', mermaid: 'mermaid', mmd: 'mermaid',
}
export function MessageFileIcon({ language, path, folder = false }: { language?: string; path?: string; folder?: boolean }) {
  const [failed, setFailed] = useState(false)
  const hint = language?.toLowerCase() ?? path?.split('.').at(-1)?.toLowerCase() ?? ''
  const name = folder ? 'folder' : languageIcons[hint] ?? 'document'
  return failed ? <FileText size={16} aria-hidden="true" /> : <img src={iconUrls[`./icons/${name}.svg`]} width={16} height={16} alt="" aria-hidden="true" onError={() => setFailed(true)} style={{ flexShrink: 0 }} />
}
