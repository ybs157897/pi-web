---
name: browser-codemode
description: 把内置 browser 工具的验证序列（连续 open/evaluate/click/fill、UI 冒烟、多页面采集、批量填表）编排进一次 codemode 脚本执行。仅单次截图看图决策、一次性单步操作或首次探路不适用。
when_to_use: 任务用内置 browser 工具做页面验证或检查，且预期两次以上浏览器动作时。ego-browser CLI 调用（bash 里跑 ego-browser nodejs）不适用。
---

# Browser × codemode

## Why

浏览器操作的实际形态是「文本断言型」：open → evaluate 枚举 → 按结果 click/fill → 再 evaluate 断言，每步返回文本、决策不依赖视觉。逐次直调意味着每个动作一轮模型往返，而 TTFT 占整个墙钟时间的大头——脚本化把 N 轮往返压成 1 轮，模型只消费最终聚合证据。browser 工具进程级复用浏览器实例和标签页，本身就是为连续操作设计的，与 codemode 编排天然契合。

## When

- 同一请求中预期 ≥2 次浏览器动作时，写一次 codemode 脚本，而不是逐次直调。
- 适用：验收冒烟、多页面/多元素采集、条件点击（命中才点）、批量填表、断言校验。
- 不适用（单独直接调用 browser）：整个任务只有 1 次动作；每步都需要看截图才能决定下一步（视觉决策链只能每脚本一停，压缩不了）；第一次 open 探路确认站点可达。

## Workflow

1. **查声明**：本请求内首次使用时先 `describeTool('browser')`，不要凭动作名猜参数结构。
2. **串机械链**：一次脚本内完成 open → evaluate 枚举/读取 → 条件 click/fill → evaluate 断言，最后 `text()` 聚合返回 URL、命中数、断言值等证据。
3. **每步留证据**：每个动作 try/catch，catch 时把该步的 URL、选择器命中数、错误一起返回，而不是让脚本级 Error 吃掉中间状态。断言失败先回证据再改脚本，不在脚本里自动重试同一操作。
4. **混合出图**：需要看页面时，脚本内完成机械动作后用 `image()` 输出截图做视觉决策；下一轮基于该图续写脚本，而不是每步都停。
5. **一次一个目标**：一次脚本聚焦一个验证目标；脚本结束前把还开着的验证上下文交代清楚（停留页面、复用了哪个标签页）。

## Boundaries

- 本 Skill 只覆盖内置 `browser` 工具。ego-browser 是 shell 里跑 `ego-browser nodejs` 的 CLI 脚本，一次调用本身已编排多步操作，codemode 调不到它也没有可压缩的往返，不要为它套用本 Skill。
- codemode 脚本无 Node、无网络、无文件系统，只有 `tools.*` 与脚本 globals；evaluate 在页面内执行不受此限制。
- screenshot 是高成本动作：文本断言足够时不截图；要截图时优先放进脚本末尾一次性产出。
- 本 Skill 不授予权限：脚本调用与直接调用权限相同，仍受当前模式的工具白名单约束。
