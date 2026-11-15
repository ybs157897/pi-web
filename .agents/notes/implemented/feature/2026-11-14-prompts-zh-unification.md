# Agent Note: 提示词统一中文

Status: implemented

决策与验收结果归属 [spec.md](../../../../docs/spec.md#2026-11-14)，本文记录实现边界与兼容性细节；新增文案规则见 [prompt-changes.md](../../../../docs/defensive-patterns/prompt-changes.md)。

## Decision

本仓库维护的模型指令、动态 section、工具与参数描述、内置技能目录元数据、宿主注入的指令以及后台旁路提示词采用中文。工具路由默认使用中文；标题继续跟随用户消息语言，提交说明继续由 `locale` 选择中文或英文。压缩说明与校验器一致，明确要求 `Progress` 包含 `Done`、`In Progress`、`Blocked` 三个子节。

- 自有 section：Goal、Skills、Team、项目与个性化状态说明，以及 code mode 的宿主指导；已有中文核心、计划和委派政策不重复改写。
- 自有工具：shell（bash/pwsh）、检索、浏览器、待办、计划、提问、目标、技能、子智能体、团队、定时与 WeTrack 的说明和参数描述。执行函数、权限守卫、工具名、参数名、类型、required 与枚举均保持原契约。
- 宿主指令：目标续跑、计划批准/修改/忽略、问题忽略、后台子智能体通知、团队消息、定时提醒与插件引用。
- 后台调用：压缩的操作说明和来源规则、会话标题、提交说明，以及记忆提取工具说明。记忆提取正文已有中文。
- 工具结果仅翻译引导下一步操作的指令；状态数据与非指令错误输出不做整体本地化。
- 技能仅翻译目录元数据；按需读取的技能正文及 references 保留原文，不改外部技能、工作区 AGENTS.md 或用户内容。

Pi Durable 自带的 `read`、`write`、`edit`、`codemode`、`tool_search` 描述、code mode 生成的声明框架、`describeTool`/`searchTools` 回包以及第三方 MCP 元数据保留上游原文。不修改 node_modules，不复制依赖内部模板，也不对上游生成文本做固定短语替换。code mode 生成的自有工具声明会继承本仓库中文 description；框架文字仍可为英文。

## Consequences

以下文本参与解析或持久记录识别，保持原文：工具/参数/枚举/section key、代码与 RRULE、标签名、`Nothing to save.`、`[goal N/M]`、`[subagent-settlement]`、交互消息 kind、定时提醒标记及键名、技能目录 `- <id>: ` 的半角冒号与 `file:` 路径标记。压缩的 `SUMMARY_PREFIX`、完整 `SUMMARY_FORM`（含用于拒绝模板回显的占位文本）和角色标签保持英文，因此老摘要及占位符拒绝规则继续有效。demo 模型兼容新中文指令与原英文历史指令。

15 份快照覆盖默认、只读、计划、code mode、记忆、子智能体和团队请求；逐份核对后，section key、顶层工具可用集合及剔除 description 后的参数 schema 不变。中文说明缩短了 SDK 估算长度，因此 code mode 的 1,200 估算 token 预算内可展示更多已有嵌套工具；未改预算或工具权限。快照增加自有工具及参数说明的中文守卫，依赖工具显式豁免；团队语言断言改为中文。原有权限、待答、计划审批和压缩来源断言同步到中文，未删除行为检查。

语言统一提高维护可读性，不预设模型行为或实际 token 成本一定改善。真实模型验收采用相同供应商、模型与场景的前后对照；改造前源码保存在临时副本，凭据只用于临时验收配置。Windows 描述有平台工具构造测试，macOS 上通过不等于 Windows 实机验证。完整验收与未通过项见 spec 当日记录。
