# Spec: 工具调用流式增量执行（先输出先起跑）

## 目标

模型在一个 model step 里连续吐出多个 tool call 时，**每个 tool call 的参数一闭合就进入执行调度**，不等整条流结束。副作用工具之间仍然按声明顺序串行，只读工具仍然并发。`AskUserQuestion` 不再因为「排在副作用批次之后」而等到所有工具跑完才弹窗。

改之前，流式阶段只有「只读 + 并发安全 + 免审批 + 无用户交互」的工具会起跑（`readOnly && concurrentSafe && !destructive && !needsApproval && !requiresUserInteraction && sideEffectScope === "none"`），`Bash` / `Edit` / `AskUserQuestion` 全部积压到流结束，再由 `ToolScheduler` 分组、组间串行执行。模型习惯把提问放在批次末尾，于是提问的启动时间 = 流结束时间 + 前面所有副作用组跑完时间。

## 产品规则

- **起跑触发点是参数闭合，不是流结束**。tool call 的 `tool_input_end` 一到（`adapters/src/model/streaming-tool-call-assembler.ts` → `runtime/methods/model.ts` 的 `tool_call` 事件 → coordinator 的 `accept`），该工具立即进入调度。
- **起跑顺序 = 模型输出顺序**。分组判定的唯一来源是 `ToolScheduler`（coordinator 每次扫描都调 `runtime.scheduleTools(acceptedToolCalls)` 重算），coordinator 不另写一套并行规则、不自行维护分组。
- **分组语义与流后执行完全一致**：某工具可以起跑，当且仅当「它所在并行组之前的所有组都已经结束」。因此 `Bash`→`Edit` 这类副作用工具之间仍然严格按声明顺序串行；副作用工具之后的只读工具仍然要等它跑完。增量调度只把「组完成 → 下一组起跑」这个触发点从「流结束后统一触发」提前到「上一组完成的瞬间触发」，不放松任何顺序保证。
- **门禁只剩三项总开关**：`config.modelStreaming === "on"`、`config.streamingToolExecution !== "off"`、工具已注册且名字非空。`readOnly` / `concurrentSafe` / `needsApproval` / `requiresUserInteraction` / `sideEffectScope` 不再阻止流中起跑——审批与提问照旧发生在**各工具自己开始执行时**（`tool/executor/call-runner.ts` 的 `resolveToolPermission`），本次不改变提问与审批的通道语义。
- **`providerExecuted` 工具仍然直接跳过**，连 `acceptedToolCalls` 都不进。
- **结果合并顺序不变**：仍按模型声明顺序合并进 history（`turn-tools.ts` 的 `resultById` + `coreToolCalls.map`）。`declarationIndex` 仍是声明序号，工具行在时间线上的位置不因为起跑变早而变化——这条约束不只在 history 侧，落库与 UI 侧同样成立（见「流中占位保序」）。
- **流中占位保序：工具行不再抢占正文序号**。`part.sequence` 是 INSERT 时现场 `max+1`（`adapters/src/storage/session-store/repositories/messages.ts` 的 `savePart`），先写者得小号；同 id 更新保留原 `sequence`（`on conflict(id) do update … sequence = part.sequence`），`time_updated` 取落盘时刻但不参与排序。起跑变早后工具 part 变成流中第一批写入，会抢到比正文小的号，UI 按号排就把计划卡顶到结语前面。因此模型步**起点**（`step-start` 之后）先写两个空占位 part：一条空 reasoning、一条空 text，文本都是空串。text 占位不带 `time`（`time_created` 即步起点）；reasoning 占位带 `time: { start: 步起点 }`，因为 `ReasoningPart.time` 是必填字段。工具 part 自然落到占位之后的号。**流末改为按占位 id 回填**（同 id `persistPart`），正文与思考因此把号固定在工具之前，落库顺序与刷新/重启后的回放顺序一致。
  - 回填只覆盖第一段：一次模型请求归并后若产出多条 reasoning（签名/密文 thinking 逐块保留的例外），第一条回填占位 id，其余照常新增并排在占位之后。
  - 没有正文（`state.modelResponse` 为空）时不回填，占位保持空串。
- **占位不产生可见空行**：Stop、断流、admission 重试、context 超窗恢复等提前退出路径都不回填，占位以空行形态留在库里。UI 在 render unit 边界过滤空行——`reasoning` 空行过滤是既有设计（`packages/ui/src/v4/conversationTurnRenderUnits.ts` 的 `isVisibleAssistantWorkRow`），本次给空 `assistantText` 加同款一条（只滤 `text.trim()` 为空的正文行，不碰有内容的行）。冷恢复的合成事件侧本就跳过空 text / 空 reasoning part（`transcript-hydration.ts` 的 `synthesizeTextPart` / `synthesizeReasoningPart`），刷新后不会看到占位行。等价于「流末没写」的状态，不丢话——话本来就没落库。
- **占位不进 provider 历史**：冷恢复把 transcript 还原成 provider history 时同样跳过空占位（`core/src/agent/session-history-hydrator.ts` 的 `assistantReasoningFromParts` / `assistantTextFromParts`）。判据与 live 路径的 `hasAssistantReasoningContent` 同款——空 reasoning 且无 metadata 丢弃，空 text 丢弃。少了这一条，冷恢复会把 `{ type: "reasoning", text: "" }` 当成真实思考、并给正文前面拼一段空行，与直播不一致。
- **turn stop 是尽力而为**：某工具结果要求停轮时，**此后才起跑**的工具按既有语义产出 `ToolCancelled`（复用 `tool/executor/batch-runner.ts` 的 `TOOL_CANCELLED_AFTER_TURN_STOP` 文案），已经起跑的在途工具不回收。这与流后分组执行的取消边界一致；差别仅在于「先输出先起跑」天然让 stop 之前声明的工具真的跑过了，这是本 spec 明确接受的产品取舍。
- **断流恢复不重放副作用**：模型流中途失败时，已起跑的工具一律等到真实结果，不合成 `unknown_execution_state`、不由流后路径再执行一次；从未起跑的工具不在流式结果里，交给 `executeToolCallsForModelStep` 的 pending 路径正常执行。
- **只有「登记了但还没开批」的失败允许回落到流后执行**（持久化 / ledger 事件失败）：此时 handler 尚未运行，回落不会造成同一工具执行两次。判据是批次是否真的开跑，不是「executeDuringStream 有没有抛错」。
- **取消仍然中止在途执行**：用户 Stop / turn abort 时，coordinator 的 abort signal 照常传给在途工具，`abandon` 语义不变。

## 接口

- `apps/zcode-cli/packages/core/src/runtime/methods/streaming-tool-coordinator.ts`
  - `accept(toolCall)`：从「登记 + 立即起跑」改为「登记 + 入 accepted 前缀 + 触发一次起跑扫描」。扫描按 `runtime.scheduleTools` 的分组顺序推进，遇到「前面所有组已结束」的组就并发起跑组内未起跑的工具；已 stop 时直接为该工具产出 turn-stop 取消结果。
  - `drain(toolCalls)`：先补一次起跑扫描（流结束时所有未起跑工具在此起跑），再按传入的声明顺序收集结果，含 turn-stop 取消结果。
  - `recoverFromModelFailure(...)`：不再 `abortController.abort()` 后 250ms 竞速，改为「置 stop、禁止新起跑、等在途 handle 真实结束」，未起跑的工具不进 `streamedToolResults`。
  - 新增内部状态：`started`（已起跑）、`settled`（已结束）、`cancelledAfterTurnStop`（stop 后未起跑的工具的取消结果）、`streamingEligible`（通过门禁的工具）、`stopped`、以及串行化的扫描链（保证并发 `accept`/settle 回调不会交叉重入）。
  - 门禁函数 `shouldExecuteToolDuringStream` 改为 `isStreamingExecutionEnabled`（只保留三项总开关 + 注册表命中）。
  - `drain` 每个工具收集前都要等一次扫描链跑到尾：前一个工具结束时刚排进链的扫描会在此刻执行完，后一个工具的起跑因此已经发生。少了这一步就会在「刚解锁、尚未起跑」的窗口里查不到 handle，漏掉结果并让流后路径重复执行。
- `apps/zcode-cli/packages/core/src/runtime/methods/streaming-tool-execution.ts`（新增）
  - `executeDuringStream(...)`：单个 tool call 的流中执行（pending part → scheduled → 执行 → 终态结果）。起跑时机的决策留在 coordinator，这里只管执行；`onBatchStart` 里置 `batchStarted` 标记，作为「handler 是否已经开跑」的判据。
- `apps/zcode-cli/packages/core/src/runtime/methods/streaming-tool-synthetic-result.ts`
  - 新增 `createTurnStopCancelledStreamedToolResult(toolCall)`：`error.type = CoreErrorType.ToolCancelled`，`ledgerRecorded: false`，终态 part 由 `turn-tools.ts` 现有 `ledgerRecorded === false` 分支落盘。
  - `createSyntheticStreamedToolResult` 收窄为「已开批但拿不到结果」一种用途（原先的 `not_executed` 分支随恢复路径改造下线），消息文案不变。
- `apps/zcode-cli/packages/core/src/tool/executor/turn-stop-messages.ts`（新增）
  - `TOOL_CANCELLED_AFTER_TURN_STOP` 放在无依赖的叶子模块：流中与流后两条路径共用同一句面向模型的取消文案，直接互相 import 会形成循环依赖。
- `apps/zcode-cli/packages/core/src/tool/executor/batch-runner.ts`
  - 改为从叶子模块 import 该常量，行为不变。
- `apps/zcode-cli/packages/core/src/runtime/methods/turn-model-step.ts`：占位与回填的唯一落点。step-start 之后写空 reasoning / 空 text 占位（id 记在本步上下文），流末的 reasoning 循环与 text 写入改成按占位 id 的同 id `persistPart`（内容、metadata、`time` 窗口照常填）。`drain` 调用点、pending 划分、结果合并顺序保持不变。
- `apps/zcode-cli/packages/core/src/runtime/methods/turn-tools.ts`：不改（pending 划分、结果合并顺序全部保持）。
- `packages/ui/src/v4/conversationTurnRenderUnits.ts`：`isVisibleAssistantWorkRow` 增加空 `assistantText` 过滤，与既有空 reasoning 过滤同款；不改写协议投影，保留 running/completed 两态共用的裁剪边界。
- `apps/zcode-cli/packages/core/src/agent/session-history-hydrator.ts`：`assistantReasoningFromParts` / `assistantTextFromParts` 跳过空占位，保持冷恢复的 provider 历史与直播一致。

## 状态与时序

```
现在                                   改后
模型流 ─┬─ accept(Read1)  → 起跑        模型流 ─┬─ accept(Read1) → 起跑
        ├─ accept(Bash1)  → 积压                ├─ accept(Bash1) → 积压（Read1 未结束）
        ├─ accept(Read2)  → 起跑                ├─ accept(Read2) → 积压（Bash1 在它前面且未结束）
        └─ accept(Ask)    → 积压                ├─ accept(Read3) → 与 Read2 同组，起跑
流结束                                      └─ accept(Ask)   → 积压
drain → 按组串行                            Read1 结束 → Bash1 起跑（不等流结束）
  [Read1,Read2,Read3] [Bash1] [Ask]        Read2/3 结束 → Ask 起跑（弹窗此时出现）
  → Ask 最后弹窗
```

```
accept(T)
  ├─ providerExecuted → 忽略
  ├─ acceptedToolCalls.set(id, T)（declarationIndex = 序号）
  ├─ stop 已生效 → 记 turn-stop 取消结果，返回
  └─ sweepStartable()（串行链）
        schedule = runtime.scheduleTools(已 accept 前缀)
        for group of schedule.parallelGroups:
            if 前面所有组已 settled → 并发起跑组内未起跑工具
            否则 → 停止推进

工具结束
  └─ settled.add(id) → 若结果要求 stop 则 stopped = true → 再 sweep 一次

drain(声明顺序)
  ├─ sweepStartable() 补起跑
  └─ 逐个 await：turn-stop 取消结果 / 真实结果；未起跑且未取消 → 留给 pending 路径
```

所有者：`StreamingToolCoordinator` 是流式阶段「谁已起跑、谁已结束、谁被取消」的唯一所有者；`ToolScheduler` 仍是分组语义的唯一所有者；`executeToolCallsForModelStep` 仍是结果合并、落盘与注入 history 的唯一所有者。占位 id 的所有权属于**本模型步**（`runModelBackedTurnStepImpl` 局部变量），只有它知道该回填到哪一行。

## 落库序号时序

```
模型步起点   step-start(seq 0) → reasoning 占位(seq 1) → text 占位(seq 2)
流中        tool part(seq 3, pending → running → 终态，同 id 不改号)
流末        reasoning 首段回填占位 id（seq 1 保持）→ 其余段新增（seq n）
            text 回填占位 id（seq 2 保持，time_updated 取落盘时刻）
提前退出    不回填：占位以空串留在 seq 1/2，UI 空行过滤裁掉
```

事件顺序：占位与工具的写库顺序决定 `sequence`，`sequence` 决定冷恢复合成事件的先后，进而决定 UI 行序。回填是「同 id 更新」，`savePart` 的 `on conflict(id) do update` 在 `message_id`/`session_id` 未变时保留原 `sequence`，因此回填不会把正文重新排到工具后面。

## 验收场景

1. 模型输出「耗时约 20 秒的 Bash」+「AskUserQuestion」：问题弹窗在两个 tool call 各自参数闭合后即出现，不等 Bash 结束；Bash 在提问期间继续跑，结果正常落盘并按声明顺序注入 history。
2. 模型输出「改 A 文件的 Bash」+「改 A 文件的 Edit」：Edit 的 `tool_started` 仍晚于 Bash 的结果，串行安全没有被增量调度放松。
3. 模型输出 Read + Bash + Read：两个 Read 在流中并发起跑，Bash 在它们都结束后起跑，全程不等流结束。
4. 模型输出「CronCreate（触发 create limit）」+ 后续工具：create limit 的结果返回后，后续未起跑的工具拿到 `ToolCancelled`，文案与流后执行一致；已经起跑的只读工具正常收尾。
5. 流中断（provider 报错）且已有 Bash 起跑：恢复路径等 Bash 真实结束并复用结果，Bash 不被再执行一次；从未起跑的工具在恢复后的正常路径里执行一次。
6. `streamingToolExecution=off`：所有工具仍等流结束再按组执行，与改动前逐字一致（逐条 ledger 事件顺序不变）。
7. 用户在 Bash 执行中按 Stop：在途 Bash 收到 abort 并以 `ToolCancelled` 收口，turn 正常结束。
8. 流中起跑的工具在时间线上的位置不变：多个工具的终端行仍按声明顺序排列，只是开始时间变早。
9. Plan 档发「写计划」类任务，模型同轮说话并调 CreatePlan：计划卡排在结语之后，刷新、重启后位置不变（正文 `sequence` 小于工具 part）。
10. 同轮只调工具不说话：无空行、无多余空白，时间线与现在一致（占位被空行过滤裁掉）。
11. 工具执行中按 Stop：时间线无空白卡片，恢复后工具行状态正常，无悬空占位（占位未回填且被过滤）。

## 负面边界

- 结果合并顺序、工具行展示顺序、`declarationIndex` 语义不在本 spec 范围，仍以 `turn-tools.ts` 为准。直播期的行序由事件到达顺序决定（projection 的 `row.appended`），本 spec 不改这条链路。
- 占位保序不改 `sequence` 的现场 `max+1` 分配语义：不加独立排序键，不做流末重排（会多一个写时点，Stop 漏触发），不把文本插到工具前（要整段后移已写行，竞态最多）。
- hydration 合成侧不顺手改：空 text / 空 reasoning part 在 `transcript-hydration.ts` 已跳过，保持原样。
- 审批与提问的**通道**不变：`permission-flow` / `interaction-broker` / `V4InteractionRegistry` 不改。AskUserQuestion 的 30s handler 超时、300s 自动接受倒计时、同 session 提问队列都不在本次范围。
- `maxConcurrency`（默认 10）分组切片不变，仍由 `ToolScheduler` 决定。
- `outputTokenContinuation` 路径不变：它与工具执行互斥（`classifyOutputTokenContinuation` 在 `toolCallCount > 0` 时直接返回 `"none"`）。
- 工具失败不再截断后续调度的旧策略（`batch-runner.ts` 里已注释掉的 blocking failure 跳过）不恢复；本次不碰流后执行策略。
- 子代理 / 后台任务的工具执行不走这条 coordinator，不在本次范围。
- CreatePlan 的按档停轮语义（仅 Plan 档产生 `plan_created`）不因占位保序而改动。
- 不做「模型还没输出完就先猜着执行」：必须等 tool call 参数闭合（`tool_input_end`），半截 JSON 仍然不调度。
