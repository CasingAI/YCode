# 模型失败分类：网络错误码与自动重试

## 行为

模型请求失败后，adapters 的 `classifyModelFailure`（`apps/zcode-cli/packages/adapters/src/model/failure-classifier.ts`）负责把原始错误分类为 `ClassifiedModelFailure`。主对话的重试闸门见 `model-retry-all-failures.md`（除取消外全部重试）；本 spec 的 `retryable=true` 分类仍是该历史行为的依据记录，并继续作为观测字段输出。

传输层断连类错误码必须归类为 `NetworkError` 且 `retryable=true`。码表由 `isNetworkFailure`（`failure-inspection.ts`）维护，当前包含：

`ECONNRESET`、`ECONNREFUSED`、`EAI_AGAIN`、`ENOTFOUND`、`ENETUNREACH`、`EHOSTUNREACH`、`UND_ERR_SOCKET`、`UND_ERR_CONNECT_TIMEOUT`、`EPIPE`。

### EPIPE（2026-10 补充）

`EPIPE`（对端在写入过程中断开 socket）与 `ECONNRESET` 语义相同，都是瞬时网络/服务端断连，重试大概率成功。历史实现漏掉了它，导致 "Cannot connect to API: write EPIPE" 落到分类器兜底分支（`reason=unknown retryable=false`），主对话直接失败不重试。

`isNetworkFailure` 同时被两个消费点使用，行为需保持一致：

1. `classifyModelFailure` 兜底分支前的通用网络判定（`failure-classifier.ts`）。
2. SSE error chunk 把底层断连码包进 `ProviderBusinessError.providerCode` 时的重试判定（`failure-provider-business-codes.ts` 的 `isRetryableProviderBusinessNetworkFailure`）。

## 状态所有者与边界

- 分类器（adapters model 层）是「主对话要不要自动重试」的唯一所有者。
- workflow 流量（无上限预算）读另一张策略表（`workflow-model-failure-policy.ts`），本 spec 改动不影响其结论（表外错误本就重试）。
- compact 请求的 `isCompactStaleCode` 特判（`runner-stream.ts`）保留：它额外覆盖 `CONNECTIONCLOSED`，且先于预算门判定，不因本改动删除。

## 验收场景

- 错误码为 `EPIPE` 的原始错误：分类结果 `reason=NetworkError`、`retryable=true`，主对话按预算自动重试。
- SSE error chunk 携带 `providerCode=EPIPE`：判为可重试的网络失败，不落 unknown。
- `ECONNRESET` 等既有码表行为不变。
- 取消（Cancelled）仍不可重试。
