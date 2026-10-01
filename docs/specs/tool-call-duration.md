# Spec: 工具行耗时（tool call duration）

## 目标

终端行（`ToolCallRow` 渲染出的工具摘要行）显示「耗时 N 秒」。这个秒数与思考行共用同一套推导与文案规则，但**口径不同**：

1. **口径是纯执行时间**，不含用户审批等待。`startedAt` 只在 `ToolCallStarted` 事件写入，审批期间工具尚未启动、没有 `startedAt`，因此 `endedAt - startedAt` 天然排除了等待。
2. **运行中与结束后用不同措辞**：运行中是一个正在持续的过程，显示「持续了 N 秒」并逐秒跳动；结束后是一次已完成的测量，定格显示「耗时 N 秒」。
3. **数字只来自行数据**，不从组件挂载时刻起算。组件重建（切会话、虚拟列表回收、live tail 搬家）不得让数字归零重新爬。

思考行的文案同步改成同一套两态规则，共享纯函数与秒表；它自己的起点语义（`createdAt` 是 `reasoning_start` 事件时间）见 [`reasoning-duration.md`](./reasoning-duration.md)，本 spec 只规定两者共用的那部分。

## 产品规则

- **`durationMs` 与 `reasoningRowSchema.durationMs` 同构**：`ToolCallRow.durationMs = max(0, endedAt - startedAt)`，只在终态写一次。`startedAt` 缺失就不写这个字段。
- **从未执行的行不显示耗时**。被拒绝、超时未跑的行没有 `startedAt`，投影不写 `durationMs`，界面不渲染耗时元素——不是显示 0，也不是显示一个猜的区间。
- **拿不到数字就不渲染耗时元素**。`chat.reasoning.durationFewSeconds`（「持续了几秒」）这类模糊兜底下线：它给出一个看起来像事实、实际是猜测的值。改动前持久化的历史行没有时间数据，恢复后就是不显示。
- **运行态的判据是「有 `startedAt`」，不是「`isRunning` 为真」**。`isCompactToolCallRunningState`（`packages/shared/src/tool-call-summary.ts`）把 `input-streaming` 也算运行态，但入参仍在流式输出时工具尚未启动，`startedAt` 还没有值。
- **秒表只在运行中走，且只驱动文案**。秒表以 `startedAt` 对齐整秒边界自我续期，不做 `setInterval` 轮询；终态后由 `durationMs` 定格，与跳字的最后一跳同量，闭合瞬间不回跳。
- **亚秒一律显示 1 秒**（`max(1, ceil(ms / 1000))`），不引入毫秒粒度。终端行里大量是几百毫秒的命令，显示 0 秒或小数没有信息量。
- **超 60 秒显示分秒**：与思考行共用 `formatDurationLabel` 的组装规则——整数秒拆成「M 分 S 秒」（整分不带「0 秒」），`<60s` 保持「X 秒」。只改显示组装，不改秒数推导与纯执行时间口径。
- **耗时标签是摘要行的尾部固定段**：`shrink-0`，排在描述之后、状态标签之前。窄屏优先牺牲描述（`flex-1 truncate`），不牺牲耗时。耗时不参与 `prioritizePrimaryText` 的窄屏隐藏。
- **失败行同时显示耗时与失败标签**，读作「· 耗时 4 秒 · 执行失败」。失败详情的 tooltip 行为不变。
- **单位在边界上只换算一次**：行数据（`durationMs`、`startedAt`）与组件 prop 一律毫秒；毫秒→秒只在 `conversationDurationSeconds` 内发生一次。调用方不得先转秒再传。

## 接口

- `packages/shared/src/zcode-protocol-v4/rows.ts`
  - `toolCallRowSchema` 新增 `durationMs: z.number().optional()`，紧跟 `endedAt`。
- `apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/product-projection.ts`
  - 私有方法 `settleToolCallTiming(row: ToolCallRow, endedAt: number): ToolCallRow`：`startedAt` 缺失原样返回，否则写入 `durationMs`。
  - 接入点：`onToolCallResult` 的成功分支与权限拒绝分支、`settlePermission`。
- `packages/ui/src/v4/toolCallRowAdapter.ts`
  - 透传 `row.durationMs`。
- `packages/ui/src/v4/conversationDurationDisplay.ts`（由 `reasoningDurationDisplay.ts` 改名而来）
  - `conversationDurationSecondsFromMs(ms)`：`max(1, ceil(ms / 1000))`。
  - `conversationDurationSeconds({ startedAt, durationMs, running, now })`：有 `durationMs` 即返回其秒数；否则仅在 `running` 且 `startedAt` 有值时返回 `now - startedAt` 的秒数；其余返回 `undefined`。闭合但缺 `durationMs` 时**不能**退化成 `now - startedAt`。
- `packages/ui/src/hooks/useLiveDurationSeconds.ts`（新增）
  - `useLiveDurationSeconds({ running, startedAt, durationMs, enabled })`：返回秒数。承载整秒对齐的自续 `setTimeout`，思考组件与工具 renderer 共用。
- `packages/ui/src/ToolCallBlocks/ToolLayout.tsx`、`ToolSummaryRow.tsx`
  - 新增可选 `durationLabel?: ReactNode`（与 `statusLabel` 同为「调用方传入已格式化节点」约定），渲染在 `QueuedSummaryContent` 之后、`statusNode` 之前；并入 `resolvedSummaryContentKey`。
- `packages/ui/src/ToolCallBlocks/renderers/execute.tsx`
  - 用 `useLiveDurationSeconds` 取秒数，按 `isRunning` 选文案；秒数为 `undefined` 时不传 `durationLabel`。
- `packages/ui/src/components/ai-elements/reasoning.tsx`
  - `thinkingMessage` 两态分支：`isStreaming` 走「持续了 N 秒」，闭合走「耗时 N 秒」；删除 `duration === undefined` 的模糊兜底分支。
- i18n：删除 `chat.reasoning.durationFewSeconds` 与 `chat.reasoning.durationSeconds`；新增 `chat.timeline.duration.running` 与 `chat.timeline.duration.elapsed`。新 key 不带 `reasoning` 前缀，因为同时服务两类行。

## 状态与时序

```
执行中（跳秒）
  ToolCallStarted ──▶ startedAt = T0 ──▶ row.upserted{ status: running }
                     useLiveDurationSeconds 每秒重算 now - T0，显示「持续了 N 秒」

终态（定格）
  ToolCallResult / 权限拒绝 / settlePermission ──▶ endedAt = T1
       └─▶ settleToolCallTiming ──▶ durationMs = max(0, T1 - T0)
            └─▶ row.upserted{ status, durationMs }   界面改用 durationMs，显示「耗时 N 秒」

从未执行（无耗时）
  审批中被拒 / 超时未跑 ──▶ 终态但无 startedAt ──▶ 不写 durationMs ──▶ 界面不渲染耗时
```

所有者：`ProductProjection` 是工具行 `startedAt` / `endedAt` / `durationMs` 的唯一所有者；`useLiveDurationSeconds` 只在运行态现算，不落盘；UI 只读行数据，不锚定挂载时刻。

## 验收场景

1. 跑一条耗时约 4 秒的命令：执行中「持续了 1 秒 → 2 秒 → 3 秒 → 4 秒」逐秒递增；返回后跳字停止、改为定格「耗时 4 秒」，与最后一跳同值不回跳。
2. 同一轮里思考行同步两态：思考中「持续了 N 秒」，结束后定格「耗时 N 秒」。
3. 耗时 <1s 的命令：显示「耗时 1 秒」，不出现「0 秒」。
4. 需要审批的命令：审批等待期间不显示任何耗时文字；批准执行完后才出现，且秒数不含等待审批的时间。
5. 命令失败：行尾「· 耗时 4 秒 · 执行失败」，hover 失败标签仍能看到报错详情。
6. 命令被拒绝：行尾「· 已拒绝」，无耗时文字。
7. 折叠头保持「终端 1 次 · 思考 2 次」，不出现秒数。
8. 执行中切走会话再切回：跳字不回退到 1 秒重新爬。
9. 分享只读视图：工具行不出现耗时（该视图不走 `ToolLayout`）。
10. 改动前的历史会话回放：工具行无耗时文字；缺 `durationMs` 的思考行也不显示文字，不出现「持续了几秒」。

## 负面边界

- 折叠头汇总（`终端 1 次（共 12 秒）`）不在本 spec 范围。多次调用求和还是取最长是独立的产品决定。
- 只接终端一种工具。`ToolLayout` 的插槽通用，read / edit / todo 等 renderer 本次不传值。
- 分享只读视图不接：`ConversationShareReadonlyTimeline` 走自己的渲染分支。
- Office mode 不动。
- 不做历史数据回填，不为缺时间的老行猜数字。
- legacy 持久化模型 `ZCodePersistedToolCall` 不加时间戳，v4 投影是唯一事实来源。
- `backgrounded` 行与其它终态同一路径，`endedAt` 取移交时刻，不单独区分。
