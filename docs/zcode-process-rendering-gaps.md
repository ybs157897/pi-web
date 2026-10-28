# AI 过程渲染与 ZCode 对照（2026-10-27）

## 结论

用户点名的三处：

1. **思考耗时**：ZCode 完成态固定显示「思考 · 持续了几秒」（历史/无实测）或「思考 · 持续了 N 秒」（实时实测）；我们只显示「思考」，两种都没有。
2. **终端**：单条命令的行和卡片已基本对齐；但连续多条命令在 ZCode 会折叠成「终端 · N 个命令」，我们仍是每命令一行。
3. **查阅**：ZCode 把连续 2 个及以上的只读探查（Read/Search/List/只读 Bash）聚合为「查阅 · N 搜索, N 列表, N 文件」父行，子工具缩进挂在下面；我们完全不聚合，且 `list_files` 还会退化成「工具调用」。

逐项统计：14 个可观察表面中，**4 项对齐、4 项部分对齐、6 项缺失**。缺失集中在「过程聚合层」和「时间/状态元数据」，单卡渲染本身差距不大。

本轮（2026-10-27）已按 P0 → P1 → P2 实施：**12 项对齐、2 项部分对齐、0 项缺失**。剩余两项见文末「实施记录」。

## 证据

ZCode 参考（3.16.3 实机，历史会话）：

- `artifacts/zcode-process-compare-20261027/zcode-reference.png`：`已工作 11 秒` → `思考 · 持续了几秒` → `终端` 卡。

pi-web 对照（ego，同一类真实会话）：

- `artifacts/zcode-process-compare-20261027/2268-expanded.png`：同一终端场景；`思考` 无耗时，终端卡展开后与 ZCode 接近。
- `artifacts/zcode-process-compare-20261027/2168-top.png`：同一轮 6 条 Bash，渲染为 6 个独立「终端」行。
- `artifacts/zcode-process-compare-20261027/2285-top.png`：连续的 List/Read/Search，渲染为「工具调用」「读取」「搜索文件内容」多行，没有「查阅」。

ZCode 源码（本机 `/Users/yin/Documents/ybs/code/work/ZCode`）：

- 思考耗时与文案：`packages/ui/src/components/ai-elements/reasoning.tsx:129-158`、`:329-360`
- 过程聚合入口：`packages/ui/src/v4/conversationAssistantWorkItems.ts:56-58`、`:335-425`
- 只读探查判定：`packages/ui/src/lib/exploreToolCall.ts:125-167`
- 查阅渲染：`packages/ui/src/ToolCallBlocks/renderers/explore.tsx:419-503`
- 终端聚合：`packages/ui/src/ToolCallBlocks/renderers/execute-group.tsx:45-139`
- 终端卡片：`packages/ui/src/ToolCallBlocks/renderers/execute.tsx`、`ExecuteCommand.tsx`、`ExecuteOutput.tsx`
- 工作组时长：`packages/ui/src/v4/conversationWorkDuration.ts`、`ConversationTurnGroup.tsx:634-721`

## 逐项对照

| # | 表面 | ZCode 行为 | 当前实现 | 状态 |
| --- | --- | --- | --- | --- |
| 1 | 思考标签与耗时 | 实时测秒；完成显示「思考 · 持续了 N 秒」；无实测显示「思考 · 持续了几秒」；流式收起显示「正在思考」 | 同：客户端计时 + 完成态回退（`ReasoningBlock.tsx`） | 对齐 |
| 2 | 思考流式摘要行 | 取最新非空行，溢出右滚，行切换有 enter/exit 动画 | 最新行 + 溢出 mask/右滚 + 140ms 行进入动画 | 部分（简化动画） |
| 3 | 思考展开容器 | 240px、左边线、14px 缩进、上下渐隐、离底暂停跟随 | 同（`ReasoningBlock.module.css`） | 对齐 |
| 4 | 单条终端行/卡 | 「终端 · 命令」；展开后 `$ 命令` + 最多 3 行命令 / 10 行展开 + 5 行输出；运行时跟随 | 同（`ToolCard.tsx`、`ProcessTerminal.tsx`） | 对齐 |
| 5 | 终端输出渐隐 | `ScrollFadeViewport` 按滚动位置加 24px 上下 mask | `data-edges` + 24px mask（`ProcessTerminal.tsx`） | 对齐 |
| 6 | 连续终端聚合 | 2+ 连续命令合成「终端 · N 个命令, M 个失败, K 个已停止」，子行缩进；单条不聚合 | `toolGroup(execute)` 父行 + 桶计数 + 子行缩进 | 对齐 |
| 7 | 查阅聚合 | 2+ 连续只读探查合成「查阅 · N 搜索, N 列表, N 文件」；运行中摘要显示最新子动作；单条不聚合 | `toolGroup(explore)` 父行 + 桶计数 + 运行态最新子动作 + 子行缩进 | 对齐 |
| 8 | 单条搜索摘要 | 「搜索 · 查找 {pattern}」/「列出 {cwd}」；pattern 优先 | 搜索统一「搜索」；pattern 优先；list_files 标题「搜索列表」，摘要为原始请求 JSON（`{"name":"list_files","arguments":{...}}`），行可展开查看完整 listing 输出 | 部分对齐（list_files 明示） |
| 9 | `list_files` 分类 | 归入 search/list，摘要「列出 {cwd}」 | 归入 search/list，标题「搜索列表」，摘要为目录（`.` →「根目录」） | 有意偏离（用户要求明示） |
| 10 | todo/skill/task 分类 | 待办显示「待办 · 3/5 · 当前项」；技能、停止任务各有类别 | plan/skill/task_stop 分类已补 | 对齐 |
| 11 | 工作组时长 | 每轮固定显示「已工作 11 秒 / 工作中 3 秒」头部 | verbose 平铺模式补静态状态行 | 对齐 |
| 12 | 失败状态 | 行尾状态词「执行失败」，虚线下划线 + 可复制 tooltip | 行尾状态词 + title tooltip | 部分（tooltip 无复制按钮） |
| 13 | 读取行 | 「读取 · 文件 chip · 目录」，不可展开 | 同 | 对齐 |
| 14 | 折叠/展开动画 | 300ms 延迟卸载 + 高度动画 + 箭头 hover 显现 | 同（`ProcessRow.tsx`） | 对齐 |

## 关键行为细节

### 查阅（Explore 聚合）

ZCode 的「查阅」不是模型显式调用的工具，而是 UI 合成层：

- 连续 2 个及以上 `file-read / search / web-fetch / explore / 只读 shell` 才成立；单个仍按原工具展示。
- 只读 shell 的白名单包括 `rg/grep/find/ls/cat/head/tail/wc/stat/pwd/which/tree/sed -n/git status|log|show|diff` 等；写命令、重定向、普通命令不算 explore（`exploreToolCall.ts:113-167`）。
- 实机对照（`artifacts/zcode-process-compare-20261027/zcode-explore-reference.png`）：ZCode 的 `查阅 · 1 列表, 1 文件` 展开后子行就是 `终端 ls -la docs` + `读取 architecture.md docs/`，所以只读 Bash 出现在查阅里不是我们独有的偏差。
- 按 ZCode 原规则执行：只读 Bash（`rg/ls/cat/find/head/...`）无论单段、管道、`;`、`&&` 还是 `find -exec`，只要不含写操作或重定向，都进入「查阅」；写命令和重定向留在「终端」。
- 父行：图标 Search，类别「查阅」；完成态摘要按桶拼接，顺序 fetch → search → list → file，例如「2 搜索, 1 列表, 5 文件」；无子项时「0 个文件」。
- 运行态摘要不是桶计数，而是最新子动作：「正在读取 file」「正在搜索 query」「正在执行 cmd」。
- 展开后子行缩进 8px、左边线、14px padding，子行不显示图标；父行展开时摘要切回桶计数。

### 终端聚合

- 连续 2 个及以上「可执行 shell」才聚合成「终端」父行；单个保持普通终端行。
- 完成摘要：「N 个命令」+ 可选「M 个失败」「K 个已停止」，用中文逗号连接。
- 运行摘要：「正在执行 · 当前命令」；展开后父行只留计数，当前命令由子行表达。
- 与查阅互斥：只读命令进查阅，其余 shell 进终端。

### 思考耗时

ZCode 没有持久化思考耗时：组件在 `isStreaming` 变 true 时记 `Date.now()`，变 false 时 `ceil` 出秒数；历史/冷恢复没有测量值就显示「持续了几秒」。因此我们不需要新增协议字段，照同样方式在展示层计时即可，不会伪造历史数据。


### 子智能体（2026-10-27 补充）

- `subagent` 行从 DSH 彩色 chip 条改为 ZCode 单行摘要：Bot 图标 + 「子智能体」+ label/task + 运行状态；行本身是动作，不再展开行内 Prompt/输出。
- 点击行在右侧 Inspector 打开只读 child conversation tab；与插件 tab、文件 tab 共用右侧面板；child transcript 无 composer/retry/fork/stop，隐藏 tab 保持挂载和 SSE。
- 证据：`tests/subagent-pane.test.tsx`；ego demo `[subagent]` 截图 `artifacts/plugin-p3-check/subagent-row.png`、`subagent-row-tab.png`。

## 实施记录（2026-10-27）

按 P0 → P1 → P2 全部落地：

- P0 聚合层：新增 `src/web/process-grouping.ts`，在 `buildRenderModel` 的 process 排序后把连续只读行折成 `toolGroup(explore)`、连续可执行 shell 折成 `toolGroup(execute)`；新增 `src/web/ProcessToolGroup.tsx` 渲染父行、桶计数、运行态最新子动作、子行缩进且不显示图标。单行仍按原工具展示，reasoning/user/content 会打断分组，与 ZCode 一致。
- P0 后续修正（查阅子行）：实机确认 ZCode 的查阅会包含只读 Bash（参考图子行为 `终端 ls -la docs`），因此严格跟随其分类：单段、管道、`;`、`&&`、`find -exec` 等只读命令都进入查阅，只有写命令和重定向留在终端。`tests/process-grouping.test.tsx` 覆盖 `ls -la docs | head -40`、`find -exec`、`cd && ls`、循环（查阅）与重定向/写命令（终端）。
- P0 思考耗时：`ReasoningBlock` 按 ZCode 的客户端计时实现；流式收起「正在思考」+ 最新行，流式展开「思考 · 持续了 N 秒」，完成态无实测「思考 · 持续了几秒」。
- P1 分类与摘要：`list_files`/todo/skill/task_stop 不再落到「工具调用」；grep/glob 统一为「搜索」，摘要为「查找 {pattern}」；list_files 标题「搜索列表」，摘要为原始请求 JSON（`{"name":"list_files","arguments":{...}}`），行可展开查看完整 listing 输出；verbose 平铺模式补回「已工作 N 秒」状态行。
- P2 细节：终端输出区按滚动位置加 24px 上下渐隐；失败/停止改为行尾状态词（失败带 title tooltip）；思考最新行切换加 140ms 进入动画。

验证：

- `npx tsc --noEmit` 通过。
- 全量 `npx vitest run`：51 个文件、539 通过、1 跳过。
- `npm run build` 通过。
- ego 实机截图：`artifacts/zcode-process-compare-20261027/2285-grouped-top.png`（已工作 23 秒 + 思考 · 持续了几秒 + 四个查阅组）、`explore-final-open.png`（查阅展开后的子行）、`1937-explore-refined.png`（收紧后 `查阅 · 2 列表` → `搜索 列出 docs` + `终端 ls -la docs | head -40`）。
- ZCode 3.16.3 实机截图：`zcode-explore-reference.png`（`查阅 · 1 列表, 1 文件` 展开为 `终端 ls -la docs` + `读取 architecture.md docs/`）。
- 同一 prompt 双端对照：prompt 为「只读检查：请用 bash 运行 `ls -la docs`，然后读取 `docs/architecture.md` 前 10 行。不要修改任何文件，不要使用 list_files/glob，简短回复。」ZCode 与 pi-web（`pi-web-same-prompt.png`，会话 2326）都渲染为 `查阅 · 1 列表, 1 文件` → `终端 ls -la docs` + `读取 architecture.md docs`，结构与文案一致；终端子行正是 ZCode 的预期行为。
- 新增测试：`tests/process-grouping.test.tsx`、`tests/reasoning-block.test.tsx`、`tests/process-terminal-fade.test.tsx`、`tests/tool-classification.test.ts`。

仍保留的两项部分对齐：

1. 思考摘要行动画是简化的单次进入动画，不是 ZCode 的 `QueuedSummaryContent` 排队 enter/exit。
2. 失败状态词有 tooltip，但没有 ZCode 的 tooltip 内复制按钮。

改动集中在展示层，没有服务端或协议变更。

### 回到底部与平铺间距（2026-10-27 补充）

- 平铺模式（完全展开）的 `.processFlatBody` 补 `padding-top: 20px`，与 ZCode `AssistantHistoryStatus` 的 `pb-2` + 内容 `pt-5` 对齐；此前首个过程行紧贴分隔线。
- 新增消息视口的圆形「滚动到底部」按钮：28×28、圆形描边、16px 下箭头、距视口底 12px、水平居中；离开底部 48px 显示，点击直接落底并恢复跟随。48px 与按钮尺寸取自 ZCode（`BOTTOM_ANCHOR_EPSILON_PX`、`size="icon"`）。
- 验证：`npx tsc --noEmit`、584 项测试、`npm run build` 均通过；ego 截图 `artifacts/zcode-process-compare-20261027/jump-button-check.png` 与 `jump-button-clicked.png`。
