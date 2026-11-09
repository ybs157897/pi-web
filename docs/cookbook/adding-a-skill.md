# 加一个技能（Skill）

技能是一个 `SKILL.md` 指令包（可带附属资源），模型经 `skill_list` 发现、`skill_load` 读入；本篇讲新增内置 / 工作区 / 全局技能的放置选择与验证。

前置条件：先读 [architecture.md](../architecture.md) 的「Skills」小节；插件提供的技能来源见 [subsystems/plugins.md](../subsystems/plugins.md)。

## 步骤

1. 选放置层：内置 `skills/`（随产品分发，只读）、工作区 `.agents/skills/`（可写，`skill_save` 的唯一写入目标；`.pi-web/skills/` 同层但优先于 `.agents`）、全局 `~/.pi-web/skills` 与跨智能体共享的 `~/.agents/skills`（只读）。同名遮蔽按发现序：builtin → global → user-agents → 各工作区层 `.pi-web` → `.agents`（深层先于浅层）→ 插件；目录里各副本都保留，裸名加载发现序第一个，被遮蔽副本用 `source:name` 限定 id 仍可直达（[store.ts](../../src/server/skills/store.ts) 的 `roots()` 与 `resolveSkill()`）。
2. 会话内创建优先用内置技能创建器：让模型加载 `builtin:skill-creator`（[skills/skill-creator/SKILL.md](../../skills/skill-creator/SKILL.md)），由它走 `skill_list` / `skill_load` / `skill_save` / `skill_validate` 工作流写入工作区——它不能写全局或内置来源。
3. 手写内置技能：建 `skills/<name>/SKILL.md`，frontmatter 必填 `name`（小写 kebab-case，与目录名一致，目录名是查找键）与 `description`（≤1024 字符，写给模型的路由依据），可选 `when_to_use`；正文是给模型读的指令，附属资源放同目录并用相对路径引用（链接越界会在校验报错）：

```yaml
---
name: deploy-checklist
description: Run the pre-deploy verification checklist for this service and report each gate's evidence. Skip for local-only changes.
---
```

4. 体积与格式边界（[store.ts](../../src/server/skills/store.ts) 顶部常量）：`SKILL.md` ≤64KB、frontmatter ≤16KB、目录条目 / 资源数 / 深度有上限；缺 frontmatter 仍可加载（无描述可匹配），frontmatter 缺 `name` / `description` 则整个技能被丢弃，kebab-case 不符或与目录名不一致只是警告。
5. 热重载：目录在每次 list / load 时重扫磁盘，`skills-policy` section 每请求重列（[skill.ts](../../src/server/tools/skill.ts) 的 `renderSkillSection`）——改 `SKILL.md` 下一请求即生效，无需重启；设置页「技能」同步可见。
6. 校验：`skill_validate` 工具（或 `runtime.validateSkill`）检查格式、资源与正文里的本地 Markdown 链接；内置技能若承载路由行为，配套回归测试参照 [tests/statechart-skill.test.ts](../../tests/statechart-skill.test.ts)。

## 验证

1. `npx vitest run tests/skills.test.ts tests/skill-tools.test.ts tests/skills-runtime.test.ts` 通过——发现序与遮蔽、保存 / 版本冲突、会话内技能工具全链路。
2. 判据：会话里 `skill_list` 出现新技能（`builtin:<name>` 或 `agents:<name>`），`skill_load` 读回正文；修改 `SKILL.md` 后下一请求目录更新，无需重启。
3. 判据：`skill_validate` 返回 `valid: true`，或 warnings 均可解释（如目录名与 frontmatter 不一致）。
4. 真实模型验收（前提：本机已配置 DeepSeek 凭据且默认模型为 deepseek，脚本会先断言）：`npm run test:live:skills`。

设计理由：内置技能创建器与目录 / 加载 / 保存 / 校验、设置页可查看的决策见 [spec.md 2026-10-19 段](../spec.md)；内置技能走短描述路由、不在常驻提示词硬编码场景见 [spec.md 2026-11-03 段](../spec.md) 与 [2026-11-04 段](../spec.md)。
