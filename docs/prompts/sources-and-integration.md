# 提示词源码依据与集成说明

项目增强提示词用于驱动后续开发；运行时核心已收敛到 `src/server/prompts/runtime-core.md` 并由默认 `runtime-policy` 扩展实际注入。Todo/Goal 的动态策略根据当前模式和可调用工具生成。Skill 创建器、文件服务、四个 skill_* 工具、动态目录与设置页也已接入。问题单与验证环境管理片段仍是待建设模板，没有作为现有能力注入模型。

核对日期为 2026-10-19，依据当前工作树及公开源码。工作树已有其他未提交改动，下面的本地行号可能随并行开发移动。初稿进行了静态核查与文档审阅；后续 Skill 集成的实际验证状态以 README 和 docs/spec.md 为准。完整提示词效果仍需通过文档中要求的行为场景验证。

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
| AGENTS 与 Skills | Skill 目录、按需加载、保存/校验与内置创建器已接入；AGENTS.md 自动加载未接入 | `src/server/skills.ts`；`src/server/skill-tools.ts`；`skills/skill-creator/SKILL.md` |
| 普通子 Agent | task-owned 子会话；`subagent({task,label?})`；前台等待；不继承父消息；有 replay 去重路径 | `src/server/subagent-tools.ts:82` |
| 团队 | 9 个模型工具；后台 teammate；共享看板；Lead/成员角色；没有独立开关 | `src/server/team-tools.ts:31`、`:854`、`:906`；`src/web/TeamPanel.tsx:170` |
| Team 开启条件 | 无 Preset 时装配已注册扩展；选定或默认 Preset 收窄 extensions/tools；已有成员或任务后面板出现 | `src/server/runtime.ts:813`；`src/web/PresetsPanel.tsx:105`；`src/web/TeamPanel.tsx:237` |
| MCP | stdio、Streamable HTTP、exposure、deferred/tool_search 已接入；配置启动时读取；页面刷新不热重载；无 OAuth 流程 | `src/server/mcp.ts:67`、`:141`、`:156`；`src/server/mcp-config.ts:49`；`src/web/SettingsDialog.tsx:151` |
| code mode | QuickJS 编排真实嵌套工具；off/on/only；权限与最终工具集仍由会话配置决定 | `src/server/runtime.ts:494`、`:813` |
| 访问模式 | readOnly 过滤工具；workspaceWrite 使用项目的 macOS 执行环境限制；外部 MCP 有独立执行边界 | `src/server/runtime.ts:143`、`:832`；`src/server/execution-env.ts:19`、`:128` |
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

问题单与环境能力未接入时，应验证模型准确说明未连接并处理可独立完成的代码工作；接入后再启用对应片段并增加端到端验收。
