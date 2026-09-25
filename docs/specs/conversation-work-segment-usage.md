# Spec: 工作段工具与思考总览

## 目标

在会话工作段的“已工作 X”状态行中，紧接工作时长显示两个聚合指标：

```text
已工作 1 时 18 分 · 工具 7 次 · 思考 18 秒
```

工具来源统一按正式工具调用计数；子代理委派本身算一次工具调用，委派会话内部以及更深层子代理的工具调用和思考耗时继续合并到总数。

## 产品规则

- 指标属于当前 `TurnWorkSegment`，不是整个 session 或整个 product turn；guide 产生的多个工作段分别统计。
- 工具次数按唯一 `ToolCallRow` 计数，终端、MCP、读取、编辑、浏览器、CUA 和其他工具不再按类别拆分。形成正式 `ToolCallRow` 的失败、取消和权限拒绝调用也计数。
- Agent/Task/subagent 委派对应的 `ToolCallRow` 计一次；配对的 `SubagentRow` 不再额外计数。子会话中的正式 `ToolCallRow` 以及嵌套子代理的调用递归合并。
- 思考耗时为所有有效 `ReasoningRow` 的 `durationMs` 之和，父会话和后代会话都计入。并行子代理按各 reasoning 区间累加，表示累计实际思考量，不表示 wall-clock 经过时间。
- `durationMs` 缺失且行已结束时不得猜测结束时间；运行中由 projection 提供当前有效耗时。空文本但有有效耗时的 reasoning 仍计入思考耗时——状态行答的是「花了多久思考」，展开区的「思考 N 次」答的是「用户看见几段思考」，两者口径本就不同（见 [`reasoning-duration.md`](./reasoning-duration.md)）。
- 聚合按 `sessionId + toolCallId` 幂等，迟到、重复和并发更新不能重复计数或使总数回退。子代理终态后冻结其已知用量。
- 新 usage 字段是可选的。旧 snapshot 缺少字段时只显示当前段可证明的直接统计，不为了补齐子代理数据发起额外会话订阅。
- **「未知」不等于「0」**：任何一层拿不到可证明的用量时都缺席该字段，不补 0。否则重启后冷恢复会把终态前没统计到的子代理显示成「工具 0 次」。`AgentFailedOutput` / `AgentCancelledOutput` 的 `totalToolUseCount` 因此是可选字段。
- **每一项独立隐藏**：工具次数为 0 就不显示该项，思考耗时为 0 也不显示该项；两项都为 0 时整段隐藏。0 次工具和 0 秒思考都不是对「做了多少事」的回答，显示出来只会让人以为统计坏了——工作段在 agent 轮次开始时就已经存在，那个时刻显示一行零值尤其容易误读。

## 所有权与时序

递归 usage 分两层归属，缺一不可：

- **`core/subagent/runner.ts` 负责单个 child session 内部**的统计，并把嵌套子代理的合计（`SubagentStopped` 载荷里的 `totalToolUseCount` / `totalReasoningDurationMs`）递归进本 child 的合计。成功路径取自 `childResult.events`；失败/取消没有 TurnResult，通过 `readChildSessionEvents` 端口回读子会话已落库事件。
- **CLI `ProductProjection` 负责会话内合并**：把 child 上报的合计回写到对应 `SubagentRow.usage`，再将委派工具本身（父侧 `ToolCallRow`）和 child usage 合并到 `TurnWorkSegment.usage`。父 snapshot 不内嵌 child rows，projection 也不订阅 child session。

UI 只读取工作段摘要，不读取全局 store、不打开 child session、不重新累计。

```text
child session 事件 → runner 递归合并（含嵌套子代理合计）→ terminal output / SubagentStopped
                                                                        ↓
父会话 rows ─────────────→ ProductProjection 幂等聚合 ─────────→ SubagentRow.usage
                                                                        ↓
                                                          TurnWorkSegment.usage
                                                                        ↓
                                                    conversation snapshot / delta
                                                                        ↓
                                                  Desktop / Web / Share 只读展示
```

`transcript-hydration` 必须使用同一套规则重建直播和冷恢复数据。分享投影只保留聚合数字，不公开 child rows、`childSessionId` 或子代理内部输入输出。

## 接口

- `packages/shared/src/zcode-protocol-v4/rows.ts`
  - 新增 `WorkSegmentUsage` schema/type。
  - `turnWorkSegmentSchema.usage` 与 `subagentRowSchema.usage` 均为可选非负整数/毫秒字段。
  - `SubagentRow.usage` 不包含父侧 launcher；`TurnWorkSegment.usage` 包含直接工具、launcher 和 descendant usage。
- `apps/zcode-cli/packages/core/src/subagent/runner.ts`
  - `resolveSubagentToolUseCount` / `resolveSubagentReasoningDurationMs` 负责 child session 内部统计，两者都递归累加嵌套 `SubagentStopped` 的合计，口径对称。
  - `recoverSubagentUsage` + `ExploreSubagentPortOptions.readChildSessionEvents`：失败/取消终态回读子会话已落库事件；读不到返回 `undefined`。
- `apps/zcode-cli/packages/contracts/src/tools/agent.ts`
  - `AgentFailedOutput` / `AgentCancelledOutput.totalToolUseCount` 可选（成功路径仍必填）。
- `packages/ui/src/v4/conversationWorkSegmentUsage.ts`
  - 提供统一计数、兼容旧 snapshot 的 direct fallback 和状态行格式化纯函数。
- `ConversationTurnGroup` 与 `ConversationShareReadonlyTimeline`
  - 在原有工作状态行中追加 `工具 N 次 · 思考 Y`，不删除或替换展开区的详细过程摘要；每个为 0 的指标各自隐藏，两项都为 0 时整段不渲染。
- 中英文 locale 增加对应文案。

## 验收场景

1. 一个工作段有终端、MCP、编辑共 4 次工具调用和 12 秒 reasoning，显示 `工具 4 次 · 思考 12 秒`。
2. 父段直接调用 2 次、父 Agent 委派 1 次、child 内部调用 3 次，父 reasoning 10 秒、child reasoning 20 秒，显示 `工具 6 次 · 思考 30 秒`。
3. grandchild 的用量进入 child，再进入 parent；工具次数与思考耗时两条口径都必须递归，缺一不可。同一 child usage 重放两次不会重复，父先终态时 child 后到达也不会使数字回退。
4. 子代理失败或取消时，已产生的正式工具和 reasoning 计入，未发生的调用不推断；回读不到子会话事件时终态与事件都不带用量字段，不落盘伪造的 0。
5. 旧 snapshot 没有 usage 字段时显示可证明的直接统计，且不发起 child session 请求。
6. 分享页显示同一聚合数字，但不包含 child rows、childSessionId 或子代理内部内容。
7. 窄屏保留两个指标，不通过隐藏数据解决宽度问题；现有详细过程摘要的折叠行为保持不变。
8. 工具 0 次、思考 2 秒时显示 `已工作 7 秒 · 思考 2 秒`，不出现「工具」字样；工具 2 次、思考 0 秒时同理只显示 `工具 2 次`；两项都为 0 时状态行不出现这两个指标。

## 负面边界

- 不修改现有 `explore / terminal / changes / reasoning` 过程折叠分类。
- 不把 `SubagentRow` 作为第二次工具调用；不把旧 session store 的 token 或 cost 字段接入这里。
- 不在 React 组件中订阅、轮询或递归加载子会话。
- 不把 child rows 嵌入父 snapshot，不新增公开 usage row kind。
- 不改变既有 owner/lease、stale run、command admission 或工作段边界协议。
- 不用客户端本地时钟推算 streaming 耗时：协议时间戳一律是 CLI 时钟。

## 验证

- `pnpm architecture:check --changed`
- `pnpm typecheck`
- `pnpm lint`
- `pnpm fmt:check`
- 定向运行 shared protocol、bootstrap projection/hydration、UI work segment、分享投影、reasoning duration 和 turn summary 测试。
- 使用现有 Desktop/Web 渲染或 E2E 入口检查桌面、手机宽度和分享只读页；当前 checkout 没有可用 E2E runner 时如实记录限制。
