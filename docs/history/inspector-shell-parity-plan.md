# Inspector 侧栏外壳对齐 ZCode 批次计划（inspector-shell-parity）

> 历史快照（2026-11-09 冻结）：已完结批次的点时文档，不是现状权威。现状参考见 [docs/subsystems/](../subsystems/README.md) 或 [docs/spec.md](../spec.md)。

日期：2026-11-01。参照：本机 ZCode v3.16.2 源码（`~/Documents/ybs/code/work/ZCode`）。
规格来源：四份探索报告（GitPane / 侧栏外壳 / 浏览器+划词+轨迹 / pi-web 现状接线），关键结论已内化到本文，原始行号见报告。

## 目标

pi-web 右侧 Inspector 对齐 ZCode side pane 的交互形态：

1. **多文档 tab 常驻**：file/diff/plan 从单文档槽改为真实 tab（重复打开同一来源 = 聚焦 + 更新，ZCode code-viewer 语义）。
2. **新标签页 hub**：`+` 打开「新标签页」launcher（内置入口 + 插件推荐区），launcher 被打开的内容**原地替换**（ZCode `commitOpenedSidePaneState` 语义）。
3. **全屏切换**：tab 条右侧 Maximize/Minimize 切换，面板覆盖整个主行；`Cmd/Ctrl+Shift+F`。
4. **审查（GitPane）独立面板**：来源下拉（未暂存/已暂存/分支差异/本轮更改）+ 刷新 + 32px 文件行（懒加载 diff、单开、按 `sourceId:path` 缓存）。
5. **浏览器 tab**（降级实现）：限 localhost/127.0.0.1/[::1] 的 iframe 应用预览，地址栏 + 会话内历史栈 + 空态「粘贴或输入 URL 以打开网页」。
6. **模型轨迹面板**：消费既有 `GET /api/conversations/:id/trajectory`（NDJSON），调用卡片时间线。
7. **划词侧聊**：transcript 选区浮动「在侧聊中提问」+ hub 入口「辅助对话」，轻量会话 tab（轮询 feed）。

## 非目标（本批次明确不做）

- 终端 tab（用户明确排除）；browser-use（agent 受控浏览器）；browser-permissions 页；开发者工具；whiteboard；workflow 六件套；treemapping。
- tab 拖拽排序、tab 概览/搜索 Popover、最近关闭列表（记 follow-up）。
- 全屏视图的「对话」surface 与 floating 抽屉（ZCode full view 的 conversation surface 需要搬移真实对话宿主，本批次全屏 = 面板覆盖主行，Esc/再点退出）。
- localStorage 持久化（ZCode 也是内存 per-workspace LRU，重启即失，保持一致）。
- GitPane 内 stage/unstage/commit（ZCode 也在面板外，pi-web 已有状态卡提交流）。
- file-change 全局查找浮层（Cmd+F 查找）——记 follow-up。

## 术语与判定

- tab 判重：同 id 存在 = 聚焦 + 更新 payload（不开新 tab）。id 形状见下方契约。
- 关闭最后一个 tab → 面板收起（`inspectorOpen=false`），与 ZCode `commitSidePaneState` 一致。
- 会话切换（`selectedId` 变化）：移除 `plugin/subagent/trajectory/selection-chat` 类 tab（既有「插件页属于会话」语义的扩展）；`document/browse/git/browser/new-tab` 保留（workspace 作用域）。
- 关闭激活 tab 的激活回退：**右侧邻位**，右端超出则左邻，空则收面板（ZCode `closeSidePaneTab` 兜底）。

## 契约（所有子任务必须逐字实现）

### `src/web/inspector-tabs.ts`（E1，纯模型，无 React）

```ts
export type InspectorTabType =
  | 'document' | 'browse' | 'git' | 'browser' | 'trajectory'
  | 'selection-chat' | 'plugin' | 'subagent' | 'subagents' | 'new-tab'

export interface TabFile { path: string; content?: string; mimeType?: string; language?: string
  line?: number; size?: number; workspaceId?: string; url?: string }
export interface TabDiff { path: string; oldText?: string | null; newText?: string; diff?: string }
export type DocumentDoc =
  | { kind: 'file'; file: TabFile }
  | { kind: 'diff'; diff: TabDiff }
  | { kind: 'plan' }

export interface InspectorTab {
  id: string
  type: InspectorTabType
  title: string
  openedAt: number
  /** document */
  doc?: DocumentDoc
  /** browse */
  workspaceId?: string
  /** plugin（引用 App 的 pluginPages 页 id） */
  pageId?: string
  /** subagent */
  childId?: string
  /** trajectory / selection-chat */
  conversationId?: string
  /** selection-chat */
  ordinal?: number
  /** browser */
  url?: string
  /** browser 当前输入框草稿（可选，切换 tab 不丢） */
  addressDraft?: string
}

export interface PaneState { tabs: InspectorTab[]; activeTabId: string | null }

// —— workspace 级内存记忆（模块级 Map，LRU 50，无 localStorage）——
export function readPaneMemory(workspaceId: string): PaneState | null
export function writePaneMemory(workspaceId: string, state: PaneState): void

// —— 纯操作（全部返回新 PaneState，不改入参）——
export function activateTab(state: PaneState, id: string): PaneState
/** 批量关闭；返回回退激活 id（关闭区间右侧第一个幸存者，否则左侧；null=无 tab） */
export function closeTabs(state: PaneState, ids: readonly string[]): { state: PaneState; activeId: string | null }
export function closeOtherTabs(state: PaneState, id: string): PaneState
export function closeAllTabs(state: PaneState): PaneState // tabs: []，activeTabId: null
/** 按 id 幂等打开：存在则替换 payload 并激活（保持位置），不存在则 append 并激活 */
export function upsertTab(state: PaneState, tab: InspectorTab): PaneState
/** launcher 原地替换语义：若激活 tab 是 new-tab 且新 tab 非 new-tab，则新 tab 替换其位置；否则 upsertTab */
export function openFromLauncher(state: PaneState, tab: InspectorTab): PaneState
export function reorderTab(state: PaneState, fromId: string, toIndex: number): PaneState
/** 同会话 selection-chat 的最小未用正整数 ordinal */
export function nextSelectionChatOrdinal(state: PaneState): number
/** 归一：去重 id、activeTabId 失效时回退最后一个 tab、空则 null */
export function normalizePaneState(state: PaneState | null): PaneState | null
/** 会话作用域类型集合（切换会话时移除） */
export const CONVERSATION_SCOPED_TYPES: readonly InspectorTabType[] // ['plugin','subagent','trajectory','selection-chat']
export function stripConversationScoped(state: PaneState): PaneState
```

tab id 形状（决定判重）：
- document：`doc:file:<workspaceId>:<path>` / `doc:diff:<workspaceId>:<path>` / `doc:plan`（plan 单例）
- browse：`browse`（单例）；git：`git`（单例）；subagents：`subagents`（单例）；new-tab：`new-tab`（单例——pi-web 只保留一个 launcher 实例，重复点 `+` = 聚焦）
- browser：`browser:<uuid>`（每次新开）；trajectory：`trajectory:<conversationId>`；selection-chat：`selection-chat:<conversationId>`；plugin：pageId 即 id；subagent：childId 即 id

### `Inspector.tsx` props 增量（E2；既有 props 全部保留）

```ts
export interface InspectorProps {
  // …既有 props 原样保留…
  /** 新外壳 */
  tabs?: readonly InspectorTab[]
  activeTabId?: string | null
  onSelectTab?: (id: string) => void
  onCloseTab?: (id: string) => void
  onCloseOtherTabs?: (id: string) => void
  onCloseAllTabs?: () => void
  onOpenNewTab?: () => void
  fullView?: boolean
  onToggleFullView?: () => void
  /** 新标签页 launcher 内容（tabs 渲染到 new-tab tab 时使用） */
  launcher?: {
    surfaces: readonly PluginUiSurfaceView[]
    surfacesLoading: boolean
    onRefreshSurfaces: () => void | Promise<void>
    onOpenSurface: (surface: PluginUiSurfaceView) => void
    onOpenFiles: () => void
    onOpenReview: () => void
    onOpenBrowser: () => void
    onOpenTrajectory: () => void
    onOpenSelectionChat: () => void
    canOpenReview: boolean   // 已开 git tab 时 launcher 隐藏 review 入口（ZCode resolveOpenTabLauncherItemIds）
    canOpenTrajectory: boolean
    canOpenSelectionChat: boolean
  }
}
```

E2 的渲染规则：
- header 变 tab 条：概览区省略；从左到右 = tab strip（flex 等宽收缩，min 60px、max 156px，ZCode SidePaneTabTrigger 尺寸）→ `+`（aria「新增标签」）→ 全屏切换（Maximize2/Minimize2，仅 `onToggleFullView` 存在时渲染）→ 关闭按钮（沿用现有 close 语义 = 关闭激活 tab）。
- tab strip：单 tab 常显标题；关闭按钮 active 常显、非 active hover/focus 显现；**中键关闭**；右键菜单（关闭标签/关闭其他/关闭所有，仅一个 tab 时「关闭其他」禁用）。
- 全屏态：根节点 class 切换为覆盖主行的 overlay（App.module.css 提供 `.inspectorFullscreen`，E2 只管自己的 css；集成时我接）。
- 内容区按 activeTabId 分发到既有渲染器：document(file/diff/plan)/browse/plugin/subagent(s) 用既有实现，payload 从 `tabs` 取（**不再读 props.file/diff/plan**——兼容：若 `tabs` 未传，退回旧单槽渲染，保证旧测试不炸）。
- git/browser/trajectory/selection-chat/new-tab 内容 = 对应子组件（E3/E4/E5/E6 交付），E2 直接 import 并渲染，props 按下方各契约传递。
- tab 常驻挂载：所有内容面板按 tab 渲染并 `hidden` 切换（延续 plugin 现行为；plugin-ui-app.test 断言切走不卸载）。
- i18n 文案对齐 ZCode zh-CN：「新标签页」「新增标签」「审查」「浏览器」「文件」「辅助对话」「模型调用轨迹」「关闭其他标签」「关闭所有标签」「粘贴或输入 URL 以打开网页」「输入网址后回车」「仅支持本地地址预览」「查看代码变更与差异」「浏览网页和预览应用」「从目录中选择一个文件」等，全走 `t(中文, 英文)` 现有模式。

### `GitPane.tsx` props（E3）

```ts
export type GitChangeSourceId = 'unstaged' | 'staged' | 'branch' | 'last-turn'
export interface LastTurnChange { path: string; added: number; removed: number
  before?: string; after?: string; kind: 'modified' | 'added' | 'deleted' | 'renamed' }
export interface GitPaneProps {
  workspaceId: string
  activeSource: GitChangeSourceId
  onSelectSource: (source: GitChangeSourceId) => void
  /** 本轮更改数据集（App 从会话 artifacts 合成；undefined = 无会话上下文） */
  lastTurnChanges?: readonly LastTurnChange[]
  onNotice: (text: string) => void
}
```

- header：来源 Select（下拉，ZCode Radix Select 形态 → pi-web 用现有 select/button 实现）+ 刷新按钮（loading 转圈）。文案：未暂存 / 已暂存 / 全部分支更改 / 上一轮更改。
- 列表：32px 行（sticky、hover 高亮、`+N`/`−N`、ChevronDown 展开旋转）、单开（`expandedPath` 单值）、切来源清空展开。
- 懒加载 diff：点击展开才请求；缓存键 `sourceId:path`；in-flight 去重。
- diff 渲染：staged/unstaged/branch 优先用 DiffBlock(oldText,newText)（服务端补全文），内容缺失或超限退 CodeBlock(patch)；untracked → ReadBlock/全文；binary/truncated/unavailable → 文案行。
- last-turn：纯客户端数据集，diff 用 before/after 本地渲染，不发请求；空数据集显示专属空态（ZCode `git.empty.lastTurnTitle` 语义：「上一轮没有文件更改」）。
- 空态优先级：last-turn 专属 > 非 git 仓库 > 通用「当前来源下没有可展示的改动」。

服务端增量（E3 一并做）：
- `src/shared/types.ts`：`GitWorktreeFile` 增加 `staged: boolean`；`GitWorktreeStatus` 增加 `trackingBranchName: string | null`；新增 `GitChangeSourceId` 导出（同上四值）。
- `src/server/workspace/git/worktree.ts`：`status()` 补 porcelain XY → staged 判定（x 列非 `.` 且非 `?`/`!`；v1 可用 `git diff --cached --name-only -z` 求交集实现）与 tracking 分支（`git rev-parse --abbrev-ref @{upstream}` 失败为 null）；`diff(path, sourceId?)`：`'staged'` → `git diff --cached --unified=3 -- path` + 内容对（`git show :path` vs `HEAD:path`，<512KB 才带）；`'branch'` → `git diff <upstream>...HEAD -- path`（无 upstream → 抛业务错误「当前分支没有上游分支」）；缺省保持现行为（`diff HEAD`，untracked 回退全文）。
- `src/server/app.ts`：`GET /api/workspaces/:id/git/diff` 增加 `sourceId` 查询参数（校验枚举）。
- `src/web/api.ts` **由集成者预埋**（E3 不要改 api.ts）：`gitWorktreeDiff(id, path, sourceId?)`。

### `BrowserPane.tsx` props（E4）

```ts
export interface BrowserPaneProps {
  tab: InspectorTab                 // url/addressDraft 可变部分经 onNavigate 回写
  onNavigate: (patch: { url?: string; addressDraft?: string; title?: string }) => void
  onNotice: (text: string) => void
}
```

- 纯本地策略：`normalizeLocalUrl(input)`（新文件 `src/web/browser-url.ts`）：接受完整 http(s) URL 或裸 `localhost:3000` / `127.0.0.1:8080` / `[::1]:5173` / `*.localhost`（无端口补 80）；结果 host 不在本地集合 → 返回 null，UI 提示「仅支持本地地址预览」并附「在新窗口打开」按钮（http/https 才可外开）。
- 工具栏：后退/前进（自建会话内历史栈，push 于每次成功提交导航）/ 刷新（remount iframe）/ 地址栏（聚焦展开、回车提交、`browser.addressPlaceholder`）/ 在新窗口打开。
- 内容：`url` 为空 → 空态「粘贴或输入 URL 以打开网页」；否则 iframe（sandbox `allow-scripts allow-same-origin allow-forms allow-popups`，referrerPolicy no-referrer）。加载中 onLoad 前显示细进度条。跨源拿不到标题 → tab 标题用 `host[:port]`；favicon 取 `origin/favicon.ico`，失败回退 Globe。
- iframe 必须常驻挂载（hidden 切换），与 ZCode `shouldMountSidePaneContent` 一致。

### `TrajectoryPane.tsx` props（E5）

```ts
export interface TrajectoryPaneProps { conversationId: string; title?: string; onNotice: (text: string) => void }
```

- 数据：`api.trajectory(id)`（集成者预埋：GET `/api/conversations/:id/trajectory` → text）。解析 NDJSON（新文件 `src/web/trajectory-view.ts`）：先读 `src/server/conversation/trajectory.ts` 摸清每行 `{type, record}` 形状（entry/task/request/response/sidecall…），面板只消费模型 IO 行（request/response/sidecall 及同类），entry/task 行忽略。
- 卡片（时间线，倒序或正序取 ZCode 正序）：序号、来源标签（主对话/旁路调用）、model、`IN x · OUT y`、时长、时钟时间；input/output 分区可展开（默认收起，仅正文与工具调用行摘要）；错误行红。
- header：标题（title 或「模型调用轨迹」）、摘要行（N 次调用 · 总 tokens）、刷新、全部展开/收起、简单子串过滤框 + 计数、关闭走外壳。
- 空态：无记录/请求失败文案。

### 划词侧聊（E6）

- `src/web/selection-quote.ts`：`buildSideChatPrompt(quote: string, question: string, source?: string)` → 引用块 + 问题的 prompt 文本（引用用 fence 包裹，标注来源路径；ZCode reference 语义）。
- `src/web/SelectionChatPane.tsx` props：
```ts
export interface SideChatMessage { role: 'user' | 'assistant'; text: string }
export interface SelectionChatPaneProps {
  conversationId: string
  title: string
  messages: readonly SideChatMessage[]
  busy: boolean
  onSend: (text: string) => void
}
```
  UI：标题行（「辅助对话 N」）、消息列表（assistant 走 MarkdownText、user 纯文本）、底部输入框（Enter 发送 / Shift+Enter 换行 / busy 禁发）。feed 由 hook 供：`src/web/use-side-conversation.ts` `useSideConversation(conversationId, enabled)` —— 2s 轮询 `api.detail`（可见时才轮询），返回 `{ messages, busy }`；不碰 SSE。
- `src/web/SelectionAskPopover.tsx`：全局 `mouseup`/`selectionchange` 监听（portal 到 body），选区非空且在 `containerRef` 内时在选区上方显示「在侧聊中提问」按钮；点击回调 `onAsk(quoteText)` 后隐藏。不依赖 transcript.tsx（集成时包一层容器）。
- 会话创建流程**由集成者实现**（App）：`api.createConversation` → `api.submit(id, { text: prompt, requestId })` → 打开 `selection-chat` tab；标题「辅助对话 N」，ordinal 取 `nextSelectionChatOrdinal`。

### 集成者预埋（派发前完成，执行者不得改这些文件）

`src/web/api.ts`：`gitWorktreeDiff` 增加 `sourceId` 参数；新增 `trajectory(id): Promise<string>`。

## 文件所有权（严格互斥）

| 子任务 | 拥有文件 |
|---|---|
| E1 | `src/web/inspector-tabs.ts`、`tests/inspector-tabs.test.ts` |
| E2 | `src/web/Inspector.tsx`、`src/web/Inspector.module.css`、`tests/inspector-shell.test.tsx` |
| E3 | `src/web/GitPane.tsx`、`src/web/GitPane.module.css`、`src/shared/types.ts`（仅 git 段）、`src/server/workspace/git/worktree.ts`、`src/server/app.ts`（仅 git diff 路由）、`tests/git-worktree.test.ts`、`tests/git-pane.test.ts` |
| E4 | `src/web/BrowserPane.tsx`、`src/web/BrowserPane.module.css`、`src/web/browser-url.ts`、`tests/browser-url.test.ts` |
| E5 | `src/web/TrajectoryPane.tsx`、`src/web/TrajectoryPane.module.css`、`src/web/trajectory-view.ts`、`tests/trajectory-view.test.ts` |
| E6 | `src/web/SelectionChatPane.tsx`、`src/web/SelectionChatPane.module.css`、`src/web/SelectionAskPopover.tsx`、`src/web/selection-quote.ts`、`src/web/use-side-conversation.ts`、`tests/selection-quote.test.ts` |
| 集成（我） | `src/web/App.tsx`、`src/web/App.module.css`、`src/web/api.ts`、`src/web/keyboard.ts`、docs |

## 验收判据

1. `npm run check`（typecheck + vitest + build）全绿。
2. 单测：tab 模型判重/回退/launcher 替换/ordinal；browser-url 本地判定；trajectory 解析；selection-quote 拼装；git worktree staged/sourceId diff；Inspector 外壳（tab 条、中键关闭、launcher、常驻挂载、旧 props 回退）。
3. UI 一比一核对（浏览器 ego，pi-web:4317 vs ZCode dev）：新标签页 hub 四/五入口与 ZCode 截图布局一致（标题、两列 grid、图标块、右侧「打开」胶囊）；tab 条形态（等宽收缩、hover 关闭、`+`、全屏钮）；GitPane 来源下拉与文件行；浏览器空态/地址栏。
4. 既有回归：`tests/plugin-ui-app.test.tsx`、`tests/subagent-pane.test.tsx`、`tests/status-panel.test.tsx`、`tests/changed-files.test.ts` 全绿（E2 的旧 props 回退路径保证）。

## 落地记录（2026-11-01 完成）

- 门禁：typecheck ✓、vitest 915 passed / 4 skipped ✓、build ✓。
- 浏览器 ego（pi-web:4317，真实数据）：
  - 新标签页 hub：五入口（文件/浏览器/审查/模型调用轨迹/辅助对话）+ 应用插件区，launcher 被内容原地替换 ✓。
  - 审查：37 行未暂存（与 `git status` 完全一致）、行懒加载 diff 展开 ✓、切「全部分支更改」65 行 branchFiles ✓、来源下拉四项 ✓。
  - 浏览器：地址栏输入 `localhost:4317` → 规范化为 `http://localhost:4317/`、iframe 预览、tab 标题回写 ✓。
  - 轨迹：真实会话「2 次调用 · 输入 15,924 · 输出 190」，主对话/旁路调用标签、IN/OUT tokens ✓；无调用会话空态 ✓。
  - 多文档：审查 + 浏览器 + 轨迹 + 浏览 + AGENTS.md + package.json 六 tab 并存，各自 hidden 保活 ✓。
  - 全屏：absolute inset 覆盖主行（几何断言 1320×1000@x280），可逆 ✓；快捷键 `Alt+Mod+b` / `Alt+Mod+f`（fork 占用 ZCode 的 Shift+Mod+f，F 键改道）。
  - 工作区记忆桶：切工作区换桶、空桶自动收起（ZCode resolveSidePaneScopeState）✓。
- 已知限制（记 follow-up）：划词浮钮的浏览器 ego 受 IAB 无头环境 rAF 节流阻塞（`requestAnimationFrame` 恒不触发，真实可见窗口不受影响），链路由 `tests/selection-quote.test.ts` 的组件测试守护（13 例）；tab 拖拽排序、tab 概览/搜索、file-change 全局查找、ZCode full view 的「对话」surface 未做；MM 状态文件只出现在已暂存列表（服务端 XY 列解析 follow-up）。
- ZCode dev（localhost:5173）空任务态不渲染侧栏（需要有打开的任务），对照基准为需求截图 + `~/Documents/ybs/code/work/ZCode` v3.16.2 源码规格。
