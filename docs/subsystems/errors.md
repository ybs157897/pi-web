# 错误与异常清单

这份文档汇总用户在界面上可能遇到的错误，说明它在哪里出现、当前文案是什么、用户应该做什么。**遇到新错误就往对应分类里补一条**，编号只增不复用。

## 分层

错误按来源分四层，越靠下越靠近用户：

| 层 | 位置 | 谁能看到 | 现有分类 |
|---|---|---|---|
| 网络层 | 浏览器 fetch | 前端 | 本文 §1 |
| 接口层 | HTTP 响应 `{ error, code, failure }` | 前端 | §2（服务端错误码）、§3（模型失败） |
| 会话层 | `ConversationFailure` | 收件箱邮件、工作项、失败协议 | §3 |
| 呈现层 | 各页面自己的 `error` 状态 | 前端 | §4 |

`ConversationFailure` 是跨层协议，定义在 `src/shared/conversation-failure.ts`，服务端与前端共用。

---

## §1 网络层

这一类由浏览器在发请求时就失败，服务端完全没收到。统一在 `src/web/api.ts` 的 `fetchOrThrow` 里翻译，避免英文原文漏给用户。

| 编号 | 触发条件 | 浏览器原文 | 当前文案 | 用户该做什么 |
|---|---|---|---|---|
| N1 | 后端进程未启动 / 端口不对 / 连接被拒 | `Failed to fetch`（Chrome）、`Load failed`（Safari） | 连不上服务：请确认后端进程仍在运行，或刷新页面重试。 | 检查服务是否在跑；重启后刷新 |
| N2 | 请求被主动中止（切页、卸载组件） | `The operation was aborted` | 请求已取消 | 无需处理 |
| N3 | 断网 / DNS 失败 | 同 N1 | 同 N1 | 检查网络后重试 |
| N4 | 响应体不是 JSON | — | 服务器返回了无法读取的数据 | 多半是服务端崩溃或返回了 HTML 错误页，看后端日志 |
| N5 | 非 2xx 且 body 无 `error` 字段 | — | 请求失败（<状态码>） | 按状态码判断：4xx 查请求参数，5xx 看后端日志 |

**未覆盖**：请求超时目前不会自动中止（没有全局 timeout），长请求会一直挂着。如果以后加超时，在这里补一条。

---

## §2 接口层：服务端错误码

HTTP 非 2xx 且 body 带 `{ error, code }` 时，`apiFailure` 直接透出 `body.error`（服务端写好的中文），`code` 供调用方分支。

按出现频率（全仓运行时抛出次数）：

| 错误码 | 次数 | 典型触发 | 用户可见文案来源 |
|---|---|---|---|
| `INVALID_INPUT` | 147 | 参数格式不对、schema 校验失败 | 各工具/接口自己写的中文 |
| `NOT_FOUND` | 71 | 会话 / 工作项 / 文件不存在 | 同上 |
| `PLUGIN_SOURCE_INVALID` | 58 | 插件源不合法 | 插件子系统 |
| `CONFLICT` | 51 | 并发写、重放指纹不一致、状态已变化 | 同上 |
| `FORBIDDEN` | 27 | 路径越界、符号链接、权限不足 | 同上 |
| `UNSUPPORTED` | 24 | 平台能力缺失（如非 macOS 的写入沙盒） | 同上 |
| `PROVIDER_ERROR` | 17 | 模型服务报错（转发给 §3 分类） | 经 `providerFailure` 归类 |
| `MODEL_UNAVAILABLE` | 17 | 模型未配置 / 不可用 | 固定文案，见 §3 |
| `PLUGIN_NOT_FOUND` / `MARKETPLACE_NOT_FOUND` | 6 / 6 | 插件或市场不存在 | 插件子系统 |
| `PLUGIN_UI_UNAVAILABLE` | 5 | 插件页面不可用 | 插件子系统 |
| `ACCESS_DENIED` | 1 | 只读会话调用了写工具 | 权限子系统 |
| `PLAN_BLOCKED` | 1 | 计划模式下调了非白名单工具 | 计划模式 |

---

## §3 会话层：`ConversationFailure`

定义在 `src/shared/conversation-failure.ts`，11 个错误码，每条带 `message`（固定中文）、`action`（`retry` / `check_model` / `compact`）、`retryable`。

| 错误码 | 文案 | 动作 | 出现在 |
|---|---|---|---|
| `MODEL_UNAVAILABLE` | 当前模型不可用，请选择可用的模型后继续。 | 检查模型 | 会话、工作项、收件箱异常信 |
| `MODEL_AUTH_FAILED` | 模型服务拒绝了请求，请检查服务商凭据、账户权限或切换模型后继续。 | 检查模型 | 同上 |
| `MODEL_RATE_LIMITED` | 模型服务限流（429），本轮已停止。请稍后重试，或切换模型后继续。 | 重试 | 同上 |
| `MODEL_QUOTA_EXCEEDED` | 当前账户的模型额度不足，请检查额度或切换模型后继续。 | 检查模型 | 同上 |
| `MODEL_TIMEOUT` | 模型请求超时，请稍后重试，或切换模型后继续。 | 重试 | 同上 |
| `MODEL_CONNECTION_FAILED` | 无法连接模型服务，请检查服务地址和网络，或切换模型后继续。 | 检查模型 | 同上 |
| `MODEL_CONTEXT_LIMIT` | 会话内容超出模型上下文限制，请压缩会话或切换支持更长上下文的模型。 | 压缩 | 同上 |
| `MODEL_PROVIDER_FAILED` | 模型服务未能完成本轮请求，请重试，或检查模型配置后继续。 | 重试 | 同上 |
| `WORKBENCH_TIMEOUT` | 此工作项已达到 15 分钟执行上限。你可以从已保存的进度继续。 | 重试 | 工作项 |
| `CONVERSATION_INTERRUPTED` | 本轮执行已经停止，可以从已保存的会话继续。 | 重试 | 会话、工作项 |
| `CONVERSATION_FAILED` | 本轮执行未完成，可以根据已保存的工作进度继续。 | 重试 | 会话、工作项 |

分类逻辑在 `src/server/conversation/failure.ts` 的 `classifyProviderFailure`：按 HTTP 状态码（401/403/402/429/408/504）和错误消息正则（`insufficient_quota`、`rate_limit`、`context_length_exceeded`、`econnrefused` 等）判定，兜底 `MODEL_PROVIDER_FAILED`。

---

## §4 呈现层：各页面的错误位

| 位置 | 渲染点 | 现状 |
|---|---|---|
| Agent 工作台（整页） | `AgentWorkbench.tsx:331` `.loadError` | 显示 `error` + 「重试」按钮；`error` 来自 `useWorkbench` 的 `cause.message`（已被 §1 覆盖） |
| Agent 工作台（单条派发） | `AgentWorkbench.tsx:363` | 显示 `message.error`，来自服务端派发失败 |
| 工作项卡片 | `WorkbenchItemStatus` | `item.error` → 「执行异常」；`CONVERSATION_INTERRUPTED` → 「已停止」 |
| 收件箱邮件 | `InboxPage.tsx` 列表 / 详情 | `listError` / `detailError`，同样来自 `cause.message` |
| 会话转录 | `ConversationFailureNotice` | 展示完整 `failure`，带「重试 / 去处理异常」按钮 |
| 设置页 / 插件 / 自动化 / Hooks 等 | 各自 `setError` | 均为 `cause instanceof Error ? cause.message : fallback` |

**共性缺陷**：这些位置全都信任 `cause.message` 已经可读。§1 保证网络层的 `cause` 是中文，但**其他未经过 `api.request` 的异常仍会透出英文**（例如浏览器 API、第三方库）。遇到就补一条。

---

## 更新规则

1. 新错误先判断属于哪一层，补进对应表格
2. 编号同层内递增（N1、N2…、F1、F2…）
3. 必须写清「触发条件」「用户看到的文案」「用户该做什么」三项
4. 如果只是修了文案，把「当前文案」列更新掉，保留编号
