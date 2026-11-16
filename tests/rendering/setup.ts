import { vi } from 'vitest'
/**
 * 为 jsdom 渲染测试补齐浏览器缺失能力的环境垫片。
 *
 * jsdom 不实现（或实现不完整）以下 API，逐一 stub 掉：
 * - CSSStyleSheet.replaceSync：记录文本供样式注入断言（antd/cssinjs 需要）；
 * - ResizeObserver / IntersectionObserver：antd 组件挂载时依赖，提供空实现；
 * - matchMedia：antd 断点/主题查询依赖，固定返回不匹配；
 * - dialog 的 showModal/close：用 open 属性模拟原生对话框行为；
 * - scrollIntoView：渲染测试用不到滚动，空实现；
 * - navigator.clipboard.writeText、URL.createObjectURL/revokeObjectURL：
 *   剪贴板与导出功能依赖，返回固定的 blob 地址。
 * 每个用例的 beforeEach 调用一次。
 */
export function setupRenderingDom() {
  Object.defineProperty(CSSStyleSheet.prototype, 'replaceSync', { configurable: true, value(text: string) { Object.defineProperty(this, 'sourceText', { configurable: true, value: text }) } })
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  vi.stubGlobal('IntersectionObserver', class { observe() {} unobserve() {} disconnect() {} })
  Object.defineProperty(window, 'matchMedia', { configurable: true, writable: true, value: vi.fn(() => ({ matches: false, addEventListener() {}, removeEventListener() {} })) })
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { configurable: true, value() { this.setAttribute('open', '') } })
  Object.defineProperty(HTMLDialogElement.prototype, 'close', { configurable: true, value() { this.removeAttribute('open') } })
  Object.defineProperty(Element.prototype, 'scrollIntoView', { configurable: true, value() {} })
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: vi.fn(async () => {}) } })
  Object.defineProperty(URL, 'createObjectURL', { configurable: true, writable: true, value: vi.fn(() => 'blob:http://localhost/export') })
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, writable: true, value: vi.fn() })
}
