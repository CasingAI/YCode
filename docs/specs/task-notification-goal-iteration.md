# goal 迭代间不发"任务完成"通知与音效

## 问题

goal 自主循环的一轮迭代由两段收口组成：迭代 turn 的 `TurnComplete`（phase 落 `completedSuccess`，goal 仍 `active`），以及紧随其后的完成校验轮（verifier）收口。verifier 判定"目标未完成"时，校验轮同样以成功结束，摘要再次落到 `(phase=completedSuccess, goalStatus=notSatisfied)`，随后续跑下一轮迭代把 phase 拉回 `running`。

sessions-index 摘要的 phase 在这两处短暂处于终态。任务通知编排（`packages/ui/src/lib/taskNotificationOrchestrator.ts` 的 `collectTerminalTaskNotificationPayloads`）只检测 phase 终态边沿，于是每一轮迭代的中间态都被当成"任务完成"，弹出系统通知并播放完成音效——用户看到的是"第 N 次迭代 · 目标未完成，任务继续"，听到的却是完成音。verifier 是一次真实模型调用，耗时以秒计，这帧终态必然被 renderer 观察到，conflation 合并不掉；窗口未聚焦时（Desktop/Web 通知仅在失焦时派发）音效随之响起。

真正的任务完成对应 `(phase=completedSuccess, goalStatus=verified)`；本 spec 消除的是"goal 仍会自动继续迭代"与"完成通知"的错配。

## 产品规则

1. **goal 仍会自动继续迭代时，不发"任务完成"终态通知，不播音效。** 静默集合：通知 status 为 `completed` 且摘要 `goalStatus ∈ {active, verifying, notSatisfied}`。`active`/`verifying` 是迭代正在推进，`notSatisfied` 是 verifier 判定未完成、下一轮已在路上。
2. **`verified` 保持现状。** 目标通过校验才是真完成，正常通知 + 音效。
3. **`paused` 保持现状。** 用户 stop 使 target 进入 paused，任务真的停了，保留通知提醒。
4. **失败通知一律不静默。** `phase=error`（含 verifier `failed_closed` → goal `failed`）即使 goal 仍 active 也正常发 failed 通知——任务挂了用户必须知道。
5. **`goalStatus` 缺席（undefined）保持现状。** 普通会话、旧 CLI / 旧 sessions-index frame 没有该字段，通知行为不变。
6. **同相去重只对"上一帧真的通知过完成"生效。** verifier 通过产生的 `(completedSuccess, verified)` 帧与上一帧（被静默的迭代中间态）phase 相同，若沿用"phase 相同即跳过"的旧去重，真完成将永远不会通知。因此：上一帧处于静默集合（active/verifying/notSatisfied）视为未通知，本帧 `(…, verified)` 正常补发；校验中用户 stop 落到的 `(completedInterrupted, paused)` 同理补发。上一帧本身已通知过完成（如普通会话重复的终态帧）则照旧去重，不刷屏。
7. **只收口通知编排层。** 迭代间 turn 收口落 `completedSuccess` 是投影层的既有语义，侧栏、工时、任务行展示都在消费它，本 spec 不改 phase 行为；修复收敛在 `collectTerminalTaskNotificationPayloads` 一处（Desktop 与 Web 的 platform 层共用同一编排输出）。

## 状态所有者

- `goalStatus` 的唯一事实源是 sessions-index 摘要，由 `apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/sessions-index-projection.ts` 从 `snapshot.goal.status` 派生，与 `phase` 同窗口同源更新，通知编排可直接信赖，不需要二次查询会话快照。
- 通知边沿状态（上一帧摘要）仍归 `useTaskNotifications` 的 `previousBySessionIdRef` 所有；本 spec 不改变边沿检测方式，只在其输出处增加 goal 继续性判定。

## 验收场景

- goal 迭代 turn 收口（`completedSuccess` + `active`）：不产生 completed 通知，无音效。
- verifier 判定未完成收口（`completedSuccess` + `notSatisfied`）：不产生 completed 通知，无音效——即"第 N 次迭代 · 目标未完成，任务继续"分隔线出现时不再响完成音。
- verifier 进行中（`completedSuccess` + `verifying`）：不产生 completed 通知。
- verifier 判定通过（`completedSuccess` + `verified`，上一帧为被静默的迭代中间态）：正常产生 completed 通知 + 音效；verified 帧重复下发不重复通知。
- 用户 stop 使 target 暂停（`completedInterrupted` + `paused`，无论上一帧是 running 还是被静默的校验中间态）：正常产生 completed（interrupted）通知 + 音效。
- 迭代中任务失败（`error` + `active`）：正常产生 failed 通知。
- 无 goal 的普通会话（`completedSuccess` + `goalStatus` 缺席）：正常产生 completed 通知，重复终态帧照旧去重，行为与现状一致。
