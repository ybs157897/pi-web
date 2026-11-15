import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App.tsx'
import '../../vendor/dsh-theme/base.css'
import '../../vendor/dsh-theme/brand-font.css'
import '../../vendor/dsh-theme/corner-shape.css'
import '../../vendor/dsh-theme/design-platform.css'
import '../../vendor/dsh-theme/focus.css'
import '../../vendor/dsh-theme/gradient-shadow-text.css'
import '../../vendor/dsh-theme/scrollbar.css'
import '../../vendor/dsh-theme/shiki.css'
import './styles.css'

// 应用入口：先加载 DSH 主题样式与全局样式，再把 <App /> 挂到 #root。
const root = document.getElementById('root')
if (root === null) throw new Error('Missing application root')

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
