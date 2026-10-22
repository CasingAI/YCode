# Spec: Responses 可延续思考阶段

## 目标与语义

对支持 `openai-responses` 的流，仅在观察到真实 `response.in_progress` 时打开一个空思考阶段。该阶段是客户端观察到的响应处理区间，不代表模型内部精确推理时长；不生成正文、不读取隐藏 CoT，不改变请求参数、调度或重试策略。`response.created`、HTTP headers、SDK `start` 均不是起点。普通协议及无 `in_progress` 的兼容端点保持旧行为。

## 状态、所有者与事件顺序

```text
Responses raw response.in_progress (adapter 捕获观察时间/attempt/response id)
  → 内部 model lifecycle event (不含原始 payload)
  → Core 单一阶段状态机 (幂等起止、边界与中断原因)
  → 有序 SessionEvent / persistence
  → ProductProjection 单一行 reducer (row id、状态、createdAt、durationMs)
  → desktop continuous / web remote replayable snapshot+gap repair
  → 共享 UI 只读行事实
```

一个物理 attempt 独立拥有 response 生命周期；内部事件携带 requestId+attempt 序号形成的 attemptId，并要求有效 Responses response id。缺失 response id 时不打开阶段。同 response 重复开始幂等，不同 attempt/response 不合并；迟到 end 必须同时匹配 attemptId 和 responseId。adapter 仅捕获并转送事件，不保存 UI 阶段状态。Core 决定窗口和关闭原因；ProductProjection 拥有行状态；UI 不推导起止时间。阶段不进入 `ModelReasoningContentBlock`，不回放给后续 provider。生命周期通知**即时送达**，但不设置正文 retry boundary 或更改重试/commit 裁决；若物理 attempt 在正文提交前失败并重试，adapter 先以 `interrupted` 关闭旧 attempt 的阶段，再允许新 attempt 开始。

阶段时间在 adapter 实际观察 SSE 帧时采样，随串行事件队列传递；不以出队/落库时刻替代。响应 `in_progress` 开始阶段，真实 summary 通过原 reasoning 内容通路追加到同一可见行，保持行身份、创建时间和折叠状态。正文 `text_start`（缺失时首个非空 `text_delta`）、`tool_input_start`（仅直接 `tool_call` 流用该事件）关闭阶段；`reasoning_end` 仅关闭真实内容块，不关闭阶段。结束耗时为 `max(0, endedAt-startedAt)`。finish、失败、取消、断流、attempt 替换均幂等关闭；失败/取消为 interrupted，正常终态空阶段保留完成行。已关闭阶段不能被延迟事件或再次落盘延长。

## 持久化和兼容

为 reasoning part 增加可选、运行时校验的显式阶段标识及终止元数据；旧记录缺字段按原规则解释。摘要和空阶段持久化为同一记录，不先写占位再另写摘要。阶段数据不篡改签名、密文、provider metadata，也不改变 assistant reasoning 回放。hydration 仅为空阶段显式标记重建行；旧空 reasoning 仍跳过。live、snapshot、gap replay、历史 hydration 需得到一致行身份、最终状态和耗时。阶段窗口用于投影/展示，吸收的真实 reasoning 时长不能在工作段用量中重复计数；token、TTFT、账单不变。

## 显示

无摘要运行态显示不可展开标题和实时耗时；有真实摘要则原位成为现有可展开 reasoning 卡片；完成空阶段保留固定耗时标题，不展示正文或展开箭头；失败/取消冻结耗时并展示中断状态。复用现有毫秒行字段、秒数换算、国际化和思考可见性规则。明确阶段的空行参与每 turn 首条思考筛选；旧空行及加密签名空块继续隐藏。空阶段和摘要只计一次。

## 验收

1. `in_progress` 一到达即显示空思考，期间没有正文、摘要或工具事件时仍可见；`text_start` 到达后按事件时刻结束，完成后固定耗时。
2. `in_progress → tool_input_start` 在参数生成/工具执行之前关闭。
3. `in_progress → summary → text_start` 原位续接，T0、行身份、折叠状态不变，不重复计数。
4. 重复/迟到事件及旧 attempt 不重开、不污染新阶段；`reasoning_end` 不关闭阶段。
5. 阶段事件即时送达但不阻止正文提交前的 retry；attempt 失败进入重试前，旧阶段以 interrupted 收口，新阶段只归属新 attempt。
6. finish、失败、取消、重试、正文后取消均幂等并保留中断/完成语义。
7. 无 `in_progress`、非 SSE、其他协议保持原行为。
8. 持久化、snapshot、gap replay、hydration 一致；旧空 reasoning 不显示。
9. 思考设置开关、桌面/手机/分享视图可见性一致；工作段只计一次。
10. 不改变请求/重试次数、工具调度、usage、TTFT。
11. 桌面和手机手工 GUI 验收单独记录；未经授权不得操作运行中的 YCode，自动化 reducer 测试不视作 GUI 验收。
