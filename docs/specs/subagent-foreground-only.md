# 普通 Subagent 前台执行规则

## 目标

普通 `Agent` / `Task` Subagent 只能在父 turn 内前台执行。父 Agent 的工具调用必须等待子代理进入成功、失败或取消终态后返回，父 turn 不能在子代理仍运行时完成或继续下一模型步骤。

## 状态所有权与事件顺序

- 父 turn 的 `turnHeader` 是父级运行状态的唯一权威。
- 子代理 runner 拥有 child runtime 的生命周期；父工具的 Promise 是 child 生命周期的 join 点。
- 前台顺序为：接收 Agent 输入 → 启动 child → 发出 `SubagentSpawned` → 等待 child 终态 → 发出 `SubagentStopped` → 返回工具结果 → 父 turn 完成。
- 同一模型步骤的多个独立 Agent 可以并发运行，但并发批次结束后必须统一 join；并行不等于脱离父 turn。
- 父 turn 的 abort 继续通过既有 signal 传播到 child；child 收束后父工具才返回取消或失败结果。
- `stopTask` 的旧后台提交、通知和 `BackgroundTaskCompleted` 事件只允许作用于 `isBackgrounded: true` 的历史任务；前台 child 必须由 `run()` 自己收束，不能被停止入口改写为后台终态，若误入该入口应明确拒绝。

## 新调用规则

- Provider-visible Agent schema 不再暴露 `run_in_background`。
- 旧客户端或内部调用若显式传入 `run_in_background: true`，必须得到明确、稳定的“后台不可用”错误，不能静默忽略后假装异步成功。
- `run_in_background: false` 或省略时都只进入 `SubagentPort.run()`。
- Profile frontmatter 的 `background` 不再是有效配置。旧文件中的该字段不批量改写；加载时必须给出可审计诊断并禁止其触发后台执行。
- `autoBackgroundMs` 不再使普通 Subagent 自动转后台。它可以暂时作为兼容配置字段保留，但不得影响 Agent runner。
- 终态子代理的 `SendMessage` continuation 不得恢复成 detached background task；在有当前父 turn 的上下文中必须以前台 join 执行，否则明确失败。

## 历史兼容与迁移边界

旧会话可能包含 `run_in_background: true`、`async_launched`、`backgrounded`、旧版 Agent launch ACK、metadata/output sidecar 和 `backgroundSource: "subagent"`。这些数据必须继续支持只读 hydration、TaskOutput 查询和可用的停止操作，不得重写历史 transcript。

新 runtime 不再创建新的 `local_agent` 后台任务、Subagent completion notification 或 `async_launched` 输出。历史任务如果存在 live registry 或 active child 事实，可以继续按旧协议收束；只有历史输入而没有 live 证据时，不得继续判定为 running，应降级为 lost/ended，避免冷恢复出幽灵任务。

旧 schema、projection、UI fallback 和控制解析可以继续读取历史值；这不等于新 Agent 仍支持后台启动。

## 不改变的机制

- Bash 的后台命令、终端后台化和 `backgroundBashMaxMs`。
- Legacy Workflow、Dynamic Workflow、Workflow resume、Cron/Automation 的独立生命周期。
- `RuntimeTaskRegistry`、通用 `BackgroundTaskStarted/Updated/Completed`、`backgroundWorks`、通知队列、`notified` claim 和 stale fencing。
- 前台 Subagent 的 `SubagentSpawned` / `SubagentStopped`、`subagents.running`、child transcript、模型继承、工具权限和语言继承。
- 子代理内部启动 background Bash 的能力。

## 验收场景

1. 新 Agent 调用期间，父轮持续显示工作中；child 成功、失败或取消后父轮才结束。
2. 两个并发 Agent 中较短的一个完成时，父轮仍保持工作中，直到两个 child 都终态。
3. 显式 `run_in_background: true` 在 child 启动前得到明确错误，不生成异步启动 ACK 或 output file。
4. Profile 的旧 `background: true` 和 `autoBackgroundMs` 均不能使 child 脱离父 turn。
5. 父 turn abort 后所有 child 收束，不出现父 turn 已完成但新 child 仍运行的矛盾状态。
6. 旧 `async_launched` / `backgrounded` 会话仍可查询和展示；无 live 证据的旧任务不会无限显示为 running。
7. Bash、Workflow、Cron/Automation 的后台运行、查询、停止和通知行为保持不变。
