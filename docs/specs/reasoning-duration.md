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
- **运行时要记录真实思考窗口**：每段思考从「该块首个思考事件」起算（`reasoning_start` 与首个 `reasoning_delta` 谁先到算谁），到该段思考结束为止。
- **落盘终点分两种，都以「直播闭合时用的时间」为准**：正常收尾（`turn-model-step`）用记录到的 `reasoning_end` 时刻，缺失则取落盘当下；被取消收尾（`cancelled-stream-persistence`）一律取取消当下，**不采用** provider 早先发过的 `reasoning_end`——直播侧中断走的是 `closeStreamingRows(中断事件时刻)`，若落盘取更早的 `reasoning_end`，会漏掉「思考完但用户仍在等」的空档，重启后秒数比直播时更小。
- **reasoning part 的 `time` 语义 = 该段思考的真实起止时间**（此前误写为模型请求窗口 `[modelStartedAt, Date.now()]`，冷恢复据此得到的偏大值是伪造的）。冷恢复的 `synthesizeReasoningPart` 透传 `part.time.start` / `part.time.end ?? part.time.start`。
- **不引入 fallback 分支**：`closeReasoningRow` 的 `endedAt` 为必填参数，编译期保证所有闭合路径都提供时间；界面没有起点时不显示数字，而不是另算一个。

## 接口

- `packages/ui/src/v4/reasoningDurationDisplay.ts`（新增）
  - `reasoningDurationSecondsFromMs(ms)`：`max(1, ceil(ms / 1000))`（不出现「0 秒」）。
  - `reasoningDurationSeconds({ createdAt, durationMs, streaming, now })`：有 `durationMs` 即返回其秒数；否则仅在 `streaming` 且 `createdAt` 有值时返回 `now - createdAt` 的秒数；闭合但缺 `durationMs` 的旧快照返回 `undefined`（走兜底文案，**不能**退化成 `now - createdAt`，那会随挂钟越显示越大）。
- `packages/ui/src/components/ai-elements/reasoning.tsx`
  - 删除挂载锚定的秒表（`startTimeRef`）；新增 `startedAt` prop；运行中按秒重算纯函数。`duration`（闭合定格值）语义不变。
- `packages/ui/src/v4/ConversationRowView.tsx`、`packages/ui/src/v4/ConversationShareReadonlyTimeline.tsx`
  - 传 `startedAt={row.createdAt}`；已闭合时照旧传 `duration={durationSeconds}`。
- `apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/product-projection.ts`
  - `closeReasoningRow(state, endedAt: number)`：写入 `durationMs`；`closeStreamingRows(state, endedAt)` 转交。调用点统一传 `this.ms(event)`。
- `apps/zcode-cli/packages/core/src/runtime/methods/reasoning-stream.ts`
  - `getOrCreateReasoningBlock` 建块时记录 `startedAt`；`markReasoningBlockEnded(block, endedAt?)`；`readReasoningTiming(block)`。时间以块对象为键的内部 WeakMap 承载，**不写进 `ModelReasoningContentBlock`**（该块会作为 assistant 消息回放给 provider）。
- `apps/zcode-cli/packages/core/src/runtime/methods/model.ts`
  - `reasoning_end` 分支调用 `markReasoningBlockEnded(block)`。
- `apps/zcode-cli/packages/core/src/runtime/methods/turn-model-step.ts`
  - reasoning part 的 `time` 写 `{ start: startedAt ?? modelStartedAt, end: endedAt ?? 当下 }`。
- `apps/zcode-cli/packages/core/src/runtime/methods/cancelled-stream-persistence.ts`
  - reasoning part 的 `time` 写 `{ start: startedAt ?? assistantCreatedAt, end: 取消当下 }`。
- `apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/transcript-hydration.ts`
  - `synthesizeReasoningPart` 不改，继续透传 `part.time`。

## 状态与时序

```
直播
  reasoning_start ──▶ openReasoningRow ──▶ row.appended{ createdAt = 事件时间 T0 }
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

## 验收场景

1. 直播一轮思考，展开行看数字：按真实时间递增；不离开等它闭合，数字定格在闭合值，不回跳、不变小。
2. 思考进行中切到别的会话再切回来：数字不小于切走时的秒数（按真实时间继续增长），不是「回到 1 秒重新爬」。
3. 行闭合后切走再切回：显示同一个秒数。
4. 冷恢复（刷新/重开 app）后的历史思考行：显示与直播时同一个秒数，既不是整步窗口的偏大值，也不是「持续了几秒」。
5. 极短思考（<1s）→ 显示「持续了 1 秒」，不出现「0 秒」。
6. 回合被取消 / 报错 / stream recovery 作废尾段时，未闭合的思考行以闭合事件时间为终点写入 `durationMs`，状态 `interrupted`；重启后的同一行仍显示取消瞬间的那个秒数（落盘终点取取消当下，与直播闭合同一个量）。
7. 一轮里连续两段思考（第二段开行时收口第一段）→ 两行各自独立且正确的 `durationMs`。
8. 分享只读视图里的思考行显示同样秒数。

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
