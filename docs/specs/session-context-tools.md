# Spec: CompactNow / GetContextUsage 内置工具

## 目标

给模型两个会话上下文自治理工具：

- `CompactNow`：触发后等同上下文接近上限时的 auto compact——同一条压缩路径、同一 trigger/reason，只是不等阈值。
- `GetContextUsage`：返回与 auto compact 决策完全同口径的上下文用量（剩余 token 数与剩余百分比）。

## 产品规则

- 两个工具为 always-on 内置工具（无灰度门），主会话与子代理运行时均可注册。
- `GetContextUsage` 只读免审批；`CompactNow` 会重写会话历史，`readOnly=false`，但不设审批（它是用户显式要求的维护动作，等价于 `/compact`）。
- `CompactNow` 请求的是"下一次模型步前强制压缩"，不是在工具调用内联执行压缩。压缩必须发生在 turn-loop 的 `autoCompactIfNeeded` 边界，保证 `turnRequestState.entries` 的所有权与事件顺序与自动压缩完全一致。
- 强制请求只翻转 `below_threshold` 判定；`disabled`、`not_enough_messages`、`circuit_breaker` 三个安全闸不被强制请求越过。
- `GetContextUsage` 口径：`used` 优先取 provider usage 反推（同 `buildProviderUsageTokenOverride`），否则本地估算；分母为 effective context window（contextWindow − output reserve）；`remaining = max(0, effective − used)`，`usedPercent/remainingPercent` 基于 effective window。

## 状态所有者与事件顺序

```
Tool handler(CompactNow)
  └─ sessionContextPort.requestCompactNow()      // 置 runtime.pendingToolCompactRequest = true
       └─ turn-loop 下一模型步: autoCompactIfNeeded()
            ├─ consumePendingToolCompactRequest() // 读即清，一次性
            ├─ applyForcedAutoCompactDecision()   // below_threshold → 压缩
            └─ compactActiveConversation(trigger=Auto, reason=ContextLimit)  // 与自动压缩同一实现
```

- `pendingToolCompactRequest` 唯一所有者是 runtime（`AgentRuntimeInternal`）；读即清，保证一次请求至多触发一次压缩。
- 用量快照在 handler 调用时同步计算，基于已提交 message history 的 provider 投影；当前 turn 尚未提交的增量不计入（与 auto compact 的 PreRequest 时点口径一致）。

## 接口

- port：core 内部 `SessionContextControlPort`（`packages/core/src/tool/types.ts`，先例 `BackgroundTaskControlPort`），由 `runtime-tools.ts` 用 runtime 实现注入 `ToolExecutionContext.sessionContextPort`；不跨协议、不经 bootstrap。
- schema：`@zcode/contracts` `tools/compact-now.ts`、`tools/get-context-usage.ts`。
- 纯函数：`applyForcedAutoCompactDecision`、`buildSessionContextUsageSummary`（`packages/core/src/compact/policy.ts`）。

## 验收场景

1. 上下文低于阈值时调用 `CompactNow` → 下一次模型请求前发生 compact，事件流与自动压缩一致（`compact.auto.started/completed`，trigger=Auto）。
2. autocompact 被 `enabled=false` 或连续失败熔断时调用 `CompactNow` → 不压缩（安全闸优先）。
3. `GetContextUsage` 返回值满足 `remaining = max(0, effective − used)` 且 `usedPercent + remainingPercent = 100`（四舍五入误差 ≤0.1）。
4. 端口缺席（如未接线的宿主）→ 两个工具都报 `ConfigurationError`，不静默返回假数据。
