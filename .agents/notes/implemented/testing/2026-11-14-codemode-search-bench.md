# Agent Note: codemode 搜索效率实测

Status: implemented

## Decision

`codemodeMode` 默认保持 `on`；不把工具面收成只暴露 `codemode`（`only`）作为搜索类任务的默认形态。搜索手册 Skill 只作为 `only` 模式下的可靠性补丁，不作为省 token 的手段。

判据来自 [`scripts/live-codemode-search-bench.ts`](../../../../scripts/live-codemode-search-bench.ts) 的三组真机实测（GLM-5.3，每题每组一次，六道本仓库搜索任务）：

| 组 | 正确 | prompt tokens | 工具调用 |
|---|---|---|---|
| `on` | 6/6 | 405,358 | 41 |
| `only` | **5/6** | **205,515** | 18 |
| `only-skill` | 6/6 | 376,242 | 33 |

同口径去掉 `only` 答错那题：`on` 381k / `only` 192k（−50%）/ `only-skill` 263k（−31%）。

三条结论：

1. **收益正比于单次任务要碰的文件数。** `cross-file-trace` 要读 4 个文件，`only` 是 1 次脚本调用、15.1k prompt，`on` 是 15 次调用、147.9k，降 90%。「一个文件就够」的 `large-file-window` 只降 9%。
2. **`only` 会静默失败。** `multi-keyword` 在 `only` 下只花 860 token、2 次调用就结束，最终答案为空——模型把任务转给 `subagent` 后没回填结果，撞上 [subagent.ts:147](../../../../src/server/tools/subagent.ts#L147) 那条 `readRoute === 'codemode'` 边界。1/6 失败率配 50% 省量不划算。
3. **手册补可靠性，不省 token。** 手册生效后 `only-skill` 6/6，失败消失；但六题里只有两题变便宜（`concept-search` −15%、`large-file-window` −3%），其余更贵，`multi-keyword` +733%。手册教的「行窗口切片」「多关键词扇出」是正确习惯，模型执行得更彻底，小题上就是净成本。

## Consequences

- 设置页的代码模式三态保留现状语义：`on` 面向日常交互，`only` 面向大仓跨文件追踪与批量 triage，且要求模型较强。
- 若要再推 `only`，需先解决 `only` 下模型把任务转给子 agent 后不回填的问题；该缺陷由本实验首次在真实模型下暴露。
- 手册 Skill 若要落地，定位写成「可靠性约束」而非「效率优化」，否则会被 token 数据打脸。
- 复跑命令：`npm run test:live:search-bench -- --model=<preset>`。脚本自带隔离：`dataDir`/`piDir` 全在临时目录，`PI_WEB_HOME` 一并指向该目录——`SkillStore` 的全局根取 `piWebHome()` 而不是 `dataDir`（[index.ts:129](../../../../src/server/runtime/index.ts#L129)），不设这个环境变量手册会被静默忽略，`only-skill` 组退化为 `only` 加一次无效查找。脚本因此在开跑前用 `runtime.skills()` 断言手册已进入目录。
- 模型预设目前有 `cmdc`（commandcode deepseek，本地 3050 代理）、`zai`（GLM-5.3）、`zai-flash`。首次执行时 commandcode key 上游返回 401、opencode-go 的 DeepSeek 月配额耗尽，实际数据来自 `zai`。

## Risks

- **每股只跑一次，样本小**：单题波动可能大于组间差异。本 note 的结论按总量与机制归因给出，逐题数字只作印证。
- **缓存口径**：`input` 是扣除 `cacheRead` 后的净输入，同一任务两次运行会因缓存命中出现 `219` 与 `10523` 的差距。比较必须用 `input + cacheRead`，脚本已单列 `totalPromptTokens`。
- **换模型可能改变结论**：GLM-5.3 的脚本编写能力与三方模型不同，`only` 的失败率未必可移植。
