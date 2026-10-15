# Spec: 子代理失败原因透传

## 目标

子代理（Agent Tool 派发的 foreground child / 继续运行的 Worker）失败或取消时，父 Agent 与 UI 必须能看到真实失败原因（网络中断、限流、上下文超限、工具取消等），而不是一句没有任何信息的 `Agent <id> continuation ended with status failed.`。

现状问题：错误在链路上被逐层降级，父 Agent 只拿到"失败了"这个结论，无法判断该重试、换模型、还是报告用户。

## 产品规则

### 错误文本

失败/取消终态写入的 `errorMessage` 直接取错误的**主帧文本**：复用既有 `selectExecutionErrorMessage`（`core/src/errors/error-payload.ts`，递归 `cause` 链选第一个非包装、有 message 的帧），原样透传，不拼接任何归因元数据。

- **只保留 error 文本**，不带 `code` / `source` / `phase` / `provider` / `model` / `retryable` 等方括号字段——父 Agent 与用户要的是"错在哪"，内部归因属于日志/遥测，不进对模型的提示。
- 无 message 时退回 fallback（子代理场景为 `Agent … execution failed`）。

### 各层职责

- **runner（`core/src/subagent/runner.ts`）**：终端失败的 `catch` 分支用 `selectExecutionErrorMessage(error)` 生成 `errorMessage`，写进 `registry.error`、`SubagentStopped` 事件 `error`、终态 `AgentTerminalOutput.error/content`、落盘 artifact metadata。这些字段仍是 `string`，**不改协议类型**（避免 transcript / hydration 的破坏性变更）。
- **send-message 模型通道（`core/src/tool/handlers/send-message.ts`）**：`formatSendMessageModelContent` 在 `continuation.status` 为 `failed` / `cancelled` 时单独输出一行 `error: <continuation.error>`，父模型据此知道具体原因；正文文本与 error 相同时不重复输出。
- **display 通道（`core/src/tool/executor/result-display.ts`）**：`local_agent_message` 载荷的 `error` 字段优先取 `continuation.error`（回退顶层 `error`），经 `MAX_SEND_MESSAGE_DISPLAY_FIELD_BYTES` 限长后进 UI metadata，供 Agent 卡 tooltip 展示。

### 边界

- 只透传，不新增重试/兜底分支；provider 的重试/超时策略不在本 spec 范围。
- 不新增 UI 组件；只保证数据到达 UI 已消费的 `subagentResult.error`。
- 不改 `AgentFailedOutput` 的 zod 类型（`error: string`），不做协议破坏性变更。

## 验收场景

1. 子代理因模型 SSE 流网络中断失败时，父会话 `SendMessage` 结果文本包含 `continuation status: failed` 与 `error: Network connection failed for the provider request.`，且不含归因方括号。
2. 终端 `error` / 事件 `error` / artifact metadata 的字符串都等于同一份错误文本。
3. UI Agent 卡的失败 tooltip 能拿到 `continuation.error`（display metadata 非空）。
4. 无 message 的普通失败退回 fallback，不出现空文本。
