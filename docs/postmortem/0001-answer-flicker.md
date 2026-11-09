# Post-mortem 0001: 答后正文闪烁

Status: resolved（修复 e376a75，决策见 [spec.md](../spec.md) 2026-11-03 段「pending 交互屏障」）

## Executive summary

现象：模型用 `ask_user_question` 提问并按工具契约继续写过渡正文，用户作答、生成恢复的瞬间，这段已显示在回答区的正文跳回过程区，随后整个 thinking 阶段回答区空白——用户视角即「正文消失又出现」，每轮提问重复一次。

根因：回答区归属把 pending 期间的过渡文提为答案区正文；作答恢复 generation 的首帧触发 liveAnswer 逐出规则把旧正文挤出，而新 partial 只有 thinking 时回答区无内容块，空白持续到首个正文 token。

护栏：pending 交互屏障（待答期间答案区恒空）+ reply 屏障（解除点为最后一条交互回复 payload 之后），归属规则状态机化为 S5；真实模型逐帧采样进验收判据。

## Impact

用户可见表现：spec 记录为「正文先出现、作答恢复瞬间又跳回过程区」的闪变；thinking 空白窗在 max 档可达十几秒（[rendering-state-machines.md](../history/rendering-state-machines.md) S5）。2026-11-03 真实模型复现：会话 4059 的过渡文 `w+7651` 在答案区、`w+9465` 同帧降级进过程区；多轮会话 4081 每轮提问重复一次（同上 S5 缺陷 V5.1）。

记录未留：缺陷首次引入的提交与逃逸时长；受影响的会话与用户规模；首次发现的渠道（记录只到「2026-11-03 真实模型复现」）。

## Root cause

因果链（依 [rendering-state-machines.md](../history/rendering-state-machines.md) S5 与 spec 2026-11-03 段）：`ask_user_question` 工具契约要求模型「别等回答、继续干活」，pending 期间模型写一段过渡文；修复前的归属规则把这段过渡文提为答案区正文。作答后 generation 恢复，partial 首帧带 `streaming:true`，liveAnswer 逐出规则把上一条正文降级为过程内容以保持时间线时序——正文「搬家」；而 partial 只有 thinking 时 `responses=[]`（thinking 非 content block），答案区空白整个 thinking 阶段——正文「消失」。

次级缺口（V5.2）：已答复与续写首 token 之间的 gap 帧，`finalResponseOf` 扫全量消息会把过渡文重新提为答案区。

数据难点：durable 工具结果的 `details.status` 冻结在写入时（作答后仍是 `pending`，答案以独立 reply entry 落库），pending 判定必须读投影后的 `interactions` 记录，reply payload 是日志里唯一可靠的解除边界（[rendering.md](../subsystems/rendering.md)「回答区归属与 pending 交互屏障」）。

## Why every test missed it

投影与渲染单测（如 [render-model.test.ts](../../tests/render-model.test.ts)）以固定消息数组喂 `buildRenderModel`、断言折叠结果——覆盖的是静态状态迁移：给定一帧，各区内容对不对。本缺陷不出现在任何单一帧的折叠结果里，而出现在帧序列的演化里：partial 首帧的逐出、thinking 窗的空白、gap 帧的复活，都只在跨帧可见性判据下显形（S5 不变量 I5.1：一条消息若曾在答案区出现，其后每一帧都留在答案区——位移即缺陷）。这类判据需要时间维采样：修复后以真实模型 50ms 逐帧采样验收（会话 4111 / 4141），断言「答案区→过程区位移事件 = 0」这类事件计数。修复同批才补上的三场景单测在放行期尚不存在（e376a75 diff）。

## Guardrails added

pending 交互屏障：run 里存在待答交互（question / plan-review）时答案区恒空，过渡文从首帧起渲染在过程区（[rendering.md](../subsystems/rendering.md)，spec 2026-11-03 段）。

reply 屏障：归属候选切去最后一条交互回复 payload 之后，gap 帧不得把过渡文复活回答案区（[rendering.md](../subsystems/rendering.md)）。

S5 状态机：答案区归属显式化为状态机，非法转移 V5.1 / V5.2 与不变量 I5.1–I5.3 冻结在 [rendering-state-machines.md](../history/rendering-state-machines.md) S5。

逐帧采样进验收：真实模型 ego 逐帧采样与位移事件计数成为此类可见性缺陷的验收仪式（同上 S5「ego 验收」节）。

## Lessons

可见性缺陷的判据是跨帧不变量，不是单帧快照：凡「先 A 后 B」类症状，验收必须带时间维采样，静态断言组合不出「位移次数」。

工具契约是渲染语义的隐藏输入：「模型会继续干活」这类契约直接改变帧序列形态，评审与测试要把它当作输入域，而不只是提示词问题。

落库即冻结的字段不能当实时状态读，必须找投影层的等价实时源——该教训不限于渲染模块。
