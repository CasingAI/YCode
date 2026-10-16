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

遍历校验所有权、配置可恢复性、节点完整性、无循环及可重建内容。旧记录仅在持久证据能证明所有权与完整历史边界时兼容；时间戳仅辅助校验。缺失、损坏、循环或证据不足均使整个 Fork 明确失败并指出子代理与原因，不读最新历史补齐、不静默跳过。无子代理旧会话保持原行为。

## 原子复制、身份与幂等

复用 `commitForkBundle` 同库事务写入父副本、递归 child 副本、配置、来源及分支别名，并与源命令事实去重。相同 sourceCommandId 重放返回首次结果；独立请求创建另一分支。各副本分配新 agentId/sessionId，记录来源及所属新父；来源仅供追溯，不形成级联删除依赖。别名键为 `(parentSessionId, historicalAgentId)`，多次 Fork 合成祖先别名到当前物理身份。新身份绑定源 child 必须在存储层拒绝。非数据库计划文件等资源沿用补偿流程，数据库失败不得留下可访问半成品；外部补偿失败须明确记录且不宣称跨文件系统原子性。

## 路由与执行权

发送、冷恢复、steer、终态续跑、停止及投影共用同一解析：当前父 session 解析历史别名 → 校验物理身份确属该父分支 → 校验 workspaceIdentity（本地路径仅按既有 fallback）→ 取得执行权后才投递/启动。缺少父信息时只接受可验证持久证据；同工作区不构成跨父采用依据。证据不足明确拒绝。

每个物理 child 有持久 claim：ownerRuntimeId、单调 fencing epoch、有效期。SQLite 原子 acquire/renew/release；初次执行和终态续跑均须 claim。新建子代理首次执行必须经 `initializeSubagentFirstExecution` 在同一事务内完成 child 落库、身份绑定、首次 Claim（P0 修复：child 行不存在时直接抢 Claim 必定失败，不得先抢后建，也不得只建不抢）。token 必须与 transcript、part、entry、终态及可变会话状态写入处于同一事务校验；事件和对外结果校验代次。失效 owner 停止本地执行、丢弃迟到回调，且不能释放新 owner claim。只拒绝跨 Runtime 冲突，不新增跨 Runtime 内存队列；当前 owner 继续复用既有串行 admission/queue。fencing 不撤销已经发生的外部工具副作用。

## 目录与恢复投影

目录、tool row、侧栏、会话跳转在当前父分支使用同一解析结果；历史 tool output、metadata、spawn event 和 legacy 命名不得回退打开原 child。运行中的源 child 不得让副本显示 running。desktop continuous 与 web-remote-replayable snapshot/recovery 读取同一分支事实，并保留 workspaceIdentity、remoteSessionId、owner/lease 与 stale-run 防护。

## 事件顺序

```text
child 完整检查点持久化
  → 父历史锚点固化快照图
  → Fork 读取并校验不可变图
  → 生成独立身份/消息/别名映射
  → commitForkBundle 同库事务提交整图与命令事实
  → 投影发布分支身份
  → 当前父 Runtime 显式消息取得持久 claim 后执行
```

## Fork 失败反馈

用户发起 Fork 后，命令 ACK 若为非 accepted/duplicate，或命令提交 Promise 被拒绝，SessionPane 必须通过现有 Toast 显示本地化失败原因；同时保留 warn 日志。只有收到带有 `forkAssistant` 结果的成功 ACK 才导航到 child session。失败不得静默处理。

## 验收

覆盖递归 bundle 原子回滚、相同请求重放与不同请求隔离、源删除后副本可用；历史内容不可变、边界筛选、running child 最后完整检查点、损坏/缺失/循环/证据不足失败；祖先别名及重启解析、所有权隔离；双 Runtime/双连接 claim 竞争及租约接管后旧 token 写入拒绝；目录/导航不回退；无子代理 Fork 与桌面连续流、移动端可恢复回放回归。旧数据没有充分证据时不得静默兼容。Fork ACK 被拒绝和提交异常均须触发本地化用户提示且不能导航。

## 非目标

不做 Copy-on-Write/延迟物化，不共享可写 child，不恢复运行实例或排队消息，不重新开放后台/递归派发，不修改模型消息参数，不引入管理界面，不承诺恢复未持久化内存消息队列。
