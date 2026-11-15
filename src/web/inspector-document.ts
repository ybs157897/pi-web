const HTML_PREVIEW_POLICY = "default-src 'none'; base-uri 'none'; connect-src 'none'; form-action 'none'; frame-src 'none'; img-src data:; font-src data:; media-src data:; navigate-to 'none'; object-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; worker-src 'none'"

/**
 * 功能：给不受信 HTML 前置一段 CSP 与 no-referrer 声明，让文档预览只能在受限环境里渲染。
 * @param source 模型生成的原始 HTML
 * @returns 拼好 doctype + CSP meta 的完整 HTML 文档字符串
 */
export function sandboxedHtml(source: string): string {
  return `<!doctype html><meta http-equiv="Content-Security-Policy" content="${HTML_PREVIEW_POLICY}"><meta name="referrer" content="no-referrer">${source}`
}

/**
 * 功能：校验资源 URL 只能指向同源的 workspace 资产路由，防止文档内渲染任意远程内容。
 * @param value 待校验的 URL（可为 undefined）
 * @param baseUrl 用于解析相对地址并确定同源基准
 * @returns 同源且路径匹配 `/api/workspaces/:id/asset` 时返回规范化 href；否则 undefined
 * 内部逻辑：相对路径以 baseUrl 补全后比较 origin；URL 解析失败（TypeError）静默拒绝，其他异常照常抛出。
 */
export function safeWorkspaceAssetUrl(value: string | undefined, baseUrl: string): string | undefined {
  if (value === undefined) return undefined
  try {
    const url = new URL(value, baseUrl)
    if (url.origin !== new URL(baseUrl).origin || !/^\/api\/workspaces\/[^/]+\/asset$/u.test(url.pathname)) return undefined
    return url.href
  } catch (error) {
    if (error instanceof TypeError) return undefined
    throw error
  }
}

