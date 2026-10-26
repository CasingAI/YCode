# Spec: model-only steer 注入的冷恢复轮归属一致性

## 目标

后台任务通知 / 子智能体回复在**主 agent 轮运行中**到达时，live 链路把通知合流进当前轮
（`drainPendingRuntimeCommandsForActiveLoop`，不产生新的 TurnStarted）。但冷恢复
（重启 / 远端回放的水合路径 `synthesizeEventsFromMessages`）过去把一切 model-only 唤醒
触发都当**新轮边界**，合流的通知被切成独立的唤醒轮——用户看到的是「运行时主 agent 连续
工作，重开软件后变成碎掉的一段一段」。本 spec 消除这个 live/cold 轮归属差异：
**live 是什么样，重新打开就是什么样。**

```
live（连续链路）                       冷恢复（本 spec 之后）
────────────────                      ─────────────────────
user msg → TurnStarted                user msg → TurnStarted
assistant 产出…                        assistant 产出…
steer 通知到达（无 TurnStarted）        [持久化的 steer 通知消息：跳过，不切轮]
assistant 产出…（同一轮）               assistant 产出…（归入同一轮）
TurnCompleted（单轮收口）              TurnCompleted（单轮收口）
```

## 现状与根因

- runtime 落库 steer 通知时（`persistBackgroundTaskNotificationBatch(midTurn=true)` /
  `persistSubagentMessageCommand(midTurn=true)`），消息 metadata 已带上
  `inputPresentation: "task_notification_steer" | "subagent_reply_steer"`、
  `source: "background_task" | "subagent_message"`、`visibility: "model-only"`。
- 冷恢复的轮边界判据 `getConversationModelOnlyTurnTriggerSource`
  （`packages/shared/src/conversation-message-projection-policy.ts`）只看 `source`，
  不消费 `inputPresentation`，于是 steer 与空闲唤醒无法区分，统一按边界切轮。
  `transcript-hydration.ts` 的 `isTurnBoundaryStarter` 注释曾把这记为「已知差异」。

## 产品规则

- **轮归属的唯一事实源是落库的 `inputPresentation`。**
  `task_notification_steer` / `subagent_reply_steer` 表示 live 合流进当时正在跑的轮；
  `task_notification` / `subagent_reply` 表示空闲唤醒另起的独立轮。runtime 写入，投影只读。
- **冷恢复对 steer 型不切轮**：不合成 TurnStarted、不产生唤醒轮标题行，消息本身照旧
  跳过（provider-context-only，无用户气泡），其后的 assistant 产出归入当前轮，直到下一个
  真实轮边界。
- **空闲唤醒行为不变**：非 steer 的 model-only 唤醒仍开独立轮（origin `backgroundResult`
  等），`originMeta` 标题行照旧。
- **legacy 数据回退现状**：`inputPresentation` 缺失的旧消息无法区分合流与否，仍按边界
  处理（内容不丢、无气泡的底线不变，仅轮归属维持旧行为）。
- **判据收敛在 shared policy 单点**：steer 豁免收进 `getConversationModelOnlyTurnTriggerSource`
  的语义（「会启动独立 model-only 轮的来源」），live/cold 共用，不在水合调用点各写一份豁免。

## 接口

- `packages/shared/src/conversation-message-projection-policy.ts`
  - 新增导出 `isConversationSteeredRuntimeInjection(message)`：按
    `info.metadata.inputPresentation`（回退 `parts[].metadata.inputPresentation`，与
    `messageSource` 同款取值链）判定是否 steer 型运行时注入。
  - `getConversationModelOnlyTurnTriggerSource` 对 steer 型返回 `null`。
- `apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/transcript-hydration.ts`
  - `isTurnBoundaryStarter` 与主循环唤醒轮分支自动跟随新判据；更新注释，删除
    「已知差异」caveat。
- 不改协议、不改 runtime 落库格式、不改 UI。

## 状态与时序

```
所有者：runtime（写 inputPresentation）→ 持久 transcript → 水合投影（读，判定轮归属）

live:  后台任务完成 → enqueueRuntimeCommand(task-notification)
         ├─ 主轮运行中 → modelStep 边界 steer：落库 inputPresentation=*_steer（无 TurnStarted）
         └─ 空闲        → runTaskNotificationBatch：落库 inputPresentation=task_notification
                          + TurnStarted(origin=backgroundResult, originMeta)
cold:  synthesizeEventsFromMessages 遍历持久消息
         ├─ real user starter → 开轮 → collectTurnOutput
         │     └─ 遇 steer 型消息：跳过（非边界、非 assistant），同轮继续
         └─ 非 steer 唤醒 → 开 model-only 唤醒轮（现状不变）
```

## 验收场景

1. 轮中间的 `task_notification_steer` 通知：水合后恰一个 turnHeader（origin `userInput`），
   无 `backgroundResult` 轮，通知前后的 assistant 文本行属于同一轮。
2. 空闲唤醒型（`task_notification` + originMeta）：仍切出独立 `backgroundResult` 轮，
   `originMeta`（backgroundSource/title/workId）原样回放。
3. 无 `inputPresentation` 的 legacy 通知消息：仍按边界切轮（回退兼容）。
4. `subagent_reply_steer`：与后台通知同款，轮中间不切轮。
