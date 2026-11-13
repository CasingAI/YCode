# 四个聊天工具卡的可见标题

## 范围

本规范覆盖四个聊天工具卡：SendMessage、TaskOutput、TaskStop、Agent，以及因配对缺口而单独进入时间线的未配对 `SubagentRow` 兜底卡片。它们的共同规则是把内部任务身份从普通可见文本中隔离出来，并优先显示用户能理解的 Agent 标题、任务描述或命令。

不覆盖 workflow 卡、通用工具错误 tooltip、fallback JSON、runtime、协议和持久化语义；也不覆盖子代理目录、侧边面板状态条等独立入口。

## 所有权

- `ConversationTimeline` 持有当前已加载会话行的只读 `agentTitleByIdentity` 索引，并把它注入 `ConversationRowRenderContext`。
- 索引由 Agent ToolCallRow 与 SubagentRow 的现有配对结果生成，唯一键是 `SubagentRow.entityId`。
- 同一 `entityId` 可能出现多条 `SubagentRow`（spawn 行与续跑重建行）。索引必须**配对来源优先**：已配对 Agent 行的标题一旦命中，不得被后续未配对行的 `summaryText` 覆盖。
- 四个 renderer 与未配对 `SubagentRow` 卡片只消费 `context.agentTitleByIdentity`、`context.agentSessionByIdentity` 或自己的非身份展示字段，不各自维护第二份关联状态。
- `to`、`task_id`、`taskId` 仍可作为内部关联键、React key、`data-*` 或动作参数，但不能作为普通主标题。

## 标题规则

标题候选按以下顺序选择：

1. 关联的 Agent 友好标题：Agent title（排除内部 ID）→ description → subagent type → output description/name。
2. TaskOutput 的安全 `display.title`（来自 `TaskOutputResult.task.description`）。
3. 非内部 ID 的工具 title。
4. 任务描述（TaskStop 适用）。
5. 任务命令（TaskStop 适用）。
6. 本地化 fallback。

未配对 `SubagentRow` 卡片按以下顺序选择标题：

1. `agentTitleByIdentity.get(entityId)` 中的真实任务标题。索引不把裸 `subagentType` 当任务标题；配对 Agent 行自身缺 description 时仍可回退其 `subagent_type`（与 Agent 卡同一口径）。
2. 该行安全的 `summaryText`（运行期 payload 的真实任务描述，不是子代理类型说明）。
3. 内置子代理类型名的既有 i18n 显示名（`general-purpose` → 通用 / `Explore` → 探索），第三方类型原样显示。
4. 本地化「子智能体」fallback。

已知内部身份前缀仅包括 `agent_`、`background_`、`exec_`、`subagent_`、`task_`、`workflow_`。不使用通用 UUID 正则，避免误伤用户文本、路径、commit hash 和正常工具输出。

## 四张卡

### SendMessage

`input.to` 只用于查找目标 Agent 标题。折叠摘要、展开详情、ToolLayout hover title 与打开侧栏请求的 `title` 使用同一口径：安全索引标题 → 安全原始 `to` → 本地化目标 fallback；没有可靠关联时显示本地化 fallback，不显示裸 `agent_...` 或裸 `subagentType`。消息正文和摘要仍按用户输入展示。

### TaskOutput

`input.task_id` 只用于查找关联 Agent 标题；非 Agent 任务从有界 `task_output.display.title` 读取安全描述。标题优先级为关联 Agent 标题 → display title → 现有安全工具 title → 本地化“任务输出”。运行中、成功、not_ready、超时、失败、停止等状态文案及输出展开行为不变。

### TaskStop

`taskId` 只用于查找关联标题或精确替换其出现在 TaskStop 自身结果中的 token。主标题显示 Agent 标题、任务描述、任务命令或本地化“停止任务”；标准成功结果不得拼接内部 ID。其他工具卡和通用错误 tooltip 不做全局清洗。

### Agent

Agent 主标题、展开标题和 hover title 不得使用 `agent_...` 等内部 ID。title 不可见时继续尝试 description、subagent type 和 output 标题，最后使用本地化 fallback。Agent 展开的模型活动正文保持现有投影，本规范不对其做通用脱敏。

## 未配对的 SubagentRow

### 为什么会出现

`pairSubagentRows`（`packages/ui/src/v4/conversationAssistantWorkItems.ts`）只把 `SubagentRow` 与同 turn、`parentToolCallId` 相等的 **Agent/Task** 工具行配对。以下两类行因此没有宿主卡：

- spawn 轮的 Agent 工具行落在已加载行窗口之外（尾窗在 turn 中间截断），但同一轮的 `SubagentRow` 仍在窗口内。
- 续跑重建行：`SubagentRow.parentToolCallId` 指向 SendMessage 的 `toolCallId`（CLI 冷恢复找不到原行时的 append 路径），而 SendMessage 不是 Agent 工具行。该行承载当前运行/终态，不能按重复行丢弃。

改动前这两类行落入 `SubagentRowView` 的裸兜底 `subagentType · status — summaryText`，产生内部英文长行。裸兜底不是可接受的最终形态。

### 展示规则

未配对 `SubagentRow` 复用 Agent 摘要卡的现有通道（`ToolLayout` + 现有标题索引/身份索引 + 现有下钻回调），显示为一行子智能体状态卡：

- **kind 标签**：沿用 `chat.toolCall.agent.fallback`（子智能体）；类型名按 `resolveBuiltInSubagentChatTypeLabel` 的内置 i18n 映射展示，原始身份不翻译。
- **主标题**：按上文「未配对 SubagentRow 标题规则」；不得显示 `agent_...` 或 `subagentType · status — summaryText` 裸行。历史已落盘的坏 `summaryText` 属输入数据问题，见下文「历史数据的可视边界」。
- **运行状态**：保留 `SubagentRow.status`（running / success / failed / cancelled），文案复用既有 `subagentDirectory.status.*` 本地化词条；running 时保留运行态视觉。
- **下钻**：`childSessionId`、`context.sessionId`、`context.onOpenSubagentSession` 三者齐备时，整行可点并打开既有 `subagent-session` 侧边视图，test id 复用 `TID_V4_SUBAGENT_OPEN_SIDE_PANE`；缺一即不可点，但卡片与状态仍然渲染。打开请求的 title 与本卡主标题逐字一致。
- 卡片不提供展开详情：`SubagentRow` 没有工具输入/输出正文，点击的唯一落点是子会话侧边视图。分享/只读视图不注入回调时保持不可点。
- 行锚点、选择能力仍由现有 `RowShell` 提供，不改变其它工具行、消息正文或过程折叠。

### 数据所有权与事件顺序

```text
CLI V4 projection（唯一权威）
  SubagentSpawned / SubagentStopped
    → SubagentRow（turnId / entityId / parentToolCallId / status / summaryText / childSessionId）
    → UI rows 窗口

buildAgentTitleByIdentity(rows)（只读派生索引）
  pairSubagentRows：同 turn + parentToolCallId 命中 Agent/Task 行
    → 配对来源标题先写入（agentTitleByIdentity）
    → 未配对行仅在该 entityId 尚无标题时用 summaryText 补位

渲染
  SubagentRow 已配对 → 隐藏，由 Agent 工具卡代言
  SubagentRow 未配对 → 子智能体状态卡（索引标题 → summaryText → 类型显示名）
  SendMessage 卡 → 同一 agentTitleByIdentity（配对来源优先，不被续跑行覆盖）
```

- `summaryText` 必须是真实任务描述，不能是子代理 profile 的类型说明。该字段的生产口径由 CLI `SubagentStopped` 投影保证：`summaryText` → `result` → `description` → 既有非空 `summaryText` → `error`；失败/取消不得用 `error` 覆盖已有任务短描述，`error` 仅在行没有任务描述时回退，完整诊断仍保留在事件载荷、工具结果与失败输出中（`subagent-failure-error-propagation.md`「边界」）。UI 不做类型说明字符串黑名单，也不猜测标题。
- `SubagentStopped` 只更新生命周期行状态与终态字段；已有任务短描述与 `result`/`summaryText` 的优先级不变，本规则不吞掉结果正文。
- 不新增状态所有者、协议字段或第二套配对索引；索引与卡片都是已加载行的纯派生视图。

### 历史数据的可视边界

`isSafeVisibleToolTitle` 只排除已知内部身份前缀，不判断「这句话是不是 profile 类型说明」。因此历史会话里已经落盘的坏 `summaryText` 不会被追溯改写；只有窗口内存在配对 Agent 行、索引能给出配对来源标题时才会被盖住。若原 Agent 行已被窗口裁掉、索引没有配对来源标题，该卡会如实显示这个历史 `summaryText`。

- 这是**输入数据的限制**，不是继续兼容的实现分支：不按英文片段、`agent for` 之类文案做黑名单，也不做长度截断（合法任务描述可能同样长）。
- UI 侧只做两件事：CLI 投影写入的 `summaryText` 作为任务描述候选；存在配对来源标题时优先使用它，不被续跑行覆盖。
- 不承诺历史坏 summary 已在 UI 层修复；修复落在源头（CLI 冷恢复 description 口径）与配对索引优先级上。

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
- 同一 `entityId` 的配对标题优先于未配对/续跑行的 `summaryText`；后续行不得把前序 Agent 标题覆盖成类型说明。
- 标题索引缺失时 renderer 仍能独立渲染，不崩溃、不显示裸内部 ID。
- 状态标签、运行态、展开态、错误状态和输出内容不因标题投影而改变。
- 未配对 `SubagentRow` 不得回退成 `subagentType · status — summaryText` 裸行；即使没有标题、没有下钻身份，也必须显示本地化类型名与本地化状态。
- 未配对 `SubagentRow` 的状态来自该行自身，不能改读配对卡或 `snapshot.subagents.running` 来顶替。

## 验收场景

- 同一会话中，Agent、TaskOutput、SendMessage、TaskStop 对同一 `agent_...` 显示同一个友好标题。
- SendMessage 的 `给 agent_...` 变为目标标题；TaskStop 的主标题和标准成功结果不出现 `taskId`。
- 跨回合的后续工具卡能显示前序 Agent 标题；并发 Agent 标题互不串。
- 历史或非 Agent 任务显示本地化 fallback，不显示内部 ID。
- 同一 `entityId` 同时存在「已配对 spawn 行」与「续跑重建/未配对行」时，标题索引与 SendMessage 标题都取配对 Agent 的真实任务标题，不取续跑行的 `summaryText`。
- spawn 行的 Agent 工具卡不在已加载窗口内时，未配对 `SubagentRow` 显示：真实任务标题（索引或 `summaryText`）或内置类型显示名 + 本地化状态；不出现 `general-purpose · running — General-purpose agent for researching...` 这类裸英文行。若该行输入本身是历史坏 `summaryText`（无配对来源标题可用），按「历史数据的可视边界」如实降级，不做字符串猜测。
- 未配对 `SubagentRow` 有 `childSessionId` 且宿主注入回调：整行可点，点击打开对应 `subagent-session` tab，标题与卡片一致；缺回调（分享/只读）时不可点但状态仍显示。
- 失败/取消的未配对 `SubagentRow`：主标题仍为此前任务短描述，状态为本地化「失败」/「已取消」；错误诊断不出现在标题位，但仍在事件载荷与工具结果中。
- SendMessage 索引无标题但会话身份可解析时：卡片与打开请求都显示本地化「目标子智能体」，不显示原始 `subagentType`，两者逐字一致。
- TaskOutput 既有状态和输出回归测试继续通过。
- 停止一条带描述的后台 Bash 任务：折叠行显示描述，展开区显示命令原文，折叠行里看不到命令。
- 停止一条没有描述的后台任务：折叠行显示命令原文，与改动前一致。
- 回放改动前保存的 TaskStop 卡片：折叠行显示命令原文，不报错。
