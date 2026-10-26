# goal 迭代间不发"任务完成"通知与音效

## 问题

goal 自主循环的一轮迭代由两段收口组成：迭代 turn 的 `TurnComplete`（phase 落 `completedSuccess`，goal 仍 `active`），以及紧随其后的完成校验轮（verifier）收口。verifier 判定"目标未完成"时，校验轮同样以成功结束，摘要再次落到 `(phase=completedSuccess, goalStatus=notSatisfied)`，随后续跑下一轮迭代把 phase 拉回 `running`。

sessions-index 摘要的 phase 在这两处短暂处于终态。任务通知编排（`packages/ui/src/lib/taskNotificationOrchestrator.ts` 的 `collectTerminalTaskNotificationPayloads`）只检测 phase 终态边沿，于是每一轮迭代的中间态都被当成"任务完成"，弹出系统通知并播放完成音效——用户看到的是"第 N 次迭代 · 目标未完成，任务继续"，听到的却是完成音。verifier 是一次真实模型调用，耗时以秒计，这帧终态必然被 renderer 观察到，conflation 合并不掉；窗口未聚焦时（Desktop/Web 通知仅在失焦时派发）音效随之响起。

真正的任务完成对应 `(phase=completedSuccess, goalStatus=verified)`；本 spec 消除的是"goal 仍会自动继续迭代"与"完成通知"的错配。

目标状态与回合结局是两个不同事实。`TargetChanged(paused)` 只改变 goal，不证明本轮被取消。例如运行中切到 plan/readonly 会暂停目标，但当前回合仍应正常结束。通知层不能仅凭 goal 变为 `paused` 判定停止；暂停与成功更新合帧时，这种判定会吞掉真实完成通知。

另一种需要静默的情况是：上一帧已经为 `completedSuccess`，本帧仅把迭代中的 goal 改为 `paused`，没有新的成功边沿，不应补发完成通知。真正的停止与成功竞态由 Core 的终态准入裁决，见 `docs/specs/stop-success-terminal-arbitration.md`，不在通知层猜测停止意图。

## 产品规则

1. **goal 仍会自动继续迭代时，不发"任务完成"终态通知，不播音效。** 静默集合：通知 status 为 `completed` 且摘要 `goalStatus ∈ {active, verifying, notSatisfied}`。`active`/`verifying` 是迭代正在推进，`notSatisfied` 是 verifier 判定未完成、下一轮已在路上。
2. **`verified` 保持现状。** 目标通过校验才是真完成，正常通知 + 音效。
3. **已接受的用户 stop 保持静默。** Core 将被取消的回合或 verifier 收口为 `completedInterrupted`（goal 常为 `paused`），不发终态通知、不播音效。成功已经进入事件提交的阶段不可撤销，后到 stop 为 noop，不追加取消终态。
   - 上一帧已经是 `completedSuccess`、本帧仍为 `completedSuccess`，且 goal 从迭代态转入 `paused`：只有目标状态变化，没有新的成功事实，不补发完成通知。
   - 上一帧为 `running`、本帧为 `completedSuccess`：这是新的成功边沿。即使 goal 同时变为 `paused`，也不能据此静默。运行中切 plan/readonly 后正常完成，无论暂停与成功分帧还是合帧，完成通知行为一致。
   - goal 已经处于 `paused` 时用户新提交一轮并正常完成，仍按真完成通知。
4. **失败通知一律不静默。** `phase=error`（含 verifier `failed_closed` → goal `failed`）即使 goal 仍 active 也正常发 failed 通知——任务挂了用户必须知道。
5. **`goalStatus` 缺席（undefined）保持现状。** 普通会话、旧 CLI / 旧 sessions-index frame 没有该字段，通知行为不变。
6. **同相去重只对"上一帧真的通知过完成"生效。** verifier 通过产生的 `(completedSuccess, verified)` 帧与上一帧（被静默的迭代中间态）phase 相同，若沿用"phase 相同即跳过"的旧去重，真完成将永远不会通知。因此：上一帧处于静默集合（active/verifying/notSatisfied）视为未通知，本帧 `(…, verified)` 正常补发。上一帧本身已通知过完成（如普通会话重复的终态帧）则照旧去重，不刷屏。`completedInterrupted` 不产出通知，不参与完成去重。
7. **通知与执行结果各有唯一职责。** 迭代间成功 turn 落 `completedSuccess` 是投影层的既有语义，本 spec 不改它，也不让 goal 暂停伪造中断。通知规则收敛在 `collectTerminalTaskNotificationPayloads`（Desktop 与 Web 共用输出）；Core 另按 `stop-success-terminal-arbitration.md` 修复停止与成功的裁决。

## 状态所有者

- `goalStatus` 的唯一事实源是 sessions-index 摘要，由 `apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/sessions-index-projection.ts` 从 `snapshot.goal.status` 派生，与 `phase` 同窗口同源更新，通知编排可直接信赖，不需要二次查询会话快照。
- 通知边沿状态（上一帧摘要）仍归 `useTaskNotifications` 的 `previousBySessionIdRef` 所有；本 spec 不改变边沿检测方式，只在其输出处增加 goal 继续性判定。

## 验收场景

- goal 迭代 turn 收口（`completedSuccess` + `active`）：不产生 completed 通知，无音效。
- verifier 判定未完成收口（`completedSuccess` + `notSatisfied`）：不产生 completed 通知，无音效——即"第 N 次迭代 · 目标未完成，任务继续"分隔线出现时不再响完成音。
- verifier 进行中（`completedSuccess` + `verifying`）：不产生 completed 通知。
- verifier 判定通过（`completedSuccess` + `verified`，上一帧为被静默的迭代中间态）：正常产生 completed 通知 + 音效；verified 帧重复下发不重复通知。
- 用户主动 stop（`completedInterrupted` + `paused`，无论上一帧是 running 还是校验中间态）：不产生通知，无音效。
- 迭代轮已成功收口后仅暂停目标（上一帧 `completedSuccess` + `active/notSatisfied`，本帧 `completedSuccess` + `paused`）：不补发完成通知，无音效；这不构成新的回合取消事实。
- 运行中切入 plan/readonly 暂停 goal，当前回合正常成功收口：暂停与完成分帧或合帧，都正常产生一次 completed 通知。
- goal 已处于 `paused` 时用户新提交一轮并完成（上一帧 `running` + `paused`，本帧 `completedSuccess` + `paused`）：正常产生 completed 通知 + 音效。
- goal 刚暂停但回合真实失败（`error` + `paused`）：正常产生 failed 通知，重复失败帧去重。
- 迭代中任务失败（`error` + `active`）：正常产生 failed 通知。
- 无 goal 的普通会话（`completedSuccess` + `goalStatus` 缺席）：正常产生 completed 通知，重复终态帧照旧去重，行为与现状一致。
