# 定时任务到点必达与会话留痕

## 目标

定时/延时任务到点触发后，无论执行成败，聊天列表里必须留下这个会话与这条消息；成功或失败在会话内呈现（错误横幅 + 继续），与调度结算解耦。派发前模型解析失败不得再"无痕失败"。

## 背景

派发链（scheduler 认领 → host `dispatchCronRun`）原有顺序为「模型解析 → createTask → sendPrompt」。模型解析失败发生在建会话之前，错误只写 `automation.lastError` / `automation_runs.error`，聊天列表无任何痕迹；且解析成功后的传输类失败会触发重试，每次重试重复建会话。

## 产品规则

- **到点必达**：保存了具体模型选择（ModelSelection）的任务，解析失败时仍创建会话并把任务提示词发进会话。发送以执行域（execution-scope）绑定**保存的选择原样**，不做任何兜底回落——维持 model-group spec「不回落 Workspace 首选」不变量。
- **失败在会话内呈现**：轮次在请求期失败产生 TurnError → 会话错误横幅 + 「继续」；列表行状态为 error；真实错误经 `trackCronRunOutcome` 写入 run 台账（outcome=failed）。
- **派发结算与执行结果解耦**：消息送达即派发成功（ok:true → `markDispatched`）。一次性任务卡片转已完成，表示调度责任已尽；执行成败由会话与运行历史承载，不回写 `automation.lastError`。
- **不重试已送达的失败**：execution-passthrough 分支派发成功后不再进入 5 次退避重试（消息已送达、失败已可见、用户可手动「继续」；重试只会重复同样失败）。
- **无具体模型可绑定的失败维持现状**：组意图任务（组已删 / 无可用成员）与「解析不出 Workspace 首选」的场景没有可执行域绑定的选择，维持派发失败 + 退避重试 + 卡片原因展示。
- **基础设施级失败维持现状**：无 host、DB 未就绪、createTask/sendPrompt 传输失败仍按 transient 退避重试。
- **一个 run 一个会话**：run 行持久化 `session_id`（首建即回填，先到先得不覆盖）；重试复用同一会话。`sendPrompt` 幂等键为 runId（inputId→commandId 对齐），复用会话不重复发消息。
- **会话内创建（targetTaskId）**：解析失败时消息同样发进绑定会话，以失败轮呈现；不写会话模型配置。
- **闲时任务（off-peak）同类缺陷（`validateSelection` 失败无会话）不在本 spec 范围**，记录为后续项。

## 状态所有者

| 状态                                 | 所有者                                             | 说明                                                             |
| ------------------------------------ | -------------------------------------------------- | ---------------------------------------------------------------- |
| automations / automation_runs 调度态 | `AutomationRepo`（scheduler 结算 + host 幂等回写） | dispatch 状态机、重试、`markDispatched` / `markRunDispatch` 不变 |
| `automation_runs.session_id`         | `AutomationRepo.attachRunSession`                  | 派发期间首建回填，先到先得；不触碰 dispatch 状态                 |
| 会话内容（消息、TurnError、横幅）    | V4 session runtime                                 | 执行域选择只属于单次执行，不进入 session 配置                    |
| run 终态 outcome                     | `trackCronRunOutcome` → `markRunOutcome`           | 既有通道；TurnError 终态落 failed + 真实错误                     |

## 事件顺序

```text
到点 → scheduler 认领(runId) → host dispatchCronRun
  ├─ 解析成功 → createTask(带解析后模型) → attachRunSession
  │      → trackCronRunOutcome → sendPrompt(会话域) → ok:true
  │      → scheduler markDispatched → turn 运行 → 终态回写 run.outcome
  ├─ 解析失败 + 有保存的具体选择 → createTask(不带模型) → attachRunSession
  │      → trackCronRunOutcome → sendPrompt(执行域=保存的选择原样) → ok:true
  │      → scheduler markDispatched（一次性转已完成，不再重试）
  │      → turn 请求期失败 → TurnError 落会话（横幅 + 继续）→ run.outcome=failed
  └─ 组意图 / 无首选可解析 → 抛原错误 → transient 退避重试 ×5 → 卡片已失败（现状）
传输失败（任一分支）→ transient 重试 → 复用 run.session_id 同一会话（消息幂等不重发）
```

- 执行域直发的合法性：CLI 准入对 `selectionScope:"execution"` 跳过闸前模型校验（prompt-turn），运行时在请求期解析；与闲时派发「会话不带模型 + 发送绑定执行选择」同形。
- 组意图不能执行域直发：组需要 host 侧按名单哈希钉死成员，无成员可钉即无合法选择。

## 验收场景

1. 延时任务保存的具体模型在触发时不可解析（如代理上游断链）：聊天列表出现会话，提示词已作为用户消息落进会话，会话显示错误横幅与「继续」；运行历史一条 dispatched + outcome=failed 及真实错误；一次性卡片转已完成；无派发重试。
2. 同一任务传输类失败（sendPrompt 超时）：重试后复用 run.session_id 同一会话，消息不重复。
3. 组意图任务组已删：维持派发失败、卡片显示「模型组已删」原因（现状）。
4. 解析成功：行为与现状完全一致（会话带任务模型、正常执行）。
5. targetTaskId 任务解析失败：消息发进绑定会话并显示失败轮，绑定会话模型配置不变。
