# 加一个提示词 section

新增一个按请求能力动态注入的提示词块（section），并保持生成目录与提示词快照同步。

前置条件：先读 [prompts/runtime-system.md](../prompts/runtime-system.md)（section 清单与注入条件的规范索引）与生成的 [section-catalog.md](../section-catalog.md)。

## 步骤

1. 用 `section()` 工厂定义：在所属扩展里 `const mySection = section('my-policy', async (input, context) => { … })`，render 返回字符串或 `undefined`（本请求不注入），写法参照 [work-policy.ts:116](../../src/server/conversation/work-policy.ts#L116) 起的 `runtimeCoreSection` / `projectInstructionsSection` / `workPolicySection` 与 [skill.ts](../../src/server/tools/skill.ts) 的 `renderSkillSection`。
2. 挂到扩展的 `sections` 数组，扩展经 `registry.install` 进 [src/server/runtime/index.ts](../../src/server/runtime/index.ts)；安装序决定 section 在请求里的相对顺序。
3. render 按当前能力动态渲染，不写死工具名：用 [tool-routing.ts](../../src/server/conversation/tool-routing.ts) 的 `resolveToolRoute` 把工具解析为 `direct` / `codemode` / `unavailable` 再决定文案——plan、readonly、子智能体变体的工具集各不相同，写死名字会让快照在其他变体失真。
4. 可变规则不进 runtime-core：runtime-core 是每个请求无条件注入的稳定核心（[runtime-core.md](../../src/server/conversation/prompts/runtime-core.md)），长度 ≤3300 字符由 [tests/prompt-snapshot.test.ts:152](../../tests/prompt-snapshot.test.ts#L152) 把守；会话事实、工具相关或条件触发的条款放进本节这样的条件 section。
5. 补目录映射：在 [gen-section-catalog.ts](../../scripts/gen-section-catalog.ts) 的 `SECTION_SOURCES`（key → 定义文件，[gen-section-catalog.ts:41](../../scripts/gen-section-catalog.ts#L41)）与 `SECTION_NOTES`（一行注入条件）各加一条——守卫要求 runtime 真实注入的每个 key 两者齐备，缺一即生成失败。
6. 刷新快照：`npx vitest run tests/prompt-snapshot.test.ts -u`，逐份 `git diff` 审阅——新 section 只应在满足注入条件的变体出现，每个变体头部的 `sections (… chars)` 行同步变化。
7. 重新生成目录并全量验证：`npm run gen:docs`，然后 `npm run check`。

## 验证

1. `npx tsx scripts/gen-section-catalog.ts --check` 通过——新 key 已进 `SECTION_SOURCES` 与 `SECTION_NOTES`。
2. `npx vitest run tests/prompt-snapshot.test.ts` 通过；`git diff tests/__snapshots__/prompt/` 中新 section 的出现 / 缺席与声明的注入条件一致。
3. 若改了 runtime-core 正文：[tests/prompt-snapshot.test.ts:152](../../tests/prompt-snapshot.test.ts#L152) 的 ≤3300 断言仍为绿。
4. `npm run check` 通过。

设计理由：runtime-core 瘦身（4,202 → 2,758 字符）与七份快照成为改动评审门见 [spec.md 2026-10-28 段](../spec.md)；条款按当前能力路由、去重与计划 / 只读收窄见 [spec.md 2026-11-04 段](../spec.md)。
