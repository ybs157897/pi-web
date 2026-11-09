# UI 打磨审计 · 2026-11-04

> 历史快照（2026-11-09 冻结）：已完结批次的点时文档，不是现状权威。现状参考见 [docs/subsystems/](../subsystems/README.md) 或 [docs/spec.md](../spec.md)。

对 pi-web 当前 UI 做的第一轮诊断评审（三区布局 / AI 输出渲染 / 任务 / 文件）。
方法：CDP 无头 Chrome 采集 12 个场景截图（`artifacts/ui-audit/`）+ 每场景几何断言 + CSS token 逃逸 grep + 人工/VLM rubric 评审。
采集脚本：`artifacts/ui-audit/capture.mjs`、`capture2.mjs`（一次性工具，非正式测试设施）。

## 证据索引

| 场景 | 文件 |
|---|---|
| 默认会话 5556（表格/子智能体条/Git 工具右区） | `light-home.png` `dark-conv-rich.png` |
| 右区子智能体只读 tab | `light-subagent-pane.png` |
| WeTrack 问题清单 / 自动化任务 | `light-wetrack.png` `light-automations.png` |
| 模型设置页 | `light-model-settings.png` |
| 390px 窄屏会话 | `narrow-conv.png`（右区关闭）/ `narrow-conv-rich.png`（右区全屏接管） |
| 2× 细节裁切 | `detail-table` `detail-toolrows` `detail-composer` `detail-sidebar` `detail-wetrack-banner` |

## P1 · 明显破损或不一致

### 1. ~~暗色模式：右侧子智能体提示卡片不翻转~~ → **未复现，撤回**
首轮截图（`dark-conv-rich.png` / `dark-home.png`）里右区提示卡呈浅色底。复核结论：
- token 链路本来就是对的：`.userBubble` → `--dsw-specific-bubble`，暗色区有映射（`design-platform.css:386` → bluish-850）。
- 两次独立复现（亮色下打开 pane → 切暗色，不重点击）计算样式与截图均为暗色 `rgb(44,44,46)`（见 `repro-dark-A/B.png`）。
- 原截图判定为 **headless 合成帧伪影**（切主题瞬间的陈旧图层）。
处置：不改代码。建议在真实浏览器里人工切一次暗色确认；若真实浏览器可复现再按 token 链路排查。

### 2. Markdown 表格横向溢出无感知，末列文字被硬切
`detail-table.png`：末列 "root/repository/ref"、"package-runtim" 在右缘被垂直切断，行内再折行；明暗一致。
现状：容器有横向滚动 + 12px 内阴影渐隐（`message-rendering/MarkdownTable.module.css:20-21`），但渐隐叠在正文文字上不可感知，滚动条不常显。
建议（任选组合）：滚动条常显（`scrollbar-gutter` + auto-hide 关闭）；右缘渐隐加强并遮住被切字形；表头尾列加「→ 可横向滚动」微提示。几何断言已证明这不是页面级溢出，纯组件内问题。

### 3. Token 逃逸清单（代码层，可直接当修复任务）
- 硬编码颜色：44 处 hex + 8 处 rgb/rgba（`grep -rEn "#[0-9a-fA-F]{3,8}|rgba?\(" src/web --include='*.module.css'`）。
  - ~~`Inspector.module.css:670` / `BrowserPane.module.css:109` 的 `background:#fff`~~ → **核实后为 iframe 内容画布**（HTML/PDF 预览、浏览器页面），白色是语义正确的，撤回。
  - ~~`SubagentRunStrip --sa-1..4` 色板~~ → **核实为有意的身份色板**（文件头注明「Colors identify children, never state」，明暗两套各自调过），撤收口建议。
- 裸 `font-size`：**194 处 / 31 个文件**。头部：QuestionComposer 26、TrajectoryPane 18、Inspector 18、StatusPanel 12、ToolCard/TeamPanel/App 各 11。
- 说明：UI chrome 用固定 px 未必错，但内容区字号应统一走 `--dsh-content-font-size` 系；建议按文件分批收口，先改 QuestionComposer/Inspector/TrajectoryPane 三个重灾区。

## P2 · 交互与排版品质

### 4. 窄屏下行内代码 chip 与中文标点断行粗糙
`narrow-conv.png`：行首出现「、」；`（TS 481）` 类 chip 与全角括号间距不均、断行零碎。
建议：正文容器加 `line-break: strict`（禁标点悬挂行首）；chip 的 margin 规范化为 token 间距；`code` 不参与行首。

### 5. ~~子智能体 chip 三色表达同一状态~~ → **误报，撤回**
源码（`SubagentRunStrip.module.css:1-3`）明示设计契约：**色相 = 子智能体身份，状态由符号承载**（勾=完成、旋转=运行、叉=失败）。并行委托多个 agent 时色相正是用来区分"谁是谁"的，容器查询还有逐级降级。评审时把身份编码误读成了状态编码。

### 6. 模型设置页布局失衡
`light-model-settings.png`：内容卡 ~725px 左锚定，右侧 400px 空白；provider 详情列里模型条目拥挤（模型名 "DeepSe…" 即截断，而卡片外仍有大量宽度没用）。
建议：整卡 `max-width` + 居中（或栅格利用右侧空间）；模型行给名称更多宽度、能力 chips 收紧。

### 7. 390px + 右区 tab 打开 = 全屏接管，返回路径弱
`narrow-conv-rich.png`：右区全屏覆盖会话，仅右上角小 ✕ 可退出；无返回手势/明确返回钮。
建议：移动宽度下 pane 顶栏加「‹ 返回会话」文字按钮；或首次全屏时浮层提示。

## P3 · 细节打磨

8. 表头文字对比度偏低（`detail-table`，40% 透明度灰 on white ≈ 2.5:1）→ **已修**：`.scroll th` muted→subtle（60%）。
9. 工具行「执行失败」标签太弱 → **已修**：行尾位置是 ZCode 对齐的有意设计（注释明示），但颜色从 `--message-muted` 升为 `--message-danger`；「已停止」维持中性 muted。
10. Composer 占位文案半角逗号混排 → **已修**：中文统一全角（`，/ 调用指令、@ 文件、$ 技能`），英文不动。
11. ~~`App.module.css:221` 一处 `gap: 15px`~~ → **保留**：DSH trailing action strip 原样照抄（hover 才出现的行尾操作条），改了会漂移。
12. ~~侧栏时间戳挤压~~ → **撤回**：ZCode 对齐的刻意设计（44px 截断 + hover 时时间与操作条换位防抖动）。

## 正面确认（回归基线要锁住的形态）

- 明暗主题整体一致性很好：表格、工具行、侧栏、右区 Git 工具、composer 全部正确翻转（除 P1-1 一处）。
- 桌面 1440：零横向滚动、零越界元素、composer 钉底正确；390 宽无页面级横滚。
- 工具行单行折叠 + 省略号、子智能体条、滚到底浮动按钮、底部状态栏（2 轮 67 步 / 829K tok · 缓存命中 91%）形态干净。
- 空状态（自动化任务 / WeTrack 无数据）品质好，模式统一。

## 未覆盖场景（下一轮补）

- 流式运行中状态（thinking 指示器、工具行逐帧展开、问答卡、计划确认）——需真实模型跑一轮采样，走既有 ego 仪式。
- 右区文件预览 / 轨迹 / 浏览器预览 tab（本轮只开到 Git 工具与子智能体）。
- 模型选择弹层、设置对话框（SettingsDialog）。

## 建议的落地顺序

1. ~~P1-1 主题别名修复~~ → 复核后撤回（见 P1-1）。
2. P1-2 表格右缘 → **已修**：边缘条从弱阴影改为卡片底色渐隐遮罩（36px，`--message-card` 渐变），切断字形被淡出而非硬切。
3. ~~P1-3 `#fff` 风险点 + 色板收口~~ → 复核后撤回（见 P3-3 修正）。
4. P2-4 CJK 断行 → **已修**：`.markdown` / `.fallback` 加 `line-break: strict`。
5. ~~P2-5 chip 语义~~ → 复核后撤回（身份色板是有意设计）。
6. P2-6 模型设置页 → **已修**：`.models` 在 1120 居中列内自身居中（`margin-inline:auto`），max-width 720→860，双栏详情宽度 +140px。
7. P2-7 窄屏返回路径 → **已修（CSS 方案）**：≤760px 时 pane 关闭钮给可见命中面（34px + 边框 + token 底色），替代原计划的文字返回钮。
8. P3-8/9/10 → **已修**（表头 subtle、失败 danger 色、占位全角标点）；P3-11 保留（DSH 原样）、P3-12 撤回（ZCode 对齐设计）。

每项改完跑 `node artifacts/ui-audit/capture.mjs capture` 对比同场景截图；后续把该管线固化为回归基线（pixelmatch diff + 场景清单进 `scripts/`）。
