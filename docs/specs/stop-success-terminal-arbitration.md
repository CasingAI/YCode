# 停止与成功终态的单一裁决

## 目标与范围

停止被当前执行接受后，该执行阶段必须以取消收口，不能再发成功终态或完成音。真正已经进入成功事件提交的阶段不撤销、不追加取消终态；此时停止请求不算已接受的取消。普通回合、UserPromptSubmit 提前结束、失败回合续跑、目标完成校验，以及复用前台回合入口的手动 `/compact`、`/rewind` 共用这条规则。独立的文件回退接口不产生回合成功终态，不纳入此裁决。

本次不改变任务列表持久化状态枚举，不将 goal 暂停等同于回合中断，不改权限/输入通知、音效设置或历史任务。不根据历史队列标识推断自动续跑故障，不扩大为队列调度重构。

## 状态所有者与接口

- CLI Core 的 runtime foreground execution 是停止与终态准入的唯一所有者。沿用 `foregroundExecutionId`、controller 和既有命令队列；不在 Renderer、Host 或通知层维护另一份已接受停止状态。
- 一次前台 command 可以包含回合、verifier 和 continuation 等多个阶段。成功提交保护只覆盖当前阶段，结束后释放，不能使后续 goal work 永久不可停止。
- `stopActiveForegroundExecution` 保留 expected execution id 校验。目标不匹配时 noop，不取消新执行；成功阶段已经进入提交时返回内部 `completed` 结果，不 abort、不暂停 goal、不改变队列授权。
- `completed` 是 Core/Bootstrap 内部裁决结果，不新增 RPC payload 或 UI 状态。Bootstrap 通用 stop 不得将其降级到 legacy abort；内部抢占需按当前执行/成功提交边界等待或继续调度，不得忽略其后仍可取消的 goal work。
- 成功事件的准入由同步操作完成：先检查本轮及当前 execution 的取消信号，再保护成功提交，中间不得 await。准入紧邻成功事件 append，在 goal 记账、持久化边界和浏览器截图等可取消收尾之后，不能提前把这些收尾时间变为不可停止窗口。

## 事件顺序

```text
用户停止 / 内部抢占
  -> Core foreground execution（同一 execution id，唯一裁决）
       |-- 停止先到：abort
       |      -> 成功准入拒绝
       |      -> TurnComplete(cancelled) / verification(cancelled)
       |      -> 投影 completedInterrupted -> 通知静默
       |
       `-- 成功事件准入先到：同步进入提交保护
              -> 后到 stop 为 completed noop，不 abort
              -> 成功事件只提交一次 -> 清理并释放保护
              -> 后续 verifier / continuation 重新可停
```

Desktop `desktop-continuous` 与手机 `web-remote-replayable` 消费同一 Core 结果。背压合帧或恢复时只保留最终摘要也不得把取消解释成成功。

## 产品规则与不变量

1. **已接受停止不是成功。** 模型返回后、普通回合收尾 await、hook 提前结束、resume 收尾、verifier 的 ModelComplete/usage await 期间，成功准入前收到停止都走取消。不存在 goal 时同样适用。
2. **成功提交不可被晚到停止改写。** 从成功事件准入到该阶段必要持久化结束，后到的 stop 不应 abort 或产生第二终态。原输入/执行身份保持不变。
3. **真实错误仍可见。** append 完全失败时不能因提交保护而丢失错误收口。事件已经写入但后续投递/清理失败时，不追加矛盾的取消或失败终态；沿用日志报告故障。晚到 abort 不得将提交期间的真实错误伪装成用户取消。
4. **目标状态与回合结果正交。** 运行中切入 plan/readonly 可暂停 goal 而不打断本轮；本轮成功结束仍是成功。`TargetChanged(paused)` 只改变 goal，不能据此伪造 `completedInterrupted`。
5. **通知不推断停止意图。** `completedInterrupted` 一律静默；`error` 正常失败通知。`running -> completedSuccess` 是新的成功边沿，即使 goal 同时变 paused，仍按正常完成通知。上一帧已经为 completedSuccess、仅 goal 从迭代态变 paused 时不补发完成通知，因为没有新的成功事实。
6. **既有队列与抢占边界保留。** 真正用户 stop 按现有规则 hold 排队输入；`sendQueuedNow` 内部抢占保留 `preserveQueueAutoDrainOnCancel`。手动 compact 的 Bootstrap 收口同样消费 Core 的取消事实与队列授权，不能把已接受的内部抢占记成失败或再次 hold 队列。成功提交阶段的 noop 不得改写该位，也不能通过 legacy controller 绕过裁决。owner/lease 和 stale execution 防护不变。
7. **阶段保护必须释放。** 下一轮、verifier 和 continuation 不继承上一阶段的成功提交保护。父 signal、真实错误和无前台 owner 的直调路径仍按现有错误类型及取消规则裁决。

## 验收与测试边界

- 用可控 Promise 阻塞真实回合收尾：停止先到，只记录 cancelled，无 success，无完成通知；不能仅测试 helper 的返回值。
- 分别覆盖普通成功、UserPromptSubmit 提前结束、失败回合续跑、verifier pass/notSatisfied，以及手动 `/compact`、`/rewind` 的成功提交与收尾故障。
- 内部抢占手动 compact 时，取消生命周期、preserve 队列授权与 Core 终态一致；用户 stop 仍按原规则 hold 队列。
- 成功事件 append 已开始时停止：返回 completed，不 abort，无第二终态；完全未写入失败和已写入后投递失败分别验证。
- verifier pass 的保护覆盖 goal complete 持久化；notSatisfied 后的 continuation 可再次停止。
- Bootstrap handler 覆盖匹配、idle、mismatch、completed；completed 不得 pause goal、hold queue 或 abort legacy controller。
- 用户 stop 后投影为 completedInterrupted，排队输入保留且 autoDrain=false；内部抢占不误关原授权。
- 真实投影/索引发布覆盖 Desktop continuous 与 Web replayable 的单帧、背压合帧：取消最终摘要仍为 completedInterrupted；正常模式切换后成功最终摘要为 completedSuccess+paused。
- UI 测试覆盖暂停与成功分帧/合帧都只通知一次；目标迭代中间态静默、verified 补发、失败通知与普通完成保持。
- 不经授权操作运行中的 YCode、UI 自动化或调试协议。交互语义通过隔离的命令/运行时/投影测试验证，未执行真实界面端到端验证时明确说明。
