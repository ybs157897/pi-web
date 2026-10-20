# 提示词源码依据与集成说明

项目增强提示词用于驱动后续开发；运行时核心已收敛到 `src/server/prompts/runtime-core.md` 并由默认 `runtime-policy` 扩展实际注入。Todo/Goal 的动态策略根据当前模式和可调用工具生成。Skill 创建器、文件服务、四个 skill_* 工具、动态目录与设置页也已接入。问题单与验证环境管理片段仍是待建设模板，没有作为现有能力注入模型。

初稿核对日期为 2026-10-19；运行时契约与项目上下文在 2026-10-20 更新。依据当前工作树及公开源码，下面的本地行号可能随并行开发移动。实际验证应检查对应脚本与报告；单个样例通过不代表所有提示词规则均已得到行为验证。

## 使用方式

- [项目增强提示词](project-enhancement.md)：将分隔线后的正文交给在本仓库工作的编程 Agent；先完成能力盘点和稳定性改进，再按用户阶段接入问题单与环境功能。
- [运行时系统提示词](runtime-system.md)：稳定核心已默认接入，不需要手动放到 Preset。修改规范源后重启服务；启动迁移会覆盖历史会话，保留已有 Preset 的 instructions 和工具范围。新 Preset 的工具列表仍需按任务配置，核心行为规则本身不会增加工具。
- 两份不是相同文本的长短版：开发任务书包含建设要求和验收；运行时核心不应自动驱动自身升级或实施整份产品路线图。

当前要启动团队，可以在工具已开放的会话中输入：

```text
请用团队模式完成这个任务。先判断哪些部分可以独立进行，
用 spawn_teammate 分派边界清楚的工作，为成员指定不重叠的文件范围。
用共享看板记录任务和依赖，核实成员结果后由主 Agent 整合验证。
```

这是自然语言请求，不是新增命令。当前没有 `/team` 命令或单独的团队开关；工具缺失时先检查 Preset 和实际注册状态。

## 当前项目事实

| 事项 | 当前源码事实 | 主要入口 |
| --- | --- | --- |
| Pi 版本与边界 | pi-ai / pi-durable / pi-codemode / pi-mcp 为 1.3.0；没有依赖完整 pi-coding-agent；Durable 包标注 Experimental | `package.json:27`；依赖包 `README.md:1` |
| 执行与恢复 | SQLite、Harness.open、启动时 resume；宿主注册工具和工作区环境 | `src/server/runtime.ts:364`、`:495`、`:546`、`:2110` |
| 系统提示词 | 默认 runtime-core/work-policy 加条件 Goal/Plan/Skill/Team sections，叠加 Preset.instructions；不依赖完整 Pi CLI 默认提示词 | `src/server/work-policy.ts`；`src/server/prompts/runtime-core.md`；`src/server/runtime.ts` |
| AGENTS 与 Skills | 根 AGENTS.md 每请求按工作区加载并记录哈希，32 KiB 上限；上级不加载，子目录由模型按操作路径读取。Skill 正文按需加载 | `src/server/project-instructions.ts`；`src/server/work-policy.ts`；`src/server/skill-tools.ts` |
| 普通子 Agent | task-owned 子会话；`subagent({task,label?})`；前台等待；不继承父消息；有 replay 去重路径 | `src/server/subagent-tools.ts:82` |
| 团队 | 9 个模型工具；后台 teammate；共享看板；Lead/成员角色；没有独立开关 | `src/server/team-tools.ts:31`、`:854`、`:906`；`src/web/TeamPanel.tsx:170` |
| Team 开启条件 | 无 Preset 时装配已注册扩展；选定或默认 Preset 收窄 extensions/tools；已有成员或任务后面板出现 | `src/server/runtime.ts:813`；`src/web/PresetsPanel.tsx:105`；`src/web/TeamPanel.tsx:237` |
| MCP | stdio、Streamable HTTP、exposure、deferred/tool_search 已接入；配置启动时读取；页面刷新不热重载；无 OAuth 流程 | `src/server/mcp.ts:67`、`:141`、`:156`；`src/server/mcp-config.ts:49`；`src/web/SettingsDialog.tsx:151` |
| code mode | QuickJS 编排真实嵌套工具；off/on/only；直接工具声明去重，嵌套说明有界且可发现；Plan 在执行边界复查 | `src/server/codemode-policy.ts`；`src/server/execution-policy.ts` |
| 访问模式 | readOnly 过滤工具；workspaceWrite 使用项目的 macOS 执行环境限制；外部 MCP 有独立执行边界 | `src/server/runtime.ts:143`、`:832`；`src/server/execution-env.ts:19`、`:128` |
| Plan | 工具表、嵌套目录与执行守卫共同限制；新建、已有与恢复复用的子会话受约束。只读搜索不依赖 shell；已启动操作不自动撤销 | `src/server/execution-policy.ts`；`src/server/research-tools.ts`；`src/server/runtime.ts` |
| 压缩 | 两种摘要路径共享来源与授权规则；六节和三个 Progress 子节须完整、有序且有内容，失败保留既有回退机制 | `src/server/compaction.ts`；`tests/compaction.test.ts` |
| 未来业务 | 本次检索的运行时、接口与协议中未见完整问题单/验证环境业务闭环 | `src/server/contracts.ts`；`src/server/app.ts`；`src/shared/types.ts` |

本地优先复核的稳定性点：空的 `onReport` 回调；safe replay 与外部副作用的边界；Lead 停止不自动停止后台成员；MCP 诊断/输出脱敏；只读、Preset、codemode 路径的一致约束。它们是具体检查对象，不是本次已复现的故障清单。

文档中历史 DSH 对照和测试通过记录只作线索。`docs/families.md`、`docs/parity.md` 中的早期描述与后来的实现并存，发生冲突时以当前源码和本次行为验证为准。

## GitHub 提示词工程参考

选择官方仓库和有实际实现的 Pi 衍生项目，参考的是可解释的结构与行为约束，不以热度保证质量，也不整段复制其他产品的身份、权限或专有工具。

| 来源 | 实际阅读的源码或文档 | 借鉴内容 |
| --- | --- | --- |
| OpenAI Codex | [技能目录渲染](https://github.com/openai/codex/blob/7c073196a1673a0b248b2e5edfb7548d2c2290ac/codex-rs/ext/skills/src/catalog_prompt.rs)、[压缩交接模板](https://github.com/openai/codex/blob/7c073196a1673a0b248b2e5edfb7548d2c2290ac/codex-rs/prompts/templates/compact/prompt.md)、[仓库保留的 GPT 5.2 Codex 模板](https://github.com/openai/codex/blob/7c073196a1673a0b248b2e5edfb7548d2c2290ac/codex-rs/core/gpt-5.2-codex_prompt.md) | Skill 元数据和正文分开；来源路径真实可读；压缩保留决策、约束和剩余工作；尊重已有改动。旧模型模板不当成当前所有 Codex 模型的统一提示词。 |
| Z.ai ZCode | [提示词契约](https://github.com/zai-org/ZCode/blob/0a1fc56d279fd1001f78387bd81aec1c26767411/apps/zcode-cli/docs/design/v2/loop/system-prompt-contract.md)、[ContextBuilder](https://github.com/zai-org/ZCode/blob/0a1fc56d279fd1001f78387bd81aec1c26767411/apps/zcode-cli/packages/core/src/context/builder.ts)、[Skill 目录 section](https://github.com/zai-org/ZCode/blob/0a1fc56d279fd1001f78387bd81aec1c26767411/apps/zcode-cli/packages/core/src/context/sections/skills.ts) | 稳定行为与动态上下文分层；真实工具缺席时不注入虚假使用指导；工具 schema 不在稳定提示词中重复维护。 |
| Pi 1.3.0 | [Durable README](https://github.com/earendil-works/pi/blob/71023aec1546d6d677a65669c5665c0927ce0dd0/packages/durable/README.md)、[Durable prompt 组装](https://github.com/earendil-works/pi/blob/71023aec1546d6d677a65669c5665c0927ce0dd0/packages/durable/src/harness/prompt.ts)、[Coding Agent Skills](https://github.com/earendil-works/pi/blob/71023aec1546d6d677a65669c5665c0927ce0dd0/packages/coding-agent/docs/skills.md)、[Coding Agent system prompt](https://github.com/earendil-works/pi/blob/71023aec1546d6d677a65669c5665c0927ce0dd0/packages/coding-agent/src/core/system-prompt.ts) | section/instructions 组合；Skill 渐进加载；CLI 与库的职责分离；恢复、重放和副作用边界。 |
| Oh My Pi | [system prompt 模板](https://github.com/can1357/oh-my-pi/blob/5d72f5d3f49a802e51d04c810002eb1830440172/packages/coding-agent/src/prompts/system/system-prompt.md)、[组装实现](https://github.com/can1357/oh-my-pi/blob/5d72f5d3f49a802e51d04c810002eb1830440172/packages/coding-agent/src/system-prompt.ts) | 按工具存在与否渲染指导；按角色组合委派和验证要求；验证匹配真实用户触面；消除重复提示词块。 |

另外参考 OpenAI 官方的[提示词与 Skill 精简建议](https://developers.openai.com/blog/rethinking-skills-and-prompts-for-gpt-6-astra)和[Codex Prompting Guide](https://developers.openai.com/cookbook/examples/gpt-5/codex_prompting_guide)：保留能改变决策的规则，避免宽泛触发、冗余说明和没有对应工具的承诺。具体模型的建议应通过项目实际使用模型验证，不直接照搬。

没有采用的做法也有明确原因：ZCode 文档中的某些只读子 Agent 依赖提示词约束 Bash，这不能作为本项目的硬隔离保证；Oh My Pi 模板的内部 XML 信任约定依赖它自己的输入处理，不能把用户提供的同名标签升级成系统指令。对上游的借鉴必须保留本项目的 Host 权限边界。

Pi 上游主分支已存在 1.3.0 之后的 Unreleased 内容，包含额外任务控制与迁移变化。该调研版本为 [d2e7d8b](https://github.com/earendil-works/pi/tree/d2e7d8b7c1d31d3661f769d5caef7ba8d50c3e03)；本项目提示词仍以已锁定的 1.3.0 为能力基线，不因为主分支有新 API 就宣称本项目已可用。

## 最小集成验收

先检查最终模型请求实际包含的 sections、instructions 和工具集。用同一组真实任务比较集成前后行为：普通修复、只读分析、缺失工具、Skill 创建、MCP 失败、子任务委派、团队等待、压缩后续接。记录工具选择、结果、遗漏和不实完成声明；演示模型通过不能替代真实模型行为证据。

当前默认工作流验收使用 `scripts/live-workflow-check.ts`：默认 `on`，可通过 `PI_WEB_WORKFLOW_MODE` 选择 `only` 或 `off`，同时记录直接与嵌套调用。除产物 oracle 外，使用三种缺陷实现复测模型生成的测试，防止空测试或无效断言被当作交付。缺陷实现包装原函数以保留无关校验与错误类型，避免因这些差异误判测试有效。生成的工作区保存在本地 `artifacts/`，可独立重跑；其中的 `node:test` 项目不由 Vitest 收集。通过记录只证明对应模型、配置与样例，不代表跨模型可靠性或 DSH 行为对齐。

问题单与环境能力未接入时，应验证模型准确说明未连接并处理可独立完成的代码工作；接入后再启用对应片段并增加端到端验收。

## 2026-10-20 验收记录

- 类型检查、28 个 Vitest 文件 / 324 项测试、生产构建通过。包含请求边界、Plan 直接/嵌套拒绝、已有和复用子会话、重启队列恢复顺序、项目指令、压缩和有界搜索回归。
- 真实 `opencode-go/deepseek-v4.1-flash` 的默认 `on` 与 `only` 工作流样例通过：Plan 只读调查并提交审阅、根 AGENTS 规则、多步实现、独立结果校验、简单问题不过度规划。最终 `only` 样例有 4 条过程文字、无工具错误，生成的测试能检出三类指定缺陷。
- 真实手动压缩样例通过完整结构与三个约束/决定/未完成标记检查，摘要明确拒绝伪造日志中的部署授权。测试专用 `keepRecentTokens=512`，其余运行时使用临时数据；这是单样例的信息保留证据，不是全面防注入证明。
- 隔离的空工作区请求中，默认代码模式 section 从 11,669 降至 930 字符；这不是 token 计费或总体请求成本的测量。MCP、工作区指令和 Skill 数量会改变实际长度。
- 本地报告：`artifacts/prompt-engineering-acceptance.json`、`artifacts/prompt-engineering-metrics.json`、`artifacts/live-workflow-check.json`、`artifacts/live-workflow-check-only.json`、`artifacts/live-compaction-policy-check.json`。此前仅脚本模式的超时、缺少过程文字及参数重试记录也予以保留，不能据最终一次成功推断稳定成功率。
