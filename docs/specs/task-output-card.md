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
- TaskOutput 的 provider 输入/结果 schema、runtime task registry 和状态机保持不变；本次只扩展 UI display 投影。

## 任务来源的持久化回落

- TaskOutput 查不到 live registry 条目时，对 `agent_` 前缀的 ID 回落到 SessionStore 的持久化身份索引（见 `subagent-foreground-only.md` 的「身份所有权」），按 child transcript 投影只读历史终态。
- 该回落与 `SendMessage` 的冷恢复同源：同一张身份索引、同一套 `subagent_child` taskType 校验。不允许出现"SendMessage 能续、TaskOutput 报找不到"的不一致。
- 回落不注册进 registry，不产生排队或等待语义；`block: true` 的等待只对 live 条目有效。
- 历史终态的 `output` 取 child transcript 最后一条 assistant 文本，工具调用次数由 transcript 中真实 tool part 统计得出，不用 0 兜底。
- 回落产出的 snapshot 只用于本次投影，不可被 `TaskStop` 等写操作当作可停止的运行中任务。
- 输入校验门只做必填校验。是否存在由 handler 判定，因为校验门上下文里没有 SessionStore，在那里提前拒绝会让重启后的历史 Agent 永远查不到。
- 持久化身份不存在、child 不存在或 taskType 不符时，仍返回既有的 `TASK_NOT_FOUND` 错误码与文案。

## 验收场景

- 一个带 description 的 `codeReview` 子代理在 TaskOutput 运行态：卡片显示“正在获取任务输出”和与上方一致的友好标题，不显示 `agent_...`。
- 一个带 description 的 Bash 或 Workflow 后台任务：没有 Agent 关联时，卡片显示对应的安全任务描述，不显示 `exec_...`。
- 同一回合有多个子代理：每个 TaskOutput 只显示匹配自己的标题。
- 无 SubagentRow、无 display title、description 为空或 title 是内部 ID：显示通用本地化标题，页面不崩溃。
- TaskOutput 成功、`not_ready`、超时、失败和停止状态，以及输出展开/截断行为保持不变。
- 重启后用同一个历史 `agentId` 调 TaskOutput：返回 child transcript 的最后一条 assistant 文本和真实工具调用次数，不再返回「No task found with ID」。
- 未知 `agentId`、或身份存在但 child 已被删除：仍返回 `TASK_NOT_FOUND`，不返回空结果冒充成功。
