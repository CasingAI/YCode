# Spec: Active Compact 时间线生命周期

## 目标

Active compact（`compactActiveConversation`）从 `CompactStarted` 到终态必须闭合：无论失败发生在
summary 模型请求、MCP/工具准备还是初始化期间的取消，都必须在同一个 `operationId` 上写入
`CompactFailed`，让历史时间线不再停留在“正在压缩上下文”。

本规格只修复 runtime 的终态缺口，不增加协议字段、状态或 UI 推断。

## 状态所有者与边界

- `compactActiveConversationImpl` 是 active compact 生命周期的唯一所有者；`operationId`、`messageId`、
  `partId` 在进入生命周期时创建一次，所有状态变更复用同一组 id。
- 时间线持久化与事件由 `persistCompactTimelineEvent` / `finishCompactTimelineFailure` 统一写入，
  `CompactStarted`、`CompactCompleted`、`CompactFailed` 都走同一持久化路径。
- UI（`ConversationRowView`、product projection）只消费事件并投影 marker；不根据“是否继续跑工具”
  反推压缩失败，也不为旧坏数据补发终态。
- 成功完成时写入 `CompactCompleted`；失败/取消时写入 `CompactFailed`，其 `status` 区分
  `failed` 与 `interrupted`。

## 生命周期与事件顺序

```text
选择 entries
   │ 不足
   ├──────────────► CompactCompleted(status=skipped)   [不进入 active 生命周期]
   │ 足够
   ▼
CompactStarted(operationId=op, messageId=m, partId=p, attempt=1)
   │
   ├─ 准备阶段：initializeMcp → 取消检查 → getTools
   │     └─ 任意失败/取消
   │          └─► CompactFailed(op, status=failed|interrupted) → 抛出原错误
   │               （不进入 auto retry，不发模型请求，不重复准备）
   │
   ▼
模型 summary 请求（既有内层 prompt-too-long / media 重试不变）
   │
   ├─ Auto 可重试失败且 attempt < maxAttempts
   │     └─► CompactStarted(status=retrying, attempt+1, 同 op)
   │          └─ 回到模型 summary 请求
   │
   ├─ 其他失败/取消
   │     └─► CompactFailed(op, status=failed|interrupted)
   │
   └─ 成功
         └─► CompactCompleted(op, status=completed)
```

关键不变量：

1. `CompactStarted` 之后到终态之间，只能在准备阶段或模型阶段二选一继续；准备阶段失败直接终结，
   不落入模型请求的 auto retry。
2. 准备阶段的异常（`initializeMcp` 抛错、初始化期间取消、`getTools` 抛错）必须走
   `finishCompactTimelineFailure`，因此 `failed/interrupted` 的判定与持久化语义与模型阶段一致。
3. `initializeMcp` 在整个 operation 内最多执行一次；auto retry 只重试模型 summary 请求，不重复初始化
   MCP 工具。
4. 所有终态事件复用 started 时的 `operationId`；`replace=true` 原地更新同一个时间线 marker。
5. Desktop 的 continuous 链路与手机 replayable 链路消费同一份 runtime 事件，不新增任何旁路事件或
   客户端兜底。

## 非目标

- 不修复与本次已证实原因无关的时间线乱序问题。
- 不对历史里已经停留在 running 的坏数据做 UI 端推断或补写。
- 不改变模型 summary 请求的既有 auto retry、prompt-too-long 截断、媒体重试与错误传播。
- 不新增协议事件、状态值或持久化字段。

## 验收场景

1. `initializeMcp` 抛错：先写 `CompactStarted`，随后写同一 `operationId` 的 `CompactFailed(status=failed)`；
   不调用 `getTools`，不进入模型请求，Auto trigger 也不重试准备阶段。
2. `initializeMcp` 期间 abort：写入同一 `operationId` 的 `CompactFailed(status=interrupted)`。
3. `getTools` 抛错：写入同一 `operationId` 的 `CompactFailed(status=failed)`。
4. Auto 模型请求可重试失败：每次 retry 写 `CompactStarted(status=retrying, 同 operationId)`，
   最终失败写 `CompactFailed`；整个过程中 `initializeMcp` 只调用一次。
5. 成功路径：`initializeMcp` 只调用一次，最终写 `CompactCompleted`，原有完成语义不变。
6. 投影回归：同一 `operationId` 的 `CompactStarted` → `CompactFailed(failed|interrupted)` 复用同一
   marker row，最终只保留一行且状态分别为 `failed`/`cancelled`；终态后 `activeWorks` 不再含
   `compact`，`canStop` 与 `compactOperationLock` 同源复位。冷恢复（`mergeColdConversationEvents`
   回放）与 live 投影结论一致，不遗留 running。
