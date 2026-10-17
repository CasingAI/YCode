# 延时任务

## 产品规则

自动化管理在既有「自动化 / 工作流」顶级结构内新增「定时任务 / 延时任务 / 闲时任务」三类。延时任务是 Automation 的持久化分类，不是新调度器或 Off-Peak 队列。定时、延时共享现有 20 条 Automation 上限；闲时任务维持独立服务与准入。

延时任务从服务端接受创建或重新安排命令时开始倒计时。创建输入为正整数分钟，最大 525600 分钟；UI 以分钟、小时、天呈现并默认 2 小时。延时计划固定一次执行，不重复。记录类别、原始时长和绝对计划时间；无法识别来源的历史任务不迁移。显式 `relativeDelayMinutes` 的会话创建自动标记 delay。

延时任务沿用 Automation 项目、指令、模型、权限、暂停/恢复、删除、执行派发和运行历史。暂停保留目标时间；恢复沿用当前 Automation 生命周期语义。未开始派发时修改延迟会从服务端保存时间重新倒计时，并在一次数据库事务中改目标时间、重试/认领状态与生命周期。派发已认领（running）时拒绝修改时长或其它字段，且所有延时任务定义编辑都必须在事务内检查认领状态，避免覆盖并发认领。已完成或错过（missed）的延时任务仅在用户显式提交延时时长时重新安排新计划，保留旧运行历史，并以新目标时间生成新的 scheduled run ID；missed 不提供不带新时长的普通重启入口。

## 状态和所有者

- `AutomationService` 是创建、修改、校验与服务端时钟归一化的业务所有者。
- `AutomationRepo` 是 automations 与 automation_runs 的唯一持久化及原子认领所有者。
- Desktop Scheduler 继续负责到期认领、派发、失败重试与错过判定；不增加进程或另一种队列。
- UI store 保存展示快照，不创建第二套调度状态；分类、卡片剩余时间均由持久化 Automation 派生。
- Off-Peak 服务不参与延时任务。

```text
创建/重设表单 → UI 校验 → Automation RPC → AutomationService(服务端 now)
  → AutomationRepo 原子写类别/分钟/nextRunAt → 既有 Scheduler claimDue
  → runId(automationId:scheduledAt) 幂等台账 → Main/Host 派发 → run outcome 回写
```

## 错过处理与失败语义

延时任务到期后正常按既有原子认领最多产生一个 scheduled run。相对延时的一次性计划有 24 小时补执行期限：恢复时若目标时间距当前时间不超过 24 小时，允许补派发一次；超过期限则写入 `skipped` run 并把 Automation 标记为 `missed` 终态，不派发且不显示为成功。普通定时任务仍使用既有 5 分钟 misfire 窗口。`dispatched` 只表示成功交给 Host，不代表执行 outcome 成功；卡片状态/历史分别呈现派发和 outcome。

Scheduler 重试复用相同 scheduledAt/runId；认领崩溃回收不得创建新目标时间。已被认领的计划不可通过编辑时间撤销已开始的派发。暂停或删除仍沿用 Automation 既有命令语义。

每个派发回执必须仅结算发出该回执的原始计划认领。Scheduler 必须保留不可变的 `runId + scheduledAt`；成功和失败结算都必须以该标识和当前计划认领作为原子条件。迟到或重复回执不得清除、推进或计数较新的计划；scheduler 重启后无法确认回执仍对应当前认领时，必须忽略该回执。

回归测试覆盖旧计划回执在新计划已认领后到达、同一回执重复到达，以及重启后无法恢复在途上下文的情况。

## 持久化和兼容迁移

在 `automations` 增加 `schedule_type`（scheduled/delay）与 `delay_minutes`。新建普通日程及迁移旧记录默认 scheduled。只有经当前创建请求明确给出 `relativeDelayMinutes` 的任务写 delay；已存在的一次性任务和历史记录不推断来源。更新只允许对 schedule_type=delay 的记录传 delayMinutes。会话工具显式 `delayMinutes` 创建归入 delay；普通 CronCreate 保持 scheduled。

在 automation 生命周期增加 missed 终态并同步共享领域类型、严格协议校验、UI 展示。数据库通过新增冻结 checksum 的后续 migration 加列，不修改已发布迁移定义或 checksum。

## UI 与验收场景

延时列表恒可见，不依赖是否已有任务；与定时卡片复用视觉和状态筛选，展示目标时间和递减剩余时间。空列表提供「新建延时任务」入口。创建/编辑页复用现有项目、模型、权限和指令编辑控件，延时专属控件只包含正整数、分钟/小时/天；无 Cron、周期和结束条件。

代表性验收：

1. 创建默认 2 小时延时，服务端保存的 `nextRunAt` 基于创建服务的 `Date.now()`，类别和 120 分钟均持久化。
2. 非法零、负数、小数和超过 525600 分钟被协议/服务拒绝；延时请求强制单次执行。
3. 修改未认领的 delay 时间从修改服务端时间重新计时，数据库只保留一个下一次计划；并发调度认领先发生时更新拒绝。
4. 到期 scheduler 认领/重复 tick/重启认领恢复只对应同一 runId，成功派发后不再入队。
5. 目标落后不足 24 小时恢复后仅补派发一次；超过 24 小时标记 missed 和 skipped run；普通 scheduled misfire 行为不变。
6. 会话显式 delayMinutes 进入 delay；历史来源不明的一次性 Automation 仍为 scheduled。
7. 定时与延时共同计入 20 条上限；Off-Peak 创建、准入和队列不变。
8. 延时 tab 在空态可见，状态筛选及深链接可到达；卡片显示正确状态、时间和剩余时长。
