# Spec: OpenAI 请求的 prompt_cache_key（缓存亲和）

## 目标

OpenAI 系模型（`openai-responses` / Chat Completions，AI SDK kind `openai`）的前缀缓存按服务端机器存放，同前缀请求不保证路由到同一实例。OpenAI 提供 `prompt_cache_key`（Responses API）/ `prompt_cache_key`（Chat Completions）作为缓存路由亲和键：相同 key 的请求会被尽量路由到持有相同前缀缓存的实例。YCode 此前未发送该字段，导致多轮工具循环中连续请求的缓存命中率随机化（实测同会话秒级间隔的同前缀请求命中率仅 ~12%–55%，并在"全命中/全未命中"间跳变）。

## 产品规则

- **键的来源**：`prompt_cache_key` 使用模型请求所属会话的会话 ID（经 `normalizeModelSessionIdForAttribution` 归一化）。同一会话内的所有模型请求（主 agent、同一 turn 的多步工具循环）共享同一 key；子代理使用自己的子会话 ID，天然与父会话隔离。
- **生效范围**：仅对 AI SDK provider kind 为 `openai` 的请求注入（即 `api.type === "openai-responses"` 路径）。`openai-compatible`（第三方 Chat Completions 网关）与 `anthropic` 不注入，行为不变。
- **不覆盖显式配置**：若供应商/模型配置已经通过 providerOptions 显式提供了 `openai.promptCacheKey`，以显式配置为准，适配层不覆盖。
- **无会话上下文时缺省**：解析不出会话 ID 的请求（如无会话探测）不注入该字段。
- **隐私边界**：会话 ID 本身已存在于调试日志与遥测中，不视为凭据；不做额外脱敏，也不写入任何新增状态。

## 接口与所有者

- 注入点：`apps/zcode-cli/packages/adapters` 的 `runner-options.ts`（`createGenerateTextOptions` / `createStreamTextOptions`），以 `providerOptions.openai.promptCacheKey` 形式传给 AI SDK，由 `@ai-sdk/openai` 映射为请求体的 `prompt_cache_key` 字段。
- 键解析：`openai-request-cache-key.ts` 的 `resolveOpenAiPromptCacheKey({ providerKind, sessionId })`，与 `anthropic-request-metadata.ts` 的 `resolveAnthropicRequestMetadataUserId` 同构；调用点为 `runner-stream.ts` 与 `runner-generate.ts` 的每次 attempt。

## 状态与时序

无新增状态、无持久化。键是会话 ID 的纯函数；每次模型 attempt 构造请求时独立解析，无跨请求可变依赖。

## 验收场景

1. `openai-responses` 供应商 + 有会话 ID：请求体包含 `prompt_cache_key === 会话 ID`。
2. 同一会话连续多次模型请求：`prompt_cache_key` 稳定不变。
3. 子代理会话：使用子会话自己的 ID，与父会话不同。
4. `openai-compatible` / `anthropic` 请求：请求体不含 `prompt_cache_key`。
5. 显式配置了 `openai.promptCacheKey` 的 providerOptions：保留用户值。
6. 无会话 ID：不注入字段。
