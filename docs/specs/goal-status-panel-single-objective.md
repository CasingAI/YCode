# 状态面板目标区只展示用户目标原文

## 问题

右上角状态面板的"目标"区过去按 verifier 迭代逐轮渲染行（`buildConversationGoalIterationSummaries`）：第 1 行标题是目标原文，第 N（N>1）行标题取上一轮 verifier 的 `nextAction`，每行右侧显示该轮 Todo 的 `completedCount/totalCount`，左侧按轮次完成状态渲染目标图标或带编号的完成圈。

实测反馈这套展示有三个问题：

1. **用户无法区分"自己定的目标"与"Agent 生成的下轮计划"。** 两者用同样的图标、同样的排版并排呈现，用户天然读成"我有多个目标"。
2. **轮次行是 Agent 的内部执行过程，不是用户关心的信息。** 用户定目标时关心的是目标本身、是否在跑、是否完成，而不是每轮的 Todo 进度。
3. **单行内数据语义错位。** 行标题来自第 N-1 轮的 verifier 结论，行内进度数字却是第 N 轮自己的，两者拼在一行讲不通。

## 产品规则

1. **目标区只保留一行目标原文**：标题取 `summaryTitle?.trim() || objective.trim()`（与原第 1 行同源），纯文本呈现，不带轮次图标、不带 x/y 进度、不带 `data-goal-iteration*` 属性。
2. **标题行 trailing 原样保留**：总耗时（`data-goal-elapsed-seconds`）、暂停/恢复按钮、完成勾（`verified`）。这些回答"跑了多久、还在跑吗、完成没有"。
3. **不做折叠、不做展开。** 轮次历史从状态面板整体移除；执行历史仍可在时间流中观察（`ConversationRowView` 的 goalVerify marker，"第 N 次迭代 · 校验中"等），该链路不受本 spec 影响。
4. **只删展示，不动数据。** 协议与存储层的 `GoalState.iterations`、`verifications` 是权威投影与恢复语义的事实源，保持不变。

## 状态所有者

- `GoalState`（快照 `goal`）仍是唯一事实源；面板是只读投影。
- 面板单行标题由 `conversationGoalSummaryModel.ts` 的 `getConversationGoalPanelTitle` 提供，与耗时函数 `getConversationGoalElapsedSeconds` 同文件同源。
- 逐轮摘要函数 `buildConversationGoalIterationSummaries` 及其辅助随展示一并删除，无其他消费方。

## 验收场景

- 设定目标后面板目标区：只有一行目标原文（或其摘要标题），无小旗子/数字圈、无 `x/y` 进度。
- 目标运行中：标题行显示递增耗时与暂停按钮；暂停后显示恢复按钮；`verified` 后显示完成勾。
- 时间流中 goalVerify marker（"第 N 次迭代 · 目标校验中/完成/未完成"）照常出现。
- `getConversationGoalPanelTitle`：`summaryTitle` 非空白时优先；否则回退 `objective`；两者均空白返回 null。
