/** 裸输入（无协议）：仅接受本地 host + 可选端口 + 可选 path/query 尾巴，其余（如 example.com）不强行套 localhost。 */
const BARE_LOCAL_PATTERN = /^(?:(?:[a-z0-9_-]+\.)+localhost|localhost|127(?:\.\d{1,3}){3}|\[::1\])(?::\d{1,5})?(?:[/?#].*)?$/i

/** localhost 与其子域、127.0.0.0/8、::1（URL.hostname 对 IPv6 保留方括号）。 */
function isLocalHostname(hostname: string): boolean {
  const host = hostname.toLowerCase()
  if (host === '[::1]') return true
  if (host === 'localhost' || host.endsWith('.localhost')) return true
  if (!/^127(?:\.\d{1,3}){3}$/.test(host)) return false
  return host.split('.').every(octet => Number(octet) <= 255)
}

/**
 * 把地址栏输入收敛成本地 URL；不是本地地址或无法解析时返回 null。
 * 裸输入补 http:// 与默认端口 80（href 里 80 作为默认端口会被 URL 自动省略）。
 */
export function normalizeLocalUrl(input: string): string | null {
  const trimmed = input.trim()
  if (!trimmed) return null
  if (!/^https?:\/\//i.test(trimmed) && !BARE_LOCAL_PATTERN.test(trimmed)) return null
  let url: URL
  try {
    url = new URL(/^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`)
  } catch {
    return null
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
  if (!isLocalHostname(url.hostname)) return null
  return url.href
}

/** 供「在新窗口打开」等外开判断用的只读判定。 */
export function isLocalUrl(url: string): boolean {
  try {
    const parsed = new URL(url)
    return (parsed.protocol === 'http:' || parsed.protocol === 'https:') && isLocalHostname(parsed.hostname)
  } catch {
    return false
  }
}

/** 地址栏回显：URL 解析已去掉默认端口（http:80/https:443），这里再去掉纯根路径的尾斜杠。 */
export function displayUrl(url: string): string {
  try {
    const parsed = new URL(url)
    if (parsed.pathname === '/' && !parsed.search && !parsed.hash) return parsed.origin
    return parsed.href
  } catch {
    return url
  }
}
