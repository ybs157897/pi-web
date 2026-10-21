# Pi Durable Web

## 2026-10-18

- 定了：新建独立项目，以 Pi Durable 1.3.0 为执行与持久化内核，DSH 0.2.1-rc.2 展示组件与主题为视觉基础。
- 定了：第一版提供会话列表、新建、重命名、置顶、归档、模型选择与配置、输入、流式正文、思考、工具结果、排队、停止与刷新恢复。
- 定了：服务默认仅监听本机；凭据保留在服务端，应用数据独立存储，已有 Pi 配置只读导入。
- 判据：真实 Pi Durable/SQLite 链路通过自动化验收；浏览器能发送、显示流式内容和工具结果，刷新及重启恢复历史；亮暗主题及窄屏可用。
- 判据：真实模型使用当前已配置模型做最小调用；若供应商拒绝，保留具体错误并与确定性测试区分。
- 未决：Pi 原生停止会撤回排队输入，首版明确显示该语义；保留队列的停止需独立验证后提供。

- 判据：已通过真实默认模型 opencode/deepseek-v4.1-flash 最小调用，以及真实 HTTP/Pi/SQLite 的幂等、工具执行、分叉和进程重启恢复验收。
- 判据：类型检查、14项测试和生产构建通过；浏览器真实模型对话、刷新恢复、置顶重命名、亮暗主题及390px侧栏与设置弹窗验收通过。
- 定了：继续完整对齐真实 DSH Web，包含居中空态、工作区会话树、插件和自动化页面、聊天过程分组、回答操作栏、轨迹/文件侧栏、输入与队列操作、两栏设置。
- 判据：按相同 viewport/主题与真实 DSH 逐屏验收；菜单、表单和操作必须连接真实接口，不交付静态占位。
- 判据：用现有默认模型实际执行 write/read/edit/bash，检查工具结果和磁盘产物，不以模型自行宣称成功作为验收。

## 2026-10-19

- 定了：停止改为保留排队输入（与 DSH 语义一致），发送下一条消息后继续处理；README、architecture 与 runtime 测试同步更新。
- 定了：按真实 DSH 0.2.1-rc.2 逐屏视觉核对，先修输入区四项——附件卡、整页拖拽遮罩、`/` 指令面板、`@` 引用面板。核对清单与进度见 `docs/parity.md`。
- 判据：类型检查与全部测试通过；四项改动在 1440×900 浅色主题下与 DSH 截图对照无明显错位。
- 定了：开启 Pi Durable 1.3.0 的 code mode 与 MCP。代码模式三态（off/on/only，默认 on，设置可切并应用到空闲会话），`codemode` 工具用 QuickJS 沙箱执行脚本，脚本内调用是嵌套工具调用；工具卡展示脚本、输出与 `details.calls` 子调用。MCP 只读导入用户级 `~/.pi-web/mcp.json`（demo 为 `<数据目录>/mcp.json`，`PI_WEB_MCP_CONFIG` 可覆盖），支持 stdio/Streamable HTTP、`mcp__<server>__<tool>` 命名、`codemode/deferred/direct/hidden` exposure 与 `tool_search`，设置新增只读 MCP 状态页；OAuth 暂不接入，配置变更需重启。
- 判据：`npm run typecheck`、全量 vitest（166 项，含 mcp 9 项与 runtime 3 项新用例）、`npx vite build` 通过；demo 实例 HTTP 验收 codemodeMode 切换、`/api/mcp` 形状与 `[codemode]` 脚本真实调用 bash；MCP 连接/隔离由内存 transport 与真实 stdio 夹具覆盖；ego-browser 真实浏览器冒烟（代码工具卡/代码模式三选/MCP tab）0 console error，截图在 `artifacts/ui-codemode-check/`（gitignored）；独立 verifier 45/45 检查 PASS（含凭据不泄漏、readOnly 工具面、busy/preset 不误伤）。真实模型复核脚本 `npm run test:live:codemode` 已就绪，但 opencode-go 供应商返回 401 `api_key_expired`（平台 key 过期，与本轮代码无关），保留错误待 key 恢复后补跑。
- 定了：子智能体的转录内呈现改为「一行彩色胶囊」（`SubagentRunStrip`）：同一回合连续的 `subagent` 调用折成一组，**代码模式脚本里通过 `tools.subagent` 发起的嵌套调用**也提成同一组（脚本卡隐藏这些嵌套行；截断的 `args` 用字段前缀还原 label）；每个子会话按父会话子列表顺序取固定配色（缺行时按 id 哈希，6 色循环）；尚未匹配到子会话时显示转圈 + 「创建中」/「正在创建子智能体」，运行中显示 `{已结束}/{总数}`，完成后显示 tokens，失败标红并描边；点胶囊复用既有 `selectConversation` 打开子会话的「对话」界面（执行过程在转录里可见），父标题面包屑返回父会话。已完成但 label 对不上的胶囊会按 label 前缀、再按最新子会话顺序兜底匹配，避免出现不可点击的完成态。工具结果与实时投影（`details.result` 嵌套形状）合并出状态与指标，`ConversationDetail.subagents` 在有子会话运行时 1.5s 轮询。
- 判据：`npm run typecheck`、全量 vitest（178 项，+11：`tests/subagent-run-model.test.ts`，render-model +2）、`npx vite build` 通过；demo 实例（4331）跑 `[subagents]` 三路并行委派，CDP 无头浏览器验收完成态三色胶囊 + tokens、运行态转圈 + `0/3 结束`、点 city 胶囊进入子会话并可经面包屑返回、暗色主题同几何可读，0 页面异常；截图在 `artifacts/subagent-strip-check/`（gitignored）。
- 定了：Windows 为「有条件支持」。README 新增 Windows 章节（Node/Git for Windows 前提、koffi 可选依赖、cmd/PowerShell 启动写法、与 macOS 的差异、验证差异），architecture 新增 Platforms 小节；完整审计、证据与待实机验证清单见 `docs/windows-support.md`。Windows 上 bash 工具依赖 Git for Windows（未接入 PowerShell 工具），`workspaceWrite` 仅 macOS 可用（capabilities 已降级为 readOnly/fullAccess），Windows 原生目录选择器（koffi + IFileOpenDialog）已接入但未经实机验证。
- 判据：Windows 10/11 + Node 24 + Git for Windows 下 `npm run dev` 可打开 127.0.0.1:4317，原生选择器与 bash 工具按 README 描述工作；README、architecture 与 `docs/windows-support.md` 对能力边界与前提的说明一致。
- 未决：Windows 实机验收（koffi/COM 选择器全链路与失败回退、长路径/UNC、WAL 与关控制台恢复、ACL、Git Bash/Git.exe 探测、Git 分支、Skills、默认任务规划/提示词资产、MCP）与 Windows CI；`npm test` 需平台化 POSIX 权限断言、Skills 路径分隔符/符号链接和 Git 测试；`test:live:tools`/`test:live:codemode` 写死 `workspaceWrite`，Windows 上不可用，而 `test:live:skills`/`test:live:workflow` 仍需真实模型、Git Bash 与 Windows 实机记录。
- 定了：界面按用户要求引入 ZCode 参照（`zai-org/ZCode` 开源仓库，浅克隆核对）：① 输入区上方空态标题按 ZCode 实现——5/9/12/14/18/23 分段的问候语 + 背后 400×320 渐隐 Logo（20–30px 按可用宽度自适应，文案取自 ZCode locales）；Logo 沿用 ZCode 的尺寸、上移位置与渐隐遮罩，但形状改为 Pi 的 π 描边；标题旁不再显示小 π 标记、产品名或「预览版」徽标；② 侧栏移除头部「新建会话」图标按钮与「新会话」按钮上的快捷键徽标；③ 修复侧栏折叠后 `新会话` 按钮文字与快捷键徽标重叠（重影）；④ 空态隐藏「标准模式」预设选择器（无预设时不渲染，有预设仍可选）；⑤ 新增 Git 分支切换：repo 级本地分支列表 + 切换 + 新建并切换，交互参照 ZCode `GitBranchSwitcher`（搜索框 + 当前分支置顶 + 底部「新建分支并切换」），阻塞原因按 ZCode 的结构化 issue code 返回（`packages/services/src/git/repo/gitCliHelpers.ts:64`），不做 stash / force / rebase 等本文档未承诺的工作流。
- 判据：`npm run typecheck`、全量 vitest、`npx vite build` 通过；demo 实例上真实浏览器核对问候语分段/背景 Logo/侧栏展开与折叠（无重影）/空态无预设选择器；分支切换在临时 git 仓库工作区实测「列出 → 切换 → 新建并切换 → 非法名/未提交覆盖的阻塞提示」。

- 定了：内置技能创建器与目录、加载、保存、校验；设置页可查看技能。
- 判据：新技能可跨会话和重启使用，只读与工作区边界有效。
- 未决：真实模型对照仍受 401/缺失凭据阻挡；2026-10-20 的 macOS 基线已通过 typecheck、241 项测试与 build，但 Windows 实机验收尚未开始。

## 2026-10-20

- 定了：自主拆任务、更新进度和汇报规则默认接入，不需手动配置预设。
- 判据：模型请求含核心规则；Plan、只读、分叉和重启均符合约束。
- 未决：两侧真实模型对照被过期或缺失凭据阻挡。
- 定了：上下文压缩升级为「压力裁剪 + 预算触发 + 缓存感知摘要」三层（机制见 `docs/families.md` 第 10 节与 `src/server/compaction.ts`）：保留 Pi Durable 的 16k/30k/34k 策略，有效窗口默认使用模型真实窗口（1M 即 1M；模型未声明窗口时回退 200k，可用 `PI_WEB_CONTEXT_BUDGET` 设成本上限）；请求压力超过窗口 85% 时确定性裁剪老 tool result；回合结束超过预算时后台触发压缩；摘要优先复用会话前缀（同 provider session，剩余窗口足够时），使用 6 节工程检查点模板、注入防护与文件跟踪，校验失败自动退回 Pi 内置摘要器。
- 判据：typecheck / 全量 vitest / build 通过；demo 实例先发小消息再发 180k 字符消息可自动压缩，`pi.compaction` 摘要包含完整模板与 `<read-files>/<modified-files>`；`tests/compaction.test.ts` 覆盖预算、裁剪、序列化、文件列表、校验、请求构建与 memo/失败回退。真实模型因 key 过期未验收。
- 判据（2026-10-20 补）：真实 `opencode-go/deepseek-v4.1-flash`（1M window）provider 测试 `connected`，真实对话 3 轮后手动压缩成功，`pi.compaction` 摘要 980 字符、含 6 节标题与 `<read-files>`；ego + 真实 `opencode-go/deepseek-v4.1-flash` 验证：运行中在转录末尾显示与完成标记同级的「正在进行上下文压缩」系统行（旧完成标记隐藏、无 toast），完成后该行变为「已完成上下文压缩」（`artifacts/ego-compaction/07-level-running.png` / `08-level-completed.png`）。1M 模型默认使用完整窗口，`PI_WEB_CONTEXT_BUDGET` 可选设上限；测试用 60k 上限与 2k keep 降低真实模型成本。
- 定了：长间隔调度、引用删除保护、10 键快捷键、Provider 保存门禁与摘要占位校验。
- 判据：自动化到期才运行、引用删除返 CONFLICT、Provider 用新配置、摘要拒绝占位。
- 未决：Windows 实机验收仍未完成。
- 定了：工作步骤展开的三项修复（2026-10-21）——改动文件内联预览可收起（每卡一个 `aria-expanded` 开关，收起后保留路径与「查看差异」）；工作区内绝对路径/反斜杠路径归一化后可打开，越界仍拒绝；压缩完成后任务继续，且压缩完成标记回到它所替换内容的位置而非贴在最底部。
- 判据：压缩阈值归属改由平台生成级压缩负责（`ownsCompactionThreshold()`），一次压缩只产生一次摘要请求、任务继续完成（`tests/compaction-flow.test.ts`，关掉守卫即失败）；系统行按消息流位置编排（`render-model.ts` 的 `timeline`）；ego 验收：文件卡片 `aria-expanded` true→false、预览 138px→0，工作区内绝对路径请求 200、越界 400，压缩标记在转录中的位置由最后变为它所替换内容处。Windows 实机验收仍未完成。
- 定了：消息流末尾补「正在运行」指示器（2026-10-21）——形态取 ZCode 的 `ChatLoading`（16px 图标、旋转加在 HTML 包装层以走合成层、`role="status"`、只有图标无文案），位置取 DSH 的 `ChatFlow`（挂在整个消息流最末尾）；触发语义对齐 ZCode 的 `shouldShowTurnChatLoading`：仅运行中显示，等待用户回答/授权时隐藏，压缩等维护任务在跑时隐藏，**不做防抖**（ZCode 源码明确：running 是权威事实，额外静默计时会让每次投影更新都重启可见性并使 UI 晚于真实状态）。运行事实取会话 `busy`（`live.run !== undefined`）而非最后一轮的 `status`——后者由该轮已记录的消息推导，两个工具轮次之间会掉到 `completed`，指示器会在任务未停时闪一下。
- 定了：块级流式状态按「块」而非「整条消息」判定（2026-10-21）——对齐 DSH `AssistantMarkdown.tsx:103` 的 `running={streaming && i === last}`，只有消息里最后一个有内容的块才是流式尾巴；正文块不再因 toolCall 到来而在回答区与过程区之间搬家（流式中的 assistant 消息固定占有回答区）；块身份改用模型 content 数组里的位置 `slot`（Pi 只追加，该位置稳定），投影层保留空块、过滤下移到渲染层，React key 不再随「空块变非空」而漂移。
- 判据：`npm run typecheck`、全量 vitest（32 文件 383 项）、`npx vite build` 通过；`tests/render-model.test.ts` 新增 6 例（正文不搬家、块级流式状态、slot 稳定性）、`tests/projection.test.ts` 新增 2 例（空块保留与 slot 盖章）；ego 验收：真实模型 `opencode-go/minimax-m3`（推理等级 High）下「正文可见但思考仍在流式」帧数 0、「正文误入过程区」帧数 0，思考行的 `data-running` 在正文出现瞬间由 1 变 0；demo 与真实实例上运行期间「忙但无指示器」帧数 0，待回答交互时指示器隐藏。
- 定了：assistant 消息的身份改为 `assistant:${byTaskId}:${timestamp}`（2026-10-21）——流式与落盘共用同一身份，生成结束时不再整棵子树重挂载。锚点取自 Pi Durable：entry 上的 `byTaskId` 与 `LiveState.run.taskId` 是同一个 generation task 的 id，partial 与最终 message 又是同一个对象（时间戳相同）。重试写下的两条 entry 靠时间戳区分；调度器 fault 路径没有 task scope，退回 entry id（上游限制）。
- 判据：`npm run typecheck`、全量 vitest（32 文件 386 项）、`npx vite build` 通过；`tests/projection.test.ts` 新增 3 例；ego 前后对照：改前流式与落盘是两个 DOM 节点，改后是同一个节点、`data-message-id` 不变。
