# goal 迭代间不发"任务完成"通知与音效

## 问题

goal 自主循环的一轮迭代由两段收口组成：迭代 turn 的 `TurnComplete`（phase 落 `completedSuccess`，goal 仍 `active`），以及紧随其后的完成校验轮（verifier）收口。verifier 判定"目标未完成"时，校验轮同样以成功结束，摘要再次落到 `(phase=completedSuccess, goalStatus=notSatisfied)`，随后续跑下一轮迭代把 phase 拉回 `running`。

sessions-index 摘要的 phase 在这两处短暂处于终态。任务通知编排（`packages/ui/src/lib/taskNotificationOrchestrator.ts` 的 `collectTerminalTaskNotificationPayloads`）只检测 phase 终态边沿，于是每一轮迭代的中间态都被当成"任务完成"，弹出系统通知并播放完成音效——用户看到的是"第 N 次迭代 · 目标未完成，任务继续"，听到的却是完成音。verifier 是一次真实模型调用，耗时以秒计，这帧终态必然被 renderer 观察到，conflation 合并不掉；窗口未聚焦时（Desktop/Web 通知仅在失焦时派发）音效随之响起。

真正的任务完成对应 `(phase=completedSuccess, goalStatus=verified)`；本 spec 消除的是"goal 仍会自动继续迭代"与"完成通知"的错配。

用户主动 stop 还有第二种收口形态：停止落在刚收口的迭代轮之后，phase 已经是 `completedSuccess`，此时 stop 把 goal 置为 `paused`，但投影层改 goal 状态时不改 phase（`product-projection.ts` 的 `onTargetChanged` 默认分支只发 goalPatch）。摘要因此落到 `(phase=completedSuccess, goalStatus=paused)`：完成相位是上一轮迭代收口的延续，停止并没有产生新的完成事实，但编排层只按 phase 判终态，这一帧会被当成"真完成"补发完成通知并播放完成音——用户点下停止按钮的同时听到完成声。

## 产品规则

1. **goal 仍会自动继续迭代时，不发"任务完成"终态通知，不播音效。** 静默集合：通知 status 为 `completed` 且摘要 `goalStatus ∈ {active, verifying, notSatisfied}`。`active`/`verifying` 是迭代正在推进，`notSatisfied` 是 verifier 判定未完成、下一轮已在路上。
2. **`verified` 保持现状。** 目标通过校验才是真完成，正常通知 + 音效。
3. **用户主动 stop 保持静默。** 停止有两种收口形态，都不发终态通知、不播音效；停止是用户已知的操作，不需要再提醒。
   - 停止打断正在运行的回合：phase 落 `completedInterrupted`（goal 常为 `paused`），`completedInterrupted` 一律静默。
   - 停止落在刚收口的迭代轮之后：phase 已是 `completedSuccess`，stop 把 goal 置为 `paused`，完成相位是上一轮迭代收口的延续，这一轮没有新的完成事实，同样静默。判据落在"goal 从其他状态转入 `paused`"这一帧上——goal 状态发生变化的那一帧不补发完成通知。
   - `paused` 本身不是静默条件：goal 已经处于 `paused` 时，用户新提交一轮并正常完成，仍按真完成通知（那一轮是新的完成事实）。
4. **失败通知一律不静默。** `phase=error`（含 verifier `failed_closed` → goal `failed`）即使 goal 仍 active 也正常发 failed 通知——任务挂了用户必须知道。
5. **`goalStatus` 缺席（undefined）保持现状。** 普通会话、旧 CLI / 旧 sessions-index frame 没有该字段，通知行为不变。
6. **同相去重只对"上一帧真的通知过完成"生效。** verifier 通过产生的 `(completedSuccess, verified)` 帧与上一帧（被静默的迭代中间态）phase 相同，若沿用"phase 相同即跳过"的旧去重，真完成将永远不会通知。因此：上一帧处于静默集合（active/verifying/notSatisfied）视为未通知，本帧 `(…, verified)` 正常补发。上一帧本身已通知过完成（如普通会话重复的终态帧）则照旧去重，不刷屏。`completedInterrupted` 不产出通知，不参与完成去重。
7. **只收口通知编排层。** 迭代间 turn 收口落 `completedSuccess` 是投影层的既有语义，侧栏、工时、任务行展示都在消费它，本 spec 不改 phase 行为；修复收敛在 `collectTerminalTaskNotificationPayloads` 一处（Desktop 与 Web 的 platform 层共用同一编排输出）。

## 状态所有者

- `goalStatus` 的唯一事实源是 sessions-index 摘要，由 `apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/sessions-index-projection.ts` 从 `snapshot.goal.status` 派生，与 `phase` 同窗口同源更新，通知编排可直接信赖，不需要二次查询会话快照。
- 通知边沿状态（上一帧摘要）仍归 `useTaskNotifications` 的 `previousBySessionIdRef` 所有；本 spec 不改变边沿检测方式，只在其输出处增加 goal 继续性判定。

## 验收场景

- goal 迭代 turn 收口（`completedSuccess` + `active`）：不产生 completed 通知，无音效。
- verifier 判定未完成收口（`completedSuccess` + `notSatisfied`）：不产生 completed 通知，无音效——即"第 N 次迭代 · 目标未完成，任务继续"分隔线出现时不再响完成音。
- verifier 进行中（`completedSuccess` + `verifying`）：不产生 completed 通知。
- verifier 判定通过（`completedSuccess` + `verified`，上一帧为被静默的迭代中间态）：正常产生 completed 通知 + 音效；verified 帧重复下发不重复通知。
- 用户主动 stop（`completedInterrupted` + `paused`，无论上一帧是 running 还是校验中间态）：不产生通知，无音效。
- 用户在迭代轮收口后点 stop（上一帧 `completedSuccess` + `active`，本帧 `completedSuccess` + `paused`）：不产生通知，无音效。
- goal 已处于 `paused` 时用户新提交一轮并完成（上一帧 `running` + `paused`，本帧 `completedSuccess` + `paused`）：正常产生 completed 通知 + 音效。
- 迭代中任务失败（`error` + `active`）：正常产生 failed 通知。
- 无 goal 的普通会话（`completedSuccess` + `goalStatus` 缺席）：正常产生 completed 通知，重复终态帧照旧去重，行为与现状一致。
