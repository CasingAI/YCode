# Spec: OpenAI 请求的 prompt_cache_key（缓存亲和）

## 目标

OpenAI 系模型（`openai-responses` / Chat Completions，AI SDK kind `openai`）的前缀缓存按服务端机器存放，同前缀请求不保证路由到同一实例。OpenAI 提供 `prompt_cache_key`（Responses API）/ `prompt_cache_key`（Chat Completions）作为缓存路由亲和键：相同 key 的请求会被尽量路由到持有相同前缀缓存的实例。YCode 此前未发送该字段，导致多轮工具循环中连续请求的缓存命中率随机化（实测同会话秒级间隔的同前缀请求命中率仅 ~12%–55%，并在"全命中/全未命中"间跳变）。

## 产品规则

- **键的来源**：`prompt_cache_key` 使用请求所属会话解析出的 `cacheAffinityKey`（经 `normalizeModelSessionIdForAttribution` 归一化）。新建会话默认以自身 session ID 为 Key；普通 Fork 继承来源会话的已解析 Key；Subagent Fork 继承被复制的来源 child 的 Key。主会话和每条 Subagent 谱系相互独立，同一谱系的多级 Fork 共享 Key。`sessionId` 始终标识当前执行会话，不被替换为来源 ID。
- **Fork 来源证据**：普通 Fork 将 `forkSourceSessionId` 与最终 `cacheAffinityKey` 持久化在 child 自身；Subagent Fork 仅使用已验证 Fork 图中的 `sourceChildSessionId`。`parentID` 只表示当前归属，不用于推断 Fork 来源。旧会话仅在可信持久记录可证明来源时恢复谱系；来源缺失、损坏或证据不足时回退为自身 session ID。
- **持久化与删除**：谱系信息存入 child-local SessionEntry JSON data，不新增数据库表或列。Stable/compact-edit Fork 与递归 Subagent 副本随 `commitForkBundle` 原子提交；legacy Fork 仍沿用既有多步创建/复制流程，本规则不承诺其会话、历史和缓存条目的整体原子性，迁移该路径需另行覆盖 notice、Goal 与 workspace 文件恢复语义。缓存恢复不得依赖源会话仍存在；删除源会话不删除 child 自身的谱系快照。
- **压缩与重启**：上下文压缩不修改 cacheAffinityKey；重启后从会话自身持久 entry 恢复，无法验证时安全回退自身 ID。
- **并发分支**：各 Fork 分支持有独立 session 身份及不可变谱系快照；同一来源的并发 Fork 可共享其缓存亲和 Key，但不得共享或覆盖会话执行状态。
- **前缀边界**：共享 cacheAffinityKey 只提供路由亲和，不改变 OpenAI 的前缀匹配机制。Fork 的工具调用 ID 重映射不得改变模型可见前缀的语义；验收需比较 Fork 前后的模型输入前缀。
- **显式配置**：若供应商/模型配置已经通过 providerOptions 显式提供了 `openai.promptCacheKey`，以显式配置为准，适配层不覆盖。
- **生效范围**：仅对 AI SDK provider kind 为 `openai` 的请求注入（即 `api.type === "openai-responses"` 路径）。`openai-compatible`（第三方 Chat Completions 网关）与 `anthropic` 不注入，行为不变。
- **无会话上下文时缺省**：解析不出会话 ID 的请求（如无会话探测）不注入该字段。
- **隐私边界**：会话 ID 本身已存在于调试日志与遥测中，不视为凭据；来源与 Key 仅写入 child 自身的会话状态，不记录到日志。

## 接口与所有者

- `sessionId` 是当前会话身份和归属/遥测上下文；`parentID` 是当前父会话归属；`forkSourceSessionId` 是普通 Fork 来源；`cacheAffinityKey` 是模型请求缓存路由亲和。四者职责不可互换。
- SessionStore 是持久化权威；Core 在 Fork 时根据可信来源解析并组装 child-local 缓存元数据，stable/compact-edit Fork 由 SQLite adapter 随 `commitForkBundle` 事务提交，legacy 路径仍按现有多步方式写入；模型适配层只读取解析后的 key，不推断 Fork 关系。
- 注入点：`apps/zcode-cli/packages/adapters` 的 `runner-options.ts`（`createGenerateTextOptions` / `createStreamTextOptions`），以 `providerOptions.openai.promptCacheKey` 形式传给 AI SDK，由 `@ai-sdk/openai` 映射为请求体的 `prompt_cache_key` 字段。
- 键解析：`openai-request-cache-key.ts` 基于 provider kind 与独立 `cacheAffinityKey` 解析；调用点为 `runner-stream.ts` 与 `runner-generate.ts` 的每次 attempt。

## 状态与时序

```text
新建会话：sessionId → cacheAffinityKey → 持久化 child-local entry
Fork：可信来源记录/已验证 sourceChildSessionId → 解析来源 cacheAffinityKey
  → 构造新 sessionId、保持 parentID 归属 → stable/compact-edit bundle 同事务提交；legacy 路径按既有多步流程持久化 child-local 谱系 entry
模型请求：当前 sessionId 用于归属/遥测；cacheAffinityKey 单独注入 OpenAI promptCacheKey
恢复：读取本会话 entry → 校验后使用；缺失/损坏/证据不足 → 回退自身 sessionId
```

上下文压缩只改变上下文内容，不写缓存谱系状态；模型请求每次从会话的已解析状态取得 key，不在 runner 内建立第二份可变缓存。

## 验收场景

1. `openai-responses` 请求按当前会话解析出的 `cacheAffinityKey` 注入 `prompt_cache_key`，而 `sessionId` 仍保持当前执行会话身份。
2. 同一会话的连续请求及同一 Fork 谱系多级 Fork 使用稳定 Key；新建普通会话及新建 Subagent 默认使用各自 session ID。
3. 普通 Fork 与 Subagent Fork 分别继承正确来源；Subagent Fork 的 `parentID` 指向新父会话，不作为来源推断依据。
4. 压缩、重启及源会话删除后仍从 child-local entry 恢复 Key；旧数据证据不足、entry 损坏时回退自身 ID。
5. stable 与 compact-edit Fork 在 `commitForkBundle` 事务内持久化来源和 Key，事务失败不留下部分数据库 Fork；legacy Fork 保留既有多步持久化语义，但必须将 cache affinity 写入 child-local entry，源会话删除后不影响恢复。
6. `openai-compatible` / `anthropic` 请求不含 `prompt_cache_key`；显式 `openai.promptCacheKey` 保留用户值；无会话 ID 时不注入。
7. 并发分支不共享执行状态，且同来源分支可共享亲和 Key；Fork 前后模型输入的工具调用/消息前缀语义一致。
8. OpenAI 请求选项测试验证 providerOptions 注入；若 SDK 测试入口可控，再断言实际序列化请求体字段。

## 原有行为

旧版本规则为每个会话直接使用自身 session ID。迁移不批量回写历史会话；只在 Fork 时依据可信来源证据生成 child-local 谱系记录，无法证明时沿用自身 ID。

## 原始目标说明

OpenAI 系模型（`openai-responses` / Chat Completions，AI SDK kind `openai`）的前缀缓存按服务端机器存放，同前缀请求不保证路由到同一实例。OpenAI 提供 `prompt_cache_key`（Responses API）/ `prompt_cache_key`（Chat Completions）作为缓存路由亲和键：相同 key 的请求会被尽量路由到持有相同前缀缓存的实例。YCode 此前未发送该字段，导致多轮工具循环中连续请求的缓存命中率随机化（实测同会话秒级间隔的同前缀请求命中率仅 ~12%–55%，并在“全命中/全未命中”间跳变）。

**提示**：该规则只控制缓存路由亲和，不承诺服务端必然命中缓存。

<!-- 原先的产品规则段已整合到上方，避免出现两套冲突定义。 -->

- **原注入接口**：`apps/zcode-cli/packages/adapters` 的 `runner-options.ts`（`createGenerateTextOptions` / `createStreamTextOptions`），以 `providerOptions.openai.promptCacheKey` 形式传给 AI SDK。
- **原键解析入口**：`runner-stream.ts` 与 `runner-generate.ts` 的每次 attempt。

## 兼容注记

`openai-compatible`（第三方 Chat Completions 网关）与 `anthropic` 不注入该字段。没有会话上下文时不注入。显式 `openai.promptCacheKey` 始终优先。

<!-- 原验收列表改由上述验收场景维护。 -->

## 历史规则（仅供变更追溯）

旧实现仅以 `sessionId` 为纯函数输入，无持久化；这些规则现已由 Fork 缓存谱系规则取代，但非 OpenAI、显式覆盖和无会话行为保持不变。

<!-- 旧内容此前已通过 git 历史保存，不在此重复。 -->

## 说明

本规格是当前生效规则；旧规则文字如果与本节冲突，以本节为准。

<!-- end -->

## 额外验收

- 显式配置 providerOptions 时保留原值。
- 请求归属、遥测及执行隔离继续使用当前 sessionId。
- 不修改 OpenAI 的前缀匹配机制。

## 实现边界

缓存谱系属于会话持久状态，不由请求 runner 重算父子关系；SessionEntry 的 data 使用 JSON 可编码载荷，读取时必须运行时校验。- **生效范围**：仅对 AI SDK provider kind 为 `openai` 的请求注入（即 `api.type === "openai-responses"` 路径）。`openai-compatible`（第三方 Chat Completions 网关）与 `anthropic` 不注入，行为不变。

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
