# 子代理 Fork 继承与执行隔离

## 目标与范围

普通历史 Fork、stable Fork、compact-edit Fork 以及仍可调用的 checkpoint/legacy Fork 必须使用同一策略：在 Fork 历史边界复制其可证明的子代理恢复图，生成完全独立的 Agent/child 身份与分支别名。不得共享可写 child transcript、复制运行实例或恢复 pending queue、Promise、abort handle、未完成工具执行；child 仍禁止新建子代理。权限和平台连接由当前父 Runtime 按现有策略建立，不从历史恢复授权。

## 状态所有者与接口

- SessionStore 是身份、父子归属、不可变历史检查点、别名和跨 Runtime 执行 claim 的唯一持久权威。
- Core 决定 Fork 历史范围、遍历并验证快照图、重映射身份，并通过现有 Fork bundle 发起一次提交。
- SQLite adapter 在一致读取、事务约束及条件写入中实现持久化和 fencing。
- RuntimeTaskRegistry 只持有本地执行句柄和派生状态；不得作为跨 Runtime 锁。
- 目录、tool row、事件及导航从当前父会话解析别名，不从历史文本/metadata/旧命名直接打开源 child。

## 历史边界与失败语义

子代理完整恢复检查点必须包含版本、真实所属父 session、创建工具调用、物理 agent/child 身份、可恢复配置版本、边界内完整历史载荷及递归子检查点引用。检查点不可变，后续 message/part 更新不得改变已锚定内容。父历史锚点固化前确保 child 检查点已持久化；运行 child 仅引用不晚于父边界的最后完整检查点，不等待任务结束，不带入未完成 tool call。边界后的新 child 排除。

检查点载荷是 child 在父历史锚点时刻可证明的前缀：首条 realUser user prompt 及其之前的初始化事件；之后追加的执行历史不进入快照，也不读取最新历史补齐。检查点登记由 SessionStore 的 checkpoint resolver 统一负责：解析 Fork 图时，对边界内创建、缺失检查点且同时具备 `subagent_identity`、父 realUser 锚点与 child 消息的 child，按同一确定性规则惰性重建并持久化；已存在的检查点保持不可变。边界判定使用 Fork 边界消息的完成时刻（assistant）或创建时刻（user）圈定候选 child；边界之后创建的 child 不要求检查点、不阻断更早历史的 Fork，也不进入复制图。

遍历校验所有权、配置可恢复性、节点完整性、无循环及可重建内容。旧记录仅在持久证据能证明所有权与边界前缀时兼容；时间戳仅辅助圈定候选范围。缺失、损坏、循环或证据不足（含缺少首条 realUser prompt）均使整个 Fork 明确失败并指出子代理与原因，不静默跳过。无子代理旧会话保持原行为。

启动即失败的派发会留下「有 child 会话行与身份、没有任何 message/part」的 child：它在模型准入阶段就被拒绝，从未产出转写，因而没有可继承历史。这类 child 不属于「证据不足」：Fork 不复制它的身份、不为它建立分支别名，也不因它阻断 Fork；父转写里的失败记录照常复制。判据只看转写是否为空（既无 message 也无 part），不看失败原因、时间戳或额外标记，因此不需要新增失败态字段。

对有转写的 child，证据要求只施加在真正进入复制图的那些：child 的可证明父 realUser 锚点落在本次 Fork 的可继承锚点集合之外时，它本来就会被复制图排除，因此既不写检查点也不阻断 Fork；该判据与复制图自身的筛选是同一套，不另立「是否在范围内」的第二标准。锚点无法证明（缺身份、缺首条 realUser prompt、缺父锚点）仍然让 Fork 明确失败并指出子代理与原因。

父转写中引用的历史 agentId 在新分支里解析不到物理 child（父归属不符）时按既有路由规则明确拒绝，不回退打开源 child。

## 原子复制、身份与幂等

复用 `commitForkBundle` 同库事务写入父副本、递归 child 副本、配置、来源及分支别名，并与源命令事实去重。相同 sourceCommandId 重放返回首次结果；独立请求创建另一分支。各副本分配新 agentId/sessionId，记录来源及所属新父；来源仅供追溯，不形成级联删除依赖。别名键为 `(parentSessionId, historicalAgentId)`，多次 Fork 合成祖先别名到当前物理身份。新身份绑定源 child 必须在存储层拒绝。非数据库计划文件等资源沿用补偿流程，数据库失败不得留下可访问半成品；外部补偿失败须明确记录且不宣称跨文件系统原子性。

### 子代理历史的分支本地身份

Core 对每个进入复制图的 child 检查点，复用主会话 Fork 的身份预分配规则；先遍历该检查点的完整历史载荷和被历史快照引用的 verifier entries，再克隆消息、parts 与条目。消息、part（含已完成工具的附件）、tool call、turn、product turn，以及历史 Goal 快照中的 target、verification 和 verifier entry 引用，都必须映射到该 child 副本的本地身份。同一源身份在一次复制内只分配一次；再次 Fork 必须重新分配，不能复用源分支或上一分支的可写身份。

`anchor.turnId`、`anchor.productTurnId`、有序消息与边界消息引用、timeline 和 compaction 的本地锚点，必须使用对应类型的映射；不得用 tool call ID 代替 product turn ID。Goal boundary 仍是历史快照，不因本次修复新增 child Goal 运行状态或恢复执行；其 verifier 引用必须由检查点自带的条目证明。非 verifier 条目沿用现有复制规则，不通过字段名猜测扩展身份语义。

克隆保持严格引用校验。引用落在可证明历史之外，或引用的 verifier entry 缺失时，整个 Fork 在 `commitForkBundle` 前失败，错误保留具体原因并标明子代理；不得保留源本地引用、删除有效锚点、跳过该 child 或先写入部分分支。源检查点及其消息、parts、条目不得原地修改。旧数据继续经现有 resolver 证明边界，不迁移源 turn 身份，也不修改持久化格式、命令协议或执行 claim。

## 路由与执行权

发送、冷恢复、steer、终态续跑、停止及投影共用同一解析：当前父 session 解析历史别名 → 校验物理身份确属该父分支 → 校验 workspaceIdentity（本地路径仅按既有 fallback）→ 取得执行权后才投递/启动。缺少父信息时只接受可验证持久证据；同工作区不构成跨父采用依据。证据不足明确拒绝。

每个物理 child 有持久 claim：ownerRuntimeId、单调 fencing epoch、有效期。SQLite 原子 acquire/renew/release；初次执行和终态续跑均须 claim。新建子代理首次执行必须经 `initializeSubagentFirstExecution` 在同一事务内完成 child 落库、身份绑定、首次 Claim（P0 修复：child 行不存在时直接抢 Claim 必定失败，不得先抢后建，也不得只建不抢）。token 必须与 transcript、part、entry、终态及可变会话状态写入处于同一事务校验；事件和对外结果校验代次。失效 owner 停止本地执行、丢弃迟到回调，且不能释放新 owner claim。只拒绝跨 Runtime 冲突，不新增跨 Runtime 内存队列；当前 owner 继续复用既有串行 admission/queue。fencing 不撤销已经发生的外部工具副作用。

持有 claim 的前台 runner 同时拥有续租定时器。首次执行与终态续跑从取得 claim 后开始续租，续租间隔不得超过租期的三分之一；消息写入前的续租校验继续保留。续租返回 false 或抛错时，runner 必须中止本地 child 执行，不得自动重新取得 claim。runner 收尾时先停止并等待进行中的续租，再释放自己持有的 claim，防止释放后仍有迟到续租。进程崩溃或失联时定时器停止，租约自然过期后才允许其他 Runtime 接管。

模型请求失败时，assistant 错误消息持久化属于尽力而为的诊断记录。若该次写入因 claim 失效或其他持久化异常失败，必须记录持久化异常，但仍将原始模型执行错误返回给父 Agent；不得让持久化异常覆盖 provider 错误。

## 目录与恢复投影

目录、tool row、侧栏、会话跳转在当前父分支使用同一解析结果；历史 tool output、metadata、spawn event 和 legacy 命名不得回退打开原 child。运行中的源 child 不得让副本显示 running。desktop continuous 与 web-remote-replayable snapshot/recovery 读取同一分支事实，并保留 workspaceIdentity、remoteSessionId、owner/lease 与 stale-run 防护。

## 事件顺序

```text
child 完整检查点持久化（历史缺失时由 resolver 在边界内重建）
  → 父历史锚点固化快照图
  → Fork 读取并校验不可变图
  → Core 按同一规则预分配父与各 child 的独立本地身份/消息/别名映射
  → 严格克隆并校验全部本地引用（失败不进入提交）
  → commitForkBundle 同库事务提交整图与命令事实
  → 投影发布分支身份
  → 当前父 Runtime 显式消息取得持久 claim 后执行
```

## Fork 准入与失败反馈

Fork 目标是历史稳定边界，其正确性只取决于该边界是否仍可解析。父会话后续的结构性更新（包括运行中的工具、控制态与子代理状态变化）会推进 conversation revision，但不会使已完成的 Fork 目标失效，因此 `forkAssistant` 的准入不以 `baseRevision` 等于当前 revision 为前提。命令仍携带 `baseRevision` 供审计；CommandInbox 继续校验 `baseLogEpoch`（投影代际）与行目标可解析性，执行时由 stable resolver 再校验 Fork 边界。除 Fork 外，其他 CAS 命令的 revision 相等语义不变。

用户发起 Fork 后，命令 ACK 若为非 accepted/duplicate，或命令提交 Promise 被拒绝，SessionPane 必须通过现有 Toast 显示本地化失败原因；同时保留 warn 日志。失败详情优先取 ACK `message`（具体执行原因），缺失时回退 `reasonCode`/`status`，避免只显示 `fault.command.executionFailed` 这类泛化命名空间。只有收到带有 `forkAssistant` 结果的成功 ACK 才导航到 child session。失败不得静默处理。

## 验收

覆盖递归 bundle 原子回滚、相同请求重放与不同请求隔离、源删除后副本可用；历史内容不可变、边界筛选、running child 最后完整检查点、损坏/缺失/循环/证据不足失败；历史 child 缺检查点时按首条 user prompt 前缀惰性回填，边界后创建的 child 不阻断更早边界且缺 prompt/身份仍须失败；启动即失败、没有任何转写的 child 不阻断 Fork、不进入复制图且不被复制成空 child；锚点落在可继承范围之外的 child 同样不阻断 Fork、不写检查点；祖先别名及重启解析、所有权隔离；双 Runtime/双连接 claim 竞争及租约接管后旧 token 写入拒绝；目录/导航不回退；无子代理 Fork 与桌面连续流、移动端可恢复回放回归。旧数据没有充分证据时不得静默兼容。Fork 在父会话运行中、本地 revision 落后时必须仍可被接受；代际变化或目标失效仍须拒绝。Fork ACK 被拒绝和提交异常均须触发本地化用户提示且不能导航。

子代理身份映射回归必须通过实际 stable Fork 入口验证：初始化消息与首条 realUser prompt 携带真实形态的 turn/product turn 锚点时可成功 Fork；timeline、compaction、已完成工具附件及历史 verifier 引用映射一致；源检查点保持不变；再次 Fork 生成另一套独立身份。不可映射的消息引用、缺失的 verifier entry 必须保留明确失败，并验证未调用原子提交，不产生半成品。

## 非目标

不做 Copy-on-Write/延迟物化，不共享可写 child，不恢复运行实例或排队消息，不重新开放后台/递归派发，不修改模型消息参数，不引入管理界面，不承诺恢复未持久化内存消息队列。
