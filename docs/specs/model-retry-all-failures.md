# 主对话模型失败全量重试

## 行为

主对话（有界重试预算，默认 `maxAttempts=11`，即首次 + 10 次重试）的模型请求失败后，**除用户主动取消外一律自动重试**，不再按失败分类的 `retryable` 短路。退避曲线不变（指数退避 2s→60s、jitter、provider `Retry-After` 优先）。

背景：2026-10-07 用户遇到 `opencode-go-responses` 400 `Invalid upload request`，分类器判 `invalid_request / retryable=false`，attempt 1 后直接 turn failed。provider 侧对上传参数等校验存在偶发拒绝，重试有机会自愈，因此把「要不要重试」与「失败分类」解耦。

## 状态所有者与接口

- 重试闸门唯一入口：`retryAllowedByFailurePolicy`（`apps/zcode-cli/packages/adapters/src/model/workflow-model-failure-policy.ts`）。SSE 路径（`runner-stream.ts` 的 `canRetryStreamFailure`）与非流式路径（`runner-generate.ts`）共用它，两处语义必须一致。
- 有界预算：`reason === Cancelled` 之外全部可重试。分类器（`failure-classifier.ts`）的 `retryable` 字段保留，继续随状态事件与最终错误 context 输出（观测/UI 语义），但不再作为主对话重试依据。
- workflow 流量（无上限预算）不受影响：照旧读 `resolveWorkflowModelFailurePolicy` 策略表，配额/鉴权/invalid_request 等仍停下来找人。
- 独立保护不因本改动绕过：
  - 已向用户发出可见输出（`emittedRetryBoundaryEvent`）绝不重放，交给 core 的 stream recovery。
  - compact 请求（`preserveProviderStreamBoundaries=true`）在 response_body 阶段的失败不重放。
  - 预算耗尽（attempt 达到 `maxAttempts`）后停止，turn failed。

## 已知代价（有意接受）

- 401/403 鉴权失败、400/422、上下文超窗等确定性失败也会重试满 10 次（含退避等待）后才向用户报错；超窗场景会延迟 core 的 reactive compact 触发。
- 取消（用户点停止）是唯一例外，立即终止不重试。

## 验收场景

- 400 `invalid_request`（如 `Invalid upload request`）：gate 判可重试，按预算重试至 11 次。
- 401/403、超窗、unknown 分类：同样可重试。
- 取消（Cancelled）：不可重试，立即失败。
- attempt 已达 `maxAttempts`：不再重试。
- workflow 无上限预算 + invalid_request：仍按策略表 stop，不重试。
- 已发出可见输出的流失败：不重放（本改动前后一致）。
