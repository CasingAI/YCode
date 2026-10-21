# 四个聊天工具卡的可见标题

## 范围

本规范只覆盖四个聊天工具卡：SendMessage、TaskOutput、TaskStop、Agent。它们的共同规则是把内部任务身份从普通可见文本中隔离出来，并优先显示用户能理解的 Agent 标题、任务描述或命令。

不覆盖 workflow 卡、通用工具错误 tooltip、fallback JSON、runtime、协议和持久化语义。

## 所有权

- `ConversationTimeline` 持有当前已加载会话行的只读 `agentTitleByIdentity` 索引，并把它注入 `ConversationRowRenderContext`。
- 索引由 Agent ToolCallRow 与 SubagentRow 的现有配对结果生成，唯一键是 `SubagentRow.entityId`。
- 四个 renderer 只消费 `context.agentTitleByIdentity` 或自己的非身份展示字段，不各自维护第二份关联状态。
- `to`、`task_id`、`taskId` 仍可作为内部关联键、React key、`data-*` 或动作参数，但不能作为普通主标题。

## 标题规则

标题候选按以下顺序选择：

1. 关联的 Agent 友好标题：Agent title（排除内部 ID）→ description → subagent type → output description/name。
2. TaskOutput 的安全 `display.title`（来自 `TaskOutputResult.task.description`）。
3. 非内部 ID 的工具 title。
4. 任务描述（TaskStop 适用）。
5. 任务命令（TaskStop 适用）。
6. 本地化 fallback。

已知内部身份前缀仅包括 `agent_`、`background_`、`exec_`、`subagent_`、`task_`、`workflow_`。不使用通用 UUID 正则，避免误伤用户文本、路径、commit hash 和正常工具输出。

## 四张卡

### SendMessage

`input.to` 只用于查找目标 Agent 标题。折叠摘要、展开详情和 ToolLayout hover title 显示目标标题；没有可靠关联时显示本地化目标 fallback，不显示裸 `agent_...`。消息正文和摘要仍按用户输入展示。

### TaskOutput

`input.task_id` 只用于查找关联 Agent 标题；非 Agent 任务从有界 `task_output.display.title` 读取安全描述。标题优先级为关联 Agent 标题 → display title → 现有安全工具 title → 本地化“任务输出”。运行中、成功、not_ready、超时、失败、停止等状态文案及输出展开行为不变。

### TaskStop

`taskId` 只用于查找关联标题或精确替换其出现在 TaskStop 自身结果中的 token。主标题显示 Agent 标题、任务描述、任务命令或本地化“停止任务”；标准成功结果不得拼接内部 ID。其他工具卡和通用错误 tooltip 不做全局清洗。

### Agent

Agent 主标题、展开标题和 hover title 不得使用 `agent_...` 等内部 ID。title 不可见时继续尝试 description、subagent type 和 output 标题，最后使用本地化 fallback。Agent 展开的模型活动正文保持现有投影，本规范不对其做通用脱敏。

## TaskStop 的任务描述

被停止的后台任务有两样彼此独立的文字：**描述**是模型当初写的那句人类可读说明（“运行全仓类型检查”），**命令**是命令原文（`cd "C:/Users/MPC/YCodeProjec...`）。折叠行是时间线上扫一眼就读的地方，属于前者；命令原文属于展开区。

- 描述由「停止任务」工具回传时一并带出。`TaskStopOutput` 与 `task_stop` display 都新增 `description` 字段；描述缺失时为空，不回落成命令。
- 描述的取值来源是**被停止任务自己的描述**：会话投影里的后台任务条目 `description` 优先，runtime 任务快照 `description` 兜底。两者都不是模型写的真实描述时，视为没有描述。
- `command` 字段的语义不变：它是命令原文（`local_agent` 任务例外，仍是短描述，因为旧快照里的 `command` 可能是完整 prompt）。描述不占用 `command` 槽位。
- 折叠行取 Agent 关联标题 → 任务描述 → 任务命令 → 本地化 fallback。描述显示时用正文字体，不用等宽字体。
- 展开区保留命令原文。描述已经是折叠行的内容，展开区不再重复显示它；只有命令缺席时才把描述放进展开区并标为「任务描述」。
- 历史会话与冷恢复的 display 没有 `description` 字段：折叠行回退到命令原文，与改动前逐字一致。

## 不变量与失败语义

- 无关联、历史数据缺字段、非 Agent 任务且没有安全 display title 时只能使用稳定本地化 fallback，不猜测标题。
- TaskOutput 的 display title 与 Agent 标题一样必须排除已知内部身份前缀；它不改变 task id 的内部关联用途。
- 多个 Agent 并发时按 `entityId` 隔离，不能串用其他 Agent 的标题。
- 标题索引缺失时 renderer 仍能独立渲染，不崩溃、不显示裸内部 ID。
- 状态标签、运行态、展开态、错误状态和输出内容不因标题投影而改变。

## 验收场景

- 同一会话中，Agent、TaskOutput、SendMessage、TaskStop 对同一 `agent_...` 显示同一个友好标题。
- SendMessage 的 `给 agent_...` 变为目标标题；TaskStop 的主标题和标准成功结果不出现 `taskId`。
- 跨回合的后续工具卡能显示前序 Agent 标题；并发 Agent 标题互不串。
- 历史或非 Agent 任务显示本地化 fallback，不显示内部 ID。
- TaskOutput 既有状态和输出回归测试继续通过。
- 停止一条带描述的后台 Bash 任务：折叠行显示描述，展开区显示命令原文，折叠行里看不到命令。
- 停止一条没有描述的后台任务：折叠行显示命令原文，与改动前一致。
- 回放改动前保存的 TaskStop 卡片：折叠行显示命令原文，不报错。
