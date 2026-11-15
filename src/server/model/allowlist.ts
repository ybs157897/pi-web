/** 脚本化演示 Provider 的标识：无论白名单怎么配置，演示模型始终保持可选。 */
export const DEMO_MODEL_PROVIDER = 'pi-web-demo'

/** 判定一个模型所需的最小身份信息。 */
type ModelIdentity = { provider: string; modelId: string }

/**
 * 功能：判断一个模型是否通过项目模型白名单。
 * @param allowlist 白名单条目列表，undefined 或空数组表示不过滤任何模型
 * @param model 待判定的模型身份（provider/modelId）
 * @returns 通过白名单返回 true；演示 Provider 恒为 true，保证脚本化演示始终可用
 * 内部逻辑：条目以 `*` 结尾时按前缀匹配，否则要求 `provider/modelId` 完全相等。
 */
export function modelWithinAllowlist(allowlist: readonly string[] | undefined, model: ModelIdentity): boolean {
  if (model.provider === DEMO_MODEL_PROVIDER) return true
  if (!allowlist || allowlist.length === 0) return true
  const full = `${model.provider}/${model.modelId}`
  return allowlist.some(entry => entry.endsWith('*') ? full.startsWith(entry.slice(0, -1)) : full === entry)
}

/**
 * 功能：校验一条白名单条目的语法是否合法。
 * @param entry 待校验的条目字符串
 * @returns 合法返回 true
 * 内部逻辑：格式须为 `provider/modelId`，可选地以 `*` 结尾表示前缀通配；`*` 出现在其他
 * 位置、含空白、超长（>200 字符）或缺少分隔符均视为非法。
 */
export function isValidAllowlistEntry(entry: string): boolean {
  if (entry.length === 0 || entry.length > 200 || /\s/u.test(entry)) return false
  const star = entry.indexOf('*')
  if (star !== -1 && star !== entry.length - 1) return false
  const pattern = star === entry.length - 1 ? entry.slice(0, -1) : entry
  const slash = pattern.indexOf('/')
  return slash > 0 && slash < pattern.length - 1
}

/**
 * 功能：把用户输入的白名单归一化为设置路由落盘保存的形状。
 * @param entries 原始条目列表
 * @returns 去除首尾空白、剔除空项并按输入顺序去重后的条目列表
 */
export function normalizeModelAllowlist(entries: readonly string[]): string[] {
  const seen = new Set<string>()
  const normalized: string[] = []
  for (const entry of entries) {
    const value = entry.trim()
    if (value === '' || seen.has(value)) continue
    seen.add(value)
    normalized.push(value)
  }
  return normalized
}
