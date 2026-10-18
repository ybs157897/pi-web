const HTML_PREVIEW_POLICY = "default-src 'none'; base-uri 'none'; connect-src 'none'; form-action 'none'; frame-src 'none'; img-src data:; font-src data:; media-src data:; navigate-to 'none'; object-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; worker-src 'none'"

/** Prefix untrusted HTML with a policy that allows only inline assets and scripts. */
export function sandboxedHtml(source: string): string {
  return `<!doctype html><meta http-equiv="Content-Security-Policy" content="${HTML_PREVIEW_POLICY}"><meta name="referrer" content="no-referrer">${source}`
}

/** Accept only same-origin workspace asset routes for in-page file rendering. */
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

