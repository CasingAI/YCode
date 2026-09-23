# Spec: 同一轮思考归并成一条 reasoning part

## 背景

上游把一次模型请求的思考切成多段：Responses 的一个 `reasoning item` 会下发多个 summary part（`${item_id}:${summary_index}` 分别开块），一次响应又可能包含多个 item；流式直播按 provider chunk id 分块，因此**一次模型请求常得到十几条 `ModelReasoningContentBlock`**。

此前落库逐块写入，实测一条 assistant 消息落出 18 条 reasoning part（来自 9 个 itemId，每个 item 2 条）。这些段在事实上属于同一轮思考，逐条落库的代价是：

1. 库里同一轮思考散成十几行，`part` 表被流式碎片填满；
2. 冷恢复由 `part` 逐条合成 `reasoning_start/delta/end`，恢复后的历史把同一轮思考显示成十几行；
3. 「思考 N 次」的计数把同一轮算成 N 次。

本次改动把**落库粒度**从「上游段」改成「一次模型请求」，即一次模型请求的思考在数据库里只留一条 `ReasoningPart`。

## 产品规则

- **归并单位是一次模型请求**，不是上游的段。`turn-model-step`（正常收尾）与 `cancelled-stream-persistence`（取消 flush）两条落库路径共用同一个归并函数，粒度必须一致，否则同一轮思考在「跑完」和「被打断」两种结局下落库结果不同。
- **段的连接是连续叙述**：多个块的文本按顺序用空行（`"\n\n"`）拼接。实测段内容是独立成行的标题/句子（如 `**Analyzing FAT filesystem scanner quirks**`、`Synthesizing prior investigation layers and planning next steps.`），空行拼接才是可读的连续叙述，直接首尾相接会粘连。
- **窗口覆盖整段思考**：归并后 `time.start = min(各块起点)`、`time.end = max(各块终点)`。块的起点取该块登记的真实思考起点（`readReasoningTiming`），未登记时回退到该路径的兜底起点（正常收尾 = `modelStartedAt`，取消 = `assistantCreatedAt`）。
- **终点取值策略按路径参数化**（沿用 `reasoning-duration.md` 的既有语义）：正常收尾取各块记录到的 `reasoning_end`，缺失则取落盘当下；取消收尾一律取取消当下，**不采用** provider 早先发过的 `reasoning_end`。
- **空文本块不产生额外行，但也不丢事实**：`hasAssistantReasoningContent` 为假的块（无文本且无 provider 元数据）直接跳过，不参与归并、不产生 part。
- **例外：携带块级签名的思考块不归并，单独成条**。判据与 adapter 侧 `reasoning-history-normalization` 的 `isSignedOrRedactedReasoning` 同一语义：`providerOptions.anthropic.signature`（Anthropic thinking 签名）非空，或 `providerOptions.anthropic.redactedData`（redacted thinking）存在。这类块由 provider **逐块校验**（块数量与内容变化会被拒），合并即破坏回放，因此遇到即先收口当前归并组、该块自成一条并原样保留其 `providerOptions`。
- **保留段的 `metadata` 取归并组首块的 `providerOptions`**。Responses 的 itemId/encrypted_content 挂在块上，但本仓库从不设置 `previousResponseId` / `conversation` / `store: false`，`shouldStripStoredReasoningForOpenAiResponsesStatelessReplay` 恒为真，回放时带 `openai.itemId` 的 reasoning 块在请求投影边界被整段丢弃，因此少存后续 item 的 itemId 不改变上线内容（见「回放中性」一节）；UI 与冷恢复路径都不读 `part.metadata`。
- **本改动只动落库粒度，不动直播事件与投影**。直播仍由投影层按上游分片开行（见「已知边界」），恢复后的历史由 `part` 重建，粒度因此不同；把直播也收敛成一轮一行属于投影层改动，不在本次范围。

## 回放中性（为什么合并不改变发给 provider 的内容）

| 类型                                                      | 回放依赖                                                     | 合并影响                                                  |
| --------------------------------------------------------- | ------------------------------------------------------------ | --------------------------------------------------------- |
| Anthropic thinking（`anthropic.signature`）               | 逐块签名校验                                                 | **排除归并**，1:1 保留原块与 metadata                     |
| Anthropic redacted thinking（`anthropic.redactedData`）   | 逐块密文回放                                                 | **排除归并**，1:1 保留                                    |
| OpenAI Responses（`openai.itemId` / `encrypted_content`） | `item_reference`（store=true）或 summary+密文（store=false） | 本仓库恒走 strip 分支，回放前整块丢弃，合并不改变上线内容 |
| 其他 provider                                             | 无块级校验                                                   | 无影响                                                    |

## 已知边界：直播与恢复后的行数仍不一致（本次未收敛）

直播这次不动：`product-projection` 对每条 `reasoning_start` 都 `openReasoningRow`（先闭合上一行），而 `reasoning_end` 到达即闭合；Responses 的每个 summary part 都会走一遍 start→delta→end，所以**直播仍是每个上游分片一行**（例：9 个 itemId → 9 行）。恢复后的历史改为 1 行。

结论：同一轮思考，直播看到 N 行、重启后看到 1 行，两个方向都还在。本次按需求只收敛数据库与恢复路径；要让直播也一轮一行，需要投影层按「同一 `assistantResponseId` 的连续 reasoning 不新开行、不在分片级 `reasoning_end` 上闭合、只在下一类行或回合终态闭合」改，属于独立改动（影响 live 渲染、正在跑的秒数与「思考 N 次」计数），不在本次范围。

## 接口

- `apps/zcode-cli/packages/core/src/runtime/methods/reasoning-part-persistence.ts`（新增）
  - `mergeReasoningForPersistence({ blocks, fallbackStart, resolveEnd })`：返回 `ReasoningPartForPersistence[]`（`{ text, metadata?, time: { start, end } }`），供两条落库路径直接透传给 `persistPart`。
  - `carriesBlockBoundProviderMetadata(block)`（内部）：签名/密文块判据。
- `apps/zcode-cli/packages/core/src/runtime/methods/turn-model-step.ts`
  - 正常收尾改为 `mergeReasoningForPersistence({ blocks: result.reasoning ?? [], fallbackStart: modelStartedAt, resolveEnd: (block) => readReasoningTiming(block)?.endedAt ?? 落盘当下 })`，逐条 `persistPart`。
- `apps/zcode-cli/packages/core/src/runtime/methods/cancelled-stream-persistence.ts`
  - 取消 flush 改为同一 helper，`fallbackStart: assistantCreatedAt`、`resolveEnd: () => completedAt`。
- 不改：`reasoning-stream.ts`（块内时间登记）、`product-projection.ts`（行状态）、`transcript-hydration.ts`（逐 part 合成，条数自然随落库粒度收敛）、UI 侧全部组件。

## 状态与时序

```
一次模型请求（Responses 例：2 个 item，item A 有 2 个 summary part）
  上游 chunk ──▶ getOrCreateReasoningBlock(A:0) / (A:1) / (B:0)
                 ├─▶ 每块登记 startedAt / endedAt（WeakMap）
                 └─▶ 直播：每条 reasoning_start 各开一行（本图例 3 行，本次不改）

落库（turn-model-step 或 cancelled-stream-persistence）
  blocks ──▶ mergeReasoningForPersistence
              ├─ 普通块 ──▶ 同一归并组：text 以 "\n\n" 连接，window = [min start, max end]
              └─ 签名/密文块 ──▶ 先收口当前组，再自成一条（metadata 原样）
            ──▶ persistPart × N(N = 归并组数 + 签名块数；此例为 1)

冷恢复
  ReasoningPart(1 条) ──▶ synthesizeReasoningPart ──▶ reasoning_start/delta/end(ts = part.time) ──▶ 1 行、秒数为整段思考窗口

所有者：core 运行时是「一次模型请求的思考事实」的唯一所有者（归并只发生在这里）；product-projection 仍是
行状态所有者；UI 与冷恢复只读 part，不参与归并。
```

## 验收场景

1. 一次 Responses 请求产生多个 reasoning item / summary part：落库后该 assistant 消息只有**一条** reasoning part，文本为各段按顺序空行拼接。
2. 该消息冷恢复后，历史里只有一行思考，秒数等于归并窗口（`min 起点` → `max 终点`），与库里 `part.time` 同一量。直播期间仍是 N 行（见「已知边界」，本次未收敛）。
3. 恢复后的历史里「思考 N 次」把这一轮算作 1 次，不再按 itemId 虚增。
4. Responses 无摘要的加密思考（无文本、有 metadata）不产生可见行；纯空壳（无文本无 metadata）不产生 part。
   **归并不改变可见性**：空摘要的思考行在 UI 被裁掉（`responses-reasoning-summary.md` 场景 5），所以一轮里只有一条带文本的思考块时，归并前后用户都只看到那一行；归并改的只是库里条数与冷恢复后的行数。实测真实回合 50 个 reasoning item 归并成 14 条 part（其中仅 1 条带文本），与「回合里最多看到 1 行思考」一致。
5. Anthropic 带 `signature` 的 thinking 与 redacted thinking 仍逐块落库、顺序不变，夹在普通块之间时前后普通块被签名块切成两组（组内归并、组间不跨）。
6. 回合被取消：未闭合的思考按同一归并规则落成一条，`time.end` 为取消当下（不是 provider 早先发过的 `reasoning_end`）。
7. 归并后的 `time.start` 是该组最早的真实思考起点；块没有登记起点时回退到 `modelStartedAt`（正常）/ `assistantCreatedAt`（取消）。

## 验证

- 命令与真实结果（2026-09-23 本机执行）：
  - `pnpm typecheck`：通过（tsc -b 全部项目无输出）。
  - `pnpm --dir apps/zcode-cli typecheck`：通过（27/27 successful）。
  - `pnpm lint`：73 warnings / 0 errors，均为改动前既有告警；改动文件（`reasoning-part-persistence.ts`、`cancelled-stream-persistence.ts`、`turn-model-step.ts` 及新测试）无告警。
  - `pnpm architecture:check --changed`：OK，violations 0 / new 0。
- 测试（`node --import tsx --test <file>`）：`apps/zcode-cli/packages/core/test/reasoningPartPersistence.test.ts` 11 例全通过；连带复跑 reasoning 相关既有用例（core 计时 8 例、bootstrap 耗时 3 例 + 冷恢复耗时 3 例、UI 秒数 9 例）共 34 例全通过。
- 未执行：桌面端手工过一遍「直播一个 Responses 回合 → 重启 → 检查行数与秒数」（需交互式运行桌面端，本机未执行）；已知边界中的直播行数未收敛。
