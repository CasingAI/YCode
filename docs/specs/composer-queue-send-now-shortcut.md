# 空草稿 Enter 立即发送队首

> 状态：已实现。适用面：`packages/ui` 的 v4 会话输入框。

## 1. 产品规则

会话运行中、输入框上方有排队消息、且输入框里没有任何草稿内容（文本、附件、代码评论、
网页上下文、PPT 引用、会话选区、分享上下文全部为空）时：

- 按 Enter = 把队列里第一条可立即发送的消息发出去，与点击该行的「立即」按钮完全等价；
- 输入框 placeholder 同步换成 `chat.placeholder.followUpQueueSendNow`
  （zh：「按 Enter 立即发送队首：{text}」），让用户知道这个键位可用；
- 右下角圆形按钮**仍然是「停止」**。快捷键不夺走鼠标的停止入口。

任一条件不成立时，行为与本 spec 之前完全一致：Enter 走原发送/入队路径，
placeholder 回到 `chat.placeholder.followUpQueue`。

## 2. 权威判据

快捷键不自己判断「能不能发」，只读与队列行「立即」按钮相同的两个事实：

| 判据                                          | 含义                                                                                       | 出处                                                                                  |
| --------------------------------------------- | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------- |
| `snapshot.availability.sendQueuedNow.allowed` | 会话处于 running/prewarming 且不在 compacting；否则 denied(`sendQueuedNowRequiresRunning`) | `apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/projection-state.ts:138-142` |
| `queueItem.dispatch.state === "queued"`       | 该项未被 reserve/promote 占用                                                              | `packages/shared/src/zcode-protocol-v4/snapshot.ts:210-213`                           |

外加 composer 自身的门禁：`!disabled && !pending && submissionReady`，
与发送键共用 `submitDisabled` 的同一组条件。

## 3. 队首解析必须与面板同源

队列面板渲染的不是原始 `snapshot.queue`，而是先过
`projectPendingGuideQueue`（`packages/ui/src/v4/pendingGuideProjection.ts:13-28`）：
`delivery.admitted === "guide"` 的项正在等待 model-step 注入，面板不画它。

因此快捷键的队首由 `packages/ui/src/v4/composerQueueHead.ts` 的
`resolveComposerQueueHead` 解析：先过同一个投影函数，再取第一个
`dispatch.state === "queued"` 的项。**不得直接取 `queue.items[0]`**，
否则会出现 placeholder 提示 A、实际发送 B。

## 4. 重复触发闸门

`sendQueuedNow` 是 fire-and-forget 命令，`dispatch.state` 要等下一帧快照才回流。
composer 用 `queueSendNowInFlightRef` 记住刚触发的 queueItemId，在该项离开
`snapshot.queue.items` 之前不再重复触发。没有这道闸，连按 Enter 会把同一个 id
再打一次，撞上 CLI 的 `QueueItemAlreadyReservedError`
（`apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/commands/handlers/queue.ts:38`）。

## 5. 负面边界

- **不改右下角按钮**：`showStopControl` 与「停止」按钮不因本快捷键改动。
- **不碰 held-queue 二次确认**：`chat.queue.sendConfirm.*` 处理的是「有草稿时发送新消息，
  要不要清空已排队内容」，与「空草稿直接发队首」不是同一条语义链。
- **不改 CLI 侧**：`sendQueuedNow` 的 reserve → stop → promote → remove 生命周期、
  reservation 幂等、`dispatch.state` 状态机全部保留；快捷键只是同一个命令的第二个入口。
- **不新增协议命令、不新增 renderer 本地队列状态**：队首只从 snapshot 解析。
- **队列暂停且非运行态时不提供该能力**：`inputRouting.mode === "choice"`
  （completed + 队列暂停）下 availability 已判 denied，此时 Enter 不触发命令、
  placeholder 不出现，避免用前端行为覆盖一条本来就被协议拒绝的操作。
- **有草稿时 Enter 语义不变**：仍然走原入队/发送路径，不叠加快捷键。

## 6. 验收

1. 运行中排入两条消息、点队首「立即」发掉第一条后，输入框为空时 placeholder 变为
   「按 Enter 立即发送队首：<队首文本>」；按 Enter 后队首那条被发出、队列少一条，
   表现与点「立即」一致，右下角按钮仍是「停止」。
2. 输入框有文字时按 Enter 走原路径，提示文案不出现。
3. 停止当前轮使队列暂停且不在运行态时，placeholder 回到「继续输入以排队后续修改」，
   按 Enter 不触发命令，日志无 `sendQueuedNowRequiresRunning`。
4. 空输入连按 Enter 两次只发出一条，日志无 `already reserved`。
5. 队列为空时 placeholder 与改动前一致；附件/代码评论等既有 `allowSubmitWhenEmpty` 场景不受影响。

单元测试：`packages/ui/test/composerQueueSendNowShortcut.test.ts`
（覆盖空队列、guide 投影、reserved/promoting 顺延、预览截断）。
