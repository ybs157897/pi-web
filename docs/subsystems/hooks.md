# 钩子（hooks）

> 状态：现状参考（2026-11-17）。决策与验收历史见 [docs/spec.md](../spec.md) 对应日期段。格式与语义对齐 ZCode/Claude Code 的 hooks 契约，[parity.md](../parity.md) 未单列条目。

## 配置来源与热生效

两个全局来源：用户级 `hooks.json` 存 `dataDir` 根（生产默认即 `~/.pi-web/hooks.json`，与 personalization 同款，测试/演示经隔离 dataDir 自动隔离），项目级存 `<workspace>/.pi-web/hooks.json` 随仓库共享（[store.ts:102](../../src/server/hooks/store.ts#L102)）。配置在**每次 hook 触发时热读**，靠 mtime+size 缓存兼顾问开销（store.ts 的 `load`）；创建即生效、无需重启或 reconfigure——这与 ZCode 的 per-session 快照不同，是有意的取舍：本功能的需求是「agent 创建后自动生效」，稳定性由执行层契约（超时/隔离/fail-closed）保证而非快照。单来源 JSON/schema 损坏只记诊断不执行该来源，不牵连另一来源。

## Schema 与 matcher

格式兼容 `{ hooks: { enabled, timeoutMs, maxOutputBytes, events: { <Event>: [ { matcher?, hooks: [...] } ] } } }`，未知字段在配置与 stdout 输出两处均 passthrough 保留（[schema.ts:11](../../src/server/hooks/schema.ts#L11)）。默认超时 15 秒（[schema.ts:26](../../src/server/hooks/schema.ts#L26)）、stdout 上限 32KB；条目级 `timeoutMs` > 来源级 > 全局默认。hook 定义两种形态：`process`（`command`+`args[]` argv 直传，跨平台首选）与 `command`（整条 shell 字符串，兼容 Claude 插件）。matcher 语义（[schema.ts:128](../../src/server/hooks/schema.ts#L128)）：缺省/空/`*` 匹配全部；仅字母数字下划线与 `|` 按精确名称列表、大小写敏感；其余按 JavaScript 正则，非法正则永不匹配并记诊断；无查询值的事件（Stop/PreCompact）带 matcher 也执行。

## 信任边界

用户级配置无信任门：本机自己写的，`enabled` 即执行。项目级随仓库走，外部带来的声明（如 git clone）默认 pending 不执行，须经设置页批准。声明 digest 覆盖全部执行参数——event/matcher/type/command/args/includeNested/生效 timeoutMs/生效 maxOutputBytes，改任何一项都使旧信任失效回落 pending；`enabled` 不参与（启停是管理操作）（[store.ts:56](../../src/server/hooks/store.ts#L56)）。信任集存 `dataDir/hooks-trust.json`（绝不进仓库），键为 workspaceId+digest；**每次 dispatch 重验不缓存**，store 损坏 fail-closed 全拒项目级（[store.ts 的 `trustedDigests`](../../src/server/hooks/store.ts#L102)）。两条批准通道：agent 经 `manage_hooks` 创建/更新（用户已在对话确认）自动 admit；设置页「钩子」页手动批准/撤销，页面编辑保存**不自动批准**——新 digest 回落 pending 是安全边界。

## 执行契约

子进程执行引擎对齐 ZCode 运行时契约（[runner.ts:136](../../src/server/hooks/runner.ts#L136)）：stdin 单行 JSON（Claude 兼容 snake_case 字段 `session_id`/`cwd`/`hook_event_name` 加事件专属 `tool_name`/`tool_input`/`tool_use_id`/`tool_response`/`error`/`is_interrupt`/`stop_hook_active`/`last_assistant_message`/`reason`/`message_count`，pi-web 扩展 `changed_files`；同时注入 `PI_WEB_SESSION_ID`/`PI_WEB_PROJECT_DIR` 环境变量）；stdout 以 `{` 开头才解析并 zod 校验，非 JSON 仅诊断；exit 0 成功、**exit 2 阻断**（PreToolUse 拒绝调用、Stop 要求续跑）、其他非零可恢复失败不拖垮会话；合法 JSON 但已知字段类型错误判该 hook 失败。超时与父级取消都杀进程树（posix `kill(-pid)`、Windows `taskkill /F /T`，[runner.ts:79](../../src/server/hooks/runner.ts#L79)）；组内串行、逐条 try/catch 隔离；`additionalContext` 按序拼接、注入层 24k 字符截断；决策聚合 deny/block 优先、`updatedInput` 后者覆盖（[runner.ts:268](../../src/server/hooks/runner.ts#L268)）。

## 事件接线

首批接五个内核钩子点（[extension.ts:391](../../src/server/hooks/extension.ts#L391)）：`PreToolUse` → `ToolTask.beforeTool`（block/改 arguments；**默认只拦模型直发调用**，条目 `includeNested:true` 才拦 codemode 嵌套）；`PostToolUse` / `PostToolUseFailure` → `afterTool`（成功/失败分支，additionalContext 追加到工具结果 output 末尾）；`Stop` → `GenerationTask.onYield`（续跑驱动，上限 3 次）；`PreCompact` → `CompactionTask.beforeCompact`（block 拒绝压缩、`hookSpecificOutput.summary` 替代摘要）。`UserPromptSubmit` 与 `SessionStart` 仅在 schema 中声明、尚未接线（见已知限制）。`PermissionRequest` 不支持：pi-web 权限模型是 accessMode，无逐工具 ask 路径，与 ZCode 不同构。每个 handler 整体 try/catch，hooks 子系统任何异常收敛为放行，绝不拖垮会话。

## changedFiles 与 Stop 续跑

`afterTool` 对 write/edit/multi_edit 成功调用（含 codemode 嵌套）聚合本轮修改文件到会话 doc `pi-web.hooks`（commit 事务内读改写，并行工具轮不丢更新；**不能用 `api.memo`——它按 task 存活**，tool task 的状态到不了 generation task 的 Stop）；`Stop` 的 stdin 带 `changed_files` 列表送达脚本，消费后清空（无 Stop 配置也清空，防跨轮泄漏）。Stop 续跑与 goal 的 `onYield` 同款边界：有 pending 交互（`awaitingUser`）时不续跑、不越过用户答复；续跑计数达 `MAX_STOP_CONTINUATIONS=3` 硬停；「连续」语义靠 `beforeRequest` 判别——最后一条 user 消息不带 `[hook 要求继续]` 前缀即真实输入，计数归零（[extension.ts:366](../../src/server/hooks/extension.ts#L366)），续跑移交创建新 generation task，不能用 taskId 区分。

## 创建与管理

`manage_hooks` 工具五个动作（[tool.ts:297](../../src/server/hooks/tool.ts#L297)）：list / create / update / delete / set_enabled。create 支持 `script` 参数一站式落盘（脚本写入对应来源的 `hook-scripts/` 目录，先写脚本后写配置，失败不留半截），项目级新增自动 admit；写操作过 `canWrite` 门（fullAccess/workspaceWrite 且非计划模式，与 `skill_save` 同款）。index 定位与设置页同口径：事件内按组顺序→组内顺序展开的连续序号（[store.ts:311](../../src/server/hooks/store.ts#L311)）。工具描述硬约束：创建/修改前必须先用 `ask_user_question` 确认超时（默认推荐 15 秒）与级别；`ask_user_question` 的非阻塞语义（问完结束本轮、答复以跟进消息送达）天然阻止未确认就创建。内置技能 [skills/hooks-creator/SKILL.md](../../skills/hooks-creator/SKILL.md) 提供场景→事件映射、脚本规范与 changed_files 示例。

## 设置页与可观测

设置 → 钩子页（[HooksPanel.tsx](../../src/web/HooksPanel.tsx)）：双来源分组、逐条启停/删除、项目级 pending 横幅与批准/撤销、信任状态徽标、来源损坏诊断；REST 路由 `/api/hooks`、`/api/hooks/trust`、`/api/hooks/remove`、`/api/hooks/enabled`（[app.ts](../../src/server/app.ts)），feature 服务在 [runtime/hooks.ts:82](../../src/server/runtime/hooks.ts#L82)。运行记录走轨迹同一 JSONL 通道：每会话文件追加 `type:'hook'` 行（event/source/command/outcome/durationMs/exitCode/error，[trajectory.ts](../../src/server/conversation/trajectory.ts) 的 `createHookCapture`），`assembleTrajectory` 的通用 capture 合并按 ts 排序天然纳入；outcome 含 `success`/`blocked`/`failed`/`timeout`/`cancelled` 与信任门产生的 `pending_trust`/`skipped`。

## 隔离与路径安全

用户级配置与信任集在 dataDir（测试/演示隔离）；项目级写入做路径防逃逸与符号链接拒绝（`writeScript` 校验脚本名白名单，目标须在脚本根内且非链接）。零工作区会话只跑用户级钩子，`manage_hooks` 的项目级操作报「没有工作区」。轨迹采集沿用 `PI_WEB_TRAJECTORY=0` 关闭开关。

## 已知限制

- `UserPromptSubmit` 与 `SessionStart` 仅 schema 声明、尚未接线：效果路径需会话级 doc 暂存 + `beforeRequest` 注入，属第二批次；`PermissionRequest` 不同构不实现。
- command 型 hook 在 Windows 走系统自带 Windows PowerShell（不依赖 pwsh 安装）；其输出编码按平台默认代码页，脚本应显式 UTF-8 或以 process 型 node 为准。
- live 验收（`npm run test:live:hooks`）在 macOS 通过；Windows 实机未执行（[windows-support.md](../windows-support.md) 的条件支持口径）。
- 项目级钩子的信任 store 为单进程假设；多进程共享 dataDir 时的并发写与 CAS 未做防护（与 goal 的同类限制一致）。
- Stop 续跑计数按会话持久；同一会话内被真实用户消息重置，跨会话独立。