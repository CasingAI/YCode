# Spec: 思考行耗时的真实来源（reasoning duration）

## 目标

思考行（`ReasoningRow`）显示「思考 · 持续了 N 秒」。这个秒数必须是**行数据**的事实，而不是界面组件生命周期的副产物：

1. **直播时**：唯一来源是行自身的 `createdAt`（打开该行的 `reasoning_start` 事件时间），显示 `now - createdAt`。组件重建（切会话、列表回收、运行轮在 live tail 与虚拟列表间搬家）不得改变这个数字。
2. **闭合时**：投影写入 `durationMs = max(0, endedAt - createdAt)`，与直播值是同量，数字闭合不回跳、不变小。
3. **冷恢复时**：历史行同样由持久化的 `part.time` 得出，而 reasoning part 的 `time` 必须是**该段思考的真实起止时间**，不是模型请求窗口。

## 产品规则

- **起点是行自身的 `createdAt`**（`rowBase(event, ...)` 创建行时写入）。它等于 `reasoning_start` 事件时间；该事件缺失、由首个 `reasoning_delta` 开行时，即首个 delta 的时间。这是已有的记录时间，不新增状态、不改协议。
- **终点是闭合该行的事件时间**。`reasoning_end`、`closeStreamingRows`（回合终态/中断/stream recovery 作废尾段）以及「新 reasoning 开行时收口旧行」三条路径都必须把闭合事件的时间传下去。
- **`durationMs` 只在闭合时写一次**。`closeReasoningRow` 收口后置空 `streamingReasoningRowId`，二次闭合是 no-op，已闭合行的 `durationMs` 不会再被改写。
- **界面只从行数据取值**：已闭合读 `row.durationMs`；运行中读 `now - row.createdAt`。组件**不持有任何时间起点**，也不做第二套推导；拿不到起点就不显示数字（走既有兜底文案），绝不用「挂载时刻」凑一个数。UI 侧推导收敛到纯函数 `reasoningDurationSeconds`，其签名里没有挂载时刻。
- **单位在边界上只换算一次，边界两侧都是毫秒**：行数据（`ReasoningRow.durationMs`、`createdAt`）与组件 prop（`durationMs`、`startedAt`）一律是毫秒；「毫秒 → 秒」的换算只在 `reasoningDurationSeconds` 内发生一次。调用方**不得**先 `reasoningDurationSecondsFromMs` 转成秒再传——那会被再除一次 1000，任何超过 1 秒的思考都退化成「持续了 1 秒」（回归记录见文末）。
- **运行时要记录真实思考窗口**：每段思考从「该块首个思考事件」起算（`reasoning_start` 与首个 `reasoning_delta` 谁先到算谁），到该段思考结束为止。
- **落盘终点分两种，都以「直播闭合时用的时间」为准**：正常收尾（`turn-model-step`）用记录到的 `reasoning_end` 时刻，缺失则取落盘当下；被取消收尾（`cancelled-stream-persistence`）一律取取消当下，**不采用** provider 早先发过的 `reasoning_end`——直播侧中断走的是 `closeStreamingRows(中断事件时刻)`，若落盘取更早的 `reasoning_end`，会漏掉「思考完但用户仍在等」的空档，重启后秒数比直播时更小。
- **reasoning part 的 `time` 语义 = 该段思考的真实起止时间**（此前误写为模型请求窗口 `[modelStartedAt, Date.now()]`，冷恢复据此得到的偏大值是伪造的）。一次模型请求的思考归并成一条 part 后（见 `reasoning-part-merge.md`），`time` 覆盖归并组：起点取各段最早、终点取各段最晚。冷恢复的 `synthesizeReasoningPart` 透传 `part.time.start` / `part.time.end ?? part.time.start`。
- **事件时间戳 = 帧到达时刻（入队时刻），不是出队落库时刻**。流式写队列（`model-streaming-event-queue`）是串行 append，落库/通知耗时会让出队整体后移；若在 `emitModelStreamingEvent` 内 `new Date()`，同轮 `reasoning_start/end` 会被挤到相邻毫秒，`durationMs` 恒为 0/1 秒。因此 `enqueue` 时读取时钟记下 `enqueuedAt`，出队时由 `emitModelStreamingEvent(payload, trace, events, enqueuedAt)` 回填 `event.timestamp`。顺序语义不变（仍是同一串行队列），只是时间戳不再包含排队等待。
- **空文本 reasoning 行不渲染、不计数**。Responses 无摘要的加密思考、以及只有签名的空 `reasoning_delta`，会产生 `text === ""` 的行：渲染层（`ConversationRowView`）直接返回 null；分组计数（`conversationAssistantWorkItems` 可见行过滤）同样剔除。避免“思考 N 次”虚增，以及零文本行闭合时 `durationMs = 0` 显示“持续了 1 秒”。

## 接口

- `packages/ui/src/v4/reasoningDurationDisplay.ts`（新增）
  - `reasoningDurationSecondsFromMs(ms)`：`max(1, ceil(ms / 1000))`（不出现「0 秒」）。
  - `reasoningDurationSeconds({ createdAt, durationMs, streaming, now })`：有 `durationMs` 即返回其秒数；否则仅在 `streaming` 且 `createdAt` 有值时返回 `now - createdAt` 的秒数；闭合但缺 `durationMs` 的旧快照返回 `undefined`（走兜底文案，**不能**退化成 `now - createdAt`，那会随挂钟越显示越大）。
- `packages/ui/src/components/ai-elements/reasoning.tsx`
  - 删除挂载锚定的秒表（`startTimeRef`）；新增 `startedAt` prop；运行中按秒重算纯函数。
  - 耗时 prop 是 **`durationMs`（毫秒）**，与 `startedAt` 同量，直接进 `reasoningDurationSeconds`；组件内部把结果命名成 `durationSeconds`（秒）供文案与 context 使用，此后不再做时间换算。
- `packages/ui/src/v4/ConversationRowView.tsx`、`packages/ui/src/v4/ConversationShareReadonlyTimeline.tsx`
  - 传 `startedAt={row.createdAt}`，已闭合时**直传 `durationMs={row.durationMs}`**（毫秒）；两个调用方都不再 import `reasoningDurationSecondsFromMs`。
- `apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/product-projection.ts`
  - `closeReasoningRow(state, endedAt: number)`：写入 `durationMs`；`closeStreamingRows(state, endedAt)` 转交。调用点统一传 `this.ms(event)`。
- `apps/zcode-cli/packages/core/src/runtime/methods/reasoning-stream.ts`
  - `getOrCreateReasoningBlock` 建块时记录 `startedAt`；`markReasoningBlockEnded(block, endedAt?)`；`readReasoningTiming(block)`。时间以块对象为键的内部 WeakMap 承载，**不写进 `ModelReasoningContentBlock`**（该块会作为 assistant 消息回放给 provider）。
- `apps/zcode-cli/packages/core/src/runtime/methods/model.ts`
  - `reasoning_end` 分支调用 `markReasoningBlockEnded(block)`。
- `apps/zcode-cli/packages/core/src/runtime/methods/reasoning-part-persistence.ts`（新增）
  - `mergeReasoningForPersistence`：把一次模型请求的思考块归并成要落盘的 part（粒度、段拼接、签名块例外见 `reasoning-part-merge.md`）。归并组的 `time` 为 `{ start: min(各段 startedAt ?? fallbackStart), end: max(各段 resolveEnd) }`。
- `apps/zcode-cli/packages/core/src/runtime/methods/turn-model-step.ts`
  - 正常收尾经 `mergeReasoningForPersistence` 落盘，`fallbackStart = modelStartedAt`，`resolveEnd = 各块 endedAt ?? 落盘当下`。
- `apps/zcode-cli/packages/core/src/runtime/methods/cancelled-stream-persistence.ts`
  - 取消收尾经同一 helper 落盘，`fallbackStart = assistantCreatedAt`，`resolveEnd = 取消当下`（常量）。
- `apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/transcript-hydration.ts`
  - `synthesizeReasoningPart` 不改，继续透传 `part.time`。
- `apps/zcode-cli/packages/core/src/runtime/methods/model-streaming-event-queue.ts`
  - `createModelStreamingEventQueue` 新增可选 `clock`（默认 `Date.now`，测试可注入）；`enqueue` 时读取 `enqueuedAt` 并随闭包带到出队，传给 `emitModelStreamingEvent`。
- `apps/zcode-cli/packages/core/src/runtime/methods/model-streaming-event.ts`（+ `internal-methods.ts` 签名）
  - `emitModelStreamingEvent(payload, trace, events, timestampMs?)`：传入时回填 `event.timestamp`，缺省保持原行为。
- `packages/ui/src/v4/ConversationRowView.tsx`
  - `ReasoningRowView`：`row.text.length === 0` 直接返回 null（此前只在 streaming 时跳过，闭合的空行会留下“持续了 1 秒”）。
- `packages/ui/src/v4/conversationAssistantWorkItems.ts`
  - 可见行过滤同样剔除空文本 reasoning，计数与分组不再包含它们。

## 状态与时序

```
直播（事件时间戳 = 入队/帧到达时刻）
  reasoning_start ──▶ openReasoningRow ──▶ row.appended{ createdAt = 入队时刻 T0 }
                                          └─▶ 运行时记 startedAt = T0
  reasoning_delta ────────────────────────▶ row.delta(text)    界面显示 now - T0（锚点在行上）
  reasoning_end ──▶ 运行时记 endedAt ──▶ closeReasoningRow(state, this.ms(event))
                       └─▶ row.upserted{ state, durationMs = end - T0 }   界面改用定格值（同量，不跳变）
  TurnComplete/cancel/error/recovery ──▶ closeStreamingRows(state, this.ms(event)) ── 同一条路

持久化与冷恢复
  正常收尾 turn-model-step ──▶ ReasoningPart{ time: [startedAt, endedAt ?? 当下] }   ← 真实思考窗口
  被取消   cancelled-stream-persistence ──▶ ReasoningPart{ time: [startedAt, 取消当下] }  ← 对齐直播的中断时刻
  transcript-hydration ──▶ reasoning_start(ts = part.time.start) / reasoning_end(ts = part.time.end)
                        └─▶ 同一 reducer ──▶ 与直播同一个 durationMs

所有者：ProductProjection 是行状态（createdAt / durationMs）的唯一所有者；运行时是「思考窗口」事实的
唯一所有者（流式期间它还只是待落盘事实）；UI 只读行数据，不推导、不锚定挂载时刻。
```

## 回归记录：全部闭合思考显示「持续了 1 秒」

**现象**：闭合后的思考行一律显示「思考 · 持续了 1 秒」，与真实思考时长无关。

**根因（单位二次换算）**：`47ff6b1`（思考耗时改从行数据计算）把 `Reasoning` 组件内部的耗时推导从「秒」改成「毫秒」——`duration` prop 直接进 `reasoningDurationSeconds({ durationMs: durationProp })`，而该纯函数第一步就是 `ceil(ms / 1000)`。但 prop 名与两个调用方没同步：`ConversationRowView` / `ConversationShareReadonlyTimeline` 仍按旧契约先 `reasoningDurationSecondsFromMs(row.durationMs)` 把毫秒转成**秒**再传进去，于是组件又除了一次 1000：

```
6245ms ──调用方换算──▶ 7 秒 ──组件再当毫秒换算──▶ max(1, ceil(7 / 1000)) = 1 秒
```

任何 ≥ 0ms 的输入都落在 `[0, 1)` 秒区间，`max(1, …)` 兜底把结果恒定为 1。直播中（行未闭合，走 `now - startedAt`）不经过这条路径，所以只有**闭合后的定格值**被压成 1 秒——与「光蹦字就远超 1 秒」的观察一致。

**运行时证据（dev 应用，CDP 采样同一行）**：`rowId=1054`，`createdAt=1790164030335`，文本从 81 字符增长到 2511 字符历时约 6300ms，闭合后投影写入 `durationMs=6245`（应显示 7 秒），同一时刻触发器文案为「思考 · 持续了 1 秒」。即**行数据正确、渲染错误**，投影与落盘两条链路本身无需修改。

**修复**：耗时 prop 更名 `duration` → `durationMs` 并在注释里写明毫秒契约，两个调用方直传 `row.durationMs`（不再 import `reasoningDurationSecondsFromMs`），组件内部结果命名 `durationSeconds`，让「毫秒 → 秒」的换算全项目只剩一处。spec 本节与「产品规则」的单位条目即为此回归的固化约束。

## 验收场景

1. 直播一轮思考，展开行看数字：按真实时间递增；不离开等它闭合，数字定格在闭合值，不回跳、不变小。
2. 思考进行中切到别的会话再切回来：数字不小于切走时的秒数（按真实时间继续增长），不是「回到 1 秒重新爬」。
3. 行闭合后切走再切回：显示同一个秒数。
4. 冷恢复（刷新/重开 app）后的历史思考行：显示与直播时同一个量——单段思考（直播只有一行）逐行一致；多段思考按 `reasoning-part-merge.md` 归并成一条后，恢复后的秒数是整段思考窗口（该 spec 的「已知边界」记录了直播仍按分片分行的差异）。既不是整步窗口的偏大值，也不是「持续了几秒」。
5. 极短思考（<1s）→ 显示「持续了 1 秒」，不出现「0 秒」。
6. 回合被取消 / 报错 / stream recovery 作废尾段时，未闭合的思考行以闭合事件时间为终点写入 `durationMs`，状态 `interrupted`；重启后的同一行仍显示取消瞬间的那个秒数（落盘终点取取消当下，与直播闭合同一个量）。
7. 一轮里连续两段思考（第二段开行时收口第一段）→ 两行各自独立且正确的 `durationMs`。
8. 分享只读视图里的思考行显示同样秒数。
9. **单位回归**：闭合后的思考行显示真实秒数——思考超过 1 秒就不得显示「持续了 1 秒」；同一行的行数据 `durationMs`、直播中现算的秒数、闭合后的定格秒数三者一致（见「回归记录」）。

## 验证

- 命令：`pnpm typecheck`、`pnpm --dir apps/zcode-cli typecheck`、`pnpm lint`、`pnpm architecture:check -- --changed`。
  - 结果：全部通过（lint 73 warnings / 0 errors，均为改动前既有的无关文件告警）。
- 测试（`node --import tsx --test <file>`）：
  - `packages/ui/test/reasoningDurationDisplay.test.ts`（9 例）
  - `apps/zcode-cli/packages/core/test/reasoning-stream-timing.test.ts`（8 例）
  - `apps/zcode-cli/packages/bootstrap/test/reasoningDuration.test.ts`（3 例）
  - `apps/zcode-cli/packages/bootstrap/test/reasoningHydrationDuration.test.ts`（3 例，含「冷恢复得到的思考耗时与直播同值」）
  - 结果：23 例全通过。
- 未执行：验收场景 1-8 的桌面端手动过一遍（需交互式运行桌面端，未在本机执行）。

### 单位回归（本次修复）的验证

- 命令：`pnpm typecheck`、`pnpm --dir apps/zcode-cli typecheck`、`pnpm lint`、`pnpm architecture:check --changed`、`oxfmt --check`（改动文件）。
  - 结果：全部通过（lint 73 warnings / 0 errors，均为改动前既有的无关文件告警；architecture violations 0）。
- 单测：本次未执行（按用户要求跳过）。
- 桌面端实测（重建 prebuilt renderer 后由 CDP 读**真实渲染文案**与同一行的 fiber 行数据）：
  - `rowId 1163`：`durationMs = 1720` → 显示「思考 · 持续了 2 秒」。
  - `rowId 1165`：`durationMs = 2610` → 显示「思考 · 持续了 3 秒」。
  - 修复前这两行都会是「持续了 1 秒」（二次换算把任何输入压成 1）；两行给出两个**不同且正确**的值，即闭合路径已恢复真实秒数。验收场景 9 由此覆盖。
