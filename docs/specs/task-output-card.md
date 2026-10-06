# TaskOutput 任务输出卡

## 目标

让 TaskOutput 卡片在等待或读取后台任务输出时显示用户可理解的任务标题：优先复用关联的子代理标题，否则使用 TaskOutput 结果携带的有界任务描述，避免把内部 `agent_...`、`exec_...` 等任务 ID 直接展示给用户。

## 状态与数据所有权

- 子代理的 `entityId`、`summaryText` 由现有 v4 `SubagentRow` 投影拥有。
- TaskOutput 的 `input.task_id` 由现有 TaskOutput 工具行拥有。
- 非 Agent 后台任务的描述由 `TaskOutputResult.task.description` 拥有，并在 core 的有界 `task_output.display.title` 中作为派生展示事实投影；UI 只消费 display，不维护第二份任务描述状态。
- 会话时间线从已加载的完整 `ConversationRow[]` 一次性建立只读 `entityId -> 友好标题` 索引；`ConversationTurnGroup` 和 renderer 只消费结果，不各自重复配对。四张卡的统一规则见 [`tool-card-visible-titles.md`](./tool-card-visible-titles.md)。
- `task_id` 保留为内部关联键和调试信息，不作为默认用户可见主标题。

## 展示规则

1. TaskOutput 工具行存在关联的 SubagentRow 时，主标题优先显示与上方 Agent 工具行一致的友好标题；Agent 标题缺失时再回退到关联行的 `summaryText`。
2. 没有可靠 Agent 关联时，优先显示 `task_output.display.title`。该字段来自 `TaskOutputResult.task.description`，用于 Bash、Workflow、历史任务及其它能提供描述的任务；显示前必须经过可见文本安全过滤。
3. 关联标题或 display title 缺失、为空、是内部任务 ID 或没有安全标题时，才回退到本地化的通用任务标题。旧 Agent 后台任务仅作为历史读取/停止兼容，不是新的 Agent 后台启动方式。
4. 运行中仍显示“正在获取任务输出”；`retrievalStatus: "not_ready"`、超时、失败、停止和成功等既有状态语义不变。
5. 普通输出、展开、截断和错误展示不因标题关联而改变。

## 关联边界

- 只使用已加载会话窗口内、由 `parentToolCallId` 精确配对（或旧数据同回合唯一剩余项回退）的 `SubagentRow`，避免跨会话复用 Agent 标题。
- 非 Agent 任务标题只从有界 `task_output.display.title` 读取；不读取 Bash input、Workflow input、后台工作面板状态或自然语言输出进行反向解析。
- `task_output.display.title` 随现有 display metadata 持久化和冷恢复，不新增数据库字段、缓存或 runtime 状态；旧数据没有该字段时安全回退。
- TaskOutput 的 provider 结果 schema、runtime task registry 和状态机保持不变；provider 输入 schema 只收窄 `timeout` 边界（见「等待预算显示」），不改字段集合与语义。

## 任务来源的持久化回落

- TaskOutput 查不到 live registry 条目时，对 `agent_` 前缀的 ID 回落到 SessionStore 的持久化身份索引（见 `subagent-foreground-only.md` 的「身份所有权」），按 child transcript 投影只读历史终态。
- 该回落与 `SendMessage` 的冷恢复同源：同一张身份索引、同一套 `subagent_child` taskType 校验。不允许出现"SendMessage 能续、TaskOutput 报找不到"的不一致。
- 回落不注册进 registry，不产生排队或等待语义；`block: true` 的等待只对 live 条目有效。
- 历史终态的 `output` 取 child transcript 最后一条 assistant 文本，工具调用次数由 transcript 中真实 tool part 统计得出，不用 0 兜底。
- 回落产出的 snapshot 只用于本次投影，不可被 `TaskStop` 等写操作当作可停止的运行中任务。
- 输入校验门只做必填校验。是否存在由 handler 判定，因为校验门上下文里没有 SessionStore，在那里提前拒绝会让重启后的历史 Agent 永远查不到。
- 持久化身份不存在、child 不存在或 taskType 不符时，仍返回既有的 `TASK_NOT_FOUND` 错误码与文案。

## 等待预算显示

- 等待预算是调用级事实，唯一来源是本次调用的 `input.timeout`；runtime task registry 不持有 deadline，`task_output.display` 也不携带时长字段。UI 只消费 `input`，不新增协议字段。
- 预算是**上限**而不是保证：`block=true` 且任务先完成时等待立即结束，此时不再显示等待段。
- `timeout` 的取值范围是 `[0, 300000]` 毫秒，省略时 runtime 取 `15000`；`required` 仍是 `task_id / block / timeout` 三项，模型必须显式传。
- 运行中在摘要行状态词之前显示「还剩 {duration}」，`duration` 是**剩余量**（不是初始预算），按整秒边界递减到 0；预算用尽或任务闭合后该段消失。
- 超时终态不显示任何时长，只保留状态词「等待超时」。行上的 `durationMs` 口径是 `ToolCallResult` 事件时间戳减 `ToolCallStarted`，把读输出文件和结果序列化都算进去了，它不是「等了多久」，不能拿来渲染等待时长。
- `block=false`、Office mode 紧凑视图、参数仍在流式解析（`input` 未成形）或被 snapshot 裁剪导致读不到 `timeout` 时，一律不渲染等待段。读不到时**不用契约默认值兜底**——那会显示一个并非本次真实调用的预算。
- 倒计时不复用工具行的 `useLiveDurationSeconds`：那条推导对秒数做「最小 1 秒」钳位（耗时语义不出现 0 秒），倒计时用它会让 15 秒预算从 14 秒起跳。

## 后台任务预览跳转

- TaskOutput 卡片的摘要行在 `task_id` 可用且不以 `agent_` 开头时，提供一个跳转入口，打开既有的 `BackgroundBashOutputSidePane`（命令原文、cwd、状态、字节数、exit code、Stop、跟随尾部、打开完整文件）。展开折叠行为保持不变，跳转是叠加进去的入口，不替换 `canToggle`。
- 走 `onOpenBackgroundBash` 这条既有回调链，卡片只交 `workId` 与 `title`，`workspacePath` / `sessionId` / `rootSessionId` / `workspaceIdentity` / `remoteSessionId` 由会话宿主绑定。这条约定与既有的 `onOpenPlanDetail` / `onOpenWorkflowRun` 一致。
- `agent_` 前缀是子代理任务而非 Bash 后台任务，侧面板查询端必然返回 `unavailable`，因此不提供入口。
- CLI 重启后后台任务表清空，侧面板按既有语义显示「不可用」错误态，卡片不额外判断。

## 等待时长对模型可见

- `TaskOutputResult` 带 `waited_ms`（可选整数毫秒），由 handler 在等待前后取 `Date.now()` 差值写入；`block=false` 时同样写入（那是真实的一次检查耗时）。
- 模型可见内容里必须有它，且在 `retrieval_status` 之后。模型对时间没有概念，只给「超时」不给时长，它无法判断是该调大 `timeout` 重试还是改用 `block=false` 轮询。
- `retrieval_status` 为 `timeout` 时，模型可见内容追加一句明确指引：本次预算是多少、已用满、可以调大 `timeout` 再查一次。
- 该字段只进 `TaskOutputResult` 与模型可见内容，**不进 `task_output` display**，因此不触及持久化 schema 与冷恢复路径。

## 验收场景

- 一个带 description 的 `codeReview` 子代理在 TaskOutput 运行态：卡片显示“正在获取任务输出”和与上方一致的友好标题，不显示 `agent_...`。
- 一个带 description 的 Bash 或 Workflow 后台任务：没有 Agent 关联时，卡片显示对应的安全任务描述，不显示 `exec_...`。
- 同一回合有多个子代理：每个 TaskOutput 只显示匹配自己的标题。
- 无 SubagentRow、无 display title、description 为空或 title 是内部 ID：显示通用本地化标题，页面不崩溃。
- TaskOutput 成功、`not_ready`、超时、失败和停止状态，以及输出展开/截断行为保持不变。
- 重启后用同一个历史 `agentId` 调 TaskOutput：返回 child transcript 的最后一条 assistant 文本和真实工具调用次数，不再返回「No task found with ID」。
- 未知 `agentId`、或身份存在但 child 已被删除：仍返回 `TASK_NOT_FOUND`，不返回空结果冒充成功。
- `block=true, timeout=15000` 读取仍在跑的任务：卡片在状态词前显示「还剩 15 秒」并每秒递减；任务先完成时该段消失，摘要行不留空白。
- `retrieval_status` 为 `timeout` 的终态：只显示状态词「等待超时」，不出现任何时长数字。
- `block=false`、Office mode、或 `input.timeout` 读不到（流式参数阶段、snapshot 裁剪）：不渲染等待段，不出现 `NaN` / `undefined` 文案。
- 传入 `timeout=300000` 通过校验；`timeout=300001` 被拒。省略 `timeout` 时 runtime 取 `15000`。
- 点击 `exec_` 前缀的 TaskOutput 卡片：打开后台任务输出预览面板，命令原文与跟随尾部的输出区可用。
- 点击 `agent_` 前缀的 TaskOutput 卡片：摘要行不出现预览入口，展开行为不变。
- 模型侧：`retrieval_status` 为 `timeout` 的结果里能读到 `waited_ms` 与调大 `timeout` 的指引。
- Bash 工具调用与思考行的耗时显示在本次改动前后逐字一致。
