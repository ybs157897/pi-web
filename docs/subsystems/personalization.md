# 个性化指令（Personalization）

设置 → 个性化 里的自定义指令：一个用户级 Markdown 文件，按请求注入系统提示词。它是偏好，不是权限——不改变工具面、访问模式或任何授权判断。

## 存储

- 位置：`<dataDir>/AGENTS.md`，默认即 `~/.pi-web/AGENTS.md`（数据目录由 `PI_WEB_DATA_DIR` / `PI_WEB_HOME` 决定，见 [home.ts](../../src/server/state/home.ts)）。设置页只做编辑器；直接改文件等效。
- 上限：100 KiB（`MAX_PERSONALIZATION_BYTES`，[personalization.ts](../../src/server/state/personalization.ts)）。保存超限返回 `INVALID_INPUT`；文件被手工改到超限时，读取只取前 100 KiB 并在提示词里注明截断。截断边界上的残缺多字节字符被丢弃，其余非法 UTF-8 使整份文件报错而不是静默替换。
- 写入：临时文件 + rename 原子替换，mode `0600`；空内容写空文件，等价于未设置。`\0` 被拒绝。
- 语义：不存在或空白 → 该 section 完全不注入，未配置用户的提示词逐字节不变。

## 注入

`personal-instructions` section 由 `runtime-policy` 扩展贡献（[work-policy.ts](../../src/server/conversation/work-policy.ts)），顺序在 `runtime-core` 之后、`project-instructions` 之前：

- 每次请求重读文件，保存后对**下一个请求**生效，同一会话无需新建（与 ZCode 的「新会话生效」不同，这里更热）。
- 正文包在 `<personal_instructions>` 里，内部字面闭合标签被转义；块首行声明「项目指令与显式任务指令冲突时优先」。
- Explore 子智能体不注入，与项目指令同一理由：只读检索会话保持精简。
- 注入条件与来源登记在生成目录 [section-catalog](../section-catalog.md)。

## 接口与界面

- `Runtime.personalization()` / `savePersonalization(content)`（[contracts.ts](../../src/server/contracts.ts)），HTTP 为 `GET /api/personalization` 与 `PUT /api/personalization`（严格单字段 `{ content }`）。
- 设置面板 [PersonalizationPanel.tsx](../../src/web/PersonalizationPanel.tsx)：挂载时读取，实时按 UTF-8 字节计数，超限时标红并禁用保存，保存成功显示「已保存，后续请求生效」。

## 验收

- `npx vitest run tests/personalization.test.ts`：读写、上限、截断、非法 UTF-8、闭合标签转义、原子写。
- `npx vitest run tests/work-policy.test.ts`：注入顺序、空文件静默、Explore 排除。
- 真实模型：设置里写「回答第一行必须是 `MARKER`」，任意会话发一句话观察首行；改标记再发一句，同一会话应换成新标记。
