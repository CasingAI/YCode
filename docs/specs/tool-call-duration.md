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
- **后台移交的行不显示耗时**，改显灰色「后台」或「转后台」——见下节。耗时这个数字回答的是「占住 turn 多久」，后台场景下两种都不是用户关心的量。

## 后台移交

两种后台，对应两个不同的词，都替换掉耗时的位置：

| 行上事实                                          | 真实经过                                     | 摘要行显示 |
| ------------------------------------------------- | -------------------------------------------- | ---------- |
| `backgrounded` + 入参带 `run_in_background: true` | 调用时就要求后台；spawn 完立即移交进程就返回 | · 后台     |
| `backgrounded` + 入参无该标记                     | 前台跑满 `timeout`，运行时把进程移交到后台   | · 转后台   |

- **为什么显式后台的数字没意义**：那个秒数只是 spawn 成本，与任务实际跑了多久无关（一个跑三分钟的脚本也只会是「耗时 1 秒」）。
- **为什么超时转后台的数字也没意义**：那是「跑了多久才被移交」，同样不是这次执行的用时。移交之前的前台阶段仍报「持续了 N 秒」：那段时间确实是本次前台执行占住 turn 的时长，与普通前台命令无异。
- **区分靠入参，不靠透传 mode**。`BashBackgroundLifecycleMode` 已经在 `bash.ts` 里分叉出 `explicit` / `auto_on_timeout`，但两种模式产出的工具结果形状相同；判定改用「入参有没有 `run_in_background`」这一个已经落在行上的事实，少一份会漂移的真相。
- **`backgrounded` 由投影写在 `BackgroundTaskStarted` 上**：该事件的 `toolCallId` 定位工具行，行上写 `backgrounded: true` 与 `workId`。找不到行就静默丢弃，不按 phase 门禁——这条事实只改已存在行上的不可变字段，任何时刻应用都正确。
- **`backgrounded` 行不写 `durationMs`**。字段语义定义不变（仍是纯执行耗时），只是后台行不产出它；界面拿不到数字自然不渲染耗时元素。事件迟到（BackgroundTaskStarted 晚于 ToolCallResult）时，写标记的那一步一并丢掉已有的 `durationMs`，两条时序终态一致。
- **标记同时修正一处既有空转**：`product-projection-bash-progress.ts` 里「`row.backgrounded` 则不产出实时输出预览」的守卫此前恒不生效（工具行从来没有生产者），标记补上后，转后台的行不再刷新输出预览。

## 接口

- `packages/shared/src/zcode-protocol-v4/rows.ts`
  - `toolCallRowSchema` 新增 `durationMs: z.number().optional()`，紧跟 `endedAt`。
- `apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/product-projection.ts`
  - 私有方法 `withToolCallTiming(row: ToolCallRow, endedAt: number): ToolCallRow`：`startedAt` 缺失原样返回，否则写入 `durationMs`；行已 `backgrounded` 时不写 `durationMs`（后台移交口径见上节）。它是全部终态路径的耗时唯一收口。
  - `onBackgroundTaskLifecycle`：按事件载荷的 `toolCallId` 经 `toolRowIdByCallId` 定位工具行，写 `backgrounded: true` 与 `workId`；定位不到则不产 delta。
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
  - 行上有 `backgroundKind` 时改传「后台」/「转后台」的 `durationLabel`（复用 `DurationLabel`，样式与耗时一致），office 模式同样不显示。
- `packages/ui/src/v4/toolCallBackgroundKind.ts`（新增）
  - `toolCallBackgroundKind({ backgrounded, input })`：`backgrounded` 非真返回 `undefined`；否则按 `input.run_in_background === true` 返回 `"requested" | "auto"`。纯逻辑，供单测。
- `packages/ui/src/components/ai-elements/reasoning.tsx`
  - `thinkingMessage` 两态分支：`isStreaming` 走「持续了 N 秒」，闭合走「耗时 N 秒」；删除 `duration === undefined` 的模糊兜底分支。
- i18n：删除 `chat.reasoning.durationFewSeconds` 与 `chat.reasoning.durationSeconds`；新增 `chat.timeline.duration.running` 与 `chat.timeline.duration.elapsed`。新 key 不带 `reasoning` 前缀，因为同时服务两类行。后台措辞另加 `chat.timeline.background.requested` 与 `chat.timeline.background.auto`。`chat.timeline.duration.remaining` 是 TaskOutput 等待倒计时专用的 key，本 spec 不消费，归属见 [`task-output-card.md`](./task-output-card.md)。

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

后台移交（无耗时，改显后台措辞）
  BackgroundTaskStarted ──▶ 按 toolCallId 定位工具行 ──▶ backgrounded = true + workId
       └─▶ withToolCallTiming 见 backgrounded ──▶ 不写 durationMs
            └─▶ 界面显「· 后台」（入参带 run_in_background）或「· 转后台」（入参无此标记）
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
11. 带 `run_in_background: true` 的 Bash（哪怕跑三分钟）：摘要行尾是灰色「· 后台」，不出现任何秒数；重开会话后措辞不变。
12. 不带 `run_in_background`、`timeout` 小于实际耗时的 Bash：前台阶段显示「持续了 N 秒」，移交那一刻行尾换成灰色「· 转后台」，且输出预览不再刷新。
13. 带显式 `timeout` 的前台 Bash（含 `timeout` 大于实际耗时的快速命令）：全程显示「持续了 N 秒」，**任何时刻都不出现倒计时文案**；闭合后是「耗时 N 秒」。

## 负面边界

- 折叠头汇总（`终端 1 次（共 12 秒）`）不在本 spec 范围。多次调用求和还是取最长是独立的产品决定。
- 只接终端一种工具。`ToolLayout` 的插槽通用，read / edit / todo 等 renderer 本次不传值。
- 分享只读视图不接：`ConversationShareReadonlyTimeline` 走自己的渲染分支。
- Office mode 不动。
- 不做历史数据回填，不为缺时间的老行猜数字。
- legacy 持久化模型 `ZCodePersistedToolCall` 不加时间戳，v4 投影是唯一事实来源。
- `endedAt` 不因后台移交而特殊化：仍取终态时刻，只是不再派生 `durationMs`。
- 后台的**成因**由行上的 `input` 判定，不由执行器透传 `BashBackgroundLifecycleMode` 判定——两者都成立时选前者，避免同一事实有两份可能漂移的来源。
- 子代理行的 `backgrounded` 是 Agent 自己的后台（`payload.background === true`），与 Bash 超时移交不是一回事，措辞不共用。
- `BashOutputSchema.assistantAutoBackgrounded` 保持零生产者的现状：它是给模型看的文案素材，与界面显示是两件事。
