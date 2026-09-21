# Spec: 思考行耗时的真实来源（reasoning duration）

## 目标

思考行（`ReasoningRow`）收起态会显示「思考 · 持续了 N 秒」。这个耗时目前有两个问题：

1. **直播时**：耗时的唯一来源是 UI 组件内部的秒表（`startTimeRef = Date.now()`，挂载时刻起算），不是思考真正的开始时刻。组件因切会话、列表回收、窗口重挂载而重建时，计时从头开始；挂载本来就晚于 `reasoning_start`（首个 delta 到达才挂载）。
2. **冷恢复时**：投影从不写 `row.durationMs`，UI 落到兜底文案「思考 · 持续了几秒」（写死的假值）。

本改动让耗时统一来源于**事件/transcript 里已有的记录时间**，直播与历史回放得到同一个数。

## 产品规则

- **起点是行自身的 `createdAt`**。reasoning 行由 `rowBase(event, ...)` 创建，其 `createdAt` 就是打开该行的 `reasoning_start` 事件时间（`reasoning_start` 缺失、由首个 `reasoning_delta` 开行时，即首个 delta 的时间）。这是「已有的记录时间」，不新增状态、不改协议。
- **终点是闭合该行的事件时间**。`reasoning_end`、`closeStreamingRows`（回合终态/中断/stream recovery 作废尾段）以及「新 reasoning 开行时收口旧行」三条路径都必须把闭合事件的时间传下去。
- **`durationMs = max(0, endedAt - createdAt)`**，写进 `ReasoningRow.durationMs`。该字段协议里早已存在（`reasoningRowSchema.durationMs`），只是从未被赋值；UI 也早已读它。
- **直播口径不变**：流式中 `durationMs` 尚未产生，UI 仍用内部秒表显示实时耗时；行闭合时 `row.upserted` 带上 `durationMs`，UI 切换到该真实值（`duration` 作为受控 prop 覆盖内部状态）。
- **冷恢复必须给真实时间**。`synthesizeReasoningPart` 从 transcript 合成 `reasoning_start` / `reasoning_end` 时，分别使用持久化的 `part.time.start` / `part.time.end` 作为事件时间，否则两条合成事件会共用「首条消息时间 + seq」，耗时塌成 ≈0。
- **不引入 fallback 分支**：不因为拿不到时间而保留第二套推导逻辑。`closeReasoningRow` 的 `endedAt` 为必填参数，编译期保证所有闭合路径都提供时间。

## 接口

- `apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/product-projection.ts`
  - `closeReasoningRow(state, endedAt: number)`：写入 `durationMs`。
  - `closeStreamingRows(state, endedAt: number)`：把 `endedAt` 转交 `closeReasoningRow`。
  - 调用点 `onModelStreaming`（`reasoning_end` 分派）、`openReasoningRow`、以及三处 `closeStreamingRows`（turn 终态、turn error、stream recovery tail discarded）统一传 `this.ms(event)`。
- `apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/transcript-hydration.ts`
  - `synthesizeReasoningPart`：`reasoning_start` 事件时间取 `part.time.start`，`reasoning_end` 取 `part.time.end ?? part.time.start`。
- UI 不改：`ConversationRowView` 已经读 `row.durationMs` 并传给 `Reasoning`，`durationMs` 与 `state` 在同一条 `row.upserted` 中到达，受控 prop 会立即覆盖组件内部计时。

## 状态与时序

```
会话启动/流式
  reasoning_start ──▶ openReasoningRow ──▶ row.appended{ createdAt = event.timestamp }
                                              │
  reasoning_delta ────────────────────────────┤ row.delta(text)         UI 内部秒表计实时
                                              │
  reasoning_end ──▶ closeReasoningRow(state, this.ms(event))
                       └─ row.upserted{ state, durationMs = end - createdAt }   UI 切真实值
  TurnComplete/cancel/error/recovery ──▶ closeStreamingRows(state, this.ms(event)) ── 同一条路

冷恢复（同一 reducer，同一事件语义）
  ReasoningPart ──▶ reasoning_start(ts = part.time.start)
                ├─▶ reasoning_delta
                └─▶ reasoning_end(ts = part.time.end) ──▶ 同上，得到与直播一致的 durationMs
```

- 耗时所有者：投影（`ProductProjection` 是行状态的唯一所有者）。UI 只读 `row.durationMs`，不自己推导。
- 事件全序仍由 `sequenceNumber` 裁决；时间戳只承载展示事实。

## 验收场景

1. 直播一轮思考，结束后收起行显示真实秒数（≈ `reasoning_end` 与 `reasoning_start` 的时间差），不是挂载起算值。
2. 刷新页面/切走再切回后，同一行显示与直播时相同的秒数（不再是「持续了几秒」）。
3. 冷恢复的历史思考行显示 `part.time.end - part.time.start` 的真实值，而非 ≈0 或假文案。
4. 回合被取消 / 报错 / stream recovery 作废尾段时，未闭合的思考行以闭合事件时间为终点写入 `durationMs`，状态 `interrupted`。
5. 一轮里连续两段思考（第二段开行时收口第一段）→ 两行各自有独立且正确的 `durationMs`。
6. 极短思考（<1s）→ 显示「持续了 1 秒」，不出现「0 秒」。
7. 改前已持久化、行上没有 `durationMs` 的旧历史 → 仍走既有兜底文案，不报错、不伪造数字。

## 验证

- 已执行：`pnpm typecheck`（全仓）、`pnpm --filter @zcode/bootstrap typecheck`、`pnpm lint`、`pnpm architecture:check --changed`（0 违规、0 新增）、`pnpm exec oxfmt --check`（改动文件）。`apps/zcode-cli` 在 oxlint `ignorePatterns` 内，该目录本就不参与 lint。
- 已执行：`node --import tsx --test apps/zcode-cli/packages/bootstrap/test/reasoningDuration.test.ts`（5 项中 3 项）与 `.../test/reasoningHydrationDuration.test.ts`（2 项）：直播闭合、中断闭合、连续两段各自计时、冷恢复取 `part.time`、缺 `end` 退化。
- 反向验证：临时短路两处修复后 5 项全部失败，确认测试确实守护该行为，而非恒真。
