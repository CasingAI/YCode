# TaskOutput 任务输出卡

## 目标

让 TaskOutput 卡片在等待子代理输出时复用同一回合子代理行的友好标题，避免把内部 `agent_...` 任务 ID 直接展示给用户。

## 状态与数据所有权

- 子代理的 `entityId`、`summaryText` 由现有 v4 `SubagentRow` 投影拥有。
- TaskOutput 的 `input.task_id` 由现有 TaskOutput 工具行拥有。
- 会话时间线从已加载的完整 `ConversationRow[]` 一次性建立只读 `entityId -> 友好标题` 索引；`ConversationTurnGroup` 和 renderer 只消费结果，不各自重复配对。四张卡的统一规则见 [`tool-card-visible-titles.md`](./tool-card-visible-titles.md)。
- `task_id` 保留为内部关联键和调试信息，不作为默认用户可见主标题。

## 展示规则

1. TaskOutput 工具行存在关联的 SubagentRow 时，主标题优先显示与上方 Agent 工具行一致的友好标题；Agent 标题缺失时再回退到关联行的 `summaryText`。
2. 关联标题应与上方 Agent/Subagent 行使用同一友好文本，不重新拼接或重复生成描述。
3. 没有可靠关联、历史数据缺少 SubagentRow、非 Agent 后台任务或标题为空时，回退到本地化的通用任务标题。旧 Agent 后台任务仅作为历史读取/停止兼容，不是新的 Agent 后台启动方式。
4. 运行中仍显示“正在获取任务输出”；`retrievalStatus: "not_ready"`、超时、失败、停止和成功等既有状态语义不变。
5. 普通输出、展开、截断和错误展示不因标题关联而改变。

## 关联边界

- 只使用已加载会话窗口内、由 `parentToolCallId` 精确配对（或旧数据同回合唯一剩余项回退）的 `SubagentRow`，避免跨会话复用标题。
- 只使用现有 v4 行字段，不改变 Agent、TaskOutput 的协议 schema、持久化格式或 runtime 状态机。
- 旧数据没有可关联标题时必须安全回退，不猜测或解析自然语言输出。

## 验收场景

- 一个带 description 的 `codeReview` 子代理在 TaskOutput 运行态：卡片显示“正在获取任务输出”和与上方一致的友好标题，不显示 `agent_...`。
- 同一回合有多个子代理：每个 TaskOutput 只显示匹配自己的标题。
- 无 SubagentRow、非 Agent 任务或空 description：显示通用本地化标题，页面不崩溃。
- TaskOutput 成功、`not_ready`、超时、失败和停止状态，以及输出展开/截断行为保持不变。
