# Spec: GetContextUsage 专用上下文卡

## 目标

把会话中的 `GetContextUsage` 工具结果从通用 Parameters / Result / raw JSON 兜底改成专用、可折叠的上下文容量卡。用户应能在折叠状态快速判断已用量、有效窗口和剩余量，并在展开后查看完整窗口、自动压缩阈值与 token 来源。

## 状态所有者与展示投影

- runtime 的 `SessionContextUsageSnapshot` 是 used、remaining、effective context window、auto-compact threshold、百分比和 token source 的唯一事实所有者。
- `GetContextUsage` handler 只返回 runtime 快照；UI 不读取 composer meter，也不在 renderer 中重算这些业务字段。
- `get_context_usage` display 是结果的有界、不可变展示投影，随 ToolCallResult 进入实时事件、transcript metadata 和 V4 `output.display`。
- Desktop continuous 与 Web remote replayable 共用同一终态 display；只允许运行中刷新节奏不同，不建立 client mode 业务分支。

```text
GetContextUsage handler
  → GetContextUsageOutputSchema
  → createToolResultDisplay(get_context_usage)
  → contracts strict display union
  → V4 output.display / transcript metadata
  → toolCallRowToLegacyNode(raw.display)
  → readToolResultDisplay
  → GetContextUsageToolCallBlock
```

## 产品规则

### 正常终态

- 折叠摘要显示本地化类别“上下文用量”、`used / effective window (usedPercent)` 和 `remainingTokens`。
- 百分比分母必须是 `effectiveContextWindowTokens`，不能误用完整 `contextWindowTokens`。
- 展开区显示已用、剩余、有效上下文、自动压缩阈值、完整上下文窗口和 token source。
- 容量数字使用固定 K/M/B 口径；中文界面也显示 `200K`，不显示“20万”。
- `estimate` 与 `provider_usage` 使用不同但稳定的本地化标签。
- 正常结果不显示空 Parameters、通用 Result 或整块 raw JSON。

### 运行与异常状态

- scheduled / running 只显示“正在读取上下文用量”，不把旧值或 partial output 当作新快照。
- failed / denied / stopped 复用现有状态文案与错误 tooltip，不展示过期用量。
- completed 但 display 缺失或无效时显示稳定的“数据不可用”状态，不回退到 raw JSON。
- producer 只在 `GetContextUsageOutputSchema` 校验成功后生成 display；无效输出不制造半可信展示事实。

### 历史兼容

- 新调用优先读取结构化 `raw.display`。
- 既有 transcript 只有 `output.text` / `raw.rawOutput` JSON 时，renderer 可做一次严格兼容解析，并投影为同一 UI 数据形状。
- 兼容解析必须验证全部字段；解析失败只显示不可用状态。
- 不增加 transcript migration、缓存表或第二份 session state。

## UI 与响应式规则

- 复用 `ToolLayout`、`ToolSummaryRow` 的折叠、键盘、状态和错误 tooltip 机制。
- 正常完成态的折叠摘要在 conversation 容器窄于 480px 时进入极简单行：保留图标、`used / effective window (usedPercent)`、剩余量和展开箭头，隐藏类别标题与“已读取上下文”成功状态；容量摘要和剩余量均保持单行。
- running、无有效数据以及 failed / denied / stopped 不套用正常完成态的窄屏隐藏规则，继续显示对应状态文案；异常状态不得因布局精简而失去错误语义。
- 详情使用 `rounded-lg border border-border bg-panel`，数值使用 `font-mono`、`tabular-nums` 和仓库 `text-ui-*` 字号。
- 详情以 `@container/conversation` 的实际内容宽度决定列数：容器 ≤768px 时单列，≥769px 时双列；所有容器保留 `min-w-0`，长标签和数值允许换行。
- 状态不能只依赖颜色；明暗主题和 Zai variants 使用现有语义 token。

## 负面边界

- 不修改 `GetContextUsageOutputSchema`、runtime context 计算或 auto-compact policy。
- 不合并 composer context meter、Coding Plan quota、quota banner 或 session usage store。
- 不修改 shared tool identity；renderer 按可信工具名先于 family/fallback 分流，避免把 `GetContextUsage` 误送给 `ReadSessionContextToolCallBlock`。
- 不新增 ToolCallRow 专用顶层字段，不修改 CommandInbox、remote attachment 或 workspace identity。
- 本次只覆盖 Desktop/Web 共用 ToolCallBlocks；TUI 的独立 tool transcript 展示不在范围内。

## 验收场景

1. 新 `GetContextUsage` 调用完成 → 进入专用卡，不出现 Parameters / Result / raw JSON；摘要与详情和工具输出一致。
2. 0%、接近 auto-compact threshold、100% 三种用量 → 进度和文本不越界，剩余量按 effective window 口径展示。
3. `estimate` 与 `provider_usage` → 来源标签不同且准确；中英文容量均保持 K/M/B。
4. running、failed、denied/stopped、无效 display → 状态明确，不显示陈旧数据或 raw JSON。
5. 冷回放只有旧 JSON output → 严格兼容解析后仍显示同一张专用卡；非法旧数据不导致整卡 JSON 展开。
6. 宽屏、≤768px 与极窄容器 → 卡片可读、可点击、可键盘展开，文案不溢出。
7. Desktop continuous 与 Web remote replayable 的同一终态 → 字段和视觉语义一致。
8. `ReadSessionContext`、其它 fallback 卡和 Agent/Task 可见标题行为不回归。
