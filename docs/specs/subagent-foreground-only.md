# 普通 Subagent 前台执行规则

## 目标

普通 `Agent` / `Task` Subagent 只能在父 turn 内前台执行。父 Agent 的工具调用必须等待子代理进入成功、失败或取消终态后返回，父 turn 不能在子代理仍运行时完成或继续下一模型步骤。`agentId` 是逻辑 Agent 的稳定身份；每次前台执行另有 execution generation，终态不会注销这个身份。

## 状态所有权与事件顺序

- 父 turn 的 `turnHeader` 是父级运行状态的唯一权威。
- 子代理 runner 拥有 child runtime 的生命周期；父工具的 Promise 是 child 生命周期的 join 点。
- 前台顺序为：接收 Agent 输入 → 启动 child → 发出 `SubagentSpawned` → 等待 child 终态 → 发出 `SubagentStopped` → 返回工具结果 → 父 turn 完成。
- 同一模型步骤的多个独立 Agent 可以并发运行，但并发批次结束后必须统一 join；并行不等于脱离父 turn。
- 父 turn 的 abort 继续通过既有 signal 传播到 child；child 收束后父工具才返回取消或失败结果。
- `stopTask` 的旧后台提交、通知和 `BackgroundTaskCompleted` 事件只允许作用于 `isBackgrounded: true` 的历史任务；前台 child 必须由 `run()` 自己收束，不能被停止入口改写为后台终态，若误入该入口应明确拒绝。

## 身份所有权

三层事实各有唯一 owner，任何一层都不得复制另一层的职责：

| 事实                                        | 唯一 owner                                         | 不负责                                  |
| ------------------------------------------- | -------------------------------------------------- | --------------------------------------- |
| 逻辑身份 `agentId` 与 `childSessionId` 绑定 | SessionStore                                       | 不保存 status、output、error 或完成时间 |
| 历史内容与终态事实                          | child transcript（`session` / `message` / `part`） | 不做身份索引                            |
| 当前进程的运行控制                          | `RuntimeTaskRegistry`                              | 不承担跨进程身份权威                    |

- `RuntimeTaskRegistry` 是进程内 live execution 缓存，进程退出即失效；它被清空不代表 Agent 不存在。上一版只把身份语义做对、却让查找仍依赖这张内存表，是"关掉软件后所有 Agent 都不能再用"的直接原因。
- Agent 首次创建 child session 时，必须在同一事务内写入 `agentId → childSessionId` 绑定。child 不存在或 `taskType !== "subagent_child"` 时整体回滚，不允许留下无身份的 child。
- 同一 `agentId` 重复写同一映射幂等；指向不同 child 视为显式冲突，必须报错而不是覆盖。
- 身份索引不存任务状态。状态继续由 child transcript、父 transcript 和当前 registry 投影得出，避免出现第二套任务状态机。
- 临时目录的 `metadata.json` 与 `outputFile` 只是排障产物，任何情况下都不能作为身份或状态的权威来源。
- child session 的创建入口必须与身份绑定同事务；先建 session 再补写身份的写法不被接受。

## 新调用规则

- Provider-visible Agent schema 不再暴露 `run_in_background`。
- 旧客户端或内部调用若显式传入 `run_in_background: true`，必须得到明确、稳定的“后台不可用”错误，不能静默忽略后假装异步成功。
- `run_in_background: false` 或省略时都只进入 `SubagentPort.run()`。
- Profile frontmatter 的 `background` 不再是有效配置。旧文件中的该字段不批量改写；加载时必须给出可审计诊断并禁止其触发后台执行。
- `autoBackgroundMs` 不再使普通 Subagent 自动转后台。它可以暂时作为兼容配置字段保留，但不得影响 Agent runner。
- 终态子代理的 `SendMessage` continuation 不得恢复成 detached background task；在有当前父 turn 的上下文中必须以前台 join 执行。
- 只要 Agent 已被接受并分配 `agentId`，成功、失败、取消、停止或丢失的执行结果都必须返回该 ID；终态本身不能成为后续 `SendMessage` 的拒绝条件。
- `completed`、`failed`、`cancelled` 以及仍可定位的 `stopped`/`killed`/`lost` 记录均可尝试继续；同一逻辑 Agent 通过新的 execution generation 追加 child transcript。若旧 transcript 不可恢复，保留逻辑 ID 并明确标记 `contextReset`，不能静默换 Agent。
- 终态续跑必须校验当前父 session、活动 branch 和 workspace identity；身份不存在、scope 不匹配或消息本身非法时才返回失败。
- 并发续跑由 registry 的同步 claim/CAS 决定唯一新 execution；同一 continuation 重放复用同一结果，旧 generation 的迟到结果不得覆盖新状态。

## 历史兼容与迁移边界

旧会话可能包含 `run_in_background: true`、`async_launched`、`backgrounded`、旧版 Agent launch ACK、metadata/output sidecar 和 `backgroundSource: "subagent"`。这些数据必须继续支持只读 hydration、TaskOutput 查询和可用的停止操作，不得重写历史 transcript。

新 runtime 不再创建新的 `local_agent` 后台任务、Subagent completion notification 或 `async_launched` 输出。历史任务如果存在 live registry 或 active child 事实，可以继续按旧协议收束；只有历史输入而没有 live 证据时，不得继续判定为 running，应降级为 lost/ended，避免冷恢复出幽灵任务。

旧 schema、projection、UI fallback 和控制解析可以继续读取历史值；这不等于新 Agent 仍支持后台启动。

## 终态身份与 continuation 规则

- `agentId` 是一次逻辑 Agent 创建时分配的唯一 ID；`childSessionId` 优先保持为 `subagent_${agentId}`，execution generation 每次续跑递增。
- Agent/SendMessage 的终态结果统一带 `agentId`、`childSessionId`、`status` 和 `canContinue`。child 已建立但失败或取消时，工具仍返回结构化终态，不返回丢失身份的通用错误。
- `SendMessage` 对 running Agent 继续使用 steer/queue；对终态 Agent 使用 `resumed_foreground`，等待新 execution 到终态后把 continuation 结果返回父模型。
- 如果 child transcript 不可恢复，允许在同一逻辑 `agentId` 下建立新 child context，并返回 `contextReset: true`；这不是新建另一个 Agent，UI/事件仍以原 `agentId` 关联。
- 终态提交、事件发射和 abort 句柄清理必须按 execution generation fencing；旧执行不能覆盖新执行。
- durable identity 与 execution generation 是两层独立事实：前者跨进程存活，后者只在当前 `RuntimeTaskRegistry` 内有意义。冷恢复出的 Agent 从终态开始计数，不假装自己是原 execution 的延续。

## 冷恢复与跨 Parent Runtime 采用

- `SendMessage` 查不到 live registry 时，必须先查 SessionStore 的持久化身份，再决定失败。直接返回"找不到本地 Agent"只在持久化身份也不存在时才允许。
- 冷恢复只向当前 registry 注册**终态** snapshot，不伪造 `running`；真正开始新 execution 必须经过既有 CAS claim。
- 冷恢复继续复用 `resumeFromStore` 读取同一 child session，不复制 transcript、不新建 child。
- 原 `parentSessionId` 作为 provenance 保留；新 execution 的 owner 是当前父 session 与 turn，权限、provider header、child client port 一律取当前 Parent Runtime 的上下文，不信任历史 ID 自行授予权限。
- 同一 workspace identity 下，当前 Parent Runtime 可以显式采用旧 Agent。`workspaceIdentity` 缺失时回退到 `workspaceRoot`；两者都缺失即拒绝，不默认放行。
- 未知 `agentId`、workspace 不匹配、child task type 不是 `subagent_child`、child session 不存在：明确拒绝并给出可读原因，不静默串线，也不把无法校验的历史记录伪装成可执行 Agent。
- child transcript 不可恢复时保留同一 `agentId`，走 `contextReset` 建立新 child context，并把 `contextResetGeneration` 推进。这是显式受控换绑，不是静默重绑。
- 历史 `subagent_${agentId}` 命名的 child session 在首次被查询时校验并 lazy backfill 身份行；不做全库批量回填。
- 冷恢复是**采用**，不是复活：它只恢复身份和 transcript 的可达性，不恢复任何已丢失的运行中状态或排队消息。

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
8. Agent 一旦分配 ID，任何终态（包括取消、失败和停止）都返回同一 ID；父 signal 取消不能被 executor 的 generic error 遮蔽。
9. SendMessage 对同一逻辑 Agent 的终态续跑不产生 detached background；成功、失败、取消都返回可识别的 continuation，旧 generation 不得覆盖新结果。
10. 并发续跑只启动一个 child；scope 不匹配或 transcript 不可恢复时，错误/重置语义可观察且不静默串线。
11. 新建 Agent 后退出并重新打开 ZCode，只拿 `agentId` 调 `SendMessage`：定位到同一 child session，前台恢复并返回 continuation，不新建第二个 child。
12. 三个只存在于历史 transcript、没有身份行的旧 `agentId`：lazy backfill 后均能定位到对应 `sess_subagent_agent_*`，消息数不变，不重新执行旧任务。
13. 另一 workspace 的 `agentId`、未知 ID、以及 workspace 两侧都缺失的请求：明确拒绝，不返回可执行 Agent。
14. 重启后用同一 `agentId` 调 `TaskOutput`：返回历史终态与 child 输出摘要，不再是"找不到任务"。
15. 并发两个 `SendMessage` 加一次旧 generation 的 stop：只启动一个 child，旧 stop 不 abort 新 execution。
