# 队列项命令的准入判据

> 状态：已实现。适用面：`apps/zcode-cli` 的 v4 队列命令组（`deleteQueueItem` / `editQueueItem` /
> `reorderQueueItem` / `sendQueuedNow`）与 `packages/ui` 的 v4 队列面板。

## 1. 问题

队列面板上的「移除 / 编辑 / 立即 / 拖拽排序」四类操作，目标是**某个队列项**，不是整张会话投影。
但它们此前和其它 CAS 命令一样，要求信封里的 `baseRevision` 等于 CLI 当前的会话 revision。

会话 revision 的递进规则是封闭的（`apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/projection-state.ts`
的 `REVISION_BEARING_PATCH_KEYS`）：行结构变化 + A 区（control / availability / inputRouting / meta /
config / queue / pendingInteractions / backgroundWorks / subagents / sandbox / goal / plan / agentWorktree）
任一变化各 +1。其中绝大多数与「我要删的那一条排队消息」无关——别的消息入队、当前轮的控制态切换、
子代理状态迁移都会推进它。

客户端手里的 `baseRevision` 来自最近一次收到的投影快照。桌面 continuous 链路推送密集，快照通常只
落后一两个 revision；Web / 手机 replayable 链路的推送间隔明显长于一次命令往返，客户端的
`baseRevision` 天然落后于 CLI 当前 revision。

结果是：一条**仍然好好躺在队列里**的消息，删除与编辑都被判 `proto.staleRevision` 拒绝。删除是
fire-and-forget，失败只落 warn 日志，用户看到「点了没反应」；编辑要把正文退回输入框，被拒后弹
「未能把排队消息退回输入框，请重试。」

## 2. 产品规则

1. **以目标队列项为准入条件。** 队列项命令的准入只看目标项自身是否仍可操作，不再要求整会话
   revision 相等。与 `forkAssistant` 的处理同构：目标是一个稳定边界时，全局 revision 推进不构成
   拒绝理由。
2. **`baseRevision` 仍然必带**，只作审计用途，不再参与裁决。协议信封不变：
   `COMMANDS_REQUIRING_BASE_REVISION` 仍含这些命令，`parseCommandEnvelope` 的校验不变。
3. **代际与行目标校验不变。** `baseLogEpoch` 与 row target 语义不变；本规则只放宽 revision 相等这一项。
4. **保护不丢。** 目标项不可操作时必须拒绝或幂等收口，不能把「已经不在队列里」的旧投影当成可删除项。

## 3. 状态所有者与判据

| 事实                   | 所有者                                  | 判据                                                         |
| ---------------------- | --------------------------------------- | ------------------------------------------------------------ |
| 队列项是否存在         | v4 投影 `snapshot.queue.items`          | `host.getQueueItem(sessionId, queueItemId)`                  |
| 队列项是否正在派发     | v4 投影 `queueItem.dispatch`            | `"queued"` = 可操作；`"reserved"` / `"promoting"` = 正在派发 |
| runtime 侧是否已被占用 | core runtime `pendingInputReservations` | `removePendingInputById` 在被他人预留时返回 false            |

裁决顺序（`apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/commands/handlers/queue.ts`）：

```text
投影里没有该项         → noop(queue.itemMissing)              // 已消费 / 已删除
dispatch.state ≠ queued → 拒绝(guard.queueItemReserved)        // 正在派发，删除会与派发竞争
removeQueueItem 失败    → noop(queue.itemMissing)               // 竞态：已被并发消费
```

`sendQueuedNow` 不走上面这条链：它有更强的 reserve → promote → remove 协议（`reserveQueueItem`
抢占失败即 `guard.queueItemReserved`），准入判据由该协议自己给。

## 4. 事件顺序（删除）

```text
UI 点「移除」
  → deleteQueueItem 命令（baseRevision 仅审计）
  → CommandInbox：baseRevision 必带；不再比较 revision 相等
  → handler：目标项可操作性判定
  → runtime.removeQueueItem → TurnSteerDiscarded 事件
  → 投影 queue patch → 客户端快照更新
```

编辑（把队列消息撤回输入框）复用同一条删除命令：

```text
UI 点「编辑」
  → deleteQueueItem（同一命令）
  → ACK accepted → 才把正文恢复到 composer
  → ACK noop / 其它 → 不恢复，弹 chat.queue.editRestoreFailed
```

**关键不变量：只有 CLI 真的删掉了那一项，composer 才会拿到那份正文。** 已消费的旧投影不得被恢复
成草稿——否则用户会重发一条模型已经看过的消息。

撤回待引导（guide）消息复用同一条命令，准入边界不变：

```text
guide 项在投影中（delivery.admitted = guide）且 dispatch.state = queued
  → deleteQueueItem 允许
  → runtime.removePendingInputById 在首次 await 前用 pendingInputReservations 落锁，
    drainPendingInput 看到占用即放弃，撤回与消费只能有一方获胜
  → ACK accepted → 正文/附件恢复到 composer
drain 已 splice、TurnSteerDrained 未提交 → runtime 命中 pendingInputDrainIds，noop，不按 held 撤销
已 drain / 投影无该项 / runtime 未命中 → noop(queue.itemMissing)，不回填
reserved / promoting                    → guard.queueItemReserved，不回填
```

guide 与 queue 共用 `queueItemId` 与 `pendingInputId`，不新增命令。完整语义见
`docs/specs/pending-guide-withdraw.md`。

## 5. 负面边界

- 不放宽其它 CAS 命令：行目标类命令（`editUserQuery` / `retryTurn` / `forkAssistant` /
  `setAssistantFeedback` / `applyFileRewind`）与配置类命令仍按各自的准入规则裁决。
- 不改信封 schema：`baseRevision` 依然必带。
- 不新增 renderer 本地队列状态：队列面板仍然只读投影。
- 不为删除失败新增 toast：队列面板保持安静，失败仍走 warn 日志；UI 已按
  `dispatch.state !== "queued"` 禁用该行的按钮。

## 6. 验收

1. Web 端：会话运行中排一条消息，等 CLI 侧 revision 推进（再排一条、跑一轮工具）后再点「移除」——
   该项被删除，不出现「点了没反应」。
2. Web 端：同样条件下点「编辑」——正文回到输入框，不弹「未能把排队消息退回输入框」。
3. 目标项已被消费（刚被自动 drain）后再点「编辑」——正文**不**回到输入框，仍弹失败提示。
4. 目标项正在派发（`dispatch.state` 为 `reserved` / `promoting`）时删除——被拒绝，该项不被删除。
5. `deleteQueueItem` 仍必须携带 `baseRevision`；缺失时信封解析即拒（`proto.invalidPayload`）。
6. `editUserQuery` 等行目标命令在 revision 落后时仍判 `proto.staleRevision`，语义不变。

单元测试：`apps/zcode-cli/packages/bootstrap/test/queueItemCommandAdmission.test.ts`。

## 7. 非目标

- 不做「客户端重试直到 revision 命中」的通用 CAS 重试机制（配置类命令已有自己的有界重试，
  见 `packages/ui/src/v4/SessionPane.tsx` 的 `dispatchConfigCas`）。
- 不改队列项 id 空间与投影结构。
- 不改 `sendQueuedNow` 的 reserve / promote / remove 生命周期。
