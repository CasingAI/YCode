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
- **运行中的子代理按节拍回传累计用量**：子代理执行期间，父工作段状态行必须随子代理的工具调用与思考闭合实时递增，不能冻结在「只有父侧 Agent launcher 那一次」直到子代理结束。终态数字是权威值，运行中的数字是它的单调前缀。
- 新 usage 字段是可选的。旧 snapshot 缺少字段时只显示当前段可证明的直接统计，不为了补齐子代理数据发起额外会话订阅。
- **「未知」不等于「0」**：任何一层拿不到可证明的用量时都缺席该字段，不补 0。否则重启后冷恢复会把终态前没统计到的子代理显示成「工具 0 次」。`AgentFailedOutput` / `AgentCancelledOutput` 的 `totalToolUseCount` 因此是可选字段。
- **每一项独立隐藏**：工具次数为 0 就不显示该项，思考耗时为 0 也不显示该项；两项都为 0 时整段隐藏。0 次工具和 0 秒思考都不是对「做了多少事」的回答，显示出来只会让人以为统计坏了——工作段在 agent 轮次开始时就已经存在，那个时刻显示一行零值尤其容易误读。

## 所有权与时序

递归 usage 分两层归属，缺一不可：

- **`core/subagent/runner.ts` 负责单个 child session 内部**的统计，并把嵌套子代理的合计（`SubagentStopped` 载荷里的 `totalToolUseCount` / `totalReasoningDurationMs`）递归进本 child 的合计。成功路径取自 `childResult.events`；失败/取消没有 TurnResult，通过 `readChildSessionEvents` 端口回读子会话已落库事件。
- **运行中进度也由 runner 负责**，口径与终态共用同一对 `resolveSubagentToolUseCount` / `resolveSubagentReasoningDurationMs`，因此直播数字与终态数字按构造一致。触发源是子代理自身的每条事件（`reportActivity`），经 1500ms 节流后由 `SubagentProgress` 事件上报父会话；累计值未变化时不发事件，空闲子代理不产生任何写入。projection 不轮询、不订阅 child session，进度事件与终态事件走同一条 `emitParentEvent` 通道。
- **子代理的工具计数是 scheduled 语义，不是 completed 语义。** `TurnComplete.toolCallCount` 在工具进入执行器之前累加（`turn-model-step.ts` 的 `state.toolCallCount += executableToolCalls.length`），而 `ToolCallRow` 也正是由 `ToolCallScheduled` 创建。运行中读数走不到 `TurnComplete`，必须落到兜底分支，该分支同样按 scheduled 语义计数：把 `ToolCallScheduled` / `ToolCallStarted` / `ToolCallResult` / `ToolCallError` 四类事件的 `payload.toolCallId` 收进 `Set` 去重后取大小。四类都在，缺 `ToolCallScheduled` 的旧 transcript 形态靠其余三类兜住；缺 `toolCallId` 的事件跳过，不猜。**只数结果事件会让并行工具的数字等到最慢那个跑完才跳**——子代理界面早已出行，父状态行却不动，用户看到的是"外面不同步"。
- 由此产生一条已知边界：有工具 `Scheduled` 了但没真正进执行器（被自动化上限截断、启动失败等），运行中会数它、终态 `TurnComplete` 不数。projection 的 `max` 单调守卫会让终态无法向下修正，偏高 1~2 会留着。权限拒绝的工具不受影响——它在两条路径里都算，因为 `executableToolCalls` 在权限闸门之前累加。这条边界不额外开分支修复。
- **CLI `ProductProjection` 负责会话内合并**：把 child 上报的合计回写到对应 `SubagentRow.usage`，再将委派工具本身（父侧 `ToolCallRow`）和 child usage 合并到 `TurnWorkSegment.usage`。父 snapshot 不内嵌 child rows，projection 也不订阅 child session。进度事件与终态事件的合并口径必须一致：都经 `resolveSubagentRowUsage`，且逐字段取 `max` 做单调守卫——中途读数与终态读数来自不同事件序列，取 max 才能同时满足「不重复计数」与「不使数字回退」。进度事件不写 `endedAt`、不改 `status`。

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

### 冷恢复批量重放的收口不变量

- **批量期间跳过逐事件 usage 物化**：冷恢复把整段历史重放进未发布的候选投影（`beginHydrationReplay → applyHydrationEvent×N`）时，结构 delta 照常推进候选快照，但工作段 usage 不逐事件重算。中途 usage delta 本来就不会发布给任何客户端——批量成功后 delta log 清空、改走 snapshot recovery 边界——逐事件全窗口重算只对大会话制造 O(事件数×行数) 的同步停顿，是纯浪费。
- **收口统一重算一次**：`completeHydrationReplay` 在候选快照上（accumulator 仍存活时原地写入）从最终行集合强制重算全部 turnHeader 的 `workSegments[].usage`。该重算是派生物化，与 command row actions 同规：不经 `attachRevision`、不递增修订号、不产生独立 delta 发布。
- **终态逐字段一致**：同一事件序列，直播逐事件收敛与冷恢复收口重算后，所有 turnHeader 的 `workSegments[].usage`（`toolCallCount` / `reasoningDurationMs`）必须相等。usage 由最终行集合唯一决定，两条路径只允许在不发布的中间态上不同。
- **运行中思考耗时的时刻口径**：`durationMs` 缺失且行仍在 streaming 时，耗时取「触发重算那一刻」的事件时间；直播用当前触发事件时间，冷恢复收口用最后一条事件时间。已闭合行带 `durationMs`，两条路径同值——等价性断言只对已闭合行成立。
- **严格回退路径不受益**：批量路径体积校验失败时走逐事件 `ingest`（live 语义），usage 逐事件物化照旧；该回退是慢路径保护，不改变正确性。

## 接口

- `packages/shared/src/zcode-protocol-v4/rows.ts`
  - 新增 `WorkSegmentUsage` schema/type。
  - `turnWorkSegmentSchema.usage` 与 `subagentRowSchema.usage` 均为可选非负整数/毫秒字段。
  - `SubagentRow.usage` 不包含父侧 launcher；`TurnWorkSegment.usage` 包含直接工具、launcher 和 descendant usage。
- `apps/zcode-cli/packages/contracts/src/events/session.events.ts`
  - 新增 `SessionEventType.SubagentProgress`，载荷字段与 `SubagentStopped` 对齐（`agentId` / `childSessionId` / `totalToolUseCount` / `totalReasoningDurationMs`），使两者共用 `resolveSubagentRowUsage`。
  - 该类型不是瞬态事件：进度要进冷恢复，分类为 **memory-only 权威**（`cold-event-merge.ts` 的 `MEMORY_ONLY_EVENT_TYPES`）。durable transcript 只从 Agent tool output 合成终态 `SubagentStopped`，从不合成进度事件；归进 `TRANSCRIPT_DERIVED_EVENT_TYPES` 会被冷恢复压制，重启后运行中的数字退回「只有父侧 launcher 那一次」。
- `apps/zcode-cli/packages/core/src/subagent/runner.ts`
  - `resolveSubagentToolUseCount` / `resolveSubagentReasoningDurationMs` 负责 child session 内部统计，两者都递归累加嵌套 `SubagentStopped` 的合计，口径对称。
  - `recoverSubagentUsage` + `ExploreSubagentPortOptions.readChildSessionEvents`：失败/取消终态回读子会话已落库事件；读不到返回 `undefined`。
  - `runAgentToCompletion` 在子代理挂起期间挂节流上报闭包，由 `reportActivity` 驱动，值未变不发事件，终态与异常路径收尾。
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
9. 子代理**运行中**：父工作段状态行的工具次数与思考耗时随子代理的工具调用与思考闭合递增，不冻结在「工具 1 次」直到子代理结束。子代理结束后，数字与展开区可见过程之和（父侧 launcher 单独计 1）对齐。
10. 空闲子代理（无新事件）持续十秒以上：状态行数字不变，父会话事件流中没有新增 `SubagentProgress`。重复投递同一条进度事件幂等；进度事件的数字之后到达的终态数字覆盖，不回退。

## 负面边界

- 不修改现有 `explore / terminal / changes / reasoning` 过程折叠分类。
- 不把 `SubagentRow` 作为第二次工具调用；不把旧 session store 的 token 或 cost 字段接入这里。
- 不在 React 组件中订阅、轮询或递归加载子会话。
- 不把 child rows 嵌入父 snapshot，不新增公开 usage row kind。
- 不改变既有 owner/lease、stale run、command admission 或工作段边界协议。
- 不用客户端本地时钟推算 streaming 耗时：协议时间戳一律是 CLI 时钟。
- 不动子代理工具事件镜像白名单（`tool-event-mirror.ts` 的 ToolCall + Permission）：其中不含 reasoning，补进去会让主时间线显示 child 的 Read/Bash，那是已修复过的错误行为。
- 不把 `SubagentProgress` 加进 TUI 子代理目录的 `DIRECTORY_EVENTS`：该集合触发目录重扫，秒级进度事件会让它持续抖动。
- 不改终态口径：`SubagentStopped` 三态输出、`recoverSubagentUsage` 的失败/取消回读、`AgentFailedOutput` / `AgentCancelledOutput` 的 optional 用量字段全部保留。
- `WorkSegmentUsage` 不扩字段：本次只有 `toolCallCount` 与 `reasoningDurationMs`，不引入 token 或 cost。

## 验证

- `pnpm architecture:check --changed`
- `pnpm typecheck`
- `pnpm lint`
- `pnpm fmt:check`
- 定向运行 shared protocol、bootstrap projection/hydration、UI work segment、分享投影、reasoning duration 和 turn summary 测试。
- 使用现有 Desktop/Web 渲染或 E2E 入口检查桌面、手机宽度和分享只读页；当前 checkout 没有可用 E2E runner 时如实记录限制。
