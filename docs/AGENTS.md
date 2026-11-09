# AGENTS.md — 文档标准（宪法）

本文件定义本仓库文档的层级分类、写作规则与字数预算，由 `npm run doc:check` 的各验证脚本执法。体例参照 DeepSeek Harness 的文档体系移植，单语裁剪（见「单语条款」）。

## 层级分类：一个事实只有一个家

每条规则、每个机制、每段历史都有唯一归属层；其他地方链接过去，不复述。

| 层 | 职责 | 不属于它的东西 |
|---|---|---|
| 根 `AGENTS.md` | 常驻指令：每个会话都需要在上下文里的规则，每条 1–3 行并链接归属地 | 长篇解释、操作步骤、可从链接读到的内容 |
| `docs/architecture.md` | 有序现状地图：组成、请求循环、接缝、扩展点；改 `src/` 前先读 | 类型定义（→ subsystems）、单主题细节（→ subsystems）、决策理由（→ spec） |
| `docs/subsystems/` | 每个主题一页的现状参考：类型、语义、行为、边界 | 行为叙事（→ architecture）、决策过程（→ spec）、实施史（→ history） |
| `docs/spec.md` | 决策记录（编年）：定了 / 判据 / 未决，带日期回注；**历史权威，不是现状权威** | 机制现状描述（→ subsystems）、操作步骤（→ cookbook） |
| `docs/postmortem/` | 编号事故复盘（`0001-` 递增）：已逃逸的缺陷为什么放行 | 未上线的取舍（→ spec）、评审规则（→ defensive-patterns） |
| `docs/defensive-patterns/` | 评审时强制执行的规则，按改动对象分页 | 类型定义与语义（→ subsystems）、一次性教训（→ postmortem） |
| `docs/cookbook/` | 带编号验证步骤的操作指南 | 设计理由（→ 链接到的 spec 日期段） |
| `docs/parity.md` | 对照层（本仓库专有）：与 DSH / ZCode 的逐项对照、有意差异清单 | 与参照仓无关的机制描述（→ subsystems） |
| 生成目录 `docs/tool-catalog.md`、`docs/section-catalog.md` | 从代码生成的穷举参考，`gen:docs` 再生、`verify:docs` 校验新鲜度 | 任何手写内容（手改会被门拒绝） |
| `docs/prompts/runtime-system.md` | 提示词体系配套：section 清单与注入条件；规范源是代码文件，本文不留副本正文 | runtime-core 正文（→ `src/server/conversation/prompts/runtime-core.md`） |
| `docs/history/` | 冻结的点时文档（已实施完毕的计划、审计、评审记录）；永不改写 | 任何仍在演进的规则或现状 |
| `.agents/notes/` | 跨批次决策记录：proposed / implemented / rejected / archived 四态 × 六分类；spec.md 之外的补充决策通道 | spec.md 已记录的决策（不双写） |
| 根 `README.md` | 产品入口：安装、使用、能力边界 | 贡献者流程（→ cookbook）、架构（→ architecture） |

归位口诀：逃逸的 bug → postmortem；决策理由 → spec 当日段（或 note）；操作步骤 → cookbook；类型与机制现状 → subsystems；常驻指令 → 根 AGENTS.md；与参照仓的对照 → parity；已完结的点时文档 → history。

## 写作规则

- **只写现状。** 机制描述用现在时命名它今天的行为；变更过程、迁移路径、上线记录留给 commits、spec、postmortem 和 history。正文不说「最近改成」「以前是」，需要历史时链接归属地。
- **一段一行。** 每个段落是一物理行，用编辑器软折行（`verify-md-wrap` 执法）；代码块、表格、列表结构保持自身格式。
- **spec.md 体例**：每条决策「定了 / 判据 / 未决」三段式；文件挪位或语义反转不改写历史，在原条目追加带日期回注（如「（2026-11-03 注：现位于 …）」）——这是本仓库已有惯例的成文化。
- **引用代码用 Markdown 相对链接**，仓库相对路径，与运行时提示词的引用规范一致（如 [index.ts:180](../src/server/runtime/index.ts#L180)）；验证脚本检查链接目标存在性。
- **fenced 代码块必须真实**：贴类型声明要能对上源码；贴命令要真的能跑。禁止从记忆里凭空写 API。
- **语言**：见下方单语条款。

## 单语条款

本仓库文档统一中文；代码标识符、工具名、路径、命令保持英文原文，不翻译、不音译。不维护 `.zh.md` / `.i18n.yaml` 配对——若将来需要双语，在 spec.md 记决策后再引入配对机制，不提前建设。

## 字数预算

`scripts/doc-budgets.manifest.json` 为常驻文档设上限；`verify-doc-budgets` 拒绝超限、缺失或多余的清单条目。计数单位是「汉字数 + 非 CJK 词数」（中文无空格分词，纯词数计数失效）。

门变红时按顺序处理：

1. **搬走**：内容属于别的层 → 移到归属层，留一行链接。
2. **压缩**：内容属于本层但可以更短 → 压缩。
3. **提额**：内容确实需要空间 → 在 PR 里说明理由后提高 manifest 上限；上限是护栏不是缩减目标。

棘轮只收紧：低于上限时保留至少 5% 余量；上调后文档未回到目标以下前冻结该上限。初始预算刻意宽松（现量 + 余量），后续只降不升（除非说明理由）。

## 生成目录规则

`docs/tool-catalog.md` 与 `docs/section-catalog.md` 由 `npm run gen:docs` 从真实 runtime 生成，头部带 `<!-- Generated ... do not edit -->` 标记：

- 改工具描述 / section 文案后必须重跑 `gen:docs`，否则 `verify:docs` 报 first-diff 行号。
- 新增工具没有进目录时，完整性守卫直接失败——一个工具不能悄悄没有文档。
- 目录覆盖内置工具面；MCP 动态工具与插件提供的工具不在其内，边界声明写在目录头部。
