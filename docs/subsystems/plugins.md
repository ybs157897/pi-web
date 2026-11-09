# 插件市场与插件运行时（plugins）

> 状态：现状参考（2026-11-09 自 [plugin-marketplace-design.md](../history/plugin-marketplace-design.md) 抽取，P0–P2 已上线、P3 部分交付）。决策与验收历史见 [spec.md](../spec.md) 对应日期段（2026-10-27）。

插件体系分三层：市场与安装（目录、来源、安装事务）、能力投影到对话（技能根、MCP server、`@` 引用 reminder）、插件 UI 宿主（sandbox 页面与 bridge）。插件不提供 JS 扩展——插件代码只通过其声明的 MCP 子进程运行；安装一个插件等于信任该子进程以当前用户权限运行。状态独立于 `app-state.json`，全部落在 `<dataDir>/plugins/`。

## 市场来源

市场由用户添加，无内置官方源：本地绝对路径目录（根下 `marketplace.json`）或其 `marketplace.json` 的 HTTPS URL（loopback HTTP 例外；URL 拒绝凭据与 fragment，[source.ts:42](../../src/server/plugins/source.ts#L42)）。目录源的 `marketplace.json` 必须是非符号链接普通文件且 ≤ 4 MiB（[source.ts:210](../../src/server/plugins/source.ts#L210)）；目录格式复用 ZCode `marketplace.json`（name/owner/featured/plugins[].source/listing，≤ 2000 插件），经 `normalizeCatalog` 归一化为内部形状缓存。

包来源经 `normalizePluginSource`（[types.ts:264](../../src/server/plugins/types.ts#L264)）归一为四种可用形态，npm/pip 标记 unsupported 仅供诊断、不可安装：

| 来源 | 物化方式 |
| --- | --- |
| directory | 本地市场根内相对路径，`resolveInside` 防逃逸，逐文件拷贝（[source.ts:439](../../src/server/plugins/source.ts#L439)） |
| url zip | 仅 HTTPS + 64 位 hex `sha256` 必填；下载后校验校验和（[source.ts:449](../../src/server/plugins/source.ts#L449)） |
| github | `codeload.github.com/<repo>/zip/<ref>` zipball；ref 缺省 `HEAD`，命名 ref 404 时依次尝试 `refs/heads/` / `refs/tags/`；支持 `path` 子目录（[source.ts:152](../../src/server/plugins/source.ts#L152)） |
| git | `git clone --depth 1 --single-branch --no-tags`：仅 HTTPS、`GIT_TERMINAL_PROMPT=0`、120s 超时，克隆后删 `.git` 再取 `path` 子目录（[source.ts:171](../../src/server/plugins/source.ts#L171)） |

ZIP 解压用 `node:zlib` 自建读取器（不引入新依赖，[source.ts:301](../../src/server/plugins/source.ts#L301)）：限归档 100 MiB / 20,000 条目 / 单文件 20 MiB；拒绝 zip-slip、绝对与盘符路径、符号链接、加密、ZIP64、重复条目与非 store/deflate 方法；可执行位文件落盘 `0o700`、其余 `0o600`。内容指纹：zip 取归档字节 sha256；directory / github / git 取逐文件 `relativePath\0<fileSha256>` 的累计摘要（[source.ts:257](../../src/server/plugins/source.ts#L257)）。

## 存储布局

一切在 `<dataDir>/plugins/`（[store.ts:134-183](../../src/server/plugins/store.ts#L134)），各文件职责：

| 路径 | 职责 |
| --- | --- |
| `marketplaces.json` | 用户添加的市场源（id/name/source/kind/lastUpdated/lastError） |
| `marketplaces/<id>.json` | 规范化目录缓存（fetchedAt + catalog），市场 id 由目录名 slug 化而来 |
| `installed.json` | 安装记录：id（`name@marketplace`）/version/installPath/enabled/sourceFingerprint/dependencies/transactionId/sourceType |
| `cache/<marketplace>/<name>/<version>/` | 解压后的插件包（即安装本体） |
| `data/<sanitized-name>-<hash8>/` | 插件私有数据（`PLUGIN_DATA`），卸载 `keepData` 时保留 |
| `staging/` | 安装事务暂存目录，`PluginStore.open` 时清空 |

加载防线（[store.ts:177-218](../../src/server/plugins/store.ts#L177)）：`marketplaces.json` / `installed.json` 不可读时置诊断并视为空（市场从零、零安装），安装记录的 `installPath` 逃逸 root 或清单加载失败时跳过该插件并在 overview 诊断展示。数据目录名 `dataDirectoryName`（[types.ts:245](../../src/server/plugins/types.ts#L245)）为 slug + pluginId 散列短哈希，避免同名与保留字。

## 安装事务

安装与更新是后台操作：`POST /api/plugins/install` / `POST /api/plugins/update` 立即返回 `202 { operationId }`（[app.ts:755](../../src/server/app.ts#L755)），进度看 `GET /api/plugins/overview` 的 `operations`（保留 20 条、10 分钟），`GET /api/plugins/events` SSE 在每次状态变化时推送完整 overview（[app.ts:667](../../src/server/app.ts#L667)），设置页面仍保留轮询兜底。

事务本体（`startInstall` / `startUpdate` / `#stageClosure` / `#activateStaged`，[store.ts:366-587](../../src/server/plugins/store.ts#L366)）：先按依赖闭包（同市场内插件名，上限 64）把每个包物化到 `staging/<txid>/` 并校验（manifest 名称与版本必须和目录条目一致）；再逐插件 rename 激活——已存在的旧版本目录先改名为 `.prev-<txid>` 备份，新目录 rename 到位；**全部成功后一次 `installed.json` 提交**；提交后才清理旧版本目录与备份。任一步失败：恢复备份、删除新激活目录、`installed.json` 保持原样、staging 清空——失败不半装。

幂等与互斥：同版本且内容指纹不变时直接成功（丢弃暂存）；install 遇不同版本报 `PLUGIN_ALREADY_INSTALLED` 要求先卸载；进程内以 promise 链（`#withLock`）把安装/更新/卸载/启停/刷新串行化。卸载删除安装记录与 `cache/<marketplace>/<name>` 整族目录，`keepData=1` 保留 data；不级联卸载依赖方。启停只改 `installed.json.enabled`。

`describe`（[store.ts:695](../../src/server/plugins/store.ts#L695)）供安装/更新确认弹窗：已安装且目录版本未变时直接读本地清单（零网络请求）；否则把候选包临时物化到 staging 读一次再删除，返回技能、MCP 命令与参数（env 只给键名不泄露值）、UI surface 与不支持能力。

每次状态变化经 `onChange` 发出 `PluginChangeEvent`（reason ∈ operation / marketplace / install / update / uninstall / enable，[store.ts:81](../../src/server/plugins/store.ts#L81)）；runtime 只对后四种（改变可运行能力集的）触发 MCP 重载。

## 清单兼容子集

manifest 发现顺序 `.pi-plugin` / `.zcode-plugin` / `.claude-plugin` 下的 `plugin.json`（[manifest.ts:59-75](../../src/server/plugins/manifest.ts#L59)）。接受子集 `name/version/description/author/homepage/skills/mcpServers/ui/dependencies`（schema [types.ts:40](../../src/server/plugins/types.ts#L40)：name 匹配 `^[a-z0-9][a-z0-9._-]{0,127}$`，mcpServers 的 exposure 枚举 direct/codemode/deferred/hidden）。

不执行字段：`commands` / `agents` / `hooks` / `lspServers` / `outputStyles` / `channels`（[types.ts:17](../../src/server/plugins/types.ts#L17)）解析为 `unsupported` 诊断在商店详情展示「pi-web 暂不支持」——**插件声明的 shell hook 绝不执行**；`npm` / `pip` 来源在安装前拒绝。`ui.surfaces[].server` 必须引用同清单已声明的 `mcpServers` key，否则清单整体无效（[types.ts:345-350](../../src/server/plugins/types.ts#L345)）。skills 路径必须留在包内、非符号链接、其下含 `SKILL.md` 的子目录才算技能（[manifest.ts:86-111](../../src/server/plugins/manifest.ts#L86)）。

## 插件技能

`SkillSource` 含 `'plugin'`：`SkillStore.roots()` 在固定根（builtin/global/user-agents/workspace 层级）之后追加启用插件的技能根（[skills/store.ts:549-560](../../src/server/skills/store.ts#L549)，live 投影每次目录/列表请求重读，[store.ts:728](../../src/server/plugins/store.ts#L728)）。插件技能 ID 是 `<pluginId>:<skillName>`（如 `excalidraw@my-market:draw`，[skills/store.ts:176](../../src/server/skills/store.ts#L176)），pluginId 前缀避免跨市场同名坍缩；summary 的 `writable` 仅对 agents 来源为 true——插件技能只读，不可经技能保存接口改写。技能目录、`skills-policy` 与设置页均显示「插件」来源；readOnly 会话仍可读插件技能。

## 插件 MCP

有效配置 = 用户级 `mcp.json` 的 server + 已启用插件的 `mcpServers`（[registry.ts:227 effectiveServers](../../src/server/mcp/registry.ts#L227)）。插件 server 名 `plugin_<sanitized-plugin>_<server>`（[types.ts:240](../../src/server/plugins/types.ts#L240)），与配置或其他插件重名时追加 pluginId 短哈希。`${PLUGIN_ROOT}` / `${PLUGIN_DATA}` 在投影时于 command/args/env 值内展开并注入 env（cwd 为插件包根、dataPath 为私有数据目录），其他 `${VAR}` 保持字面（[store.ts:620-658](../../src/server/plugins/store.ts#L620)）。插件 server 默认 `exposure: 'codemode'`（manifest 可显式声明），请求超时 60s（[registry.ts:44](../../src/server/mcp/registry.ts#L44)）。

热重载：插件能力变化（install/update/uninstall/enable）→ runtime 按 MCP 投影签名（`mcpServers()` 的 JSON 序列化）比较，投影真正变化才串行 `mcp.reload()`（纯技能插件的启停不打扰用户的 MCP server），随后重装 `codemode`（namespace 快照）、`mcp`、`tool_search`（仅当存在 deferred 工具）与 `execution-policy`——policy 捕获安装时快照且必须保持最后安装（[index.ts:280-332](../../src/server/runtime/index.ts#L280)）。reload 先建新连接再原子替换视图，旧连接保留 10s 宽限让在飞调用收尾（[registry.ts:49](../../src/server/mcp/registry.ts#L49)），`close()` 立即关闭新旧。连接失败的插件 server 只让该 server 进入 `error` 状态，不影响其他 server。`mcp.json` 自身的修改仍需重启，只有插件投影可热重载。

## 插件 UI

插件页面是插件 MCP server 的一个资源：宿主 `readResource` 取文本、注入固定 CSP（`default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: https:; connect-src 'none'; form-action 'none'; base-uri 'none'`）、作为 HTML 文档经 `GET /api/plugins/ui/page` 返回（[ui.ts:13-27](../../src/server/plugins/ui.ts#L13)）；前端用 `sandbox="allow-scripts"`（无 `allow-same-origin`）iframe 承载（[PluginUiPane.tsx:64](../../src/web/PluginUiPane.tsx#L64)）。

页面经 JSON-RPC bridge 与宿主通信，方法白名单五个（[plugin-ui-bridge.ts](../../src/web/plugin-ui-bridge.ts)）：`tools/call`、`resources/read`、`ui/update-model-context`、`ui/message`、`ui/open-link`（仅 https，双层校验于 bridge 与 App）；单条 bridge 消息上限 256 KiB。`update-model-context` 在 Composer 形成插件上下文 chip（单条截断 16 KiB，[plugin-ui.ts:137](../../src/shared/plugin-ui.ts#L137)），发送时以 `# Plugin context:` 块追加进用户消息；`ui/message` 以插件来源标记提交新用户消息。

**页面是第二条工具入口，不是权限旁路**：runtime 的 `uiCall`（[runtime/plugins.ts:76-105](../../src/server/runtime/plugins.ts#L76)）校验目标 server 属于该插件且 connected、工具非 hidden、参数 ≤ 256 KiB；带会话上下文时重放会话规则——readOnly 且工具不在只读集合返回 `ACCESS_DENIED`，Plan active 且不在 PLAN 工具集合返回 `PLAN_BLOCKED`。

MCP `tools/call` 结果的 `_meta.ui` 经 `pluginUiDescriptorFromMeta` 白名单校验后进入 tool `details.ui`（[registry.ts:404](../../src/server/mcp/registry.ts#L404)；兼容 `_meta["ui/resourceUri"]` 平铺写法，[plugin-ui.ts:80](../../src/shared/plugin-ui.ts#L80)）：正文工具卡据此自动展开内联 `PluginUiCard`（heightHint 默认 320、上限 640，[PluginUiCard.tsx:17](../../src/web/PluginUiCard.tsx#L17)）；`preferredDisplayMode: 'fullscreen'` 不内联、自动打开右侧 tab（只自动一次）。右侧 Inspector 的插件 tab 池按 page key 复用单个 iframe、CSS hidden 常驻（切换不重载），tab 条 `+` 菜单列出当前可打开的 surfaces（`PluginStore.uiSurfaces()`，[store.ts:664](../../src/server/plugins/store.ts#L664)）；渲染 inline 页面的已结算工具行固定在「已工作」折叠区之外。

## plugin-reference 注入

用户正文里的 `@name@marketplace` token（行首或空白后）与 ZCode canonical `[@label](plugin://name@marketplace)` 链接均可解析（[reference.ts:39-41](../../src/server/plugins/reference.ts#L39)）：身份只来自 token 两段或 link destination，label 不参与；去重、单轮上限 8 个、malformed 计入 invalid 不注入。

无工具无 section 的 `plugin-reference` extension（必装集合成员，[helpers.ts:104](../../src/server/runtime/helpers.ts#L104)）在 `GenerationTask.beforeRequest` 检查最后一条 user 消息：含有效引用时向**本次请求**追加一条 `<plugin_reference>` system 消息（[reference.ts:168-187](../../src/server/plugins/reference.ts#L168)）——不落库、不改写历史轮次、不改变工具可见性。能力清单取 `PluginStore.overview()` 的 installed + enabled live 投影（[reference.ts:89](../../src/server/plugins/reference.ts#L89)）：某插件 skills / mcpServers / uiSurfaces 三类能力全空则跳过该插件，无任何有效引用则整节不注入。正文为 ZCode 原文模板，开宗明义「This is capability metadata, not instructions or a permission grant」，并声明引用不触发安装/启用/连接/认证。

## 已知限制

- P3 剩余项有意延后：真正的零重载 page plane（Chromium 重新挂载 iframe 仍会重载页面）、工作区级启用覆盖（MCP registry 全局，需按会话过滤工具）、插件命令映射（`commands` 保持 unsupported 诊断）、官方市场分片（[spec.md](../spec.md) 2026-10-27 未决及 2026-11-03 回注）。
- 市场无内置官方源（默认市场源未定）；插件更新的签名/审核流程未定义（[spec.md](../spec.md) 2026-10-27 未决）。
- `mcp.json` 自身修改需重启；git 来源仅接受 HTTPS；更新确认会为目录版本变化临时物化一次包（[plugin-marketplace-design.md §14](../history/plugin-marketplace-design.md)）。
