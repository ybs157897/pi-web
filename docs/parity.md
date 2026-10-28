# DSH Web 一致性清单（实时）

基准：`deepseek-ai/deepseek-harness` HEAD `687f282e86`（dsh 0.2.1-rc.2），本地 `dsh web` 与 pi-web demo 同 1440×900 / 浅色 / 中文逐屏截图对照。
证据目录：`artifacts/ego-compare/shots`（gitignored，仅本机）。

状态：`待修` / `进行中` / `已修` / `不做`（附原因）。

## 有意差异（用户要求）

| ID | 差异 | 说明 | 状态 |
|---|---|---|---|
| DF-1 | 插件市场按 ZCode 数据模型原生实现（2026-10-27 起取代原「不展示插件管理界面」决策） | 设置 → 扩展 → 插件市场：本地目录 / HTTPS / GitHub / git 来源、安装 / 更新 / 卸载 / 启停、安装确认（展示 MCP 命令与能力）、插件技能接入技能目录、插件 MCP 工具热重载；P2 补齐 `@` 引用 reminder、`_meta.ui` 内联卡、右侧插件 tab 与 JSON-RPC bridge。原「所有内置扩展工具恒开启」仍成立，不做逐插件工具开关。 | 已实现（P0+P1+P2） |
| DF-2 | 代码模式与 MCP 按 Pi Durable 1.3.0 语义开启 | `codemode` 工具 + QuickJS 沙箱 + `details.calls` 子调用；MCP 由用户级 `mcp.json` 与已启用插件的 `mcpServers` 合并而成（stdio/HTTP、`mcp__<server>__<tool>`、exposure、`tool_search`），插件能力变化时热重载。DSH 对应的是 PTC `run_code` preset 与插件市场的 MCP 配置，UI/配置模型不同，不做逐屏对照。 | 有意差异（Pi 原生能力） |
| DF-3 | ~~回答的最终结论按「设计文档」版式渲染~~（差异已随功能移除，2026-10-26） | 「结论文档排版」整体下线：前端渲染层（`DocText` / `DocBlock` / `DocInline` / `doc-split` / `doc-inline`、`DocBody.module.css` / `DocBlock.module.css`）、设置项 `docStyle`、模型契约 `doc-style-instruction.ts`，以及为 doc 块 JSON 载荷引入的「结构化输出」模型能力开关（b3093f6）一并删除；移除时结论与过程回答统一走库的 `MarkdownText`；2026-10-27 的 ZCode 输出迁移见 DF-4。历史会话里已有的 ```` ```doc ```` 围栏按普通代码块显示。详见 `docs/spec.md` 2026-10-26。 | 已移除（用户要求） |

| DF-4 | AI 输出改按 ZCode（2026-10-27） | 回答、代码、表格/图表/图片、思考、常见工具过程与已更改文件摘要以 ZCode 3.16.2 源码和 3.16.3 实机为参考；宿主执行、权限、问答、计划和子会话语义保留。新正文不再使用 DSH Markdown/CodeBlock，终端不再依赖 DSH 内部 DOM。详见 `docs/zcode-markdown-rendering-plan.md`。 | 有意差异（用户要求，已实施） |

## 输入区

| ID | 问题 | DSH 对照 | 证据 | 状态 |
|---|---|---|---|---|
| IN-1 | 附件卡缩水成一行文字：图片 34×34、文件 chip 约 121×44、无边框、12px、无大小元信息、删除键常显 | 图片 64×64；文件卡 240×64、radius 16、1px 边框、14px 名称、`MD 26B`/`PDF 597B` 元信息、删除键 hover 显示 | `dsh-03-attach-zoom.png` / `pi-04-attach-zoom.png` | 已修（实测图片 64×64/radius 20；文件卡 240×64/radius 16/1px 边框/元信息，与 DSH 实测一致） |
| IN-2 | 拖拽无任何反馈；拖到输入卡外浏览器会直接打开文件 | document 级整页毛玻璃遮罩 + 插图 + 标题 + 图片限制；拒绝态与 `dropEffect` | `dsh-04-drag.png` / `pi-05-drag.png` | 部分修复（整页遮罩 + 插图 + 标题/限制 + dropEffect；Windows 审计发现 Composer 卡片与 document 级 drop 会双触发） |
| IN-3 | `/` 面板是约 360px 窄浮层，只有 3 条命令，无分组/说明/图标 | 与输入卡同宽，分「添加」「指令」，图标+名称+id+右侧说明 | `dsh-08-slash-menu.png` / `pi-09-slash-menu.png` | 已修（面板宽 774 = 输入卡宽，添加/指令分组；ego 复核） |
| IN-4 | `@` 面板是窄浮层，只有文件、无分组/目录下钻 | 同宽面板，分组「文件与文件夹」，目录可下钻（Tab），另有子智能体/对话分组 | `dsh-09-at-menu.png` / `pi-10-at-menu.png` | 已修（同宽面板 + 分组 + 目录下钻；实测 @src/ 后列出 src/nested、src/index.ts） |
| IN-5 | 「繁忙时的发送行为」设置不生效（硬编码 `followUp`） | 设置项决定 Enter/发送按钮行为，备用手势取反 | 代码 `App.tsx:151` | 已修（sendMode 初值取 settings.busySendMode） |
| IN-6 | 附件并发添加可绕过上限；超限后收到英文 `Request body is invalid` | 客户端预检整批拒绝并给出本地化文案 | 代码 `App.tsx:490-521` | 已修（reading 预留计数；纯函数门控 16/16 用例） |
| IN-7 | 附件无读取中/失败/重试态；发送失败无幂等重试 | 上传中 spinner/进度、失败点击重试、未完成阻止发送 | 代码 `App.tsx:528-539` | 已修（reading/ready/error 三态 + 失败点击重试 + 未就绪阻止发送；发送失败复用同一 requestId 幂等重试；ego 复核） |
| IN-8 | AVIF 与 `File.type` 为空的图片被降级为普通文件 | 图片按 MIME 白名单识别并渲染缩略 | 代码 `App.tsx:47` / `server/workspace-files.ts:20` | 部分修复（前端识别 avif + 空 MIME 按扩展名推断；服务端 `IMAGE_TYPES` 仍不含 avif，发送会 400） |
| IN-9 | `/compact` 不可达；`/plan` 不存在 | `/` 面板包含压缩/计划/权限/目标/反馈 | 代码 `Composer.tsx:100-106` | 部分修复（`/compact` 已接通 runtime/HTTP/api 并接入 App；`/plan`、目标、反馈仍未实现） |
| IN-10 | 队列项附件只显示「附件消息」；无重排（DSH 也无重排，此项两边一致） | 队列行显示图片 24×24 / 文件 chip | 代码 `Composer.tsx:196` | 已修（队列行 24×24 图片缩略 + 文件 chip（图标+名+大小）；两边都无重排） |
| IN-11 | 切换/新建会话静默清空已添加附件 | 草稿与附件按会话保留 | 代码 `App.tsx:286-291` | 已修（附件按 scope 保存，切回恢复） |

## 聊天与侧栏

| ID | 问题 | DSH 对照 | 证据 | 状态 |
|---|---|---|---|---|
| CH-1 | 会话行 hover 直接露 3 个图标，标题被挤压省略 | 行内只露「…」菜单 + 置顶；hover 弹深色信息卡 | `dsh-18-row-hover.png` / `pi-11-session-top.png` | 已修（hover 仅「…」菜单 + 常显置顶图标，菜单含全部动作；DSH 的深色 hover 信息卡未做） |
| CH-2 | 轨迹视图只有搜索 + 简单列表 | 「时长/轮次/调用」开关 + 彩色时序图 + 密集行 | `dsh-15-trajectory.png` / `pi-15-trajectory.png` | 已修（时长/轮次/调用三开关 + 时序图 + 类型 chip；ego 复核，统计口径与列表一致） |
| CH-3 | 用户气泡 radius 17 / padding 9×15 | radius 20 / padding 10×16；底色两边一致 `rgb(237,243,254)` | 实测 | 已修（padding 10×16、radius 20，与 DSH 实测一致） |
| CH-4 | 用户消息图片最大 300px 宽 | 单图长边 240、宽高比 clamp、多图 64 tile | 实测 + `dsh` `MessageImage` | 已修（消息图片上限改为 240×240、radius 16） |
| CH-5 | 子智能体触发器/层级目录/只读转录缺失 | 会话头计数触发器 + 目录 + 子会话转录 | `dsh-16-team.png` 等 | 不做（待后端工具） |
| CH-6 | 智能体团队面板缺失 | 成员 + 共享任务 + 打开成员会话 | `dsh-16-team.png` / `pi-97-team-01-trigger.png` … `pi-97-team-05-back-to-lead.png`、`pi-97-team-06-real-panel.png` / `dsh-97-team-01-panel.png` | 已修（2026-10-19：`TeamPanel` 会话头触发器 + 成员区/共享任务区；空态与 DSH 同文案，见「团队对比」） |
| CH-7 | 计划/目标/待办/问答交互缺失 | 计划 chip、待审卡、todo 清单、目标栏、问答卡 | 代码核对 | 不做（待后端工具） |
| CH-8 | 偶发「连接已恢复」Toast | 无 | `pi-17-queue.png` | 已修（根因：任何 SSE `open` 都被当成 recovered；改为仅在曾断开后提示，生产构建双向实测通过） |
| CH-9 | 改动文件默认逐文件展开成卡片，整块很长 | 回合末尾一张卡：填充卡头（文件磁贴 + 已编辑 N 个文件 + 总增删）、每行一个路径 + 增删数、超过 4 行折叠、点行在右侧看 diff、悬停 500ms 出预览（`ui-deliverables/ChangedFiles.tsx`，折叠常量 `COLLAPSED_ROWS = 4`，行按 display 路径排序） | 本机 DSH 源码 `687f282e86` + `artifacts/doc-layout-check/50-53-*.png` | 已修（按 DSH 结构移植：单卡、默认折叠、折叠开关、悬停预览、点行开 Inspector；行数据由本轮产物推导，排序对齐 `compareDisplay`）。另：pi-web 多一个卡头折叠控件（DSH 无整卡折叠），卡片位置/行分隔线/折叠键边线已按 DSH 源码对齐 |

## 设置与页面

| ID | 问题 | DSH 对照 | 证据 | 状态 |
|---|---|---|---|---|
| ST-1 | 设置弹窗 mask 无背景模糊 | 毛玻璃遮罩 | `dsh-12-settings.png` / `pi-12-settings.png` | 不做（默认主题 `--dsw-mask-blur: none`，两边同源；截图差异疑为本机 DSH 主题覆盖/JPEG 压缩） |
| ST-2 | 外观是紧凑分段按钮；字号是数字输入+齿轮 | 外观三张带图标大卡；字号下拉式控件 | `dsh-17-settings-general.png` / `pi-16-settings-general.png` | 已修（外观三卡实测 180×82/gap10，DSH 181×83；字号 `N px` 下拉） |
| ST-3 | 插件页是工具开关清单、字母「C」占位图标、英文工具描述 | 插件配置中心（内置/实验性/已安装 + 彩色图标 + 添加插件） | `dsh-13-plugins.png` / `pi-13-plugins.png` | 已修（P0+P1：市场来源、搜索/筛选、安装确认、安装/更新/卸载/启停、能力标签与诊断、SSE 进度；按钮式启停而非 DSH 的插件开关清单。内联插件 UI 属 P2） |
| ST-4 | 自动化页无筛选 tab、无搜索框、空态无按钮 | 全部/已开启/已结束 + 搜索 + 空态「新建自动化任务」 | `dsh-14-automations.png` / `pi-14-automations.png` | 已修（已启用/已结束映射 enabled 布尔；ego 1440×900 复核通过） |
| ST-5 | 账号与余额设置区缺失 | 账号/余额/充值 | `dsh-12-settings.png` | 不做（无云端账号） |

## 文案与语义

| ID | 问题 | DSH 对照 | 状态 |
|---|---|---|---|
| CP-1 | 访问模式「只读 / 完全访问」 | 「仅可查看 / 完全权限」 | 已修（仅可查看/完全权限） |
| CP-2 | 切到完全权限无风险确认 | 「确认启用完全权限?」+ 勾选 + 取消/启用 | 已修（风险确认弹窗：标题/说明/勾选/取消/启用；ego 复核） |
| CP-3 | 附件上限 4 张/4 MiB，界面不显示 | 界面明示「最多 20 张，每张 20MB」 | 已修（拖拽遮罩显示本项目上限「最多 4 张，每张 4 MiB」） |
| CP-4 | 设置右上「查看配置」 | 「打开配置文件」 | 已修（设置右上改为「打开配置文件」，服务端按平台调系统命令，失败有明确错误码与 Toast） |
| CP-5 | 账号菜单只有「设置」 | 设置/意见反馈/退出登录 | 已修（账号菜单「意见反馈」+ POST /api/feedback 落盘 app-state，上限 200 条） |

## 已对齐（核对通过）

- 侧栏宽度 280px、背景 `rgb(249,250,251)`；页面白底。
- 输入卡尺寸约 712×186、radius 28；加号/发送按钮位置与形态。
- Hero 布局、占位文案、工作区与预设 chip 位置。
- 用户气泡底色 `rgb(237,243,254)`（仅 radius/padding 微差，见 CH-3）。
- 通用设置的行结构（权限/语言/外观/字号/工作步骤/代码工作视图/快捷键/繁忙发送行为）。
- 设置弹窗整体尺寸约 796×800。
- 队列行为：停止保留队列（本轮进入文档与测试）。

## 变更记录

- 2026-10-19：建立本清单；修复门禁基线（`AttachmentReference` 接口改为类型别名以符合 `JsonValue` 索引签名；停止语义测试与 README/architecture 对齐为“保留队列”）。
- 2026-10-19：IN-1 ~ IN-4 落地并 ego 复核（附件卡几何与 DSH 实测一致、整页拖拽遮罩、`/` 与 `@` 同宽面板、目录下钻）；CP-1/CP-2 对齐（文案 + 风险确认）；`/compact` 接通 runtime/HTTP/api 并接入 App。
- 2026-10-19：IN-5/IN-6/IN-8/IN-11 与 CH-1 落地（sendMode 初值、附件并发门控、AVIF/空 MIME、附件按 scope 保留、会话行「…」菜单）；ST-2 落地（外观三卡 + `N px` 字号下拉，实测与 DSH 坐标误差 ≤1px）；ST-4 落地（自动化筛选/搜索/空态 CTA，ego 复核）。
- 2026-10-19：小项批次二：CH-2（轨迹工具栏/时序图）、CP-4（打开配置文件）、CP-5（意见反馈）落地并验证；IN-7/IN-10（附件生命周期、队列缩略图）与 CH-1 余项（hover 信息卡）、CH-8（连接提示）在并行实现中。
- 2026-10-19：Windows 审计复核发现 IN-2 仍有卡片/document 双 drop，IN-8 的 AVIF 仅前端修复、服务端 schema 未同步；两行状态已订正。详见 `docs/windows-support.md`。
- 2026-10-20：模型目录与推理等级批次：按 DSH `reasoningEfforts` 语义修复档位映射；全局 models.json 热重载 + `/api/models/events` SSE；目录收窄时会话档位按 pi-ai 规则 clamp。详见文末「模型目录与推理等级（2026-10-20）」。
- 2026-10-20：全局配置目录批次：默认 `~/.pi-web`，设置页直接写全局 `models.json`/`auth.json`，移除 `providers.json`；旧 `~/.pi/agent` 与项目 `.data` 一次性迁移；工作区技能来源改为 `.pi-web/skills`。详见文末「全局配置目录（2026-10-20）」。
- 2026-10-20：工作区浏览批次：「浏览文件」改为右侧 Inspector，中间正文保留；工作区菜单改用整行矩形容器锚定，修复省略号隐藏后菜单漂到左上角；目录切换滚动复位。详见文末「工作区浏览与菜单锚点（2026-10-20）」。
- 2026-10-20：推理档位删除持久化：设置页不再把 null-pinned 档位渲染成行；档位下拉使用完整 7 档，删除后可重新添加。详见文末「推理档位删除持久化（2026-10-20）」。
- 2026-10-20：新会话默认模型：目录校验 + 可用模型回退，失效的 `deepseek-flash` 不再原样显示；显式选择不存在的模型仍报错。详见文末「新会话默认模型（2026-10-20）」。
- 2026-10-20：补齐 favicon（SVG/PNG/ICO/Apple touch）并让生产模式正确服务根级图标。详见文末「Favicon（2026-10-20）」。
- 2026-10-20：当前工作区可折叠：切换时自动展开一次，之后 chevron 可折叠选中的会话组。详见文末「当前工作区折叠（2026-10-20）」。
- 2026-10-20：隐藏模型白名单并清空历史过滤器；选中模型/推理等级会写入默认值，新会话与新窗口沿用。详见文末「模型白名单隐藏与选择记忆（2026-10-20）」。
- 2026-10-20：侧栏默认打开当前工作区文件目录，分隔线可拖拽；Markdown 增加渲染预览，代码/文本改为全文高亮（不再折叠中间段）。详见文末「侧栏浏览、拖拽与文件预览（2026-10-20）」。

## 整族功能（DSH 0.2.1-rc.2 → Pi Durable）

机制映射、假设验证与实现顺序见 [families.md](families.md)。

| 族 | 状态 |
|---|---|
| 待办（todo_write + 清单面板） | 已实现并验证（工具/doc/投影/面板/测试 + ego 复核：收起计数、展开四项状态、下一轮清空；readOnly 放行） |
| 问答（ask_user_question + 交互协议） | 已实现并验证（工具/doc/`POST .../interactions/:callId/answer`/三源配对投影/问答卡；98 用例 + ego 端到端含跳过与 400/404；迟到回答气泡与工具行见 `pi-80-ask-reply-*`） |
| 计划模式（plan + exit_plan_mode + 待审） | 已实现并验证（chip + section `plan-policy` + `exit_plan_mode` + 待审卡（同意执行/要求修改）+ superseded 处理 + `/plan`；86 用例 + ego 全流程 `pi-70-plan-*`；pending 语义＝下一次模型请求生效） |
| 目标（goal + onYield 续跑 + GoalBar） | 已实现并验证（create/get/update_goal + CAS + onYield 自动续跑（demo 实测 3/3 轮）+ GoalBar 暂停/编辑/清除；runtime 与投影已接线） |
| 子智能体（前台一次性 + children API） | 已实现并验证（`subagent` 工具建 task-owned 子会话并前台取回答案；`children/childMessage/childStop` + 三条路由；投影 `subagents`；会话头计数触发器 `SubagentPanel`；102 用例 + ego 全流程 `pi-90-subagent-01…07`；机制对照见下节「子智能体对比」） |
| 团队（共享看板 + send/wait） | 已实现并验证（`pi-web.team` doc + 9 个工具 + CAS 看板纯函数 + `wait_agent` 有界等待；runtime `team(id)`/`GET .../team`/投影 `ConversationDetail.team`/`TeamPanel`；门禁 128/128；ego `pi-97-team-01…05`；真实模型 pi/DSH 同流程见「真实模型验证」；机制对照与有意差异见下节「团队对比」） |

## 子智能体对比（2026-10-19，前台一次性 + children API）

同一会话头位置、同一演示流程（1440×900 / 浅色 / 中文，demo 模型 `pi-web-demo`：`[subagent]` → 触发器 → 展开 → 打开子会话 → 返回父会话 → 跟进/停止）；pi 侧证据 `pi-90-subagent-01…07`。

### 机制对照

| 观察点 | DSH（`687f282e86`） | pi-web | 差异定性 |
|---|---|---|---|
| 工具与参数 | `subagent`（`packages/subagent/tool-subagent/src/index.ts:82,159,212-234`）：`description`（必填，3–5 词显示名）+ `prompt`（必填）+ `cwd?`；措辞按 provider 的 `inheritsParentContext` 分叉（`index.ts:113-137`） | `subagent`（`src/server/subagent-tools.ts:78-96`）：`task`（必填，自带完整任务）+ `label?`（可选显示名，缺省取任务首行）；措辞按「子会话不共享消息、但继承 agent 组合」写定 | 有意差异：一期只有一种子会话形态（全新、不继承消息），无需按 provider 分叉措辞；参数名按「自带任务的 task」命名 |
| 启动语义 | `execute` 内 `startActivation({delivery:'parent'})` 后**立即返回** `{kind:'activation', subagentId}`（`index.ts:330-337`，输出 schema `:264-274`），结果由 subagent runtime 事后通知父会话 | `api.commit` 建 task-owned 子会话（`ownership:{kind:'task',taskId:api.taskId}`，`subagent-tools.ts:98-113`）→ `submit()` → `wait()` → 读 `settled.answer` 的 entry 文本（`115-140`），答案作为**本次工具调用的结果**返回 | **有意差异（一期）**：Pi 没有「runtime 事后通知父会话」的 seam（无 `subagent/end` + 完成通知注入的等价物），前台等待是能给出真答案的最小闭环（理由见下） |
| 工具卡片 | 输出 `activation` 立即进转录，渲染 `started subagent <id>`（`index.ts:273`） | `api.details({conversationId,status,label})` 先 `running` 后 `completed`/`failed`（`subagent-tools.ts:114`、`73-77`） | 有意差异（暂缓）：`subagent` 工具行的特判渲染归 `ToolCard.tsx`（另一并行任务） |
| 结果三通道 | `SubagentResult{output, structured?, diagnostic?, stopReason}`（`packages/subagent/subagent/src/types.ts:252-278`）；非 `completed` 由工具层转 `isError`（`:226-232`） | `output`＝子会话最后一条 assistant 文本；失败走 `api.diagnostic({severity:'error'})`，harness 以 `<harness>[error] …` 附在工具结果末尾（`pi-durable/dist/harness/tool.js:686-706`），`output` 只留一句中性状态，`details.status='failed'` | 已对齐（三通道分开）：诊断不混进答案正文 |
| 子会话归属 | 子会话由 provider 建、父会话 catalog 记 descriptor | 子会话记录 `owner={conversationId,taskId}`；`pi.agent` 由 harness creation hook 从 owner 会话复制（`pi-durable/dist/harness/agent.js` `createAgent`），故自动继承父会话的工具/模型/工作目录；另写 `pi-web.subagent` doc 存 label（`subagent-tools.ts:19-30`） | 已对齐（机制不同、语义相同）：pi 的 doc 等价于 DSH descriptor |
| 列表 / 状态 | `list_agents`：`{kind:'child',id,label,status:'running'\|'inactive'}`（`packages/subagent/tool-subagent-control/src/list-agents.ts:55-79`） | `children(id)`：`{id,label,title,status,answer,createdAt,updatedAt}`（`runtime.ts:528-570`），`status` 取子会话 `busy` | 有意差异（多一列）：DSH 行副标题是 `title · mode · activity`，pi 是 `status · 最近回答`（一期无 mode/耗时/token 列） |
| 控制面 | `send_message` / `interrupt_agent`（`tool-subagent-control/src/index.ts:35-56,80-90`）——面向**模型** | `POST .../children/:childId/messages`（`whenBusy:'followUp'`）/ `.../stop`（`abort`）+ `GET .../children`（`app.ts:449-468`、`contracts.ts:50-55`）——面向**人类 UI** | 有意差异：模型侧控制工具留到「可继续子智能体」阶段 |
| 所有权校验 | 控制权限按 live lineage 授权（`types.ts:66-68`），DSH 有 Agent 注册表可查 | **Pi 无所有权 seam**（families.md A7），故 runtime 自校验：`record.owner?.conversationId === id` 否则 `NOT_FOUND`（`runtime.ts:576-585`） | 有意差异（限制自己做）：语义等价，来源不同（DSH＝活体谱系，pi＝持久 owner 边） |
| 崩溃重放 | activation 由 subagent runtime 托管 | 工具 `replay:'safe'`：先 `scanConversations({ownerTaskId:api.taskId},1)` 复用已有子会话，再以稳定 `requestId=subagent:<taskId>` 提交（`subagent-tools.ts:98-113`） | 有意差异（pi 特有）：一次委派＝一次工具调用，做成幂等 |
| 面板触发器 | 会话头 `{n} 个子智能体`；运行中 aria-label 用「正在运行」变体、可见文本始终是总数；空 catalog 不渲染；hover 即开 150ms、hover 即关 120ms、点击 pin（`packages/client/ui-subagent/src/client/SubagentHeaderLineage.tsx:496-500,536-552,667-716`；文案 `locales.ts:36-42`） | 同文案同位置（标题右侧、header actions 之前）：`SubagentPanel.tsx:193-201`，`aria-haspopup="tree"`，空列表返回 null（`:188`）；hover/pin/外点/Escape 与 DSH 同构（`SubagentPanel.tsx:108-149,173-180`） | 已对齐（触发器 28px 高 / 12px 字 / `--dsw-alias-label-tertiary`，`SubagentPanel.module.css:12-40`；hover 于 2026-10-19 修，`pi-98-subagent-03-hover-open` 对 `dsh-98-hover-03-subagent-open`） |
| 面板卡 | 336px、`--dsw-specific-menu` 材质 + `--dsw-elevation-prominent`、行 44px、状态点 + label + 10px 副标题（`SubagentHeaderLineage.module.css:100-200,215-235`） | 同几何同材质（`SubagentPanel.module.css:42-63,65-96,98-115`）；行＝label + `正在运行/当前未运行` + 回答摘要 + `停止/跟进/打开` | 已对齐（材质与尺寸）；按钮是 pi 的显式控件 |
| 打开子会话 | 点整行 → `openChild`；子会话头另有面包屑 switcher 在同级间切换（`SubagentHeaderLineage.tsx:279-286,785-822`） | 「打开」→ 复用现有选会话路径（`App.tsx:1443-1447`），详情走 `GET /api/conversations/:id` | 已实现：子会话头面包屑「父标题 ← 当前标题」+ 同级计数切换（`App.tsx:1478-1495,1763-1790`）；截图 `pi-99-subagent-03..06` |
| 转录内呈现 | 同一回合的多次 `subagent` 调用各自启动、转录里只有工具回执；回合过程行用 `{n} subagent` 汇总（`packages/client/ui-chat/src/client/locale.ts:153-154`、`conversation-nodes/turn-process.ts:180-184`） | 连续调用合并为一行彩色胶囊（`SubagentRunStrip`）：每个子会话固定配色、运行中转圈 + `{已结束}/{总数}`、完成显示 tokens、失败标红；点胶囊复用既有选会话路径打开子会话 | 有意差异（pi 侧呈现增强）：DSH 的汇总停留在过程标题，pi 把「哪些子智能体、各自什么状态」放进正文一行；会话头 `SubagentPanel` 目录保持不变 |
| 子会话不进侧栏 | 子会话不进侧栏；`origin==='subagent'` 的会话在该位置不渲染触发器（`SubagentHeaderLineage.tsx:760-777`） | `list()` 只取 `owner===undefined`（`runtime.ts:610-613`）；投影给子会话标 `origin:'subagent'`+`parentId`（`projection.ts:757`），前端据此不插入侧栏（`App.tsx:262-271`） | 已对齐（ego `pi-90-subagent-03`：打开子会话后侧栏仍只有父会话） |
| 只读转录文案 | 一次性子会话的输入区换为只读说明「一次性子智能体记录 / 一次性任务不支持后续消息…」（`ui-subagent/src/client/SubagentReadOnlyComposer.tsx:19-31`） | 未做：一期子会话可继续（`childMessage` 已实现），输入区保持可用 | 不适用：只读文案属于「一次性且不可继续」，与当前实现形态不符 |
| catalog 变化推送 | 父会话日志内含 catalog，projection 帧随父会话推送 | 父会话流看不到子会话 entry（owner 边不是可订阅的表），故面板在「有子会话运行中或菜单打开」时 1.5s 轮询（`SubagentPanel.tsx:56-65`） | 有意差异（底座不同）：触发时机等价（ego `pi-90-subagent-05` 抓到运行中） |

### 为什么一期做「前台阻塞式等待」（有意差异的理由）

1. **DSH 的「启动即返回」依赖两条 pi 没有的 seam**：`startActivation({delivery:'parent'})` 需要（a）托管子 Agent 并产出 `subagent/end` 的服务层，（b）把完成通知作为消息注入父会话的通道（`packages/subagent/subagent/src/continuation-messages.ts` 的 `subagent-settled` notice）。pi-web 一期两者都没有，硬做只会得到「工具返回一个 id、父会话永远收不到结果」。
2. **前台等待仍给出核心价值**：子任务在**自己的上下文**里执行，父会话只拿到答案而非中间步骤（ego：父会话 3 步、子会话 29 步 `pi-90-subagent-07`）。
3. **代价**：父会话的工具调用会占住一个 run 直到子会话结束（DSH 里父会话可继续干别的活），因此一期**不做并行委派**（DSH system prompt 鼓励同一 assistant 消息里并行启动多个 subagent：`tool-subagent/src/index.ts:379`）。`subagent` 在只读模式下放行（只读子会话无工作区副作用）。
4. **迁移路径**：等 families.md §5 的后台常驻版（`{background:true}` anchor task + reporter）落地，工具改为「启动即返回 + 通知注入」，本节的启动语义差异即可关闭。

### 待跟进的小项（子智能体）

- ~~`subagent` 工具行特判渲染~~ —— **已修（2026-10-19）**：行摘要「已开始子智能体 · {label} · {子会话 id}」、展开为回执卡（任务原文 + 子会话 id + 「打开子会话」按钮、不再渲染整段 JSON 参数），见下节「交互收尾对比」。
- ~~子会话面包屑 switcher~~ —— **已实现（2026-10-19）**：父标题回父会话、同级计数 dropdown 切换、当前项 tag；截图 `pi-99-subagent-03-child-breadcrumb` / `-04-switcher-menu` / `-05-back-to-parent`。
- 模型侧控制工具（`list_agents` / `send_message` / `interrupt_agent`）与委派深度上限（DSH `tool-subagent/src/index.ts:382-395` 的 depth context）。
- ~~DSH 的悬停即开（150ms）/悬停即关（120ms）未做~~ —— **已修（2026-10-19）**：`SubagentPanel.tsx:34-55,88-146` 按 DSH `SubagentHeaderLineage.tsx:486-552` 同阈值实现，见下节。
- ~~子会话耗时 / token 列~~ —— **已实现（2026-10-19）**：`ConversationDetail.subagents[]` 增加 `tokens`/`durationMs`（`projection.ts:452-453,696`），`SubagentPanel` 行内显示 `{tok} · {时长}`（运行中每秒刷新，`SubagentPanel.tsx:70-72,280`）。


### 待跟进的小项（本轮记录，未做）

- ~~迟到回答在转录里目前是原始 JSON 用户气泡~~ —— **已修（2026-10-19）**：`transcript.tsx` 按 payload 识别并渲染 DSH 式折叠气泡，见下表「迟到回答 + 问答工具行的代码级并排」。
- 问答卡暂不显示倒计时/「慢慢回答」（DSH 的 timed 通道），因为一期采用「立即 pending」模式。
- 计划待审（plan-review）与审批（approval）复用同一协议但尚未实现，见 families.md 第 2 节。

- 2026-10-19：整族进展——待办、问答、目标三族实现并验证（79 测试通过 + ego 复核截图 pi-40/41/42、pi-50、pi-52/53）；计划模式（复用问答协议）、子智能体（Pi child conversation）、团队（后台子智能体 + 看板）待实现。

## 交互收尾对比（2026-10-19，问答细分 / 放弃整组 / 子智能体行 / hover 面板）

两条侧同一条流程（1440×900 / 浅色 / 中文）：pi demo 实例（端口 4418，`/tmp` 数据目录，脚本化演示模型）跑 `[ask]`、`[subagent]`、`[team]`；DSH 3080 实例（会话上显式使用 DeepSeek-V4.1-Flash）跑同一组问句（「请调用 ask_user_question …」「请调用 subagent …」）。

- pi 证据：`pi-98-ask-01-waiting` / `pi-98-ask-02-cancelled` / `pi-98-ask-03-answered` / `pi-98-subagent-01-row` / `pi-98-subagent-02-receipt` / `pi-98-subagent-03-hover-open` / `pi-98-subagent-04-child` / `pi-98-team-01-hover-open` / `pi-98-team-02-member-model` / `pi-98-team-03-narrow`。
- DSH 证据：`dsh-98-ask-01-waiting` / `dsh-98-ask-02-cancelled` / `dsh-98-ask-04-cancelled-toolrow` / `dsh-98-ask-05-cancelled-detail` / `dsh-98-ask-06-answered` / `dsh-98-hover-01-team-open` / `dsh-98-hover-03-subagent-open` / `dsh-98-subagent-00-state`（含 `-01-row` / `-02-receipt` 的 DOM 断言）。

### 1) 问答工具行的状态细分

| 语义 | DSH | pi-web | 定性 |
|---|---|---|---|
| 状态来源 | `userQuestions` 投影 + 工具结果文本（`ask-question-row.tsx:219-241`） | `ConversationDetail.interactions`（投影 `projection.ts:785-802`；行内按 callId 取状态 `ToolCard.tsx:52-62`） | 有意（来源不同）：pi 没有 `userQuestions` 投影，交互表同时是回答路由的幂等键 |
| 等待回答 | 调用运行中 → `ask.waiting`（`ask-question-row.tsx:272-273`；文案 `locales.ts:291`） | `status==='pending'` → `0 / M · 等待回答`（`tool-render-model.ts:686-689`） | 已对齐（实测两侧同为「等待回答」，`pi-98-ask-01-waiting` / `dsh-98-ask-01-waiting`） |
| 已继续工作，仍可回答 | 结果记录 pending 且投影仍 answerable（`:305-306`；文案 `:292`） | `status==='continued'` → 同文案 + verdict「等待中的问题仍可在输入框中回答」（`tool-render-model.ts:677-679`） | 已实现（映射就位，pi 一期不产生该状态：模型提问后立即继续，没有 timed/answerable 通道；见「残留差异定性」的有意项） |
| 已结束 | 结果记录 pending、投影已 settled 且无答案（`:310-312`；文案 `:296-297`） | `status==='expired'` → `已结束` + verdict「该问题已结束，结果见下方对话」（`tool-render-model.ts:681-683`） | 已对齐 |
| 已取消 | 调用以 `ASK_CANCELLED` 结束（`:258-260`；文案 `:298-299`） | `status==='cancelled'` → `已取消` + verdict「本轮已取消，未提交回答」（`tool-render-model.ts:684-686`） | 已对齐（两侧同行同 verdict；`pi-98-ask-02-cancelled` / `dsh-98-ask-05-cancelled-detail`） |
| `N / M 已回答` | `answeredPresentation`（`:297-334`，文案 `:302`） | `N / M · 已回答`（`tool-render-model.ts:694-698`） | 已对齐（`pi-98-ask-03-answered` 的 `0 / 2 · 已回答` 与 `dsh-98-ask-06-answered` 的 `1 / 1 已回答` 同构） |
| 无法严格配对时的计数兜底 | `:176-186` | `tool-render-model.ts:692-698`（`record: null` + 计数摘要） | 已对齐（既有用例保留） |

### 2) 问答卡「放弃整组问题」

| 语义 | DSH | pi-web | 定性 |
|---|---|---|---|
| 文案与图标 | `nav.cancel` = 「放弃整组问题」/「Dismiss all questions」（`ui-user-questions/src/client/locales.ts:26`；按钮 `QuestionComposer.tsx:477-479`） | 卡片头部「放弃整组问题」按钮（`QuestionComposer.tsx:244-249`；样式 `QuestionComposer.module.css:74-96`） | 已对齐（文案逐字一致；pi 放在「收起」之后，DSH 的 nav 行同序） |
| 按钮出现条件 | `dismissal === 'cancel'` 才用 nav.cancel：只有 **Host 从未命名 callId** 的卡片（`contract/slots.ts:283-287`）＝ 无 `wait` 的阻塞提问；带 callId 的 timed 卡显示「收起问题面板，可从工具调用重新打开」（`nav.close`） | 仅 `status==='pending'` 时显示（`QuestionComposer.tsx:244`）；「收起」保留为独立的折叠动作（`:236-238`） | **有意差异**：pi 的提问一律带 callId（`interaction-tools.ts:126` 写交互表），没有「未命名卡片」形态；本轮按任务口径把「放弃整组」做成 pending 卡上的显式动作，语义与 DSH 的 `ASK_CANCELLED` 一致（结束整组请求、不留回答通道）。实测 DSH 的阻塞提问卡同样显示该按钮（`dsh-98-ask-01-waiting`），故功能可对照 |
| 结束语义 | 客户端以 `ASK_CANCELLED` 拒绝 waterfall（`contract/slots.ts:548-562` 的 `dismiss()`；错误码 `:110-120`），工具调用以「已取消」收场；**不发任何用户消息** | 服务端 `POST /api/conversations/:id/interactions/:callId/cancel`（`app.ts:440-444`）→ `runtime.cancelInteraction`（`runtime.ts:1112-1149`）：文档置 `cancelled` + 幂等 steer 一条 `{"kind":"dismissed_pending_question",…}` JSON | 有意差异（底座不同）：pi 的工具调用已经返回（无阻塞），所以「取消」必须自己通知模型；steer 的 `requestId=question-dismiss:<callId>` 保证重启/重试不重复注入；steer 前与回答路由同款做模型白名单校验（`runtime.ts:1124`，拒绝时卡保持可操作） |
| 幂等与冲突 | 卡片关闭后无法再次取消（没有对应接口） | 已 `cancelled` → 幂等返回当前详情、不再 steer（`runtime.ts:1123`）；已 `answered` → 409 `CONFLICT`「该问题已回答，无法放弃整组问题」（`runtime.ts:1122`）；回答路由对已取消的调用同样返回 409（`runtime.ts:1067`），文档提交只认 `pending`（`runtime.ts:1094-1099`）；计划待审记录走该路由返回 422 `UNSUPPORTED`（`runtime.ts:1121`） | 有意差异（更严）：pi 的两条路径都不会让「放弃」和「回答」互相覆盖 |
| 卡片与转录的收尾 | 卡片消失；工具行「提问 · 已取消」+ 展开显示「本轮已取消，未提交回答」+ 题面 | 卡片消失（`QuestionComposer.tsx:31-36` 把 `cancelled` 移出可渲染集）；工具行同款只读记录（`ToolCard.tsx:178-196`）；steer 的用户消息渲染为紧凑气泡「放弃整组问题 / 未提交回答」而不是原始 JSON（`transcript.tsx:206-223,225-262`、`tool-render-model.ts:765-779`） | 已对齐；**有意差异（表现）**：DSH 没有这条用户消息（其取消不走 steer），pi 用气泡如实呈现 |
| 演示与测试 | —— | demo `[ask]` 后点「放弃整组问题」→ 模型收到 `dismissed_pending_question` 并收尾（`demo-model.ts:121-133,239-244`）；`tests/interactions.test.ts` 折叠用例、`tests/runtime.test.ts` 端到端（cancelled 状态 + 只 steer 一次 + 幂等 + 回答 409）、`tests/http.test.ts` 路由（200 / 幂等 / 409 / 404）、`tests/projection.test.ts` 存储态解析 | 证据：`pi-98-ask-02-cancelled`（行 + 记录 + 气泡）与 `dsh-98-ask-04-cancelled-toolrow` / `dsh-98-ask-05-cancelled-detail` 并排 |

### 3) `subagent` 工具行

| 语义 | DSH | pi-web | 定性 |
|---|---|---|---|
| 行摘要 | 回执行显示委派任务 + 「已启动」badge（`control-details-model.ts:147-152`：`received(arg(args,'prompt'), {label:'已启动'}, …)`），展开含「智能体 ID」字段；工具输出文本是 `started subagent <id>`（`tool-subagent/src/index.ts:273`） | 行摘要「已开始子智能体 · {label} · {子会话 id}」（`tool-render-model.ts:806-821`；行接线 `ToolCard.tsx:63-68,80-87`），展开为回执卡：任务原文 + `子会话: {id}` + 「打开子会话」 | 有意差异（表现）：两侧都「用回执替代原始 JSON」，但 DSH 以任务原文作标题 + 「已启动」，pi 以「已开始子智能体 · label · id」摘要 + 任务原文在卡内（任务口径要求 + 子会话 id 是跳转锚点） |
| 不再显示整段 JSON 参数 | DSH 记录卡出现时以 `bodyRaw/output` 置空替换 ioCard（`ask-question-row.tsx:346-351` 的同款手法；`subagent` 行由 details 模型接管） | `ToolCard.tsx:115`（`argsPayload` 对 `subagent` 置空）与 `:147-150`（`工具详情` 折叠项隐藏）；实测 `pi-98-subagent-01-row` / `-02-receipt` 均无 JSON | 已对齐（语义：行内不再暴露 `task` 原文的 JSON 形态） |
| 跳转 | DSH 用会话头的子智能体目录展开/打开（`SubagentHeaderLineage.tsx:760-822`） | 行内「打开子会话」按钮 → 复用选会话路径（`ToolCard.tsx:200-215` → `App.tsx:1536` 的 `onOpenSubagent` → `selectConversation`）；实测进入子会话「机制归纳」，侧栏仍只有父会话（`pi-98-subagent-04-child`） | 已对齐（多了行内入口，是 pi 前台一次性形态的自然入口） |
| DSH 侧的分组呈现 | 标准模式下单个工具行收进「已协调子智能体并调用工具」分类行，回执行在展开组内 | pi 的组策略由「工作步骤」设置控制（默认标准即平铺单行） | 不适用（呈现策略差异，非语义差异） |

### 4) 面板 hover 即开/即关

| 语义 | DSH | pi-web | 定性 |
|---|---|---|---|
| 悬停开（150ms） | `SubagentHeaderLineage.tsx:536-544` / `TeamAction.tsx:223-237` | `SubagentPanel.tsx:108-116` / `TeamPanel.tsx:121-133`（同 150ms；`prefers-reduced-motion` 下立即开，pi 追加的无障碍处理） | 已对齐（阈值与取消逻辑逐行同构） |
| 悬停关（120ms） | `:546-553` / `:238-245`，移出根容器与面板都重新计时 | `SubagentPanel.tsx:118-126` / `TeamPanel.tsx:134-143`；根 `onMouseLeave` + 面板 `onMouseEnter` 取消 + `onMouseLeave` 重新计时（`SubagentPanel.tsx:193,207` / `TeamPanel.tsx:180,198`） | 已对齐（实测 hover 开、移开 120ms 内关；`pi-98-subagent-03-hover-open`、`pi-98-team-01-hover-open` 与 `dsh-98-hover-03-subagent-open`、`dsh-98-hover-01-team-open` 并排） |
| 点击 pin | `pinnedRef`（`:686-690` / `:280-284`）：点击后悬停移出不关 | `SubagentPanel.tsx:196-199` / `TeamPanel.tsx:183-187`；面板打开时点击聚焦面板（DSH 同款） | 已对齐 |
| 外部点击关闭 | pointerdown 不在根/面板内 → 关（`:611-620` / `useDismissOnOutsidePointer`） | `SubagentPanel.tsx:130-146` / `TeamPanel.tsx:146-168` | 已对齐 |
| Escape | SubagentHeaderLineage：Escape → `changeOpen(false, true)`（焦点回触发器，`:642-644`）；TeamAction：焦点在面板内才回触发器（`:248-258`） | `SubagentPanel.tsx:173-180`（回触发器）/ `TeamPanel.tsx:153-157`（焦点在面板内才回） | 已对齐（逐面板同款） |
| 窄容器降级 | 容器 ≤480px 隐藏触发器文字并改为仅点击展开（`TeamAction.tsx:231`、`TeamAction.module.css:19-25`） | 同款容器查询（`TeamPanel.module.css:43-51`）+ `TeamPanel.tsx:124-127`；实测 460px 宽下标签收起、悬停不开、点击开且面板 336px 完全在视口内（`pi-98-team-03-narrow`） | 已对齐 |

### 5) 团队成员行与窄容器

| 语义 | DSH | pi-web | 定性 |
|---|---|---|---|
| 模型信息 hover 才显示 | `.memberModel { display:none }` + `.member:hover/.member:focus-visible .memberModel { display:inline }`（`TeamAction.module.css:197-206`） | 同款规则（`TeamPanel.module.css:203-209`）；实测静止 `display:none`、悬停行 `display:inline` 且其它行仍隐藏（`pi-98-team-02-member-model`） | 已对齐（本轮从「常显」改为 hover；`docs` 旧条目关闭） |
| 面板不溢出 | 面板 `width: min(500px, 100vw - 32px)`、placement 夹取 | 336px 单列 + `place()` 夹取（`TeamPanel.tsx:82-93`）；460px 视口实测 `right=444 < 460`，无横向溢出 | 已对齐（几何仍为 336 单列，见团队对比的几何条目） |

### 待跟进（本轮未做）

- ~~**子会话面包屑 switcher**~~ —— **已实现（2026-10-19）**：子会话头显示「父会话标题 ← 当前子会话」面包屑，同级用计数 dropdown 切换、当前项带「当前会话」tag，点父标题返回；截图 `pi-99-subagent-*`。
- ~~子会话耗时 / token 列~~ —— **已实现（2026-10-19）**，口径见上。

## 团队对比（2026-10-19，共享看板 + send/wait + 面板）

两侧跑同一条流程（1440×900 / 浅色 / 中文）：`spawn_teammate`（wp-checker）→ `team_task_create` → `send_message` → `list_agents` → `wait_agent` → 原样汇报。pi demo 证据 `pi-97-team-01…05`；真实模型证据 pi `pi-97-team-06-real-panel.png`（会话 361）、DSH `dsh-97-team-01-panel.png`（DSH 实例 3080，显式选 DeepSeek-V4.1-Flash）。

### 机制对照

| 观察点 | DSH（`687f282e86`） | pi-web | 差异定性 |
|---|---|---|---|
| 共享状态存放 | `team/member` + `team/task` 全量快照事件，只写 Lead 会话日志（`packages/experimental/agent-team/src/types.ts:227-243`），由 session projection 折成 `agentTeam`（`projection.ts:100-119`，注册 `index.ts:99`） | 一个 conversation doc `pi-web.team = {members, tasks}` 挂在 Lead 会话（`src/server/team-tools.ts:83`）；另有 `pi-web.team-member` 身份 doc 写成员子会话（`:96`）、`pi-web.team-anchor` 记后台锚点任务（`:112`）；`pi-web.team` 的读路径是 `harness.snapshot`（`runtime.ts:580`） | 有意差异：Pi 的 `view.docs` 只挂 5 个内置 doc（families.md A3），自定义 doc 走 `snapshot/watchDoc`；语义相同（整份快照、后写覆盖） |
| 成员记录与 phase | `TeamMemberSnapshot{id,name,description,provider,context,phase:'provisioning'\|'active'\|'failed',error?}`（`types.ts:44-56`）；Lead 是伪行（`roster.ts:129-136`） | `TeamMemberRecord{name,role,conversationId?,phase,label?,error?}`（`team-tools.ts:60-67`）；`memberViews` 合成 lead 行（`team-tools.ts:530-561`，DSH `roster.ts:126-157` 同形） | 有意差异（字段取舍）：pi 用 `conversationId` 取代 DSH 的 `id`+`provider`（成员即子会话）；`description` 落为 `label`（子会话标题） |
| 名字规则与上限 | lower-kebab、≤64、保留 `lead`、名字不复用（`roster.ts:25,436-444`）；`maxMembers 16`（`index.ts:42,257-259`） | 同一正则与文案（`team-tools.ts:212-220`）、`MAX_TEAM_MEMBERS=16`（`:42`）、复用检查含 failed 行（`:630-637`） | 已对齐 |
| spawn 语义 | Lead only（`roster.ts:234-236`）；建 continuable child + 首条 prompt，返回 `{member}`，**不等答案**（`roster.ts:263-295`） | Lead only（`team-tools.ts:806-808`）；`api.commit` 建 task-owned 子会话 + 身份 doc（`:826-845`）→ `submit`（`:860-866`，稳定 `requestId=team-spawn:<lead>:<name>`）→ 落 `active`（`:870-880`）；返回成员行 | 已对齐（启动即返回）；底座不同见「有意差异 1/4」 |
| 成员状态 | `phase` + live Agent 的 `availability` = `running`/`inactive`（`roster.ts:475-477`），`failed`/`provisioning` 直接取 phase（`:144-151`） | 同一四态：`memberViews` 用 `conversationInfo` 读子会话 `pi.live.run`（`runtime.ts:363-382`）+ phase 直取（`team-tools.ts:549-556`） | 已对齐（`inactive ≠ 完成` 的文案也在 list_agents 描述与 policy 里） |
| send_message | 校验目标是 active 成员或 `lead`（`roster.ts:42-54`），禁止自消息（`index.ts:229`），内容前缀 `Team message from <name>:`（`index.ts:230-233`），>64KB 拒绝（`index.ts:234-236`），投递到目标 inbox（steer）后即返回 `{sent:true}`（`index.ts:239-247`） | 同一授权/自消息/前缀/`65536` 上限（`team-tools.ts:887-927`）；`whenBusy:'steer'` + 稳定 requestId；返回 `{"sent":true}` 而非对方回答 | 已对齐 |
| wait_agent | 先同步读活跃 peer；无则立即 `noProgress{reason:'no-active-peer'}`（`tool-agent-team/src/index.ts:44-45,267-279`）；有则挂 waiter，**只观察调用之后的变化**、10s–1h（默认 30s），超时 `timedOut:true`（`activity.ts:22-66`） | 同一顺序与文案（`team-tools.ts:949-973`）；等待 = `api.watchDoc(Team)` + runtime 的成员会话 busy 变化 watch（`runtime.ts:384-407`）+ 注册后状态 digest 复核（`team-tools.ts:677-737`）；abortSignal 竞速并清定时器 | 有意差异（细节）：DSH 的「活跃读 + 注册 waiter」在同一个同步 span 里，Pi 的读是异步的，故注册后补一次 digest 比对，把注册窗口内的变化也算作「调用之后的变化」 |
| interrupt_agent | Lead only、不能自中断，`previousStatus` 在中断前采样，立即返回（`roster.ts:187-198`） | 同一授权与 `previousStatus`（`team-tools.ts:976-996`）；`abort` 是 join 语义（families A1/A2），调用等成员停下 | 有意差异（细节）：DSH 立即返回；pi 等 abort 完成才返回，避免悬空句柄 |
| 任务快照 | `TeamTaskSnapshot{id,revision,subject,description,status,ownerId?,blockedBy,writeScopes}`（`types.ts:71-84`），每次变更 revision+1（`task-board.ts:203-206`） | `TeamTaskRecord` 同字段 + `owner`（成员名）+ `createdAt/updatedAt`（`team-tools.ts:69-81`），`mutateTask` revision+1（`:380-402`） | 有意差异：owner 存名字（面板/授权用名，DSH 用 SessionId）；多两个时间戳供 UI |
| CAS 与越权 | stale → `TEAM_TASK_STALE_REVISION`（`task-board.ts:115-120`）；deleted 不可变（`:121`）；owner 或 Lead 才可改（`:122-126`）；claim 要 ready 且未被他人占用（`:129-137`）；complete/reopen/release 各自状态门（`:138-171`）；reassign 仅 Lead（`:172-188`）；delete 有依赖则拒（`:189-198`） | 同一语义与错误文案（`team-tools.ts:410-521`、`authorizeOwner:404-408`、`mutateTask:380-402`；reassign 仅 Lead `:484-499`；delete 依赖检查 `:501-517`） | 已对齐（含 `deleted` 墓碑保留、依赖拒删） |
| 依赖校验与环 | 自指/重复/缺失(或已删)分别拒绝，全图 DFS 检环（`task-graph.ts:26-69`）；`task-board.ts:213-232` 去重归一 | `validateDependencies:317-336`（自指/重复/缺失）+ `assertTaskGraph:283-307` + `detectCycle:262-279` | 已对齐（错误分类：`dependency-cycle`/`invalid-argument`/`task-not-found`） |
| ready 与视图 | `taskReady` = 依赖全 completed（`task-view.ts:24-26`）；视图含 `ownerName/ready/writeScopeWarnings`，警告取「与其他 in_progress 任务的写范围重叠」（`:37-62`） | 同（`team-tools.ts:223-255`）；额外投影 `blocked`（pending 且未 ready）给面板用 | 已对齐（多一个显式 `blocked` 布尔） |
| 写范围归一化 | `\`→`/`、去 `./`、去尾 `/`；拒绝空/绝对/盘符/`.`/`..`/空段（`validation.ts:26-34`）；去重（`task-board.ts:234-237`） | 同（`team-tools.ts:196-210`）；advisory 不是锁的措辞也在 policy 段（`:739-745`） | 已对齐 |
| 任务限额 | 非删除任务上限 256（`index.ts:43`、`task-board.ts:46-51`） | `MAX_TEAM_TASKS=256`（`team-tools.ts:43,345-347`） | 已对齐（id 取现有最大 `task-N` + 1，不复用墓碑 id） |
| team_task_list | status/owner/ready 过滤 + cursor/limit（1–100，默认 50）+ `nextCursor`（`tool-agent-team/src/index.ts:322-352`） | 同（`team-tools.ts:1026-1054`，owner 支持 `unowned`） | 已对齐 |
| policy 注入 | `team:policy` section（共享文件系统、写范围 advisory、`list→get→claim→干活→complete`、`inactive≠完成`、wait 语义）+ 身份 context（Lead/teammate）（`tool-agent-team/src/index.ts:34-42,173-190`） | `team-policy` section（`team-tools.ts:739-761`）：teammate 身份 + 同一组规则；Lead 只在已有 teammate 时注入 | 有意差异（注入条件）：pi 不按 Agent scope 安装，改为「有团队才注入」，避免污染普通会话；文案取自 DSH 同义改写 |
| 面板触发器 | 「智能体团队」+ icon，28px/12px/tertiary；hover 即开 150ms、hover 即关 120ms；点击 pin（`TeamAction.tsx:223-245,275-289`、`TeamAction.module.css:5-17,19-25,120-131`） | 同位置同字号（`TeamPanel.tsx:180-198`、`TeamPanel.module.css:10-40`）；文案「智能体团队 · {n} 名成员」，运行中状态点；hover 即开/即关 + 点击 pin 已按 DSH 实现（`TeamPanel.tsx:121-149`），窄容器（≤480px）收起文字并降级为仅点击（`TeamPanel.module.css:43-51`、`TeamPanel.tsx:124-127`） | **已修（2026-10-19）**：见「交互收尾对比」第 4 节；证据 `pi-98-team-01-hover-open` / `pi-98-team-03-narrow` 对 `dsh-98-hover-01-team-open` |
| 面板成员区 | 成员计数 + 2 列 roster；行 = 状态点（inactive 用 user icon）/名字/当前会话 Tag/状态文案（hover 才露模型）/错误小字；failed/provisioning/当前会话不可点（`TeamAction.tsx:78-126,317-337`、`TeamAction.module.css:197-206`） | 同结构单列（`TeamPanel.tsx:203-236`）：图标/状态点 + 名字 + 「当前会话」Tag + 状态文案 + 错误小字；模型 hover 才显示（`TeamPanel.module.css:203-209`，实测静止 `display:none`、悬停行 `display:inline`，`pi-98-team-02-member-model`）；inert 条件相同 | 已对齐（模型 hover 于 2026-10-19 修）；几何仍是有意差异：面板 336px 单列（DSH 500px 双列、孤成员 320px compact） |
| 面板任务区 | 空态「暂无共享任务，可以通过对话创建」；卡片 = subject + 状态点/状态文案 + 2 行描述 clamp + 展开 + meta（id / Owner / ready-braced / 依赖 / 写入范围 / 警告）（`TeamAction.tsx:129-176`、`TeamAction.module.css:247-347`） | 同（`TeamPanel.tsx:173-204`、`:186-220`）：空态同文案、状态点映射相同（pending ready=idle、blocked=warning、in_progress=ongoing、completed=done）、meta 同项 | 已对齐（单列宽度下的同一版式） |
| 打开成员会话 | 点行 → `openTeammate`（`TeamAction.tsx:97-102`） | 点行 → 现有选会话路径（`TeamPanel.tsx:139-149` → `App.tsx:1447-1450`）；成员会话仍不进侧栏（`runtime.ts:770-792` 的 `list()` owner 过滤） | 已对齐（ego `pi-97-team-03`：进入成员会话后侧栏仍只有 Lead；`pi-97-team-04`：Tag 跟着切到 researcher） |
| 列表变化推送 | Team 事件进 Lead 日志 → projection 帧随会话流推送 | 投影随 Lead 的 SSE 快照（`runtime.ts:1335-1339`）；成员会话 busy 变化不在 Lead 流里，故面板在「有成员运行中或面板打开」时 1.5s 轮询（`TeamPanel.tsx:66-71`） | 有意差异（底座不同）：与 `SubagentPanel` 同一策略 |

### 有意差异（理由与影响）

1. **成员即 Pi 子会话**：DSH 的 teammate 是 Cordis `continuable` subagent（provider `spawn`/`fork` + `startActivation`），pi 没有这层插件体系，改用与 `subagent` 相同的 seam —— `api.commit` 建 task-owned 子会话 + `pi-web.team-member` 身份 doc（`team-tools.ts:826-845`）；子会话自动继承 Lead 的 agent 组合（工具/模型/工作目录）。影响：teammate 的面板行、`send_message` 与 `interrupt_agent` 全部落到子会话上，语义等价；DSH 的 `provider`/`context` 里的 provider 名没有对应物。
2. **看板在 conversation doc**：Pi 的自定义 doc 不进 `view.docs`（families.md A3），所以 `pi-web.team` 由 runtime 用 `harness.snapshot/watchDoc` 读（`runtime.ts:580-586`、`team-tools.ts:677` 的 watch）。影响：投影必须显式接线（`projection.ts:432-486`），但获得「compaction 不丢状态」和「fork 不继承」两个性质。
3. **`wait_agent` 用 `watchDoc` + 有界等待**：DSH 在同一个同步 span 内完成「读活跃 peer → 注册 waiter」（`tool-agent-team/src/index.ts:267-279`），Pi 的读是异步的，故注册后再做一次状态 digest 复核（`team-tools.ts:705-724`），把注册窗口内的变化补记为「调用之后的变化」；abort 与 `context.abortSignal` 竞速并清定时器（families A1/A2）。只观察、不唤醒成员、无活跃 peer 立即 `noProgress` 三条语义与 DSH 一致。
4. **后台成员用后台锚点任务**：Pi 的 run 所有权决定「父会话是否等子会话」；成员子会话挂在 `pi-web.team-anchor` 的 `{background:true}` 任务下（`team-tools.ts:112-141,1155-1172`；pi-durable README「background 任务不占父会话」），所以 spawn 返回后 Lead 立即继续（demo `pi-97-team-02` 面板出现时 Lead 已收尾），`interrupt_agent` 仍直接 abort 成员会话。DSH 由 continuable child + 生命周期托管实现同一效果。
5. **面板几何**：pi 是 336px 菜单材质单列（任务要求「336px 级宽度」），DSH 是 500px 双列（孤成员 320px compact）；触发器文案 pi 为「智能体团队 · {n} 名成员」，DSH 只有「智能体团队」。
6. ~~不做 DSH 的 hover 即开/即关（150/120ms）~~ —— **已修（2026-10-19）**：`TeamPanel` 与 `SubagentPanel` 都按 DSH 阈值实现（见「交互收尾对比」第 4 节）。仍不做成员面包屑 switcher（待跟进，见同节）。
7. **不适用**：DSH 的 `team/message/queued|delivered` 历史 mailbox 事件（新路径走 Agent inbox，pi 无对应）、`disposalTimeoutMs`（运行时处置超时）、`structuredOutput` schemastery 输出 schema（pi 用纯文本 JSON + details）、`interrupt` 插件开关（`tool-agent-team/src/index.ts:284`，pi 始终注册）。

### 待跟进的小项（团队）

- **provisioning 崩溃对账**：DSH 在成员会话启动时用持久日志对账 `provisioning` 行（`roster.ts:374-417`），并把 `failed` 落盘；pi 的 `spawn_teammate` 未声明 `replay`，进程在「已写 provisioning 行、未落 active」之间崩溃会留下 `provisioning` 行，需要人工 `list_agents` 后处理。建议下轮做成 replay-safe（按名字复用成员行 + 对账子会话）。
- `context:'fork'` 已实现（`tx.forkConversation` 取 Lead 最近 entry，`team-tools.ts:1174-1180`），但 demo/测试只覆盖 `fresh`；fork 的继承语义（DSH 只 fork 已完成的 Lead 轮次）未验证。
- ~~DSH 的成员行 hover 才露模型；pi 常显~~ —— **已修（2026-10-19）**：模型改为 hover/focus 显示（`TeamPanel.module.css:203-209`），窄容器下面板与成员行均不溢出（`pi-98-team-02-member-model` / `pi-98-team-03-narrow`）。
- `interrupt_agent` 等 abort join 完成（见机制对照），长 turn 的成员会让工具行停留较久；DSH 是立即返回 + 事后状态。

## 真实模型验证（2026-10-19，opencode-go/deepseek-v4.1-flash）

在真实实例（4317，真实数据目录）新建会话并选择该模型，逐族验证：

| 族 | 结果 |
|---|---|
| 待办 | 模型主动调用 `todo_write` 建立三项清单（1 进行中 / 2 待处理），投影与面板正确（截图 `pi-61`/`pi-62` 同会话） |
| 问答 | 模型调用 `ask_user_question` 提问；界面出现问答卡（1/1、选项 继续/停止、自定义输入、跳过/提交），点击「继续」提交后卡片转为「已回答」只读态，模型收到回答后继续（截图 `pi-61-ask-real.png`、`pi-62-ask-real-answered.png`） |
| 目标 | 模型调用 `create_goal`（max 1），自行核对 README 标题已满足目标后调用 `update_goal(action="complete")` 收尾（`phase: complete`、rounds 0/1、revision 2）；人工创建的目标经接口暂停后界面同步为「已暂停的目标」 |

### 子智能体（2026-10-19 追加，真实模型 `opencode-go/deepseek-v4.1-flash`）

按 skill 红线（真实模型只用 DeepSeek），在真实实例（4317，真实数据目录）新建会话并显式选择 `opencode-go/deepseek-v4.1-flash`：

- 提示：「请调用 subagent 工具，把「计算 17*23」委派给子智能体（label 用 calc），拿到它的答案后原样复述给我。」
- 结果：模型调用 `subagent` → 子会话 345（label `calc`，状态 `inactive`，答案 `391`）→ 父会话最终回答「子智能体（label: calc）的回复原样如下：391」。
- 证据：`GET /api/conversations/331` 的 `subagents[0] = {id:345,label:calc,status:inactive,answer:391}`；工具列表含 `subagent`。

> 早前该族的一次真实模型复跑使用了 `zai-coding-cn/glm-5.3`（当时本机 opencode-go 在该临时实例上报 401、cmdc 报无额度），**不符合当前红线，已作废并用上面的 DeepSeek 结果替代**；demo 侧的确定性证据（`pi-90-subagent-*.png`）不受影响。

### 团队（2026-10-19 追加，真实模型两边同一条流程）

两侧同一条提示词（`spawn_teammate` wp-checker → `team_task_create` → `send_message` → `list_agents` → `wait_agent(timeout_ms 30000)` → 原样汇报成员行/任务行/session id/答案），真实模型只用 DeepSeek：

**pi-web**（真实实例 4317，真实数据目录；`POST /api/conversations` 显式带 `model`，不靠默认值）：

- 会话 361「团队真实链路」，`model = {"provider":"opencode-go","modelId":"deepseek-v4.1-flash"}`。
- 成员行：`lead`（role lead / phase active / status inactive / 会话 361）+ `wp-checker`（role teammate / phase active / 会话 379 / label 链路自检 / 模型同上）；第一次 `list_agents` 抓到 `wp-checker` 为 `running`，收尾时 `inactive`。
- 任务行：`task-1`「验证团队链路」`status pending / ready true / revision 1 / blockedBy [] / writeScopes []`（验收标准写在 description）。
- 工具链：`spawn_teammate` → `{member:{conversationId:"379",status:"running",...}}`；`send_message` → `{"sent":true}`；`wait_agent` → `{"timedOut":false}`（被成员状态/消息变化唤醒，不是 noProgress）；`team_task_list` 复核任务。
- wp-checker 子会话（379）用 bash 执行 `printf team-ok`，答案原样回传 `team-ok`，未改动任何文件；模型按提示词原样给出四行证据（截图 `pi-97-team-06-real-panel.png`：面板显示 2 名成员 + 1 条「可开始」任务）。
- 如实记录：模型明确说明「步骤未要求 complete」，任务保持 `pending/ready`；完整 `claim → 陈旧 revision 被拒 → complete` 由 demo `[team-task]` 分支与 `tests/runtime.test.ts` 覆盖（revision 3 / owner lead / completed）。

**DSH**（真实实例 3080，`dsh web`；在会话上显式选 DeepSeek-V4.1-Flash，同一条提示词）：

- teammate session id `20dd7b1b-477c-4754-a24e-b36de8420295`；`task-1` `pending / ready`；`send_message` → `{"sent":true}`；`list_agents` 观察到 `running → inactive`；`wait_agent(timeout_ms=30000)` → `{"timedOut":false}`；答案 `team-ok`；模型同样未执行 claim/complete。
- 面板截图 `dsh-97-team-01-panel.png`（成员 2、共享任务 1，双列 roster）。

→ 两侧同一流程、同一模型族、同一结果（成员 `inactive`、任务 `pending/ready`、`sent:true`、`timedOut:false`、答案 `team-ok`）；差异仅在底座与面板几何，见上节「团队对比」。

## 验收标准（自 2026-10-19 起）

固化为 skill：**`dsh-parity`**（`~/.agents/skills/dsh-parity/SKILL.md`）。**真实模型测试只允许 DeepSeek 系模型（默认 `opencode-go/deepseek-v4.1-flash`，须显式选择、不依赖实例默认值）；禁止 GLM/Qwen/Claude 等其他模型，额度有限。** 三步缺一不可：
1. **动手前核对 DSH 源码**（`/Users/yin/Documents/ybs/code/agent/deepseek-harness`）——读实现、抄出状态存放/协议/边界/文案，带 `路径:行号`；
2. **两侧同一条流程各跑一遍**（同 viewport/主题/语言，关键路径用真实模型），逐步截图成对存 `artifacts/ego-compare/shots/`；
3. **代码级并排分析**——DSH 实现路径 ↔ pi 实现路径逐条核对语义，差异定性为待修/有意/不适用。

每条结论都要有：DSH 源码行号、pi 源码行号、两侧截图（或 DOM 断言）、有意差异的理由。

### 问答「回答完成之后」的两侧对比（同日实测，真实模型 deepseek-v4.1-flash）

| 观察点 | DSH（真实实例 3080） | pi-web（真实实例 4317） | 差异 / 处理 |
|---|---|---|---|
| 回答时机与消息路径 | 窗口内回答走**工具结果**：转录不出现额外用户气泡，只有助手文本「已按你的要求询问，你的选择是：继续。」（截图 `dsh-74-ask-late-answered.png`） | pi 一期采用「立即 pending」模式，回答一律走**迟到路径**：向会话 steer 一条 `pi-web.user-question-reply` 用户消息 | 机制差异（有意）。DSH 的迟到路径同样是「一条用户消息」，故渲染应对齐 DSH 的迟到呈现，而不是原样显示 JSON |
| 转录里的回答呈现 | 迟到回答渲染为折叠气泡「回答先前等待的问题」+ 摘要行 + 逐题「问题 / 回答：」定义列表 + 复制（`ui-user-questions/src/client/QuestionReplyView.tsx:30-105`，解析/取值/复制文本 `.../question-reply.ts:58-132`） | **已修**：同一呈现 —— 识别 + 折叠气泡在 `src/web/transcript.tsx:60-72`（回答表）、`:199-209`（`UserEntryRow` 分派）、`:217-284`（气泡）；纯函数在 `src/web/tool-render-model.ts:506-616`。截图 `pi-80-ask-reply-02-bubble-collapsed.png`、`pi-80-ask-reply-03-bubble-expanded.png`、`pi-80-ask-reply-06-copied.png` | **已修**（2026-10-19，demo `[ask]` 实测；对照 `dsh-74-ask-late-answered.png`） |
| 工具行呈现 | 「提问」+ `N / M` + 状态（等待回答 / `{answered}/{total} 已回答`），展开为只读问答记录（`ui-tool/src/client/tool/toolviews/ask-question-row.tsx:214-368`；解析/配对 `:47-148`；文案 `ui-conversation/src/client/locales.ts:290-303`） | **已修**：`提问 · 1 / 2 · 已回答`（等待态 `0 / 2 · 等待回答`、失败 `提问失败`）；展开为只读记录 + 保留「调用参数」「工具详情」折叠项 —— `src/web/ToolCard.tsx:45-68`（行模型接线）、`:156-172`（记录卡）；纯函数 `src/web/tool-render-model.ts:648-735`。截图 `pi-80-ask-reply-01-tool-pending.png`、`pi-80-ask-reply-04-tool-collapsed.png`、`pi-80-ask-reply-05-tool-expanded.png` | **已修**（2026-10-19，demo `[ask]` 实测；对照 `dsh-73-ask-after-timeout.png`） |
| 问答卡 | 回答提交后离开输入区（窗口内）或转「已继续工作，仍可回答」再被替换 | 回答后卡片转只读「已回答」并显示逐题摘要（截图 `pi-62-ask-real-answered.png`） | 已对齐（pi 的只读态即 DSH 的 review 态） |
| 卡内元素 | 题号 `1 / 1`、`跳过`、`提交`、收起/放弃整组按钮、自定义输入框 | 题号 `1 / 1`、`跳过`、`提交`、收起、自定义输入框 | 已对齐（DSH 另有「放弃整组问题」按钮，pi 暂缺，记为小项） |

#### 迟到回答 + 问答工具行的代码级并排（2026-10-19，DSH `687f282e86`）

| 语义 | DSH（`packages/client/...`） | pi-web（`src/web/...`） | 定性 |
|---|---|---|---|
| 识别迟到回答 | `ui-user-questions/src/client/question-reply.ts:135-143`（`replySource` 读 entry `source.kind === 'user-question-reply'` + `:152-154` 独占 chat 节点） | `tool-render-model.ts:506-528`（解析消息文本，要求 `kind === 'answer_to_pending_question'`；先做 `includes` 廉价格挡）+ `transcript.tsx:199-209` 分派 | 有意：pi 的 `ChatMessage` 不带 entry kind（`projection.ts` 已把 entry 折成文本消息），因此按 payload 自识别；对普通用户消息（含 JSON）无副作用（`tests/render-model.test.ts:267-278`） |
| 解析容错 | `question-reply.ts:58-97`：JSON 不可解析 → 空 pairs；逐条丢缺 `id`/`question` 的题与缺 `id`/`selected` 的答 | `tool-render-model.ts:506-573`（同语义：`:530-546` 题、`:563-573` 答、`:548-561` 选项） | 已对齐（用例 `tests/render-model.test.ts:242-253、267-278`） |
| 回退原文 | `QuestionReplyView.tsx:65-66`：`questions.length === 0` 时渲染 `data.text`；`question-reply.ts:121` 复制回落 `data.text` | `transcript.tsx:265`（展开渲染 payload 原文）+ `tool-render-model.ts:604-605`（复制回落）；`lateAnswerOf` 返回 null 时整条走普通气泡 `MessageRow` | 已对齐 |
| 逐题取值 | `question-reply.ts:106-110`（selected 顺序 + 非空 custom） | `tool-render-model.ts:575-580` | 已对齐 |
| 折叠摘要 | `QuestionReplyView.tsx:34`：所有题的取值扁平连接；全空 → `reply.skipped`「已跳过」 | `tool-render-model.ts:591-601`：逐题取值（跳过写「已跳过」）后连接；全跳过 → 「已跳过」 | 有意（细微）：DSH 扁平列表不标出被跳过的题；pi 逐题标「已跳过」，符合本轮任务口径，信息更全 |
| 展开定义列表 | `QuestionReplyView.tsx:65-91`（dt: header/question/detail/options，dd: `reply.answerLabel` + 取值） | `transcript.tsx:266-278`（同结构；分隔符用 `、`/`, ` 而非 DSH 硬编码 `, `） | 已对齐（分隔符为本地化差异，有意） |
| 复制 | `QuestionReplyView.tsx:37-44` + `question-reply.ts:120-132`：题面（header — question）+ `回答：` 值，成功 1s 对勾（`writeClipboard`） | `transcript.tsx:230-238`（`writeClipboard` + 1000ms 对勾）+ `tool-render-model.ts:604-616`（同版式） | 已对齐（实测：点击后 ~0.4s 的截图 `pi-80-ask-reply-06-copied.png` 显示对勾；1.2s 后 `aria-label` 由 `已复制` 回退为 `复制问答回答`） |
| 工具行状态机 | `ui-tool/.../ask-question-row.tsx:272-273` running → `ask.waiting`；`:305-315` pending + answerable → 「已继续工作，仍可回答」/ 不可答 → 「已结束」；`:297-334` answered → `{answered}/{total} 已回答`；`:176-186` 无法严格配对时的计数兜底 | `tool-render-model.ts:648-678`：`failed` → 提问失败；`pending` → `0 / M · 等待回答`；结果带 `answers`/`status:'answered'` 或转录里有迟到回答 → `N / M · 已回答`（计数 `:733-735`） | 有意：pi 没有 DSH 的 `userQuestions` 投影，行内状态 = 结果 details + 转录里的迟到回答，故 pending 一律「等待回答」，不区分 DSH 的「已继续工作，仍可回答 / 已结束」（DSH 的两个细分文案需要投影里的 answerable/settled，属 DSH 专有的 timed 通道） |
| 严格配对 | `ask-question-row.tsx:124-148`（题数相等 + 答 id 唯一 + 每题有答案；否则不给记录，只用计数摘要） | `tool-render-model.ts:712-731`（同语义，含题 id 唯一校验 `:680-692`） | 已对齐（用例 `tests/render-model.test.ts:326-348`：数量不符 / 重复 id → `record: null` + 计数摘要） |
| 只读记录组件 | `tool/components/AskQuestionCard.tsx:24-41` + `tool/models/ask-question-card-model.ts:8-24`（unanswered: verdict + 题面列表；answered: dl + `ask.skipped`） | `ToolCard.tsx:156-172`（等待：仅题面列表；已回答：题面 + `、` 连接取值 / 已跳过） | 已对齐；等待态不渲染 DSH 的 verdict 文案，见下「有意」项 |
| 行标题与图标 | `ask-question-row.tsx:214-368` → `QuestionToolRow`（`IconQuestionOutlineRegular` + `ask.rowTitle`「提问」） | `ToolCard.tsx:57-68`（`IconQuestionOutlineRegular` 于 `toolIcon`）+ 标题 `askQuestionRowModel` 的 `title`（`tool-render-model.ts:630,658`） | 已对齐 |
| JSON 折叠项 | DSH 展现记录卡时以 `bodyRaw/output` 置空替换 ioCard（`ask-question-row.tsx:346-351`） | pi 保留「调用参数」「工具详情」两个默认折叠 JSON，仅把工具结果通知文本让位给记录卡（`ToolCard.tsx:88-89`、`:124`） | 有意：本轮任务要求保留 pi 既有折叠项；两者都是折叠态，不影响记录卡可读性 |

残留差异定性（2026-10-19）：

- **已修（2026-10-19，本轮）**：pending 工具行已按 `interactions` 的投影状态细分。接线：`App.tsx:1527`（`interactions={activeDetail.interactions}`）→ `transcript.tsx:39-48,95-100,325-330`（`Transcript` → `ProcessGroup` → `ProcessPartView`）→ `ToolCard.tsx:43-58`（按 callId 查状态并传给行模型）→ `tool-render-model.ts:648-720`（映射：`pending`→`0 / M · 等待回答`、`continued`→`已继续工作，仍可回答`、`expired`→`已结束`、`cancelled`→`已取消`、`answered`→`N / M · 已回答`；DSH 对照 `ask-question-row.tsx:272-273,297-334`、文案 `ui-conversation/src/client/locales.ts:290-303`）。截图 `pi-98-ask-01-waiting.png`（等待回答）、`pi-98-ask-03-answered.png`（`0 / 2 · 已回答`）与 `dsh-98-ask-01-waiting.png`、`dsh-98-ask-06-answered.png` 并排一致；单测 `tests/render-model.test.ts`「reads the projected interaction state: waiting, continued, closed, cancelled」。
- **有意（残留，低优先级）**：pi 的 `pending` 在语义上更接近 DSH 的「已继续工作，仍可回答」（pi 的模型提问后立即继续，`interaction-tools.ts:128-134`），但 DSH 的两个细分文案由 `userQuestions` 投影的 answerable/settled 决定（`ask-question-row.tsx:224-241`），pi 一期没有 timed/answerable 通道，故按本轮口径把 `pending` 映射为「等待回答」；`continued` 分支已实现，等（若）引入超时/继续通道后自然生效。
- **有意**：等待态记录卡只列题面、不渲染 DSH 的 verdict 文案（`ask.pendingDetail` 一类）——可操作状态由输入区问答卡承担，记录卡为只读（`continued`/`expired`/`cancelled` 三个终态已带 verdict，见 `ToolCard.tsx:178-196`）。
- **有意**：保留「调用参数」「工具详情」折叠项（本轮任务要求；问实行仍保留，DSH 在记录卡出现时以 `bodyRaw/output` 置空替换 ioCard，`ask-question-row.tsx:346-351`）。
- **有意**：多值连接符用 `、`（英文 `, `）而非 DSH 折叠/展开处硬编码的 `, `（`QuestionReplyView.tsx:34,85`），与 pi 既有问答记录/卡片用词一致。
- **有意**：折叠摘要逐题标记「已跳过」，DSH 的扁平取值列表会省略被跳过的题（只有全体为空才显示「已跳过」）。
- **不适用**：DSH 的 `reply.outcome`（`question-reply.ts:27-33`）在 pi 只有一个值（按期到达的回答），故不渲染 outcome 相关分支。

- 2026-10-19：计划模式实现并验证（86 测试 + ego 全流程 + section 注入探针）；`exit_plan_mode` 已归入 `plan` 过程分组。`dsh-parity` skill 落地，后续所有对标工作按「先读 DSH 源码 → 两侧同流程跑 → 代码级并排分析」执行。
- 2026-10-19：问答两处迟到路径渲染对齐（转录折叠气泡 + `ask_user_question` 工具行）。前端解析、无服务端改动；门禁 98/98 通过（+12 用例）、typecheck/build 绿；demo 实例 4393 `[ask]` 全流程截图 `pi-80-ask-reply-01-tool-pending` / `-02-bubble-collapsed` / `-03-bubble-expanded` / `-04-tool-collapsed` / `-05-tool-expanded` / `-06-copied`，与 `dsh-73-ask-after-timeout.png`、`dsh-74-ask-late-answered.png` 并排核对；遗留差异与定性见上文「残留差异定性（2026-10-19）」。

- 2026-10-19：子智能体族（前台一次性 + children API）实现并验证。服务端：`src/server/subagent-tools.ts`（`subagent` 工具：task-owned 子会话 + `api.details` + `submit().wait()` + answer entry 取文本；`replay:'safe'` + ownerTaskId 复用 + 稳定 requestId；失败走 diagnostic 通道）与 `runtime.ts` 的 `children/childMessage/childStop`（自校验 owner 边，越界一律 `NOT_FOUND`）。协议：`GET /api/conversations/:id/children`、`POST .../children/:childId/messages|stop`（zod 严格），契约/`api.ts`/`FakeRuntime` 同步。投影：`ConversationDetail.subagents`（仅直接子会话，`list()` 不混入）+ 会话 `origin:'subagent'`/`parentId`。前端：`SubagentPanel`（会话头计数触发器 `{n} 个子智能体`、运行中状态点与「正在运行」aria 变体、336px 菜单材质卡、行 label + 状态 + 回答摘要 + 停止/跟进/打开；空态不渲染）挂在标题右侧；`App.tsx` 接线 `api.listChildren/childMessage/childStop` 与「打开子会话」。门禁：typecheck/build 绿、测试 102/102（含 runtime 的委派/只读委派/控制与越界、http 三路由校验）。ego：demo 实例 4322（`/tmp` 数据目录）跑 `[subagent]` → `1 个子智能体` → 展开 → 打开子会话 → 返回父会话 → 跟进（抓到「正在运行」）→ 停止；截图 `pi-90-subagent-01-trigger` / `-02-menu` / `-03-child-transcript` / `-04-back-to-parent` / `-05-running` / `-06-stopped` / `-07-child-after-followup`。DSH 源码对照与有意差异（前台等待 vs 启动即返回）见上文「子智能体对比」。

- 2026-10-19：团队族（共享看板 + send/wait + 面板）实现并验证。服务端 `src/server/team-tools.ts`：`pi-web.team`（members+tasks）+ `pi-web.team-member`（成员身份，供 teammate 会话解析 Lead 看板）+ `pi-web.team-anchor`（`{background:true}` 锚点任务，成员子会话挂在其下，spawn 不再阻塞 Lead）；9 个工具（spawn/send/list/wait/interrupt + team_task_create/list/get/update）；看板纯函数（CAS、依赖 ready、环校验、owner-or-Lead 授权、reassign 仅 Lead、delete 依赖拒删、写范围归一化、`taskView` 的 blocked/ready/warnings）；限额 16/256/64KiB、`wait_agent` 10s–1h 有界等待并与 abort 竞速。runtime：`team(id)` + 成员状态探测（子会话 `pi.live.run`）+ `watchMembers`；`GET /api/conversations/:id/team`；投影 `ConversationDetail.team`；`READ_ONLY_TOOLS` 放行团队工具。前端：`TeamPanel`（会话头触发器「智能体团队 · {n} 名成员」/运行中状态点；336px 菜单材质面板：成员区（状态点/名字/当前会话 Tag/状态文案/模型/错误小字，点行打开成员会话）+ 共享任务区（空态「暂无共享任务，可以通过对话创建」、状态点映射、Owner/可开始/被依赖阻塞/依赖/写入范围/警告、描述展开））。demo `[team]`/`[team-message]`/`[team-task]`/`[team-wait]`/`[team-wait-timeout]` 分支。门禁：typecheck/build 绿、128/128（+17：`tests/team.test.ts` 12、runtime 4、http 1）。ego demo `pi-97-team-01-trigger` / `-02-panel` / `-03-member-session` / `-04-member-current` / `-05-back-to-lead`；真实模型 pi `pi-97-team-06-real-panel.png`（会话 361 / 成员 wp-checker 379 / task-1）与 DSH `dsh-97-team-01-panel.png`（同流程同结果）。DSH 源码对照与有意差异（成员即子会话、看板在 doc、watchDoc 有界等待、无 Cordis 插件体系/无 provisioning 对账）见「团队对比」。

## 收尾（2026-10-19）

六族全部落地并验证：待办、问答、目标、计划模式、子智能体、智能体团队。约束与环境：真实模型只用 `opencode-go/deepseek-v4.1-flash`（pi-web 侧模型白名单强制、旧 `~/.pi` 全局配置已裁剪并备份，当前运行时使用 `~/.pi-web`）；对标工作按 skill `dsh-parity` 执行（先读 DSH 源码 → 两侧同一条流程 → 代码级并排分析）。

### 交互收尾批次（2026-10-19 追加）

五项落地并两侧验证，详见上文「交互收尾对比」：

1. **问答工具行状态细分**：`interactions` 接进转录（`App.tsx:1527` → `transcript.tsx:39-48,95-100,325-330` → `ToolCard.tsx:52-62`），行模型按 `pending/continued/expired/cancelled/answered` 输出 DSH 的五行文案（`tool-render-model.ts:677-698`）。
2. **问答卡「放弃整组问题」**：`POST .../interactions/:callId/cancel`（`app.ts:440-444`）→ `runtime.cancelInteraction`（`runtime.ts:1112-1149`，文档置 `cancelled` + 幂等 steer + answered 409）；前端按钮 `QuestionComposer.tsx:244-249`；转录里 steer 渲染为紧凑气泡（`transcript.tsx:225-262`）。
3. **`subagent` 工具行**：`已开始子智能体 · {label} · {子会话 id}` + 回执卡（任务原文 / 子会话 id / 「打开子会话」），不再渲染整段 JSON（`tool-render-model.ts:806-821`、`ToolCard.tsx:63-68,115,135,147-150,200-215`）。
4. **hover 即开/即关**：`SubagentPanel.tsx:108-149`、`TeamPanel.tsx:121-149`（150/120ms、点击 pin、外点/Escape 关、`prefers-reduced-motion` 无延迟）。
5. **团队成员行**：模型 hover 才显示（`TeamPanel.module.css:203-209`）；窄容器下触发器收起文字并仅点击开（`TeamPanel.module.css:43-51`），460px 实测面板不溢出。

门禁：`npm run typecheck` / `npx vitest run`（135/135，+7：render-model 4、interactions 1、runtime 1、http 1）/ `npx vite build` 全绿。ego：demo 实例 4418（`/tmp/pi-98-demo` 数据目录）跑 `[ask]`（等待→放弃→已回答）、`[subagent]`（行→回执→打开子会话→hover）、`[team]`（hover 面板/成员模型/窄容器）；DSH 对照在 3080 实例（显式 DeepSeek-V4.1-Flash）跑同一条问句流程。截图 `pi-98-*` 与 `dsh-98-*` 成对存 `artifacts/ego-compare/shots/`。遗留：子会话面包屑 switcher（数据面已具备，待下一步）。

- 2026-10-19：收尾批次三。**计划预览**：Inspector 新增「计划」视图（最新 `plan-review` 的 markdown，空态「计划预览不可用」），`ToolCard` 计划卡加「打开」并首次自动打开、手动关闭后不自动重开（`pi-99-plan-01..05`）；**子会话面包屑**（父标题 ← 当前、同级切换、当前 tag）；**子会话 metrics**（`tokens`/`durationMs` 投影 + 面板 `{tok} · {时长}` 运行中每秒刷新）；**团队健壮性**：`spawn_teammate` replay-safe + 按名字幂等复用、`reconcileProvisioning` 把无子会话的 `provisioning` 行对账为 `failed`（对齐 DSH `roster.ts:375-417`）；fork 继承语义沿用既有测试（父级未完成轮次不进入 fork 前缀）。门禁：typecheck / **144/144 测试**（+9）/ build 全绿。

- 2026-10-19：开启 Pi 1.3.0 code mode 与 MCP（DF-2）。服务端 `createCodemodeExtension` + `CodemodeSandbox` 常驻注册，`codemodeMode` 三态应用到空闲会话（含 `modelTools` 的 only 过滤与清除）；`McpRegistry` 只读导入 `mcp.json`、注册 `mcp__` 工具并保留连接诊断。前端：代码模式三选、MCP 只读状态页、`codemode` 脚本/输出/子调用卡、MCP 行标题。门禁：typecheck / **166 测试**（+22：mcp 9、runtime 3、render-model 8、http 1 等）/ build 全绿；demo HTTP 验收 codemodeMode 与 `/api/mcp`，真实脚本调用 bash 返回 `codemode-ok`。真实模型复核因 opencode-go key 过期（401 `api_key_expired`）暂缓，脚本 `npm run test:live:codemode` 已就绪。

- 2026-10-19：子智能体转录内一行条（`SubagentRunStrip`，用户选定的「彩色胶囊」形态）。模型 `src/web/subagent-run-model.ts`：同一回合连续的 `subagent` 调用折成一组；**`codemode` 脚本里的嵌套 `tools.subagent` 调用**也提成一组放在脚本卡前（运行中读实时 nested tool 消息，结束后读 `details.calls`；投影会把长 `args` 截断，label/task 用字段前缀还原），脚本卡与 nested 列表不再重复这些行。状态：未匹配子会话且调用未返回 → `creating`（「创建中」/「正在创建子智能体」），失败 > 运行中 > 已完成；tokens/时长来自 `ConversationDetail.subagents`，颜色按父会话子列表顺序分配（缺行时按 id 哈希）。`tool-render-model.ts` 的 `subagentRowModel` 新增 `label`，并识别运行中投影把扩展 details 嵌在 `result` 下的形状。组件：转圈环/✓/×、运行中每秒推进时长（无 settled 时长时回退 live tokens）、`{已结束}/{总数}`、strip 自身容器查询在窄宽度先隐藏完成态 tokens 再隐藏标签、暗色专用配色、`prefers-reduced-motion`。接线：`transcript.tsx` 在 `ProcessGroup` 内分组渲染，新增 `conversationId`/`subagents` 入参与「有子会话运行才轮询」的 1.5s 刷新；`App.tsx` 传 `activeDetail`；点胶囊复用 `onOpenSubagent` → `selectConversation` 打开子会话的「对话」界面（执行过程在转录里可见），父标题面包屑返回父会话。已完成但 label 对不上的胶囊先按 label 前缀、再按最新子会话顺序兜底匹配，避免完成态被禁用。demo 新增 `[subagents]`（同一 assistant 消息三次并行委派，子任务带 child marker）。门禁：typecheck / **183/183 测试**（+16：`tests/subagent-run-model.test.ts`；render-model +2）/ build 全绿。ego 真实浏览器（4317 真实模型会话 827 / 982）：真实 codemode 5 子 agent 的完成态显示 5 个彩色胶囊（essay-1…5，labels 完整，脚本卡不再列 nested 行）、点 essay-1 进入子会话的「对话」、面包屑返回父会话并恢复 strip；2 子 agent 短任务同样成组。CDP demo（4331）覆盖运行态/暗色/窄窗口；截图 `artifacts/subagent-strip-check/pi-100-subagent-strip-01..06`（gitignored）。失败胶囊由单测覆盖。另：4317 进程在真实 5 子 agent 运行后出现过 `/api/conversations` 500（同一数据目录新进程可正常列举），重启进程恢复，待单独复现定位。

## ZCode 参照批次（2026-10-19，用户要求）

本批次不是 DSH 复刻，而是用户指定的 ZCode 参照项（开源仓库 `zai-org/ZCode`，本地浅克隆 `--depth 1`，`--filter=blob:none` + sparse checkout 读的源码）。对照物是 ZCode 源码/文档，不再是 DSH 截图。

| ID | 项 | ZCode 对照（源码行号） | pi-web 落点 | 状态 |
|---|---|---|---|---|
| ZC-1 | 空态标题改为 ZCode 的按时间问候 + 背景 Logo（Logo 形状换成 Pi 的 π） | `packages/ui/src/v4/ConversationDraftEmptyState.tsx`：分段 `:20`、问候选择 `:32-44`、跨边界刷新 `:46-60`、20–30px 自适应 `:73-90`、背景 Logo `:204-240`（400×320、5:4、`min(72vw,25rem)`、上移 40px、70% 渐隐遮罩、`foreground-subtlest`）；文案 `i18n/locales/zh-CN.ts:5207-5212` / `en-US.ts:5573-5578` | `src/web/greeting.ts`（分段/文案/字号纯函数）、`Composer.tsx` hero 问候块（定时换档 + ResizeObserver 测量；背景为 Georgia π 的 1px 描边，沿用 ZCode 的 400×320 尺寸/位置/渐隐遮罩）、`Composer.module.css` | 已修（2026-10-20：`tests/greeting.test.ts` 3 例覆盖全部分段、跨午夜与字号下限；CDP 固定 08:00 截图 `09-greeting-morning.png`，核对 30px 文案、400×320 π 描边 Logo、70% 渐隐与 390px 窄屏收缩） |
| ZC-2 | 侧栏移除头部「新建会话」图标按钮与「新会话」行的快捷键徽标 | 不适用（ZCode 侧栏结构不同；用户直接要求隐藏） | `src/web/App.tsx`（`sidebarHeader` / `newChat`）；`App.module.css` 去掉 `.newChatKeys` | 已修 |
| ZC-3 | 侧栏折叠后文字重影 | 不适用（ZCode 无此折叠态） | 根因是折叠态 `font-size:0` 只压住按钮文本、压不住绝对定位的快捷键徽标；徽标移除后消失，另在折叠态显式隐藏按钮文本 | 已修 |
| ZC-4 | 空态隐藏单模式预设选择器 | 不适用（ZCode 空态无模式选择器） | `src/web/Composer.tsx` hero 上下文行：`presets.length === 0` 时不渲染 | 已修 |
| ZC-5 | Git 分支切换（列表 / 切换 / 新建并切换） | UI：`packages/ui/src/GitBranchSwitcher.tsx`（搜索 + 列表 + 当前分支 `data-branch-current` 置顶 + 底部「新建分支并切换」，`:110`/`:298`/`:312`/`:338`）；hook：`packages/ui/src/hooks/useGitBranchSwitcher.ts`（展开即重读 `:115`、成功后刷新 Git 状态 `:233`/`:350`、HEAD 变化丢弃本地快照 `:97-112`）；服务：`packages/services/src/git/repo/gitCliRepo.ts`（`for-each-ref refs/heads` `:990`、`switch --no-guess` `:1141`、`switch --no-guess -c` `:1227-1228`、`check-ref-format --branch` `:606`、进行中操作标记位 `:616-633`）；错误归一：`packages/services/src/git/repo/gitCliHelpers.ts:64`（issue code 全集见 `packages/shared/src/git.ts:26-35`）；设计文档 `docs/git/branch-switching-service-design.md`（不做 stash/force/remote 浏览） | `src/server/git-branches.ts`（列表/切换/新建 + 结构化 issue）、`GET/POST /api/workspaces/:id/git/*`、`src/web/GitBranchSwitcher.tsx`（hero 上下文行与输入工具条） | 已修（2026-10-19：`tests/git-branches.test.ts` 8 例覆盖列表/切换/no-op/detached/新建/非法名/重复名/目标不存在/tracked 覆盖/冲突索引；demo 实例 4329 + CDP `artifacts/zcode-branch-check/verify.mjs` 17/17 通过，截图 `01-hero`…`08-blocked-switch`：菜单搜索、分支置顶、切换、新建、阻塞原因与受影响文件） |

有意差异（本批次）：

- **不做「提交并重试切换」辅助流程**：ZCode 在切换被未提交改动阻塞时给出「提交当前改动后自动重试」（`packages/ui/src/git-branch-switcher/switchAssist.ts`）。pi-web 目前没有提交流程与 diff 面板，故只按 ZCode 的 issue code 显示阻塞原因与受影响文件，不提供提交入口。
- **不做 Git Graph / remote 分支浏览 / stash / force**：ZCode 的 `GitBranchSwitcher` 底部还有「Git 图谱」，其服务设计文档也显式把 remote 浏览、stash、rebase 列为非目标；pi-web 同样只做本地分支列表、切换、新建并切换。
- **未提交改动按 Git 原生行为**：与 ZCode 一致——不因 dirty 一律禁止切换，只把 `git switch` 的真实结果（含被覆盖文件）归一成 issue。
- **没有 Git 元数据 watcher**：ZCode 由文件 watcher 实时回灌 HEAD，外部 `git switch` 后触发器会立刻变化；pi-web 在每次展开分支菜单时重新读取（`GitBranchSwitcher.load`），因此外部切换要等下一次打开菜单才反映到触发器上。


## 默认执行策略与任务进度

基准仍为 DSH `687f282e8625c6b8d11ff58211a90524be2e4317`。本次增强普通执行会话的任务管理指导，并把核心提示词接入 Pi 默认运行时；没有新增界面模式。

| 项目 | DSH 源码 | pi-web 落点 | 结论 |
| --- | --- | --- | --- |
| 多步任务主动建清单、及时更新、简单任务跳过 | `packages/todo/tool-todo/src/index.ts:45`；`packages/bundle/base/cordis.patch.yml:437` | `src/server/todo-tools.ts:35`；`src/server/work-policy.ts:27` | 已接入描述与动态路由；真实模型行为待认证恢复后验证 |
| 从用户长期请求识别 Goal，无需出现 goal 一词 | `packages/goal/tool-goal/src/index.ts:51`、`:115` | `src/server/goal-tools.ts:275`、`:401` | 目标不存在时也注入指导；按真实可调用工具生成，顶层会话可创建 |
| 阶段文字进度汇报 | 默认 persona 未发现统一汇报节奏，Todo 工具负责状态回执 | `src/server/prompts/runtime-core.md` | 有意增强：简短汇报阶段成果、阻塞和下一步，不承诺固定计时播报 |
| Plan 只研究、提交方案后等待 | `packages/bundle/web-app/presets/standard.patch.yml:54` | `src/server/work-policy.ts:57`；Todo/Goal 执行与续跑 guard | 已保留；不把自主执行策略当作默认开启 Plan 模式 |
| 默认加载及历史会话 | DSH profile 组合 persona/tool sections | `src/server/runtime.ts` 的 `ensureRuntimePolicy`、`conversationCreated`、启动迁移 | 工具为空的核心扩展覆盖 Preset、分叉、子会话和历史选择；工具范围与自定义 instructions 保留 |

有意保留的差异：本次没有迁移 DSH 的整套目标授权、会话恢复 rearm 或连续三轮阻塞状态机；暂停、恢复和编辑仍走本项目的用户控件，具体阻塞可按现有规则报告。只读模式可更新会话目标元数据，文件写权限仍关闭。Plan 模式与缺失目标完成工具都会阻止目标自动续跑。

验证：`npm run check` 通过（类型检查、241 项测试、生产构建）。`tests/runtime-policy.test.ts` 在真实 Pi Durable/SQLite 到模型适配器的边界捕获请求，覆盖默认会话、无工具 Preset、codemode-only、Plan、只读 Goal、缺失目标完成工具、子会话/分叉及旧选择重启迁移。受控模型证明接线和约束，不证明真实模型会遵循每条规则。

两侧真实模型采用 `scripts/workflow-fixture.ts` 的同一任务输入，prompt SHA-256 均为 `b7c64df46ef797ca51924a93d027d16e1402bde39fa191520532efba8fa380a0`：pi-web 明确选择 `opencode-go/deepseek-v4.1-flash`，返回 `401 api_key_expired`；DSH 的临时 headless profile 明确选择其标准 `deepseek-official/deepseek-flash`，返回 `MISSING_CREDENTIAL`。两者均未进入工具行为验收，不能声明真实行为已对齐。没有切换配置来绕过认证失败。记录为 `artifacts/live-workflow-check.json` 和 `artifacts/dsh-workflow-check.json`；本次改动表面为提示词与后端策略，未声称完成额外 UI 对齐。

## 提示词节奏、检索工具与主动询问（2026-10-21）

用户报告真实会话里模型长时间用 shell 探索、很晚才建立计划，并且偏离“帮我整理计划”的指令。对照 DSH `687f282e86` 后确认：这不是工作区索引问题——DSH 的 `file-reference-local` 索引只服务输入框的 `@` 补全，模型本身不接收仓库索引；问题来自提示词节奏、工具面和会话事实的叠加。

| 项目 | DSH 依据 | pi-web 落点 | 结果 |
| --- | --- | --- | --- |
| 路径发现与内容检索 | `tool-fs-search` 的 `glob`/`grep` 及 “use glob, not shell find” / “use grep, not shell grep or rg” section | `src/server/research-tools.ts` 新增 `glob`、`grep`；`src/server/work-policy.ts` 动态工具引导 | `glob` 支持 `**`、隐藏路径、按 mtime 新到旧；`grep` 支持正则与 `include`；两者只读 |
| 工具选择引导 | 每个工具自己的 prompt section | `work-policy` 的 `toolGuidance` | 按本请求实际 direct/codemode 路由生成，不再让模型猜 `list_files`/`search_files` |
| 会话事实 | `time-context`、`working-directory`、平台/工具 section | `work-policy` 的 `sessionFacts` | 注入 cwd、平台、平台 shell、当前日期/时区、模型、可写与 shell 能力 |
| Plan 提示词 | `standard.patch.yml` 的 Explore first / decision-complete / `exit_plan_mode` 唯一最后调用 | `src/server/plan-tools.ts` 的 `plan-policy` 与工具描述 | 计划阶段禁止实施与 todo 跟踪；能查的不问，只问用户选择/重大歧义；计划待审即结束本轮 |
| 计划请求未开 Plan | 默认 persona 不把“停在计划”当成错误 | `runtime-core.md`；`work-policy` 的 plan-off 规则 | 用户要计划时先只读研究并给出计划，不擅自实施；提示可打开 Plan 审阅 |
| Todo 节奏 | `tool-todo` 的 “plan multi-step work / add one per concrete step before you start” | `src/server/todo-tools.ts`；`work-policy` 的 todo 策略 | 去掉 “implementation work in progress” 的限定；计划请求把“调研→计划→等待确认”列为步骤 |
| 主动询问 | `ask_user_question` 的 apply 边界 | `runtime-core.md` 的“澄清与提问”；`src/server/interaction-tools.ts` 描述 | 明确列出必须提问的场景；用户提“之前聊过”但本会话无历史时先问会话/文档，不扫描 `.lith`/`.kimi-code` 等 agent 状态目录 |
| 用户话语解读 | plan-mode 的 imperative/agreement（`standard.patch.yml:55`）；time-context（`request-zone.ts:73`）；ask-user pending（`timed.ts:39`）；bash 删除/移动核对（`tool-bash/index.ts:96`） | `runtime-core.md` 新增“用户话语解读”；`plan-tools.ts`；`interaction-tools.ts`；`shell-tools.ts` | 请求类型（问句/诊断/实施/计划/确认）、指代、相对时间、多意图、粘贴内容、授权范围；Plan 命令式=计划、同意≠批准；pending≠permission；删除/移动先核对绝对目标 |
| shell 调用方式 | bash/pwsh 的 `workdir` 与 “pass workdir instead of using cd” | `src/server/shell-tools.ts` | 保留 Pi `coding-tools` 名称与 read/write/edit；Windows 只注册 `pwsh`，其他平台只注册 `bash`；两者都增加 `workdir`、`description`，越界 workdir 拒绝 |

有意保留的差异与未完成项：

- `glob` 额外排除 `node_modules`、`dist`、`.data`（DSH 的 `--no-ignore` 会包含），避免项目发现被生成目录淹没；隐藏路径仍包含。
- `grep` 使用 JavaScript 正则而不是 ripgrep，默认不区分大小写；没有为此引入 `rg` 依赖。
- Windows 只注册 `pwsh`、其他平台只注册 `bash`，与 DSH 的 Windows 组合一致；不再保留 Windows 上的 bash 兼容层。
- `AGENTS.md` 仍只自动注入工作区根；子目录改为按需读取，不再要求模型递归扫描整个仓库。DSH 的 baseline + 文件触达自动 nested 加载尚未迁移。
- 没有跨会话 `session-reference`；用户引用旧会话时仍需主动询问。
- 相对日期目前按服务器时区解释；DSH 会读取浏览器时区，并在混合/缺失时询问用户。pi-web 尚未接入浏览器时区，跨时区用户可能把“今天/昨天”算错一天。
- DSH 的 `auto-review` 授权审查层未移植；其“按实际效果而不是工具名/语气/声称意图分类、授权必须精确到 action/target/scope”的原则目前只以提示词规则存在，没有独立的审批模型兜底。
- 真实模型行为验收仍待可用凭据；本批以受控请求边界、工具单元测试和行为断言覆盖接线。

验证：`npm run typecheck`、`npx vitest run`（32 个文件，371 项通过、1 项仅在 Windows 执行）、`npx vite build`。新增 `tests/shell-tools.test.ts` 与 `tests/research-tools.test.ts` 的 glob/grep 用例、用户话语解读断言，以及 ask-user pending / shell 删除移动目标核对断言；Windows 的 `pwsh` 执行用例按平台门控。

## 模型目录与推理等级（2026-10-20）

用户报告两件事：配置推理等级不生效；配置模型后输入框的模型列表不自动刷新。对照 DSH `687f282e86` 后确认是两条独立链路。

### 1) 推理等级映射

DSH 的 pi-ai 适配器把 `reasoningEfforts` 当作**完整声明**（`packages/llm/llm-pi-ai/src/catalog.ts:704-772`）：

- 声明了任一非 Off 档位就强制 `reasoning: true`；只声明 Off 或空表会被拒绝。
- 未声明的档位在 `thinkingLevelMap` 里 pin 成 `null`，不再吃 pi-ai 对五个基础档位“缺省即支持”的默认值；`off: null` 是不支持关闭，`off` 缺失是支持关闭且不发参数。

pi-web 原来的保存路径把模型自带的 `reasoning: false` 原样带回，pi-ai 的 `getSupportedThinkingLevels` 直接返回 `['off']`，所以设置里的档位整组失效。修复：

- `src/server/models.ts` 新增 `pinnedThinkingLevelMap` 与 `upgradeStoredModel`。全局配置保存时 pin 全档位并强制 `reasoning: true`；读取旧 `providers.json` 或全局 `models.json` 时也把“有档位但 reasoning=false”升级为 reasoning 模型，兼容已落盘的坏配置。
- `src/web/SettingsDialog.tsx` 的开关改为完整控制：关闭时显式 `reasoning: false` 并移除 map；开启时写 pin 后的 map。未配置的档位不再出现在选择器里。
- `src/server/runtime.ts` 新增 `clampThinkingLevel` 调用点：创建/更新会话时存模型实际支持的档位；投影历史会话时按同一规则 clamp（例如目录收窄后 Medium 显示为 High），避免菜单没有选中项、标签与请求不一致。`src/web/App.tsx` 对新会话与切换模型做同样的客户端 clamp。
- `RuntimeModels.supportedThinkingLevels` 由 pi-ai 的 `getSupportedThinkingLevels` 派生；demo runtime 返回全档位。

### 2) 模型列表自动刷新

DSH 客户端在 `settings/document-updated`、`credentials/*-updated`、`llm/adapters-updated` 时调用 `catalog.refresh()`（`packages/client/ui-model-selection/src/client/service.ts:54-57`、`packages/client/ui-settings-models/src/client/index.ts:122-128`）。pi-web 原来只在挂载时和 `saveProvider` 之后各读一次 `/api/models`，运行中的服务不会重读磁盘上的全局 `models.json`。

修复：

- `src/server/models.ts` 用目录 watcher 监听全局 `models.json` / `auth.json` / `settings.json`；防抖后全量重读，并在**同一个 `MutableModels` 对象**上 `clearProviders()` + 重建 builtin/custom provider，保证 harness、压缩任务和运行中的请求看到的目录一起更新。`saveProvider` / `deleteProvider` 走同一条重载路径。
- `GET /api/models/events`（SSE）把重载通知推给所有打开的页面；`src/web/api.ts` 的 `watchModels` + `App.tsx` 订阅后重新拉取 catalog。外部编辑、另一个实例写入、本窗口保存三条路径都会触发。
- 每次 `catalog()` 读也会串行执行一次 freshness check，watcher 失效时仍能在下一次读取拿到新目录；非法/写到一半的文件保留上一份好目录。

### 3) 验收

- 门禁：`npm run typecheck` + `npx vitest run`（22 文件 270/270）+ `npx vite build`。
- 确定性 mock provider（记录 `reasoning_effort`）：模型只配置 `low/medium/high` 时，菜单只出现 Off/Low/Medium/High；High 的 wire value 配成 `ultra` 时请求体为 `reasoning_effort:"ultra"`；选择 Off 时请求体不含该字段。证据 `artifacts/ego-thinking-model/requests.high.jsonl`、`requests.off.jsonl` 与 `4317-models.png`、`4317-reasoning.png`。
- 自动刷新：页面停在已展开的模型菜单，外部重写全局 `models.json` 增加 `Probe C (external)`，菜单在无刷新、无重新打开的情况下出现该模型。
- 真实 `opencode-go/deepseek-v4.1-flash`：provider `test` 返回 `connected`；4317 实例的 DeepSeek 档位为 Off/Low/High/Max；新建会话从默认 Medium clamp 为 High；真实对话（conversation 1032）落盘 `thinkingLevel: high`，返回 `OK`，用量 9.7K tok。该 provider 未回传可见 reasoning block，因此“High 生效”的 wire 证据以 mock 请求体为准，真实侧只证明请求完成与档位落盘。
- 4317 上另有一条测试残留：`app-state.json` 的 `modelAllowlist` 只放行 `opencode-go/deepseek-v4.1-flash`，导致全局 models.json 里的 29 个模型在输入框只显示 1 个。已备份到 `/tmp/pi-web-4317-app-state-backup.json` 并清空白名单；白名单 UI 已于同日隐藏，加载 app-state 时会清空历史列表。

## 全局配置目录（2026-10-20）

用户要求配置修改直接落到全局文件，不再使用 Pi 的 `~/.pi`，也不再使用项目内 `.data`。现在默认全局目录为 `~/.pi-web`（`PI_WEB_HOME` 可覆盖），模型与应用数据集中在该目录：

| 文件 | 读写方 | 用途 |
| --- | --- | --- |
| `settings.json` | 启动时读取 | 默认 Provider/模型、思考等级 |
| `models.json` | 设置页直接读写 | Provider 与模型目录（Pi 格式 `providers`） |
| `auth.json` | 设置页直接读写 | Provider 凭据；删除自定义 Provider 时一并删除 |
| `mcp.json` | 启动时只读导入 | MCP 服务器配置 |
| `app-state.json` | 应用读写 | 界面偏好、工作区、Preset、自动化任务 |
| `pi-durable.sqlite` | Pi Durable 读写 | 会话、消息、工具执行记录 |

实现要点：

- `src/server/home.ts`：`piWebHome()` 默认 `~/.pi-web`，`PI_WEB_HOME` 可覆盖；`migrateGlobalHome()` 一次性把 `~/.pi/agent/{settings,models,auth,mcp}.json`、旧项目 `.data/{providers,app-state}.json`、SQLite 和 WAL 导入全局目录。旧 `.data/providers.json` 的 providers 与 credentials 会合并进全局 `models.json`/`auth.json`；已有全局 `models.json`/`auth.json` 时不会覆盖。写入 `.migrated` 标记保证幂等。
- `src/server/models.ts`：删除 `providers.json` 路径；`saveProvider` 读改写全局 `models.json` 的 `providers[id]`，有 API key 时同步写 `auth.json`；`deleteProvider` 删除 `models.json` 条目，自定义 Provider 同时删除 `auth.json` 凭据，内置 Provider 删除覆盖后恢复 shipped catalog。watcher 监听 `models.json`/`auth.json`/`settings.json`。
- `src/server/index.ts`：`PI_WEB_DATA_DIR` 未设置时 `dataDir = PI_WEB_HOME`，并执行一次迁移；设置后跳过迁移，`piDir` 默认跟随 dataDir。`src/server/runtime.ts` 的 MCP 路径改为 `dataDir/mcp.json`。
- 工作区技能来源从 `.pi/skills` 改为 `.pi-web/skills`；`src/web/SkillsPanel.tsx`、`tests/skills.test.ts`、README/architecture/windows 文档同步。
- README 新增全局目录表与 `PI_WEB_HOME`、迁移说明；demo 命令改用 `%TEMP%`/`${TMPDIR:-/tmp}`，不再写入项目 `.data`。

验证：

- 4317 首次启动迁移 7 个复制文件到 `~/.pi-web`，并把旧 `providers.json` 的目录/凭据合并进全局 `models.json`/`auth.json`：`models.json` 含 opencode-go 29 个模型、`auth.json` 含凭据、`app-state.json` 保留 2 个工作区、`pi-durable.sqlite` 保留 21 个会话；provider 测试 `connected`；模型菜单显示 29 个模型。
- 临时全局目录写入验证：`POST /api/providers` 直接生成 `models.json` + `auth.json`，不存在 `providers.json`；`DELETE /api/providers` 同时清空 providers 与自定义凭据。文件模式 0600、目录 0700。
- 门禁：`npm run typecheck` + `npx vitest run`（23 文件 273/273）+ `npx vite build`。

## 工作区浏览与菜单锚点（2026-10-20）

- **浏览文件不再离开正文**：工作区菜单的「浏览文件」改为打开右侧 Inspector（`src/web/Inspector.tsx` 的新 `browse` 视图），中间会话/自动化页面保持不变。浏览器以 compact 模式复用 `WorkspaceBrowserPage`；点文件后文件在 Inspector 的「文件」视图打开，「浏览」标签可回到原文件夹，文件夹路径与滚动位置保留（组件保持挂载）。
- **菜单不再漂移**：工作区行的 `getAnchorRect` 改为返回整行矩形（`data-workspace-row` + ref fallback），并 `align="end"`。之前锚点是悬停才出现的省略号按钮；鼠标移开后按钮 `display:none` 变成 0×0，portal 菜单会跳到视口左上角。现在即使按钮隐藏，菜单仍贴着行右缘，并随滚动/缩放持续跟踪。
- **目录切换滚动复位**：`WorkspaceBrowserPage` 在 `path` 变化时把文件列表滚回顶部，避免进入子目录后沿用上一目录的滚动偏移。
- 验收：ego 4317 实测菜单打开后 80ms 内已贴住行（x=123/y=244），鼠标移开位置不变；「浏览文件」后中间会话仍在，右侧出现文件浏览器；进入 `docs`、打开 `docs/agent-lifecycle.md`、点「浏览」返回后仍停留在 `docs`。截图 `artifacts/workspace-browse/after-fix.png`、`after-fix-docs.png`。
- 门禁：`npm run typecheck` + `npx vitest run`（23 文件 273/273）+ `npx vite build`。

## 推理档位删除持久化（2026-10-20）

问题：在模型设置里删除一个推理档位后保存，重新打开仍会出现该档位，看起来删不掉。

根因：服务端按 DSH 语义把未声明档位 pin 成 `null`（这是正确的，用于让选择器不提供该档位），但设置页的 `draftFromModel` 把 map 里的**所有 key**（包括 null）都渲染成可编辑行。删除一行保存后，服务端把它重新 pin 成 null，下一次读取又变成一行空值档位，形成“删了又回来”。

修复：

- 新增 `src/web/reasoning-levels.ts`：
  - `draftReasoningLevels()` 只渲染有字符串 wire value 的档位；`off` 仅在该 map 没有显式 `off: null`（即仍可关闭思考）时补一行。
  - `pinReasoningLevels()` 负责保存时的 pin/Off 省略，设置页改用该函数。
- `SettingsDialog` 的档位下拉改用 `catalog.thinkingLevels`（API 接受的完整 7 档），不再使用模型当前目录；这样删掉的档位之后可以重新添加。
- `tests/reasoning-levels.test.ts` 覆盖：null 档位不渲染、`off: null` 不显示 Off、删除 High 后 round-trip 仍不存在、自定义 wire value 保留。

验收（4317，临时 provider `level-proof`）：

- 初始编辑器只显示 Off/Low/Medium/High（map 里 minimal/xhigh/max 的 null 不再成为行）。
- 删除 Medium 并保存后：`thinkingLevelMap.medium === null`，catalog `thinkingLevels` 变为 `['off','low','high']`；重新展开编辑器仍是 Off/Low/High。
- 点“添加档位”能重新加入 XHigh，证明下拉使用完整档位表。
- 真实 opencode-go DeepSeek 编辑器显示 Off/Low/High/Max，不再出现 minimal/medium/xhigh 的空行。
- 证据 `artifacts/reasoning-delete/after-delete.png`、`opencode-levels.png`。

## 新会话默认模型（2026-10-20）

问题：打开新会话时输入框固定显示 `deepseek-flash`（一个内置但未配置凭据的模型），而不是当前配置里可用的模型；用户反馈“这个并不存在”。

DSH 对照：

- Host 的 `session/modelCatalog`（`packages/api/session-controller/src/catalog.ts`）返回 provider groups 和 deployment `default`；客户端把当前选择标记为 `routable`（`packages/client/ui-model-selection/src/client/directory.ts:180-186`）。
- 选择器只有在 `choices` 里能找到当前 provider/model 时才显示模型名，否则显示 `trigger.fallback`（“选择模型”），不会把原始 model id 当成模型名（`ModelSelect.tsx:420-427`）。

pi-web 修复：

- `runtime.catalog()`：把 `settings.defaultModel` 与 Pi 全局默认一起校验。优先选择目录中存在且 `available` 的候选，其次第一个可用模型，再退到存在但暂不可用的默认；只有“有效默认已不在目录/已不被白名单允许”时才把修正写回 app-state，凭据暂时缺失的有效默认不会被覆盖。
- `buildAgentChange()`：默认模型在目录中不存在（或没有默认）时回退到 `firstAvailableAllowedModel()`（优先已配置凭据的 provider），显式选择的模型或 Preset 模型仍然报 `MODEL_UNAVAILABLE`。
- 前端 `selectedModel`：新会话只接受目录中 `available` 的请求默认；失效时使用 catalog 已验证的 `defaultModel`，再退到第一个可用模型。已有会话保留自身选择，不会被静默改标签。
- 新增 `tests/models.test.ts` 用例：失效默认被替换为目录内模型并用于新建会话；显式请求不存在的模型仍被拒绝。

验收（4317）：

- 临时把 `~/.pi-web/settings.json` 的默认改为 `deepseek/deepseek-flash`（内置目录存在但 `available:false`）。
- `/api/models` 返回 `defaultModel = opencode-go/deepseek-v4.1-flash`，且该模型 `available:true`。
- 打开“新会话”，输入框显示 `DeepSeek V4.1 Flash`；模型菜单的选中项位于 `OpenCode Go` 分组，不再是原始 `deepseek-flash`。
- 恢复原 `settings.json` 后默认回到 `opencode-go/deepseek-v4.1-flash`，app-state 未残留测试默认。
- 证据 `artifacts/default-model/new-conversation.png`。

## Favicon（2026-10-20）

浏览器标签页此前没有图标，只显示默认文档图标。新增：

- `public/favicon.svg`：深灰圆角方块 + 白色 Georgia 衬线 `π`，与侧栏品牌标记一致；同时生成 `favicon-32x32.png`、`favicon.ico` 和 `apple-touch-icon.png`。
- `index.html` 声明 ICO / SVG / 32px PNG / Apple touch icon。
- 生产模式在 SPA fallback 之前显式服务这些根级文件（`src/server/app.ts`）；开发模式由 Vite 的 `public/` 提供。
- 验证：开发 `GET /favicon.svg` 返回 `200 image/svg+xml`；生产构建 `dist/web` 含四个图标文件，`/favicon.svg`、`/favicon-32x32.png`、`/apple-touch-icon.png`、`/favicon.ico` 均返回 200 且 Content-Type 正确；`tests/http.test.ts` 覆盖静态根图标路由。
- 门禁：`npm run typecheck`、`npx vitest run`（24 文件 281/281）、`npx vite build`。

## 当前工作区折叠（2026-10-20）

问题：选中的当前工作区所在的会话组无法折叠。`isExpanded` 原来包含 `currentWorkspaceId === workspace.id`，因此点击折叠只改了 `expandedWorkspaces` 集合，当前工作区仍被强制展开。

修复：

- 移除 `isExpanded` 里的当前工作区短路条件，展开状态只由 `expandedWorkspaces`（搜索时例外）决定。
- 用 `useLayoutEffect` 在 `currentWorkspaceId` 变化时把它加入展开集合：切换到某个工作区时自动展开一次，之后用户可以随时点 chevron 折叠，包括它仍是当前工作区时。
- 工作区行仍保持 `data-selected` 高亮，折叠后只隐藏会话列表，不影响行菜单和“设为当前工作区”。

验收（4317，ego）：

- 当前工作区 `deepseek-harness`：初始 `aria-expanded=true`，会话行可见。
- 点击折叠后 `aria-expanded=false`，会话行消失，行仍为选中态。
- 再次点击恢复 `aria-expanded=true`，会话行重新出现。
- 截图 `artifacts/workspace-collapse/collapsed-selected.png`。
- 门禁：`npm run typecheck`、`npx vitest run`（24 文件 281/281）、`npx vite build`。

## 模型白名单隐藏与选择记忆（2026-10-20）

- **隐藏模型白名单**：设置 → 模型不再显示“模型白名单”输入框；`AppStateStore.open` 在加载时清空任何非空 `modelAllowlist`，避免一个看不见的过滤器继续隐藏模型。字段、HTTP schema 与 `modelWithinAllowlist` 保留，供旧数据和回归测试使用。
- **记住上次模型与推理等级**：`chooseModel` / `chooseThinking` 在选中后把 `defaultModel` 与 `defaultThinkingLevel` 写回 app-state；新会话以及新开浏览器窗口都会用这套值。已有会话仍保留自己的模型/等级，不受影响。
- 选择失败（例如模型已从目录删除）只在记住默认值时提示，不会回滚已经成功的会话切换。

验收（4317）：

- 用 API 临时设置白名单为 `opencode-go/deepseek-v4.1-flash`，目录只剩 1 个模型；重启后 `modelAllowlist` 变为 `[]`，目录恢复 29 个可用模型。
- 在已有会话选择 `Claude Haiku 5.5`（XHigh），点击“新会话”后输入框和模型菜单仍显示 `Claude Haiku 5.5` / XHigh。
- 恢复默认到 `opencode-go/deepseek-v4.1-flash` / High 后，新会话显示 DeepSeek V4.1 Flash / High。
- 设置 → 模型页面不再包含“模型白名单”。截图 `artifacts/last-selection/new-conversation-claude.png`、`settings-no-allowlist.png`。
- 新增 `tests/models.test.ts`：重新打开 app-state 会清空旧白名单并恢复被隐藏的模型。
- 门禁：`npm run typecheck`、`npx vitest run`（24 文件 282/282）、`npx vite build`。

## 侧栏浏览、拖拽与文件预览（2026-10-20）

DSH 的右侧栏由 `ui-sidebar-documentpreview` 按扩展名注册渲染器（Markdown、代码、HTML、图片、PDF、Office、Excel），代码用带行号和语法高亮的只读块，Markdown 用文档渲染器。pi-web 复用现有 primitives 做出对应子集：

- **打开侧栏即文件目录**：顶栏/空态的“打开侧栏”不再打开空的“文件检查器”，而是打开当前工作区的文件浏览器；在浏览器里点文件后进入“文件”标签，“浏览”标签保留原目录和滚动位置。
- **可拖拽分隔线**：`.inspectorResizer` 是独立 5px 列；拖动改变 `--inspector-width`（默认 360，最小 280，最大 `min(760, 70vw)`）。支持左右方向键每次 16px、双击恢复 360，窗口缩小时自动 clamp；移动端仍是全屏 Inspector，隐藏分隔线。
- **Markdown 预览**：`.md/.markdown/.mdx` 默认渲染 `MarkdownText`（标题、列表、表格、代码围栏、KaTeX），提供“预览/源码”切换；相对图片路径按 Markdown 文件目录解析成 `/api/workspaces/:id/asset`，绝对 URL/Data URI 交给渲染器。
- **代码/文本完整预览**：非 Markdown 文本使用 `ReadBlock`，`maxLines = 全文行数`，不再出现“展开另 N 行”的中间折叠；语言由扩展名推断（`.java` → `java`），保留行号、语法高亮、复制和换行控制。
- 服务端文件读取仍受原有 8 MiB 上限和工作区路径校验约束。

验收（4317，ego）：

- 点击“打开侧栏”后 Inspector 标题为当前工作区 `deepseek-harness`，显示目录内容。
- 拖动分隔线：宽度 360 → 482.5；`aria-valuenow` 同步。
- `README.md`：默认“预览”标签，标题正常渲染；切“源码”后显示 78 行、无“展开另”折叠。
- `PreviewTest.java`：8 行完整显示、39 个高亮 span、无折叠。
- 截图 `artifacts/inspector-preview/01-browser-resized.png`、`02-markdown-preview.png`、`03-markdown-source.png`、`04-java-preview.png`。
- 门禁：`npm run typecheck`、`npx vitest run`（24 文件 282/282）、`npx vite build`。

## 模型设置界面（2026-10-20）

对照 DSH `packages/client/ui-settings-models`：`ModelsSection.tsx` 的「已配置行 + 单张添加卡片」、`ProviderEditor.tsx` 的「API 密钥优先 / 自定义设置折叠」、`CustomProviderCard.tsx` 的创建表单。pi-web 把模型页拆到 `src/web/ModelSettings.tsx` + `ModelSettings.module.css`：

- **提供商行**：每个已配置/已知提供商一张行卡片，标题、手写路由的「自定义」标签、凭据圆点、`编辑`/`删除`。同一时间只展开一张编辑器；打开添加卡片会先收起行编辑器。删除确认文案区分手写路由（同时删 auth.json 凭据）与内置覆盖（保留密钥、恢复内置目录）。
- **添加卡片**：底部虚线「添加模型提供商」打开一张卡片，顶部 `SegmentedControl` 分「第三方模型提供商 / 自定义模型 API」。目录模式含提供商下拉 + 同一个 `ProviderEditor`；自定义模式含 Provider ID、显示名称、API 地址、协议、API 密钥、空模型目录。两个面板首次显示后保持挂载，切换方式不丢草稿。
- **API 密钥提示**：`ProviderSummary` 新增 `envVars` / `envConfigured` / `storedCredential`（只暴露变量名，不暴露值）。服务端用「记录式 AuthContext」调用提供商的 `auth.apiKey.resolve()`：所有 `env()` 查询都返回 `undefined`，记录候选变量名，因此不需要复制 pi-ai 的 provider→env 映射。未配置且没有环境变量时显示橙色「未检测到环境变量。请填写 API 密钥，或设置环境变量 X。」；已检测到环境变量显示绿色；有存储凭据时占位文字为「留空使用已保存凭据」。`?` tooltip 列出全部环境后备顺序。
- **自定义设置**：`<details>` 折叠区，内置提供商只显示 API 地址与模型目录；手写路由额外显示显示名称与接口协议。模型目录的标题/状态与「恢复默认模型 / 获取可用模型」分列两端，与 DSH 的 `modelCatalogHeading` 一致。
- **保存与语义**：保存成功后关闭卡片并显示「已保存 X。」；`custom` 字段改为「是否手写路由」（不再把任何 models.json 覆盖都叫自定义），因此 DeepSeek 这类目录提供商配置后不带「自定义」标签。
- 保留 pi-web 原有的「测试连接」，放在页脚左侧；DSH 没有该按钮，但它不影响右侧 `取消/保存` 的布局。

验收：

- 4317（真实全局目录）：模型页显示 OpenCode Go 行（绿点、编辑/删除）；添加卡片默认选中 Amazon Bedrock，显示 `留空使用环境认证（AWS_BEARER_TOKEN_BEDROCK）` 与橙色环境变量提示；提供商下拉宽度 240px、密钥输入占满卡片。
- 临时真实实例（`/tmp` 数据目录，4320）：自定义路由填 `demo-gateway` 保存后卡片收起、出现「已保存 Demo Gateway。」与新行（带「自定义」）；目录模式添加 DeepSeek 后出现不带标签的 DeepSeek 行；编辑行显示「留空使用已保存凭据」；删除确认后 models.json 与 auth.json 同步移除。
- 截图 `artifacts/model-settings-parity/01-add-catalog.png` … `06-delete-modal.png`。
- 门禁：`npm run typecheck`、`npx vitest run`（24 文件 283/283）、`npx vite build`。

## 工作步骤组体不压缩行（2026-10-21）

- 现象：标准模式下展开工作步骤组，行数多到超过组体高度上限时，「思考」行与相邻行内容互相重叠错乱；工具行不受影响。
- 根因：DSH 组体（`ChatGroupSeat.module.css` 的 `.content`）在 `max-height: min(400px, 50vh)` + `overflow-y: auto` 的 flex 列上显式设置 `.content > * { flex-shrink: 0 }`，pi-web 的 `.processBody`（`src/web/Transcript.module.css`）漏抄了这条。思考行沿用 DSH ReasoningRow 的 `contain: size layout`，最小内容高度为 0；行总高超过上限时 flex 压缩全部落在思考行上（实测可压到 0px），24px 行头按 `overflow: visible` 照常绘制，盖住下一行。
- 修复：`.processBody > * { flex-shrink: 0 }`，行保持自然高度、组体滚动，与 DSH 一致。
- 验收（4321 临时真实实例，DeepSeek 会话，标准模式展开组）：注入 `max-height: 100px` 模拟超长组，修复前思考行布局高度 30→0、绘制仍 30px；修复后所有行保持自然高度、组体正常滚动；常态渲染不变。门禁：`npm run check`。

## 工作步骤展开与压缩标记的三个修复（2026-10-21）

### 1. 改动文件预览可收起 + 绝对路径可打开

- 现象一：回合结束后的「已改动文件」内联预览（DiffBlock / CodeBlock / ReadBlock）在 `codingViews` 打开时永远展开，且没有任何收起入口。
- 现象二：工具产出的绝对路径（Windows 盘符路径如 `D:\2026\dolynk\docs\a.md`、POSIX 绝对路径）点开时报「工作区路径无效」。
- 修复：`src/web/transcript.tsx` 的 `ChangedFiles` 拆出 `ChangedFileCard`，每个文件一个箭头切换按钮（`aria-expanded` + `aria-controls`），收起后不挂载内联预览，但「写入/修改 + 路径 + 查看差异」始终保留可点。
- 修复：`src/server/workspace-files.ts` 新增 `resolveWorkspacePath(root, requested)`，把绝对路径（落在工作区内时）与反斜杠相对路径归一化成工作区相对路径，再走原有的 `isWithin` + 逐段 symlink + `realpath` 三重校验；工作区外路径与 POSIX 上的盘符路径仍按原语义拒绝。`list` / `read` / `asset` 三个入口统一走它。
- 验收（4321 临时真实实例 + 4323 demo 实例，ego）：文件卡片 `aria-expanded` true → false、预览高度 138px → 0，路径与「查看差异」仍可点；`GET /api/workspaces/:id/file?path=<工作区内绝对路径>` 返回 200 且 `path` 归一化为相对路径，越界路径仍返回 400「工作区路径无效」。截图 `artifacts/ego-verify/01-transcript.png`。

### 2. 压缩完成后任务不再中断

- 现象：上下文压缩完成后，正在进行的任务停下，不再继续。
- 根因：pi-web 自带的压缩触发（`maybeCompact`）与 Pi Durable 内建触发（`thresholdCompaction`，阈值 `contextWindow - reserveTokens`）**落在同一个阈值**：pi-web 发起的是会话级压缩，摘要因会话忙而经 inbox 排队、在更晚的边界才落地，落地时会把 head 往前推回去，抵消平台那次「生成归属」的阻塞式压缩；两份摘要都留在上下文里，上下文不降反升，下一次请求超出窗口，生成以 model_error 结束，任务就停了。
- 复现（`artifacts/compaction-repro/repro.ts`，脚本化 OpenAI 兼容服务端 + 真实 runtime）：一次压缩触发 **两次**摘要请求（pi-web 一次、平台一次）。
- 修复：`src/server/compaction.ts` 新增 `compactionThreshold()` 与 `ownsCompactionThreshold()`；pi-web 只在「运营成本上限把阈值压到平台阈值以下、且上下文尚未越过平台阈值」的区间里自己发起压缩，其余一律交给平台自己的生成级压缩（生成等待摘要落地后继续，不中断任务）。pi-web 自定义的 6 节检查点摘要与文件跟踪仍由 `beforeCompact` 钩子提供。
- 验收：同一脚本修复后一次压缩只有 **一次**摘要请求、任务继续完成；`tests/compaction-flow.test.ts` 覆盖阈值归属与「压缩后任务继续」，临时关掉守卫即失败（2 ≠ 1）。

### 3. 压缩完成标记回到正文流

- 现象：「已完成上下文压缩」永远贴在转录最底部，不随正文渲染浮动。
- 根因：所有 system 消息被 `buildRenderModel` 收进 `model.systemMessages`，统一渲染在所有回合之后。
- 修复：`src/web/render-model.ts` 改为按消息流顺序编排时间线（`timeline`），带 `runId` 的系统行进入对应回合内部（按是否在该回合回答之前区分 `beforeAnswer`），无 `runId` 的按其在消息流中的位置插在回合之间；「正在进行上下文压缩」运行态提示落在最后一个回合的末尾。锚定用消息流位置而非时间戳：压缩条目替换的是它上面的历史，标记就该留在被替换内容的位置。
- 验收（4323 demo 实例，ego）：压缩标记在转录子节点中的序号由「最后一个」变为「第一个」（`markerIndex` 2 → 0），即回到它所替换内容的位置；`tests/render-model.test.ts` 覆盖「替换历史的标记留在其内容之上」。

## 末尾运行指示器与块级流式状态（2026-10-21）

### 1. 消息流末尾缺少「正在运行」指示器

- 现象：任务运行时转录末尾没有任何提示，用户无法直观看出任务是否已经停下（对比 ZCode：消息流末尾有一个孤立的旋转图标）。
- 上游依据：
  - ZCode `packages/ui/src/components/ai-elements/chat-loading.tsx`：lucide `LoaderIcon` + 外层 `animate-spin` 容器（源码注释说明旋转 HTML 容器而非 SVG 本体，是为了让动画走合成层）；`role="status"` + 本地化 `aria-label`；**只有图标、没有文案**。
  - ZCode `packages/ui/src/v4/chatLoadingVisibility.ts` 的 `shouldShowTurnChatLoading`：只在「最后一轮 + 运行中」显示；等待用户回答/授权（permission、AskUserQuestion）时隐藏，因为弹窗/问答卡已经是唯一的进度反馈；上下文压缩、目标校验在跑时隐藏；行级 fallback 用于避免恢复/乱序窗口里 loading 闪回。**刻意不做防抖**——源码注释写明「running 是 ChatLoading 的权威事实；额外静默计时会让 projection 更新反复重启可见性，并使 UI 晚于真实状态」。
  - DSH `packages/client/ui-chat/src/client/chat/ChatFlow.tsx:60`：运行状态挂在**整个消息流的最末尾**（`[...rows, ...pendingRows, ...running ? [<RunningStatus/>] : []]`），DSH 用的是鲸尾动画 + 「深入中 N 秒」文字，pi-web 没有该图片资源，故取 ZCode 的图标形态。
- 修复：`src/web/transcript.tsx` 新增 `TurnRunningIndicator`，挂在转录末尾（`pending` 之后）；图标用 `@deepseek-ai/dsh-client-ui-primitives` 的 `IconLoadingOutlineRegular`（16px，strokeWidth=1），旋转加在 HTML 包装层（`.runningIndicatorIcon`，`1s linear infinite`，配 `prefers-reduced-motion` 降级）；判定函数 `turnChatLoadingVisible` 与 `interactionBlocksTurnLoading` 对齐 ZCode 的规则。
- **运行事实取会话 `busy` 而非最后一轮的 `status`**：轮的 status 由该轮已记录的消息推导，两个工具轮次之间会掉到 `completed`，指示器会在任务未停时闪一下。改用 `conversation.busy`（= `live.run !== undefined`）后，ZCode 那句「running 是权威事实」才真正成立。
- 验收（ego，demo 4320 与真实 4317）：运行中指示器是转录最后一个子节点，`role="status"`、`aria-live="polite"`、`aria-label="加载中"`、16px、`1s linear infinite`；运行结束后消失；**运行期间「忙但无指示器」的帧数为 0**（改用 `busy` 前为多次闪烁）；有待回答的 question 交互时隐藏。

### 2. 思考还在 loading，正文已经提前出现

- 现象：思考块还在流式输出时，下一步的正文已经渲染出来，两块之间没有顺序约束。
- 根因（三处叠加）：
  - **块级流式状态被整条消息的 `streaming` 代替**：`ReasoningPart` 用 `part.message.streaming === true` 判断「思考是否还在流」，而同一条消息的 `streaming` 在整个生成期间恒为 true。于是正文一开始出现，思考行仍在 shimmer。DSH 的判定是**按块**：`AssistantMarkdown.tsx:103` 的 `running={streaming && i === last}`——只有数组里最后一个块才是流式尾巴。
  - **正文块在「回答区」与「过程区」之间搬家**：`finalResponseOf()` 要求消息「没有 toolCall 块」，而流式消息的 blocks 是逐步追加的（thinking → text → toolCall）。于是快照 B（thinking+text）时正文进回答区，快照 C（thinking+text+toolCall）时又被拽回过程区——过程区与回答区是两个独立 DOM 子树，正文块在两者间跳变即用户看到的错位。
  - **React key 建立在过滤后的下标上**：投影层丢弃空块，渲染层又用过滤后数组的下标做 key，前面任一块从「空」变「非空」，后面所有块的下标 +1 → key 改变 → 节点重挂载、流式 Markdown 重新解析。
- 修复：
  - `src/shared/types.ts`：`ContentBlock` 各变体增加可选 `slot?: number`，表示块在模型 content 数组里的位置（Pi 只追加，该位置即稳定身份）。
  - `src/server/projection.ts` 的 `assistantBlocks()` 改为 1:1 `map` 并盖 `slot`，不再丢弃空块；空块过滤下移到渲染层。
  - `src/web/render-model.ts`：key 改用 `block.slot ?? blockIndex`；`ProcessPart` 的 reasoning/content 变体增加 `streaming` 字段，判定为「该消息仍在流式 **且** 该块是该消息最后一个有内容的块」（对齐 DSH 的 `i === last`）；流式中的 assistant 消息（`isLiveAnswer`）固定占有回答区，正文不再随 toolCall 到来而搬家。
  - `src/web/transcript.tsx`：`ReasoningPart` / `ProcessPartView` 改用 `part.streaming`；回答区块的 key 同样改用 `slot`。
- 验收（ego，真实模型 `opencode-go/minimax-m3` 推理等级 High，conversation 1079）：思考行 `data-running` 在正文出现前为 1（t+3092，正文长度 0），正文一出现立刻变 0（t+3189，正文长度 38）——「正文可见但思考仍在流式」的帧数为 **0**，「正文误入过程区」的帧数为 **0**。`tests/render-model.test.ts` 新增 6 例覆盖正文不搬家、块级流式状态与 slot 稳定性，`tests/projection.test.ts` 新增 2 例覆盖空块保留与 slot 盖章。
- 未处理（超出本批次）：落盘后 `live-assistant:${taskId}` → `entry:${entryId}:${index}` 的 id 变化仍会让整棵子树重挂载；本批次的「正文一次性回到过程区」与该重挂载发生在同一时刻，故不额外处理。

### 3. assistant 消息在流式与落盘之间换了身份（2026-10-21）

- 现象：一条 assistant 消息在流式期间是 `live-assistant:${taskId}`，落盘后变成 `entry:${entryId}:${index}`。前端用 `message.id` 做 React key，于是这条消息在生成结束的那一刻整棵子树被卸载重建——流式 Markdown 重新解析、已渲染内容闪一下，`data-message-id` 与 DOM 锚点（`chat-message-*`）也跟着换掉，轨迹视图的跳转定位随之失效。
- 上游依据：Pi Durable 在每条 entry 上盖了 `byTaskId`（`EntryRecord.byTaskId`，`@earendil-works/pi-durable` 的 `session/transaction.js` 在 `appendEntry` 时写入当前 transaction scope 的 task id），而 `LiveState.run.taskId` 正是当前 generation task 的 id（`harness/generation.js` 的 `startRun` → `createGeneration`）。写入 assistant entry 的正是这个 task，因此**两阶段的 task id 是同一个数**。
- 修复：`src/server/projection.ts` 新增 `assistantMessageId(byTaskId, timestamp)`，assistant 消息的身份改为 `assistant:${byTaskId}:${timestamp}`——流式取 `live.run.taskId` + `partial.timestamp`，落盘取 `entry.byTaskId` + `message.timestamp`（同一个 message 对象被 provider 持续 mutate，两者时间戳相同）。时间戳同时区分了重试时同一 task 写下的两条 entry，task id 则区分了两条在同一毫秒内开始的请求。
- 边界：调度器 fault/orphan 兜底路径写入的 entry 没有 task scope（Pi Durable 的 `live.d.ts` 里明写「The scheduler's commit has no task scope, so that entry has no `byTaskId`」），这类 entry 退回 `entry:${entryId}:${index}`，仍会重挂载——属于上游固有限制。
- 验收（真实模型 `opencode-go/minimax-m3`，ego，页面内给 assistant 节点打标记后看标记是否还在）：
  - 改前：流式节点 `live-assistant:1178` 与落盘节点 `entry:1182:0` 是**两个不同的 DOM 节点**（tag0/tag1）→ 子树重挂载。
  - 改后：只有**一个** DOM 节点，流式与落盘的 `data-message-id` 同为 `assistant:1192:1792570187567`，标记仍在 → 子树未重挂载。
  - `tests/projection.test.ts` 新增 3 例覆盖「流式与落盘同名」「重试的两条 entry 靠时间戳区分」「无 task 的 entry 退回 entry id」。

## 结论文档排版的结构化输出与 JSON 载荷（2026-10-21）

对照 ZCode `packages/ui/src/settings/model-provider-section/ProviderModelMetadataDialog.tsx` 的「模型能力 → 结构化输出」开关与 DSH 的 doc 块渲染：

- **能力开关**：ZCode 把「结构化输出」放在模型编辑弹窗的「模型能力」分组里（与「原生联网搜索」「对话中系统消息」并列）。pi-web 只移植第一项——Pi 的 provider 模型描述里没有「联网搜索」和「系统消息」字段，另两项没有对应物。开关存成 `ProviderModelInput.structuredOutput`（写进 `models.json` 的模型条目），目录 `/api/models` 与供应商详情都透出，模型目录行显示 `结构化` chip。
- **能力的作用**：开启后**新建**会话的 agent 指令追加 JSON 变体（`DOC_STYLE_JSON_SUFFIX`）：`doc` 围栏里写 JSON 对象而不是 YAML。与 DSH 不同，DSH 的 doc 块只认 YAML。
- **与 ZCode 的差异（有意）**：ZCode 的结构化输出是**供应商强制**（请求里带 `response_format`/schema）。pi-web 做不到：Pi Durable 的 `ConversationStreamOptions` 没有 `samplingParams`，模型级 `samplingParams` 会连标题、压缩、工具轮次一起改掉；DeepSeek 官方也只支持 `response_format: json_object`（`json_schema` 返回 400）。所以 pi-web 的开关含义是「这个模型按契约写 JSON 可靠」，**约束落在提示词上**，不是供应商层。
- **三层兜底**：JSON → YAML（带修复链）→ 原文兜底。三个渲染层同时存在，第一层失败自动退到第二层，两层都失败才显示原文（`data-doc-block="invalid"`）。因此没有打开能力的老模型、旧会话、别的供应商的模型都不受影响。
- **流式渐进**：JSON 载荷一行写完，YAML 那套「按行往回退」用不上；改为从写了一半的 JSON 里挑出已闭合的 `items` 条目（`completeArrayItems`），逐张出现，最后一条没写完的丢掉。`compare` / `note` 是整体结构，等写完再显示。
- 验收（真实实例 4317，`opencode-go/deepseek-v4.1-flash` 打开 `structuredOutput`）：两条会话的 `doc` 围栏**全部是合法 JSON**（cards / compare / checks），界面 `invalid` 块 0 个、`partial` 块 0 个；流式采样 partial 卡片 1 → 2 → 3 递增后转正式块。截图 `artifacts/doc-layout-check/90-93-json-*.png`。

## 全场景重跑与 JSON 修复（2026-10-21）

19 条场景（8 条角色场景 + 7 条排版专项 + 4 条新增压力场景）用**历史同一批题目**在真实实例 4317 重跑，模型 `opencode-go/deepseek-v4.1-flash`（`structuredOutput` 打开，契约发 JSON 变体）：

- **载荷格式**：18 条的 `doc` 围栏全是合法 JSON；1 条（`超时关单选型`）的 note 块结尾多了一个 `}`，模型手误，JSON 与 YAML 都解析不了。
- **修复**：解析链在 JSON 层补两下——原样解析、去掉结尾多出来的逗号；仍不成就救「第一个配平的顶层对象」（对象后面只允许有多余的收尾符号）。截断的载荷不修（流式渐进另有路径），围栏里出现第二个对象也不修。
- **渲染**：19 条全部 `data-doc-block` 正常、`invalid` 0 个、`partial` 0 个、横向溢出 0 个；390px 窄屏卡片单列无溢出；深色主题下 checks / changes / note 正常。
- **三层兜底逐层实机验证**：JSON 层（19 条真实场景）／ YAML 层（demo 夹具 `[doc-fixture]`，3 块正常）／ 原文层（新增 demo 夹具 `[doc-broken-fixture]`，坏块显示「结构化块格式错误，已按原文显示」，原文不丢）。
- 截图：`artifacts/doc-layout-check/scenarios/`（19 张）、`94-fallback-raw.png`、`95-narrow-390.png`、`96-dark-*.png`。

## 路径 chip 的解析（2026-10-21）

对照 DSH `packages/util/workspace-path/src/index.ts` 的 `resolveWorkspacePath`：DSH 把相对路径直接拼到工作区根目录后面，**不做同名匹配**——模型只写文件名时，DSH 同样点不开。pi-web 在此之上多做一级兜底：

- **原路径优先**：路径就是工作区相对路径时直接命中（`docs/config-catalog.md`）。
- **按路径后缀兜底**：找不到就按整段路径后缀在工作区里找（请求 `config-catalog.md` 命中 `docs/config-catalog.md`），唯一命中就打开；多个命中时列出候选，不替用户猜；一个都没有才 404。跳过 `node_modules`、`.git`、`dist`、`.generated` 等目录。
- **契约要求写全路径**：模型侧新增一条规则「路径写工作区里的相对路径，带上目录」，让模型少制造需要兜底的路径。
- **反引号与目录**：`changes` 块的 `path` 字段若带反引号（契约要求如此），渲染与点击都用去壳后的路径；路径指向目录时，文件接口返回目录条目，检查器切到文件浏览器并定位到该目录，而不是报「只能预览普通文件」。
- 这是 pi-web 相对 DSH 的**有意增强**：DSH 的行为在 DSH 里没有对应实现，pi-web 记为 DF-3 同类的有意差异。

## 右侧状态卡：Git / 进程 / 智能体（2026-10-28）

按 ZCode `ConversationStatusPanel` 的结构补齐右侧浮动状态卡：

- **Git 工具**：worktree 状态（分支、ahead/behind、dirty、+/− 行数）、逐文件改动、单文件 diff、分支切换、提交/推送，以及用当前会话模型生成 commit message。服务端 `git-worktree.ts` 用 `execFile` 直接读 Git，不经过 shell；`GIT_TERMINAL_PROMPT=0` 避免凭据提示挂住。HTTP 路由：`/api/workspaces/:id/git/{status,diff,commit,push,commit-message}`。
- **进程**：读取 TodoWrite 快照，`已完成/总数`；超过 6 项时保留当前项附近 3 项，前后折叠；宽屏下底部 Todo dock 让位。
- **智能体**：运行中的子智能体显示标题、实时时长、停止与打开；已结束的子智能体收在「已结束的智能体 · N」折叠里，显示 token/时长并可打开只读 tab。
- **布局**：卡片在会话右上角，宽 320px；会话列宽度不足或打开右侧 Inspector 时自动隐藏，并在可见时向左让出 336px。Git 状态每 5 秒刷新，会话更新时也会重读。
- **有意不实现：终端（后台 Bash）与工作流分区**。pi-web 的协议没有 `backgroundWorks` / `workflowRuns` 投影：Pi Durable 的 shell 工具是前台调用，`harness.inspect()` 只给任务记录而不区分可展示的终端/工作流；pi-web 也没有 CreateWorkflow 协议。没有真实数据源时不画空分区或伪造状态。因此这两项**从后续清单移除**，不算待办；若未来 Pi 增加后台 shell / workflow 投影，再按 ZCode 结构接入。
- **验证**：`tests/git-worktree.test.ts`（临时仓库真实 commit/push）、`tests/git-commit-message.test.ts`（消息清洗与上下文）、`tests/status-panel.test.tsx`（进程窗口、智能体折叠、窄宽隐藏）、`tests/http.test.ts`（新路由）。实机截图：`artifacts/status-panel/panel-git-wide2.png`、`panel-git-changes.png`、`commit-modal-2.png`、`commit-ai-generated.png`、`ended-agents.png`、`process-live.png`。

## 运行中不再提前显示结束态（2026-10-28）

Pi 的一条 run 在两次工具轮之间会把消息状态落成 `completed`，但会话仍在执行。此前 `AssistantResponse` 只读消息/run 状态，导致工具轮之间短暂显示「已工作 N 秒」、用量、时间和改动文件卡，`ProcessGroup` 也随之在展开/折叠之间切换。

- 以会话级 `running` 为准：只有最新 run 且会话仍在执行时标记 live；live 期间工作头显示「工作中」，不显示结束态用量、时间、操作栏和改动文件卡。
- live 期间工作组保持展开；结束或用户手动操作后才按展示策略折叠。
- 新增 `tests/transcript-live-state.test.tsx` 与标题单测；实机用 `sleep 60` 会话确认最新 run 无用量/操作栏/改动卡、头部为「工作中」，前一条已完成 run 的历史信息仍正常保留。

## 缺陷分析检索策略与 WeTrack 侧栏（2026-10-28）

一次单点 DTS 分析实际用了约 79 次工具调用、22 分钟，大部分消耗在错误作用域、重复 grep 和大文件分段重读。补了两层：

- **提示词**：`runtime-core.md` 新增「代码定位与检索」：从缺陷的项目/模块/版本定位子仓库，先查 `git log --grep` / `git log -S` / `git log -- <path>` 作为变更索引，再从入口沿调用链、用方法签名拿行号、精读 2–3 个片段；同一检索最多两次，证据足够即停止；明确禁止用「工具调用过程复盘」代替缺陷分析。
- **WeTrack 插件**：`wetrack_detail` 的 tool content 现在包含完整详情 JSON（描述、转派备注、附件），不再只回一行摘要；Skill 增加约 15 次工具调用预算和相同的 git-log/子仓库/窄读策略。页面改为 `preferredDisplayMode: fullscreen` + 稳定 `toolCallId`，默认在右侧面板打开并由 pending/detail/report 原地更新；正文只显示分析，不会覆盖页面。
- **验证**：`tests/work-policy.test.ts`（提示词断言）、`tests/wetrack-plugin.test.ts`（完整 content、fullscreen meta、报告层级）、`tests/plugin-ui-pinning.test.tsx`（折叠时页面仍可见）；真实模型在右侧面板验证 pending → report 同 tab 更新，截图 `artifacts/wetrack-plugin/side-pane-list.png`、`side-pane-report.png`。
