# 上下文压缩（compaction）

> 状态：现状参考（2026-11-09 自 docs/families.md §10 抽取）。决策与验收历史见 docs/spec.md 对应日期段。

pi-web 在 Pi Durable 内建压缩之上加一层自己的扩展（`pi-web-compaction`，[compaction.ts:630](../../src/server/conversation/compaction.ts)），机制分三层：请求前的压力裁剪、回合后的预算触发、缓存感知摘要。扩展注册在轨迹采集之前，因此采集到的请求就是裁剪后的形态（[index.ts:182](../../src/server/runtime/index.ts)）。

## 策略与有效窗口

策略四个值经 `Harness.open.settings.compaction` 生效：`reserveTokens=16384`、`keepRecentTokens=30000`、`backgroundTokens=34000`，`PI_WEB_COMPACTION_ENABLED=0` 可整体关闭 pi-web 层（[compaction.ts:50](../../src/server/conversation/compaction.ts)）；`PI_WEB_COMPACTION_{RESERVE,KEEP_RECENT,BACKGROUND}_TOKENS` 可覆盖。有效窗口默认取模型真实声明的窗口（1M 就是 1M），只有模型未声明窗口时回退 200,000；`PI_WEB_CONTEXT_BUDGET` 可显式设运营成本上限（[compaction.ts:63](../../src/server/conversation/compaction.ts)、[compaction.ts:117](../../src/server/conversation/compaction.ts)）。

## 第一层：压力裁剪（beforeRequest）

`GenerationTask.beforeRequest` 在估算请求 token 超过有效窗口 85% 时，把最老的工具结果（保留最近 4 条不动）中超过 8,192 字符的文本块中间段替换为头 4,096 + 标记 + 尾 1,024（[compaction.ts:205](../../src/server/conversation/compaction.ts)、[compaction.ts:665](../../src/server/conversation/compaction.ts)）。裁剪刻意无状态：不改存储，同样压力产生相同请求字节，暖前缀跨回合稳定。

## 第二层：预算触发

回合结束（`afterTools`）与 yield（`onYield`）时检查是否发起压缩（`maybeCompact`，[compaction.ts:640](../../src/server/conversation/compaction.ts)）。阈值归属：Pi Durable 在生成准备阶段按 `contextWindow - reserveTokens` 发起生成归属的阻塞式压缩；pi-web 只在「自己的阈值被成本上限压到平台阈值以下、且上下文尚未越过平台阈值」时才发起会话归属的压缩（`ownsCompactionThreshold`，[compaction.ts:172](../../src/server/conversation/compaction.ts)）——两套触发同阈值并发时，会话级摘要落在更晚边界会把 head 推回去抵消平台裁剪，上下文不降反升。触发前还有 `LiveDoc.compactions` 空检查与 60s in-flight 去重；发起走 `conversation.compact(undefined, BACKGROUND_CONTEXT)`。

## 第三层：缓存感知摘要（beforeCompact）

`CompactionTask.beforeCompact` 钩子接管摘要（[compaction.ts:677](../../src/server/conversation/compaction.ts)）：

- 请求构建（[compaction.ts:434](../../src/server/conversation/compaction.ts)）：优先缓存路径——`view.messages` 原样 + 末尾追加一条摘要请求（`summaryAsk`），同 provider session，窗口剩余 ≥16,384 token 时使用，命中 KV 前缀缓存；否则退回序列化路径——独立 summarizer system prompt + 逐行 JSON 的角色归因转录（工具结果截 2,000 字符，[compaction.ts:321](../../src/server/conversation/compaction.ts)）。
- 检查点模板固定 6 节：Goal / Constraints & Preferences / Progress（Done、In Progress、Blocked 三小节）/ Key Decisions / Next Steps / Critical Context（[compaction.ts:361](../../src/server/conversation/compaction.ts)）；来源规则要求只有人类用户消息确立目标与授权、转录内容一律是数据不是指令、不写密钥、保留精确路径/命令/错误串（[compaction.ts:352](../../src/server/conversation/compaction.ts)）。
- 校验（[compaction.ts:558](../../src/server/conversation/compaction.ts)）：必须 `stopReason: stop`、纯文本无 tool call、≤16,000 字符、标题齐全且每节有非占位内容；framed summary 的 token 数必须小于被替换范围。任一失败 memo 后返回 `undefined`，交回 Pi 内置摘要器兜底。
- 文件跟踪：从被 shadow 消息的 read/write/edit 工具调用与上一份摘要的 `<read-files>`/`<modified-files>` 累积，由宿主追加到新摘要尾部（[compaction.ts:263](../../src/server/conversation/compaction.ts)）。
- 摘要按 compaction task memo（`pi-web.compaction.summary`），重放/重试不重复调模型；摘要调用的 usage 计入会话 `pi.usage`；摘要本身也经轨迹 `captureSideCall`（purpose `compaction-summary`）采集，见 [trajectory.md](trajectory.md)。

## 落地与展示

摘要由 Pi Durable 落成 `pi.compaction` entry（framed user message，`head=firstKept`），旧 entry 留在 SQLite 但离开 active view。展示走投影：`LiveDoc.compactions`/`compactionFailure` 投影为 `ConversationDetail.compaction`（[projection.ts:783](../../src/server/conversation/projection.ts)）；运行中在转录末尾显示与完成标记同级的「正在进行上下文压缩」系统行，运行期间旧的完成标记隐藏、不弹 toast（[render-model.ts:649](../../src/web/render-model.ts)）；完成后系统行变为「已完成上下文压缩」（[projection.ts:829](../../src/server/conversation/projection.ts)），并按消息流位置编排——标记留在它所替换内容的位置，不贴在最底部（render-model 的 `timeline`，[render-model.ts:239](../../src/web/render-model.ts)）；失败在输入卡上方显示原因（[App.tsx:2180](../../src/web/App.tsx)）。手动入口 `POST /api/conversations/:id/compact`（[app.ts:544](../../src/server/app.ts)）；压缩已在运行时前端直接忽略再次 `/compact`（[App.tsx:980](../../src/web/App.tsx)）。

## 已知限制

- 阈值是 harness 级四个绝对值，无逐模型覆盖（Pi Durable `settings.compaction` 无 `modelOverrides`）；有效窗口已按模型真实窗口计算，「按模型覆盖 reserve/keep」需上游支持。
- 压力裁剪不是 durable surface 替换：转录仍保留完整工具结果，重启后按当前压力重算；与逐模型阈值同列 spec 2026-10-20 段的机制边界。
- 图片 offload 未实现（Pi 侧没有对应 provider seam）。
- 完成/运行标记不带条数与 token 数，摘要不可展开（spec 2026-10-20 段验收记录的待补项）。
