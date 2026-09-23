# Spec: Responses 类模型的思考内容必须请求 summary

## 目标

`openai-responses` 类模型的思考内容此前完全不显示：回合里只有「已工作 N 秒」，展开后没有任何思考文本。

根因不在 UI、不在 SDK，也不在协议解析，而在**请求缺了一个字段**。OpenAI Responses 协议下模型思考有两种输出：`reasoning.summary`（可读摘要）与 `encrypted_content`（密文，仅供跨轮回放，不可读）。**不请求 `summary`，上游就返回空摘要数组**，其余链路只能拿到空文本。ZCode 内置配置里所有 `openai-responses` 规则都只写 `reasoning.effort`，`summary` 在全仓出现 0 次。

本改动让所有 `openai-responses` 模型在开启思考时请求 `reasoning.summary`，并补一个结构性测试防止后续新增规则再次漏掉。

## 产品规则

- **`openai-responses` 是唯一需要显式请求 `summary` 的 apiType**。`openai-chat-completions` 通过 `reasoning_content` / `reasoning_effort` 直接给明文，`anthropic-messages` 通过 thinking block 给明文，两者都不需要也不应该注入 `summary`。
- **注入点只能是 option map**。`packages/model-option-map` 是 reasoning 与 max-output 请求字段的唯一权威，adapter 侧不得再开第二条写入路径。
- **开启思考才注入**。`reasoningLevel` 为 `"disabled"` 或 `"none"` 时不注入 `summary`。两者都要判：`gpt-5.6-luna` 这类模型的关闭值是 `"none"`，没有 `"disabled"` 这个取值。
- **不新增状态、不改协议、不改 UI**。思考行、`reasoning_start/delta/end` 事件、`ReasoningRow.durationMs` 全部沿用既有机制。
- **空思考行仍然不显示**。`conversationTurnRenderUnits.ts` 裁掉空文本 reasoning 行是正确守卫，保留不动。
- **上游是否给摘要由上游决定，应用不伪造**。请求了 `summary` 也不保证每轮都有，取决于输入是否触发上游的摘要生成：
  - 用应用的真实请求形状（系统提示 + 42 个工具 + `reasoning:{effort:high,summary:auto}`）重放，「你好」**4/4 完全没有 reasoning 项**（不是空摘要，是上游根本没输出思考项）；把 `summary` 换成 `concise`/`detailed`、`effort` 换成 `max`，5 种组合 × 2 次共 10 次仍全部为空。
  - 同一请求体只把最后一条 user 消息换成需要多步推理的问题，摘要 3/3 产出（91–111 字符）。
  - 没有摘要时该回合不显示思考行——这是上游行为，不引入兜底文案或占位内容。
- **协议差异会造成预期落差**。`openai-chat-completions` 直接暴露原始思维链，`openai-responses` 只有需要显式请求的摘要。实测同一个「你好」：`deepseek-flash`（chat-completions）返回 58 字符中文思维链，`muse-spark`（responses）什么都没有。因此「问候这类短输入在 chat-completions 下能看到思考、在 responses 下看不到」是协议与上游共同决定的结果，不是本改动的缺陷。`muse-spark-1.3-contributor` 在本网关没有 chat-completions 端点（`Endpoint is unavailable`），无法通过换协议绕开。

## 接口

- `config/provider/zcode-builtin.json`
  - 所有 `apiTypeMatch: "openai-responses"` 且定义 `optionSpecs.reasoningLevel.map` 的规则，map 内增加：
    `"summary": reasoningLevel == "disabled" || reasoningLevel == "none" ? null : "auto"`
  - 依据两个既有机制：解析器支持 `null` 字面量（`packages/model-option-map/src/parser.ts`）；merge patch 中 **patch 值为 `null` 等于删键**（`packages/model-option-map/src/merge-patch.ts` 的 `mergeObject`），因此关闭思考时不注入。
  - `revision` 递增。运行时按「Bundled 与 Active 缓存中 revision 较高者」生效（`packages/provider-node/src/zcode-builtin-provider-config-source.ts`），只改内容不提 revision 会让远程同步在 `applyRemoteRelease` 抛「相同 revision 对应不同内容」。
- `packages/provider/test/responsesReasoningSummary.test.ts`（新增）
  - 读内置配置，经 `parseZCodeBuiltinModelConfigRules` 解析后，对每条 `openai-responses` 规则用 `compileModelOptionMap` 编译并用 `"high"` 求值，断言产出含 `reasoning.summary`；用 `"disabled"` 与 `"none"` 求值，断言不含。
  - 同时断言不存在「`apiTypeMatch` 未声明或为 `openai-responses`、却定义了 `reasoning` 补丁而不含 `summary`」的规则——防止后续新增宽泛规则把 `summary` 覆盖掉。

规则覆盖范围受 overlay 语义约束：`ModelConfigRules.resolve` 按固定顺序 overlay，**后命中覆盖先命中**，且 `map` 一旦出现就**整体替换**、不做字段级合并。因此不能只改 catch-all，必须逐条覆盖（当前 15 条：`modelApiRules` 10 条 + `providerSiteRules` 5 条）。

## 状态与时序

```
请求：option map 注入 reasoning.summary
   │
   ├─ 开启思考 ──▶ {"reasoning":{"effort":"high","summary":"auto"}}
   └─ 关闭思考 ──▶ {"reasoning":{"effort":"none"}}        （summary 为 null，被删键）
   │
上游：带 summary ──▶ 可读 summary_text
      不带 summary ──▶ summary: []  +  encrypted_content
   │
SDK：response.reasoning_summary_text.delta ──▶ reasoning-delta（text）
     无 summary 时仍发 reasoning-start/end（带 itemId + 密文），但零个 reasoning-delta
   │
落库：reasoning part 的 text 为空 ⟺ 未请求 summary
   │
UI：空文本 reasoning 行被裁掉 ⟶ 回合只显示「已工作 N 秒」
```

所有者不变：option map 拥有请求字段，投影拥有行状态，UI 只读。

## 验收场景

1. `openai-responses` + 开启思考发一轮 → 请求体 `reasoning` 内含 `"summary":"auto"`，回合内出现可展开且非空的思考块。
   **验收提示词必须是需要推理的多步问题**（例如「A farmer has 17 sheep. All but 9 run away. Then he buys 3 times as many as remain, minus 4. …」）。单步算术（`What is 17*23? Think it through.`）实测只有 2/6 命中摘要，会造成假失败。
2. 同一模型关闭思考 → 请求体 `reasoning` 内**没有** `summary` 键。
   注意：该模型关闭思考时的请求体是 `{"effort":"none"}`，而 `muse-spark-1.3-contributor` 的上游不接受 `"none"`（见「已知问题」），因此这一场景只断言「不注入 summary」，不断言「请求成功」。
3. `openai-chat-completions` / `anthropic-messages` 发一轮 → 请求体与改动前逐字节一致，思考内容照常显示。
4. 结构性测试通过；删除任意一条规则的 `summary` 键后该测试必须失败。
5. 上游对短输入返回空摘要时 → 该回合不显示思考行，不出现占位或伪造文本。

## 上游不返回可读摘要的实测边界（2026-09-23 复核）

用户报障「一轮跑完一个思考都没显示」时，在真实会话（`sess_8684bace`，`muse-spark-1.3-contributor` + `opencode-go-responses`）上复核链路，结论是**请求字段没有问题，是上游对这类请求不下发摘要**：

- 应用发出的请求体确为 `reasoning: {"effort":"xhigh","summary":"auto"}`（`~/.zcode/cli/debug/model-io-sess_8684bace-*.jsonl`，16 条全同）。
- 用**逐字节相同的真实请求体**（系统提示 + 31 条历史 + 42 个工具）重放：`summary` 取 `auto` / `concise` / `detailed`、`effort` 取 `minimal`…`xhigh`，全部得到同一结果——3–6 个 reasoning item，其中 2–4 个带 `encrypted_content`（约 1.4KB 密文），`summary: []`，零个 `reasoning_summary_text.delta`，也没有 `content` 字段。**没有任何可读文本可供落库或显示**。
- 反证同一模型在轻上下文下会给摘要：同模型同 42 个工具，只把 `input` 换成单条 user 消息 → 95 字符；不挂工具的短会话 → 172 字符（`auto`）与 178 字符（`detailed`）。把真实 `input` 截到前 4 条（3 条 system + 1 条上下文）仍是 0 字符，说明与工具循环无关，和上下文规模/构成有关。
- 换 `x-opencode-session` 头、去掉全部工具、换 effort 档位都不改变结果。

因此**不是请求缺字段，也不是投影或 UI 丢文本**：`encrypted_content` 是仅供回放的密文，应用无法解码，也没有第二条可读来源。同一会话库里 50 个 reasoning item 落成 14 条 part，其中只有 1 条带文本（89 字符，来自唯一一次拿到摘要的请求）；截图那张卡片（16 次查阅 + 7 次终端）对应回合内 7 条思考 item 全部空摘要，所以卡片上没有「思考 N 次」，展开也没有思考行——这是场景 5 的预期行为，不是回归。

产品后果要在预期上对齐：**Responses 类模型「有没有思考可看」由上游逐请求决定**，开启 `summary` 只把可能性打开。长上下文/工具循环的回合常常整轮没有可读摘要，此时界面按设计保持安静（不出现空思考行，也不出现占位文案）。

## 已知问题（本次未修）

`muse-spark-1.3-contributor` 的 `reasoningLevel` 只有 `["disabled","enabled"]`，关闭思考经 catch-all map 得到 `{"effort":"none"}`，而上游对该模型接受的值是 `[minimal, low, medium, high, xhigh, max]`，返回：

```
400 [invalid_request_error] reasoning_effort 'none' is not supported for model 'muse-spark-1.3-contributor'
```

**这是改动前就存在的行为**：catch-all 的 `effort` 表达式本次一字未改，关闭思考时的请求体在改动前后都是 `{"effort":"none"}`。本次只补 `summary`，不触碰该表达式，因此不引入也不修复此问题。修它需要产品决策（关闭思考时是省略 `reasoning` 字段，还是发该模型支持的最小档位如 `minimal`），不在本 spec 范围内。

`gpt-5.6-luna` 一类 `values` 含 `"none"` 的模型有同样风险（`effort` 直通 `reasoningLevel`，关闭时即 `"none"`）。

## 验证

已执行并记录真实结果：

- 结构性测试：`node --import tsx --test packages/provider/test/responsesReasoningSummary.test.ts` 通过（3/3）。
- 反向验证：临时移除两条规则的 `summary` 键，3 个用例全部失败并给出「以下规则的 map 缺少 summary」提示；恢复后重新通过，配置 diff 回到 16 行。
- `pnpm typecheck` 通过；`pnpm lint` 为 73 warnings / 0 errors（exit 0），新增文件未产生任何 warning。
- **场景 1（真实链路）**：以 `ModelConfigRules.resolve` → `compileModelOptionMaps` → `createModelOptionMapFetch`（真实注入点）→ `@ai-sdk/openai` responses → 真实网关 → `toModelStreamEvent`（真实归一化）跑通。`reasoningLevel="high"` 时 3/3 产出非空思考文本（155–203 字符），请求体确为 `{"effort":"high","summary":"auto"}`；原始 SSE 含 `response.reasoning_summary_text.delta`。改用单步算术提示词则只有 2/6，故验收提示词已按场景 1 修正。
- **场景 2（真实链路）**：`reasoningLevel="disabled"` 时真实请求体为 `{"effort":"none"}`，无 `summary` 键（并由此发现上面的 400 已知问题）。
- **线上确认（应用自己发出的请求）**：从运行中的桌面应用 `~/.zcode/cli/debug/model-io-sess_6f0a69f9-*.jsonl` 取出一条真实请求，其 body 为 `reasoning: {"effort": "high", "summary": "auto"}`，证明修复在真实应用里已生效。用这份逐字节相同的请求体重放（含系统提示与 42 个工具）：「你好」0/4 无摘要；仅替换 user 消息为多步推理问题后 3/3 有摘要（91–111 字符）。据此确认「问候看不到思考」的原因是上游不产出摘要，而非链路丢字段。
- **场景 3（全量对比）**：逐规则 diff `HEAD` 与当前内置配置。478 条规则中 15 条变化，**全部是 `openai-responses`**；每条去掉新增的 `summary` 片段后与 `HEAD` 逐字节相同。解析层面另抽 5 组（responses × 2、chat-completions、anthropic-messages）确认后两者的请求体不含任何 `summary`。
- **场景 5（deepseek，已实测）**：`https://api.deepseek.com/responses` 接受 `reasoning.summary`（HTTP 200，无字段错误），但 2/2 返回空摘要——该端点接受字段却不产出可读摘要，故这三条规则当前是「无害但无效」，无需回退。同批对比 9 个受影响模型（`gpt-5.6-luna`、`grok-4.6`、`kimi-k2.7-code`、`qwen3.8-max`、`gpt-6-astra`、`gpt-5.4-mini`、`gpt-5.3-codex`、`qwen3.7-max`、`qwen3.8-omni-flash`）在带/不带 `summary` 时状态码与错误信息完全一致，说明本次改动未给它们引入新的失败。
- 网关对**未知参数**严格拒绝（`unknown parameter` → 400），因此上面这些「带/不带结果一致」的观测有意义：`summary` 被接受是 schema 一致性，而非网关对任意字段的宽容。
- **未覆盖**：上述 9 个模型在本账号/地区上游均不可用（403/503/400），无法触达字段校验层，故「它们是否真的支持 `reasoning.summary`」仍属未验证；残余风险是一个实现了 `reasoning.effort` 但不实现 `reasoning.summary` 的端点会返回 400。
