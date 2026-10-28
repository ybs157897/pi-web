# AI 输出展示对齐 ZCode

## 目标与边界

用户要求的是完整 AI 输出体验：回答正文、思考、命令和工具过程的展示与交互。此前只换 Markdown 引擎、给 DSH 组件套样式，不能算对齐。本轮以本地 ZCode 3.16.2（`3c5b2276`）源码及运行中的 3.16.3 桌面应用为参考，重新实施并逐项验收。

修改展示层及必要的展示投影。模型调用、工具执行、权限、会话生命周期、问题答复、文件打开、子代理导航保持由原宿主负责。不得猜测未记录的思考耗时或执行结果。字号和工作步骤展示的用户设置继续有效；几何对照必须在同字号、同主题、同内容宽度下进行。

## 本轮发现的具体偏差

1. `AnswerMarkdown` 仍直接使用 DSH `CodeBlock`。其内部 `code` 元素还会命中外层行内代码样式，造成字号、背景、padding 串扰。语言图标、GitHub 高亮主题、默认不换行、流式期间不高亮等没有落实。
2. `ProcessTerminal` 通过 `div:nth-child(2)` 操作第三方组件内部 DOM，命令展开按钮放在输出之后；不是 ZCode 的命令区、输出区独立滚动结构。
3. 标题按比例缩放，粗体为 600、列表间距为 16px，均与参考不同。表格强制占满、统一不换行，缺少自然宽度、边缘提示和大表滚动操作。
4. 工作过程间距为 6px，外层固定高度再次滚动，展开箭头跑到整行最右；ZCode 使用 16px 工作项间距，箭头跟在标题之后，无外层滚动套娃。
5. 组件在流式/完成切换和 theme/props 更新时容易重挂载。原测试 mock 掉关键组件，仅检验输出字符串，不能证明交互或视觉一致。

## 对照合同与实施

| 表面 | ZCode 来源 | 实施合同 |
| --- | --- | --- |
| 正文 | `packages/ui/src/components/ai-elements/message.tsx`；`styles.css` | Streamdown 2.5；正文 1.75 行高、0.025em 字距；h1/h2 为基础字号 +4/+2px，h3–h6 基础字号；strong 500；段落、列表、引用、行内代码按参考组件定义；样式不进入代码查看器或数学内部 |
| 代码块 | `ai-elements/code-block.tsx`；`ui/code-viewer.tsx` | 使用相同版本 `@pierre/diffs` File；GitHub light/dark 高亮，WASM 引擎；语言文件图标；复制反馈；不换行/换行；流式期间 plain text，完成后高亮；键盘可操作 |
| 表格 | `ai-elements/markdown-table.tsx` | 28px 图标按钮、复制 Markdown、CSV、防公式执行、至少占满消息列，宽表按内容自然宽度借用右侧空间、单元格最长 448px、横向滚动和边缘提示、预览、宽表扩展；预览粘性表头与焦点恢复 |
| 图表 | `ai-elements/mermaid-block.tsx`、`diagram-preview-dialog.tsx` | 完成态绘制；严格安全模式；错误/过大时保留源码；复制源码；预览缩放、平移、适应视口；主题变化后重绘 |
| 图片/链接 | `message.tsx`、`markdown-image.tsx` | 图片预览、错误占位；链接内图片不得产生嵌套按钮；工作区路径与行号、已知文件引用、外链继续走宿主能力；不安全协议、HTML 不执行 |
| 思考 | `ai-elements/reasoning.tsx` | 默认收起，静态 Brain 图标；流式最新非空行跟随；展开纯文本、240px 上限、离底暂停跟随；完成态不冒充思考耗时 |
| 工具过程 | `ToolCallBlocks/ToolSummaryRow.tsx`、`ToolLayout.tsx` | 图标、类别、摘要、错误状态、尾随箭头；展开动画；保留计划、问题、嵌套工具、子代理专用动作 |
| 终端 | `renderers/ExecuteCommand.tsx`、`ExecuteOutput.tsx` | 自有 DOM；`$` 仅首行；命令 3 行摘要/10 行展开；输出最多 5 行滚动；运行时跟随，用户上滚后不抢位置；退出码与停止/失败不丢失 |
| 工作组 | `v4/ConversationTurnGroup.tsx` | 20px 回合间距、16px 工作项间距；标题后箭头；真实记录耗时；尊重简洁/标准/详细/完全展开设置 |

## 验收方法

- 使用可重复的浏览器 fixture，加载与正式页面相同的 Transcript 和渲染组件；覆盖流式/完成、长代码、宽表、中文和数学、错误图表、图片、文件链接、思考、终端成功/失败/停止。
- 实际 DOM 交互测试覆盖复制、换行、表格导出、预览、展开/收起、错误兜底与流式切换；不可 mock 掉被验收的渲染组件。
- Ego 浏览器验证浅色、暗色、桌面、390px 窄屏，保存截图及 DOM 测量。ZCode 原图参考在 `../../ego-shots/render-compare-20261027/`；本轮证据在 `../../ego-shots/render-repair-20261027/`。
- 用 `opencode-go/deepseek-v4.1-flash` 进行真实回答与只读命令测试；固定 fixture 通过不能代替真实链路。
- typecheck、相关测试、完整检查及构建通过后交付；明确未覆盖项，禁止用测试数宣布像素一致。

## 已知宿主边界

Chord 当前的 `sanitizeOutput` 在服务器端移除 ESC，真实 ANSI 可能已变为 `[31m`，仅靠展示端不能可靠恢复；不得用正则猜测并删除合法原文。该执行器行为与本次 UI 修改分开记录。思考块没有独立持久化耗时，不能拿整轮耗时冒充。ZCode 特有的插件、工作流、桌面宿主操作不属于本轮搬迁范围。

## 验收记录

完成于 2026-10-27。完整日志与机器可读记录在 `artifacts/render-repair-20261027/`（gitignored），截图在 `../../ego-shots/render-repair-20261027/`。

| 验收项 | 结果与证据 |
| --- | --- |
| 源码合同 | 回答的 CodeBlock 已替换为同版本 @pierre/diffs；终端拥有独立 DOM，未查询第三方组件的 nth-child；思考、读取/搜索摘要、编辑差异与文件变更摘要按参考组件结构重做 |
| 相同排版基准 | fixture 使用正文 14px / 代码 12px / 终端 14px；实测 h1=18px/600，正文行高=24.5px，字距=0.35px，消息列=1064px、表格=1062px；`prose-light.png` 与 `zcode-reference.png` 对照。正式页面继续尊重用户保存的字号 |
| 代码/图表 | 真实代码内容进入 Shadow DOM；复制精确源文本，换行、浅深色、未闭合流式围栏、未知语言均有测试；Mermaid 中文标签、错误源码回退、预览按钮和滚轮缩放通过。截图 `code-diagram-light.png`、`code-diagram-dark.png`、`diagram-preview.png` |
| 表格 | Markdown 复制反馈、实际 CSV 下载、公式前缀防护、预览焦点恢复通过；390px 页面宽度仍为390px，宽表内容992px在351px容器内滚动。截图 `tables-mobile-light.png`、`tables-mobile-dark.png`、`table-preview-mobile.png` |
| 图片/文件 | 连续图片画廊、选中第二张、前后切换、缩放平移、加载失败占位及链接中不嵌套按钮通过；实际 README 行号导航和本地 SVG 加载/预览通过。截图 `media-light.png`、`image-gallery-preview.png`、`live-file-mobile.png` |
| 过程区 | 思考默认收起、展开纯文本及滚动边缘提示；工具摘要、读取文件入口、编辑增删数和差异、成功/失败/停止记录可见；长命令在输出之前展开；流式输出完成后追尾，读旧输出时停止跟随。截图 `thought-stream.png`、`process-collapsed-light.png`、`process-expanded-light.png` |
| 真实模型 | `opencode-go/deepseek-v4.1-flash`：会话2248完成正文/图片/图表；只读模式无终端，没有把它算作终端成功。独立工作区模式会话2268实际调用一次 bash，输出 `RENDER_READY` 和第二行文本，未修改测试文件。截图 `live-running.png`、`live-prose.png`、`live-terminal.png` |
| 文件预览布局 | 修复外层隐藏滚动容器被 scrollIntoView 移动的问题；打开 README 后外层 scrollTop=0、关闭按钮y=7，390px也保持可见 |
| 项目检查 | `npm run check`：47文件，517通过，1跳过；typecheck和build通过；`git diff --check`通过。代码查看器按需加载；仍有大于500kB的构建块警告 |

测试中的 jsdom 仅补浏览器缺失的布局/构造样式表 API，没有 mock 掉新渲染组件。浏览器验收使用真实组件，固定场景捕获的运行错误为空。

仍未声称全应用或跨平台完全一致：没有 Windows 实机、超长历史性能压测；没有独立持久化思考耗时，不显示猜测值；底层已过滤的 ANSI 字节仍无法恢复；ZCode 专有的撤销、插件工作流和桌面宿主动作没有移植。图片/图表已有按钮、键盘、鼠标缩放平移，未移植双指缩放及桌面图片下载菜单。依赖审计与基线同为7 low、1 moderate、2 critical；critical为既有测试链 vitest/tinypool，本轮没有扩大升级范围。
