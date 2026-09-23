# Spec: 问答答案的留存（AskUserQuestion answers）

## 目标

用户回答了 AskUserQuestion（可多题、可长文本自由作答）后，答案必须在**工具调用行**上留存，直播、切会话、重启 CLI、冷恢复都看到同一份答案。当前实现里答案只活在两条易失路径上：

1. **直播**：答案经 `PermissionResolved.modifiedInput` 到达，但 v4 投影 `onPermissionResolved` 只改 `status`，从不把改写后的入参写回工具行。行的 `input` 仍是模型发问时的 `{questions}`，UI 读不到 `answers`，收起态显示「未提供回答」。
2. **持久化**：`PermissionResolved` 只在内存 event store（非瞬态但进程结束即丢，`turn-window` 仅淘汰瞬态类型）。durable 权威是消息里的 tool part，而 part 的 `state.input` 写的是权限结算**之前**的模型入参，答案从未落盘。CLI 重启后冷恢复合成的 `ToolCallScheduled` 同样没有答案。

用户实际遇到的现象：三题长文答案点「提交」后，收起块三行全是「未提供回答」。

## 产品规则

- **行的入参即有效入参**。工具行 / tool part 的 `input` 是「这次工具调用实际执行时用的入参」。权限（或 Hook）把入参改成 `modify` 后，行与 part 都必须跟着改成改写后的入参。AskUserQuestion 的答案就是改写后的 `answers` 字段，因此天然落在行的 `input.answers` 上，不需要新增结构化字段或第二份状态。
- **单一所有者**：
  - 直播行 = `ProductProjection`。`PermissionResolved` 携带 `modifiedInput` 时，投影在同一条 `row.upserted` 里同时更新 `input` 与 `inputText`（`inputText` 是同一事实的文本表示，不能与 `input` 互相矛盾）。
  - 持久记录 = tool part。执行器把有效入参经 `ToolExecutionResult.executionInput` 交给 turn 循环，由 turn 循环在终态 part 写入 `state.input`；part 仍是冷恢复的唯一权威，投影不额外持久化任何东西。
- **冷热一致**：冷恢复合成 `ToolCallScheduled{input: part.state.input}`，与直播走同一个 reducer，因此冷恢复行同样带答案。这是硬不变量：同一会话在任何时刻、任何入口打开，行内容一致。
- **不改渲染层的数据来源**：`readAskUserQuestionAnswers` 早已优先读 `input.answers`（`packages/ui/src/lib/askUserQuestion.ts`），本改动只补齐事实，不动渲染逻辑与「未提供回答」文案。
- **无答案时保持原样**：`allow`（未改写）或 `deny`（用户拒绝）路径下 `modifiedInput` 缺失，行保持模型入参，收起态继续显示「未提供回答」。此时该文案是正确的：确实没有答案。
- **「跳过」= 拒绝当前这一题**：普通 AskUserQuestion 的底部左侧按钮是「跳过」，点击即清掉**当前这一题**的草稿（已选项与自定义文本一并丢弃）并前进——非最后一题进入下一题，最后一题则提交其余已答的题。答案构建只提交用户真实提供的答案，被跳过的题天然缺席，模型侧 `formatAskUserQuestionModelContent` 输出 `The user answered some questions and skipped N`。已答的题不会因为跳过而丢失。
- **一题都没答 = 整组拒绝**：最终一题都没答（逐题跳到最后一题，或一路翻页没填）时发 `decline`，模型收到 declined；只要有一题作答就发 `accept` + 部分 answers。这是用户主动拒绝，与「超时自动结束」区分开：后者由 `interaction-registry` 发 `accept` + 空 answers，话术是"不要当成拒绝，用最佳判断继续"，因为那是用户没看见而不是拒绝。
- **Esc = 整组拒绝**（保留原「忽略」行为）：Esc 在非第一题时先返回上一题，其余情况等同整组 `decline`。它是唯一还会一次性丢光草稿的入口，因此草稿非空时必须先弹确认；用户取消则留在原对话框、草稿原样保留。
- **计划审批不参与跳过**：ExitPlanMode 复用同一对话框，底部左侧按钮仍是「忽略」= 拒绝计划；空答案在审批协议里本身表示拒绝，也不做草稿确认。

## 接口

- `apps/zcode-cli/packages/contracts/src/events/session.events.ts`
  - `PermissionResolvedPayload.modifiedInput?: unknown` —— 已存在，无需改协议。
- `apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/product-projection.ts`
  - `onPermissionResolved`：`settlePermission(toolCallId, status, payload.modifiedInput)`。
  - `settlePermission(toolCallId, status, effectiveInput?)`：`effectiveInput !== undefined` 时把 `input` 换成它、`inputText = stringifyToolInput(effectiveInput)`；`undefined` 时保持原行字段不动。
- `apps/zcode-cli/packages/core/src/tool/types.ts`
  - `ToolExecutionResult.executionInput?: unknown`：执行器已解析出的有效入参（权限/Hook 改写后），随结果返回，不进入模型可见内容。
- `apps/zcode-cli/packages/core/src/tool/executor/call-runner.ts`
  - 成功结果与失败结果都带上当前 `executionInput`（权限被拒的早退结果不带：它没有执行入参）。
- `apps/zcode-cli/packages/core/src/runtime/methods/turn-tools.ts`
  - 终态 part（`completed` / `error`）写入 `toRecordInput(result.executionInput ?? persisted.input)`；`pending` / `running` 中间态仍写模型入参（那一刻有效入参还没产生）。
- `packages/ui/src/store/alertDialogStore.ts`
  - `AlertDialogRequest.cancelLabel?: string`：提供时 `AlertDialogHost` 渲染 `AlertDialogCancel`（默认聚焦在取消侧，Enter 不会误确认）。
- `packages/ui/src/lib/elicitationResponse.ts`
  - 草稿 → 响应的纯判定（组件只负责渲染与焦点，这些规则放这里以便直接测）：`buildElicitationResponseContent`、`clearElicitationQuestionDraft`、`resolveElicitationRespondAction({isPlanApproval, questions, drafts})`（`accept` | `decline`）、`resolveElicitationFooterAction(isPlanApproval)`（`chat.elicitation.skip` | `chat.elicitation.dismiss` 与对应动作）。
- `packages/ui/src/ElicitationDialog.tsx`
  - `skipCurrentQuestion`：`clearElicitationQuestionDraft(drafts, currentQuestion.key)` 后走 `advanceFromQuestion`（最后一题即提交其余已答的题）。
  - `submitWithDrafts`：`resolveElicitationRespondAction` 判为 `decline` 时发 `onRespond(id, "decline")` 且不带 content（空 answers 对模型是另一层含义，不该被当成"用户没回答"）。
  - `dismiss`：只剩 Esc 会走到；非计划审批且草稿非空 → `await requestAlert({...})`，未确认直接返回，不发 `decline`。

## 状态与时序

```
用户点「提交」
  ElicitationDialog.submit ──▶ onRespond(accept, {answers})
        │
        ▼
  interaction-broker: {decision:"modify", modifiedInput:{questions, answers}}
        │
        ├─▶ emitPermissionResolved ──▶ 投影 onPermissionResolved
        │        └─ settlePermission(..., modifiedInput) ──▶ row.upserted{ input, inputText }   ← 直播行
        │
        └─▶ permission-flow: executionInput = modifiedInput
                 └─ call-runner ──▶ ToolExecutionResult{ executionInput }
                          └─ turn-tools 终态 part: state.input = executionInput               ← durable 权威
                                   └─ 冷恢复 synthesizeEventsFromMessages
                                            └─ ToolCallScheduled{ input: part.state.input }
                                                     └─ 同一 reducer ──▶ 与直播一致的行

用户点「跳过」（普通问答，最后一题）
  skipCurrentQuestion ──▶ clearElicitationQuestionDraft(当前题)
        └─▶ advanceFromQuestion(已清空草稿)
                 ├─ 非最后一题 ──▶ 进入下一题（草稿保留，不提交）
                 └─ 最后一题 ──▶ submitWithDrafts
                          ├─ 还有题答过 ──▶ onRespond(accept, {answers: 已答的题})
                          └─ 一题都没答 ──▶ onRespond(decline) ──▶ {decision:"deny"}

用户按 Esc（不会被底部按钮触发）
  dismiss ──▶ 草稿非空? ──是──▶ requestAlert(继续填写 / 放弃回答)
        │                        └─ 继续填写 ──▶ 返回，草稿保留
        └─否──────────────▶ onRespond(decline) ──▶ {decision:"deny"} ──▶ 行保持模型入参（未提供回答）
```

- 事件顺序不变：`ToolCallScheduled` → `PermissionRequested` → `PermissionResolved` → `ToolCallStarted` → `ToolCallResult`。投影只在 `PermissionResolved` 处改写入参，之后所有写行的路径（`onToolCallResult`、`closeOpenToolRows`、后台通知）都是 `...row` 展开，不会把答案冲掉。
- 回合被取消（Stop）也保留答案：`closeOpenToolRows` 以当前行快照收口。

## 验收场景

1. 单题自由作答后提交：工具行收起态显示用户输入，不再显示「未提供回答」。
2. 多题（含长文本）全部作答后提交：每题显示各自答案。
3. 提交后立刻 Stop：行仍显示答案，状态为取消。
4. 提交后刷新页面 / 切换会话再回来：显示同一份答案（内存事件仍在时由事件重放保证）。
5. 提交后重启 CLI（冷恢复，仅剩 part）：仍显示同一份答案。
6. 多题中跳过其中一题：该题显示「未提供回答」，其余题显示答案；模型收到 `answered some questions and skipped N`。
7. 非最后一题点「跳过」：进入下一题，不提交，其他题已填的草稿保留。
8. 逐题跳过到最后一题：发 `decline`，行状态为取消、入参保持模型入参（不出现伪造的空答案）。
9. 有题作答、其余跳过：发 `accept` + 只含已答题的 answers，被跳过的题在行上是「未提供回答」。
10. 按 Esc 且草稿非空：弹出确认；选择「继续填写」→ 对话框与草稿原样保留，未发出 decline；确认放弃 → 行显示「未提供回答」。
11. 按 Esc 且无任何草稿：直接拒绝，不弹确认。非第一题时 Esc 先返回上一题。
12. 计划审批（ExitPlanMode）底部左侧按钮仍是「忽略」= 拒绝计划，不弹草稿确认。
13. 普通权限工具（无 `modify`）：行入参不变，行为与改动前一致。

## 验证

- 已执行（见提交）：`node --import tsx --test apps/zcode-cli/packages/bootstrap/test/askUserQuestionAnswers.test.ts`（直播回写、冷恢复回写、无改写不动行）、`node --import tsx --test packages/ui/test/elicitationSkip.test.ts`（跳过只清当前题、最后一题跳过提交其余、全跳过发 decline、计划审批分叉）、`node --import tsx --test packages/ui/test/elicitationDraftGuard.test.ts`（草稿判定与 Esc 守卫）。
- 已执行：`pnpm typecheck`、`pnpm lint`（真实结果见提交说明）。
- 覆盖边界：本仓库 `packages/ui/test` 不渲染 React（无 testing-library），上述用例只覆盖 `lib/elicitationResponse.ts` 的纯判定；按钮到 `skipCurrentQuestion` 的接线、焦点与 Esc 弹窗属于未覆盖部分，需要 E2E 或人工回归。键盘可达性沿用改动前：底部按钮是鼠标/触摸操作（选项层拦截了 Tab），键盘用户用 Enter 推进/提交、Esc 整组拒绝——空草稿时 Enter 在非最后一题的效果与跳过一致。
