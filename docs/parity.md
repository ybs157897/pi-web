# DSH Web 一致性清单（实时）

基准：`deepseek-ai/deepseek-harness` HEAD `687f282e86`（dsh 0.2.1-rc.2），本地 `dsh web` 与 pi-web demo 同 1440×900 / 浅色 / 中文逐屏截图对照。
证据目录：`artifacts/ego-compare/shots`（gitignored，仅本机）。

状态：`待修` / `进行中` / `已修` / `不做`（附原因）。

## 输入区

| ID | 问题 | DSH 对照 | 证据 | 状态 |
|---|---|---|---|---|
| IN-1 | 附件卡缩水成一行文字：图片 34×34、文件 chip 约 121×44、无边框、12px、无大小元信息、删除键常显 | 图片 64×64；文件卡 240×64、radius 16、1px 边框、14px 名称、`MD 26B`/`PDF 597B` 元信息、删除键 hover 显示 | `dsh-03-attach-zoom.png` / `pi-04-attach-zoom.png` | 已修（实测图片 64×64/radius 20；文件卡 240×64/radius 16/1px 边框/元信息，与 DSH 实测一致） |
| IN-2 | 拖拽无任何反馈；拖到输入卡外浏览器会直接打开文件 | document 级整页毛玻璃遮罩 + 插图 + 标题 + 图片限制；拒绝态与 `dropEffect` | `dsh-04-drag.png` / `pi-05-drag.png` | 已修（整页遮罩 + 插图 + 标题/限制 + dropEffect；ego 复核） |
| IN-3 | `/` 面板是约 360px 窄浮层，只有 3 条命令，无分组/说明/图标 | 与输入卡同宽，分「添加」「指令」，图标+名称+id+右侧说明 | `dsh-08-slash-menu.png` / `pi-09-slash-menu.png` | 已修（面板宽 774 = 输入卡宽，添加/指令分组；ego 复核） |
| IN-4 | `@` 面板是窄浮层，只有文件、无分组/目录下钻 | 同宽面板，分组「文件与文件夹」，目录可下钻（Tab），另有子智能体/对话分组 | `dsh-09-at-menu.png` / `pi-10-at-menu.png` | 已修（同宽面板 + 分组 + 目录下钻；实测 @src/ 后列出 src/nested、src/index.ts） |
| IN-5 | 「繁忙时的发送行为」设置不生效（硬编码 `followUp`） | 设置项决定 Enter/发送按钮行为，备用手势取反 | 代码 `App.tsx:151` | 已修（sendMode 初值取 settings.busySendMode） |
| IN-6 | 附件并发添加可绕过上限；超限后收到英文 `Request body is invalid` | 客户端预检整批拒绝并给出本地化文案 | 代码 `App.tsx:490-521` | 已修（reading 预留计数；纯函数门控 16/16 用例） |
| IN-7 | 附件无读取中/失败/重试态；发送失败无幂等重试 | 上传中 spinner/进度、失败点击重试、未完成阻止发送 | 代码 `App.tsx:528-539` | 已修（reading/ready/error 三态 + 失败点击重试 + 未就绪阻止发送；发送失败复用同一 requestId 幂等重试；ego 复核） |
| IN-8 | AVIF 与 `File.type` 为空的图片被降级为普通文件 | 图片按 MIME 白名单识别并渲染缩略 | 代码 `App.tsx:47` / `server/workspace-files.ts:20` | 已修（avif + 空 MIME 按扩展名推断） |
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

## 设置与页面

| ID | 问题 | DSH 对照 | 证据 | 状态 |
|---|---|---|---|---|
| ST-1 | 设置弹窗 mask 无背景模糊 | 毛玻璃遮罩 | `dsh-12-settings.png` / `pi-12-settings.png` | 不做（默认主题 `--dsw-mask-blur: none`，两边同源；截图差异疑为本机 DSH 主题覆盖/JPEG 压缩） |
| ST-2 | 外观是紧凑分段按钮；字号是数字输入+齿轮 | 外观三张带图标大卡；字号下拉式控件 | `dsh-17-settings-general.png` / `pi-16-settings-general.png` | 已修（外观三卡实测 180×82/gap10，DSH 181×83；字号 `N px` 下拉） |
| ST-3 | 插件页是工具开关清单、字母「C」占位图标、英文工具描述 | 插件配置中心（内置/实验性/已安装 + 彩色图标 + 添加插件） | `dsh-13-plugins.png` / `pi-13-plugins.png` | 已修（图标块 40×40 + 工具描述本地化；市场/安装仍不做） |
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

六族全部落地并验证：待办、问答、目标、计划模式、子智能体、智能体团队。约束与环境：真实模型只用 `opencode-go/deepseek-v4.1-flash`（pi-web 侧模型白名单强制、`~/.pi` 全局配置已裁剪并备份）；对标工作按 skill `dsh-parity` 执行（先读 DSH 源码 → 两侧同一条流程 → 代码级并排分析）。

### 交互收尾批次（2026-10-19 追加）

五项落地并两侧验证，详见上文「交互收尾对比」：

1. **问答工具行状态细分**：`interactions` 接进转录（`App.tsx:1527` → `transcript.tsx:39-48,95-100,325-330` → `ToolCard.tsx:52-62`），行模型按 `pending/continued/expired/cancelled/answered` 输出 DSH 的五行文案（`tool-render-model.ts:677-698`）。
2. **问答卡「放弃整组问题」**：`POST .../interactions/:callId/cancel`（`app.ts:440-444`）→ `runtime.cancelInteraction`（`runtime.ts:1112-1149`，文档置 `cancelled` + 幂等 steer + answered 409）；前端按钮 `QuestionComposer.tsx:244-249`；转录里 steer 渲染为紧凑气泡（`transcript.tsx:225-262`）。
3. **`subagent` 工具行**：`已开始子智能体 · {label} · {子会话 id}` + 回执卡（任务原文 / 子会话 id / 「打开子会话」），不再渲染整段 JSON（`tool-render-model.ts:806-821`、`ToolCard.tsx:63-68,115,135,147-150,200-215`）。
4. **hover 即开/即关**：`SubagentPanel.tsx:108-149`、`TeamPanel.tsx:121-149`（150/120ms、点击 pin、外点/Escape 关、`prefers-reduced-motion` 无延迟）。
5. **团队成员行**：模型 hover 才显示（`TeamPanel.module.css:203-209`）；窄容器下触发器收起文字并仅点击开（`TeamPanel.module.css:43-51`），460px 实测面板不溢出。

门禁：`npm run typecheck` / `npx vitest run`（135/135，+7：render-model 4、interactions 1、runtime 1、http 1）/ `npx vite build` 全绿。ego：demo 实例 4418（`/tmp/pi-98-demo` 数据目录）跑 `[ask]`（等待→放弃→已回答）、`[subagent]`（行→回执→打开子会话→hover）、`[team]`（hover 面板/成员模型/窄容器）；DSH 对照在 3080 实例（显式 DeepSeek-V4.1-Flash）跑同一条问句流程。截图 `pi-98-*` 与 `dsh-98-*` 成对存 `artifacts/ego-compare/shots/`。遗留：子会话面包屑 switcher（数据面已具备，待下一步）。

- 2026-10-19：收尾批次三。**计划预览**：Inspector 新增「计划」视图（最新 `plan-review` 的 markdown，空态「计划预览不可用」），`ToolCard` 计划卡加「打开」并首次自动打开、手动关闭后不自动重开（`pi-99-plan-01..05`）；**子会话面包屑**（父标题 ← 当前、同级切换、当前 tag）；**子会话 metrics**（`tokens`/`durationMs` 投影 + 面板 `{tok} · {时长}` 运行中每秒刷新）；**团队健壮性**：`spawn_teammate` replay-safe + 按名字幂等复用、`reconcileProvisioning` 把无子会话的 `provisioning` 行对账为 `failed`（对齐 DSH `roster.ts:375-417`）；fork 继承语义沿用既有测试（父级未完成轮次不进入 fork 前缀）。门禁：typecheck / **144/144 测试**（+9）/ build 全绿。
